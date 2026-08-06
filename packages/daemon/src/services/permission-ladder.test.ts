/**
 * KAR-08.1 AC6, AC7 — the decider that answers the agent from the policy table.
 *
 * EPIC-08-S5's premise is a frequency argument, not a convenience one:
 * auto-responding to routine requests is *what makes the gates that do fire
 * meaningful*. A run that asks 200 times gets auto-clicked, and is worse than
 * no gate at all (§10.5). So the assertion that matters most here is the
 * boring one — 42 in-scope requests, zero escalations.
 *
 * EPIC-08-S6's premise is that `RequestPermissionOutcome` has two shapes and
 * **both are normal**. A cancelled run is not a broken one, and if the
 * cancellation path constructs an `Error` then somewhere upstream a `catch`
 * turns "the operator pressed stop" into a failure the ledger keeps for ever.
 * That is asserted by counting constructions, because a comment saying "we do
 * not throw here" is not a test.
 *
 * Verifies: EPIC-08-S5, EPIC-08-S6 · AC6, AC7
 */
import type { PermissionScope } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { type LadderDecision, ladderDecider } from './permission-ladder.ts';
import type { PermissionQuery } from './permission-service.ts';

const WT = '/tmp/DeFlow-ladder/wt';

const SCOPE: PermissionScope = {
  worktree: WT,
  allowlist: ['git', 'pnpm', 'node', 'eslint'],
  readOnlyCommands: ['git status', 'git log', 'ls', 'cat'],
  allowedDomains: ['registry.npmjs.org'],
};

const OPTIONS = [
  { optionId: 'a1', name: 'Allow once', kind: 'allow_once' as const },
  { optionId: 'r1', name: 'Reject once', kind: 'reject_once' as const },
];

function query(overrides: Partial<PermissionQuery> = {}): PermissionQuery {
  return {
    sessionId: 'sess-1',
    toolCallId: 'call-1',
    title: 'Edit src/a.ts',
    toolKind: 'edit',
    locations: [{ path: `${WT}/src/a.ts` }],
    options: OPTIONS,
    ...overrides,
  };
}

suite('routine requests are answered from the table, with no human involved', () => {
  it('selects an allow option for an in-scope edit', async () => {
    const escalations: PermissionQuery[] = [];
    const decide = ladderDecider({
      level: 'worktree',
      scope: SCOPE,
      escalate: (gated) => {
        escalations.push(gated.query);
        return Promise.resolve({ outcome: 'selected', optionId: 'r1' } as const);
      },
    });

    await expect(decide(query())).resolves.toEqual({ outcome: 'selected', optionId: 'a1' });
    expect(escalations).toEqual([]);
  });

  it('answers with the agent’s own option id, not with a kind of its own invention', async () => {
    // The agent's list is authoritative: it may offer `allow_always` and not
    // `allow_once`, and answering with an id it never offered is a protocol
    // error dressed up as a permission grant.
    const decide = ladderDecider({ level: 'worktree', scope: SCOPE });
    const answer = await decide(
      query({ options: [{ optionId: 'vendor-42', name: 'Sure', kind: 'allow_always' }] }),
    );

    expect(answer).toEqual({ outcome: 'selected', optionId: 'vendor-42' });
  });

  it('rejects a write a read-level node asked for, without asking anyone', async () => {
    const escalations: unknown[] = [];
    const decide = ladderDecider({
      level: 'read',
      scope: SCOPE,
      escalate: (gated) => {
        escalations.push(gated);
        return Promise.resolve(null);
      },
    });

    await expect(decide(query())).resolves.toEqual({ outcome: 'selected', optionId: 'r1' });
    expect(escalations).toEqual([]);
  });

  it('records every decision with a structured reason, never a prose blob', async () => {
    const seen: LadderDecision[] = [];
    const decide = ladderDecider({
      level: 'read',
      scope: SCOPE,
      record: (decision) => seen.push(decision),
    });

    await decide(query());

    expect(seen).toHaveLength(1);
    expect(seen[0]?.outcome).toBe('deny');
    expect(seen[0]?.reason).toEqual({ code: 'level-read' });
    expect(seen[0]?.method).toBe('fs/write_text_file');
    expect(seen[0]?.path).toBe(`${WT}/src/a.ts`);
  });

  /**
   * EPIC-08-S5 scenario 3, and the design constraint behind it: a gate that
   * fires 200 times in a run is auto-clicked. If this budget ever fails, the
   * allowlist is the bug — not the operator.
   */
  it('escalates zero times across 30 in-scope edits and 12 in-scope reads', async () => {
    let escalated = 0;
    const decide = ladderDecider({
      level: 'worktree',
      scope: SCOPE,
      escalate: () => {
        escalated += 1;
        return Promise.resolve(null);
      },
    });

    for (let index = 0; index < 30; index += 1) {
      const answer = await decide(
        query({ toolCallId: `edit-${index}`, locations: [{ path: `${WT}/src/f${index}.ts` }] }),
      );
      expect(answer).toEqual({ outcome: 'selected', optionId: 'a1' });
    }
    for (let index = 0; index < 12; index += 1) {
      const answer = await decide(
        query({
          toolCallId: `read-${index}`,
          toolKind: 'read',
          locations: [{ path: `${WT}/docs/d${index}.md` }],
        }),
      );
      expect(answer).toEqual({ outcome: 'selected', optionId: 'a1' });
    }

    expect(escalated).toBe(0);
  });
});

suite('only the gated categories reach the operator', () => {
  const fetching = query({
    toolKind: 'fetch',
    title: 'Fetch https://evil.example/payload',
    locations: [{ path: 'https://evil.example/payload' }],
  });

  it('escalates a gated request and returns what the operator chose', async () => {
    const decide = ladderDecider({
      level: 'worktree+net',
      scope: SCOPE,
      escalate: (gated) => {
        expect(gated.reason).toEqual({ code: 'domain-not-allowlisted', detail: 'evil.example' });
        return Promise.resolve({ outcome: 'selected', optionId: 'a1' } as const);
      },
    });

    await expect(decide(fetching)).resolves.toEqual({ outcome: 'selected', optionId: 'a1' });
  });

  it('fails closed when nothing is wired up to ask a human yet', async () => {
    // KAR-08.3 and EPIC-13 own the approval queue. Until they land, a gate
    // that cannot reach anyone is a rejection — never an allow.
    const decide = ladderDecider({ level: 'worktree+net', scope: SCOPE });
    await expect(decide(fetching)).resolves.toEqual({ outcome: 'selected', optionId: 'r1' });
  });

  it('cancels rather than guessing when the agent offers no option of the needed polarity', async () => {
    const decide = ladderDecider({ level: 'read', scope: SCOPE });
    const answer = await decide(
      query({ options: [{ optionId: 'a1', name: 'Allow once', kind: 'allow_once' }] }),
    );

    expect(answer).toEqual({ outcome: 'cancelled' });
  });

  it('gates a request it cannot see the subject of, rather than allowing it', async () => {
    // An adapter that populates no `ToolCallLocation` leaves the ladder with
    // nothing to check the path against. Default-deny means that is a gate.
    let escalated = 0;
    const decide = ladderDecider({
      level: 'worktree',
      scope: SCOPE,
      escalate: () => {
        escalated += 1;
        return Promise.resolve({ outcome: 'selected', optionId: 'a1' } as const);
      },
    });

    await decide(query({ locations: [] }));
    expect(escalated).toBe(1);
  });
});

suite('cancelled is an outcome, not an error', () => {
  it('answers { outcome: "cancelled" } when the run is cancelled mid-request', async () => {
    const decide = ladderDecider({
      level: 'worktree+net',
      scope: SCOPE,
      // `null` is how the escalation says "nobody is going to answer this: the
      // run was cancelled while the request was outstanding".
      escalate: () => Promise.resolve(null),
    });

    const answer = await decide(
      query({ toolKind: 'fetch', locations: [{ path: 'https://evil.example/x' }] }),
    );
    expect(answer).toEqual({ outcome: 'cancelled' });
  });

  it('constructs no Error anywhere on that path', async () => {
    const real = globalThis.Error;
    let constructed = 0;
    class Counting extends real {
      constructor(...args: ConstructorParameters<typeof real>) {
        super(...args);
        constructed += 1;
      }
    }
    globalThis.Error = Counting as unknown as typeof real;
    try {
      const decide = ladderDecider({
        level: 'worktree+net',
        scope: SCOPE,
        escalate: () => Promise.resolve(null),
      });
      const answer = await decide(
        query({ toolKind: 'fetch', locations: [{ path: 'https://evil.example/x' }] }),
      );
      expect(answer).toEqual({ outcome: 'cancelled' });
    } finally {
      globalThis.Error = real;
    }

    expect(constructed).toBe(0);
  });

  it('records the cancellation as its own outcome, not as a denial', async () => {
    const seen: LadderDecision[] = [];
    const decide = ladderDecider({
      level: 'worktree+net',
      scope: SCOPE,
      escalate: () => Promise.resolve(null),
      record: (decision) => seen.push(decision),
    });

    await decide(query({ toolKind: 'fetch', locations: [{ path: 'https://evil.example/x' }] }));

    expect(seen.map((decision) => decision.answered)).toEqual(['cancelled']);
  });
});
