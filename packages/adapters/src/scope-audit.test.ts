/**
 * KAR-08.7 AC3, AC5 — the completion-time backstop as the node runners reach
 * it: when it runs, what it appends, and when it refuses to run at all.
 *
 * The *diffing* is the daemon's (`services/scope-diff.ts`, over a real git
 * repository — this package spawns no `git`). What is proved here is the half
 * that lives on the completion path: a node with no declared scope costs
 * nothing, a clean node appends nothing, a violating node appends exactly one
 * `node.scope_warning` carrying the auditor's own two fields — and a node that
 * declares a scope with no auditor wired behind it is refused *before* it is
 * spawned, rather than completing with a backstop that was never there.
 *
 * Verifies: EPIC-08-S30 · AC3, AC5
 */
import {
  EventSeqSchema,
  NodeFailureError,
  NodeIdSchema,
  NodeScopeWarningSchema,
} from '@DeFlow/core';
import { TestClock } from '@DeFlow/testkit';
import { expect, it, describe as suite } from 'vitest';
import type { EventRecord, LedgerSink } from './ports.ts';
import {
  auditCompletionScope,
  type ScopeAudit,
  type ScopeAuditResult,
  type ScopeAuditSubject,
  scopeAuditRefusal,
  workProductRefusal,
} from './scope-audit.ts';

const NODE = NodeIdSchema.parse('implement');
const WORKTREE = '/tmp/wt/implement';

/** A sink that records what it was asked to append, and nothing else: the
 * ledger's own behaviour is @DeFlow/ledger's to prove. */
function recordingSink(): { readonly sink: LedgerSink; readonly appended: EventRecord[] } {
  const appended: EventRecord[] = [];
  const sink: LedgerSink = {
    append: (event) => {
      appended.push(event);
      return Promise.resolve(EventSeqSchema.parse(appended.length));
    },
    appendAll: (events) => {
      appended.push(...events);
      return Promise.resolve(
        events.map((_event, index) =>
          EventSeqSchema.parse(appended.length - events.length + index + 1),
        ),
      );
    },
    appendIo: () => Promise.resolve(EventSeqSchema.parse(1)),
  };
  return { sink, appended };
}

/** An auditor that reports `paths` as out of scope — and, since KAR-23.11
 * widened the port, as the node's changed set too, which is what an
 * out-of-scope write really is. */
const auditor = (paths: readonly string[], commitsAhead = 0): ScopeAudit => {
  return (request) =>
    Promise.resolve({
      changed: [...paths],
      commitsAhead,
      warning:
        paths.length === 0
          ? null
          : {
              node: request.node,
              attempt: request.attempt,
              declared: [...request.declared],
              paths: [...paths],
            },
    });
};

/** An auditor that reports a worktree with nothing in it at all. */
const emptyWorktree =
  (commitsAhead = 0): ScopeAudit =>
  () =>
    Promise.resolve({ changed: [], commitsAhead, warning: null });

suite('auditCompletionScope — the check the node runners run before completing', () => {
  it('does nothing at all for a node that declared no scope', async () => {
    const { sink, appended } = recordingSink();
    let called = 0;
    const audit: ScopeAudit = (request) => {
      called += 1;
      return Promise.resolve({
        changed: ['x'],
        commitsAhead: 0,
        warning: { node: request.node, attempt: 0, declared: [], paths: ['x'] },
      });
    };

    const audited = await auditCompletionScope(
      { node: NODE, attempt: 0, worktree: WORKTREE, declared: undefined },
      { clock: new TestClock(), ledger: sink, scopeAudit: audit },
    );

    expect(audited.warning).toBeNull();
    expect(audited.refusal).toBeNull();
    expect(called).toBe(0);
    expect(appended).toEqual([]);
  });

  it('does nothing for an empty declared scope — that is plan validation’s (AC1)', async () => {
    const { sink, appended } = recordingSink();
    let called = 0;
    const audit: ScopeAudit = (request) => {
      called += 1;
      return Promise.resolve({
        changed: ['x'],
        commitsAhead: 0,
        warning: { node: request.node, attempt: 0, declared: [], paths: ['x'] },
      });
    };

    const audited = await auditCompletionScope(
      { node: NODE, attempt: 0, worktree: WORKTREE, declared: [] },
      { clock: new TestClock(), ledger: sink, scopeAudit: audit },
    );

    expect(audited.warning).toBeNull();
    // KAR-23.11's honesty check is never even asked of a node that declared
    // nothing to write: a reviewer, a verification agent or a node that only
    // returns a document stays green through this same early return.
    expect(audited.refusal).toBeNull();
    expect(called).toBe(0);
    expect(appended).toEqual([]);
  });

  it('appends nothing when every change stayed in scope', async () => {
    const { sink, appended } = recordingSink();

    const audited = await auditCompletionScope(
      { node: NODE, attempt: 2, worktree: WORKTREE, declared: ['src/**'] },
      // One in-scope change: nothing to warn about, and evidence of work.
      { clock: new TestClock(), ledger: sink, scopeAudit: auditor([], 1) },
    );

    expect(audited.warning).toBeNull();
    expect(audited.refusal).toBeNull();
    expect(appended).toEqual([]);
  });

  it('appends exactly one node.scope_warning, carrying the auditor’s fields', async () => {
    const { sink, appended } = recordingSink();
    const clock = new TestClock(1_700_000_000_000);

    const audited = await auditCompletionScope(
      { node: NODE, attempt: 2, worktree: WORKTREE, declared: ['src/**'] },
      { clock, ledger: sink, scopeAudit: auditor(['docs/readme.md']) },
    );

    expect(appended).toHaveLength(1);
    expect(appended[0]).toEqual({
      kind: 'node.scope_warning',
      v: 1,
      ts: 1_700_000_000_000,
      nodeId: NODE,
      attempt: 2,
      payload: { node: NODE, attempt: 2, declared: ['src/**'], paths: ['docs/readme.md'] },
    });
    expect(audited.warning).toEqual(appended[0]?.payload);
  });

  it('appends a payload the published event schema accepts', () => {
    // The event is only useful if a reader can parse it back; a shape this
    // module invented would fail at the first `readRange`.
    expect(
      NodeScopeWarningSchema.parse({
        node: NODE,
        attempt: 2,
        declared: ['src/**'],
        paths: ['docs/readme.md'],
      }),
    ).toEqual({ node: NODE, attempt: 2, declared: ['src/**'], paths: ['docs/readme.md'] });
  });

  it('passes the worktree and the declared globs through to the auditor', async () => {
    const { sink } = recordingSink();
    const seen: unknown[] = [];
    const audit: ScopeAudit = (request) => {
      seen.push(request);
      return Promise.resolve({ changed: ['src/a.ts'], commitsAhead: 0, warning: null });
    };

    await auditCompletionScope(
      {
        node: NODE,
        attempt: 1,
        worktree: WORKTREE,
        declared: ['src/**', '!src/generated/**'],
        baseOid: 'a'.repeat(40),
      },
      { clock: new TestClock(), ledger: sink, scopeAudit: audit },
    );

    expect(seen).toEqual([
      {
        node: NODE,
        attempt: 1,
        worktree: WORKTREE,
        declared: ['src/**', '!src/generated/**'],
        baseOid: 'a'.repeat(40),
      },
    ]);
  });
});

suite('scopeAuditRefusal — a declared scope with nothing behind it (AC3)', () => {
  it('refuses a node that declares a scope with no auditor wired', () => {
    const refusal = scopeAuditRefusal(['src/**'], undefined);

    expect(refusal).toBeInstanceOf(NodeFailureError);
    // `internal`, not an agent failure: an unwired backstop is DeFlow's own
    // misconfiguration, and it cannot fix itself between attempts.
    expect(refusal?.deflowFailure.reason).toBe('internal');
    expect(refusal?.deflowFailure.class).toBe('permanent');
    expect(refusal?.message).toContain('src/**');
  });

  it('admits a node whose auditor is wired', () => {
    expect(scopeAuditRefusal(['src/**'], auditor([]))).toBeNull();
  });

  it('admits a node that declares nothing, wired or not', () => {
    expect(scopeAuditRefusal(undefined, undefined)).toBeNull();
    expect(scopeAuditRefusal([], undefined)).toBeNull();
  });
});

/**
 * KAR-23.11 — the mirror of the refusal above. `scopeAuditRefusal` catches a
 * declared scope with nothing *behind* it; this catches a declared scope with
 * nothing *in* it.
 *
 * On 2026-08-24 `run_20260824T143505Z_3a7365` took four implementation nodes to
 * `node.completed` over twenty-two minutes, each with zero commits and an empty
 * diff, each carrying an `output.text` that said in so many words that it had
 * written nothing. The run looked healthy.
 */
suite('workProductRefusal — a node that promised to write and wrote nothing', () => {
  const subject = (over: Partial<ScopeAuditSubject> = {}): ScopeAuditSubject => ({
    node: NODE,
    attempt: 0,
    worktree: WORKTREE,
    declared: ['src/**', 'packages/**'],
    ...over,
  });

  const result = (over: Partial<ScopeAuditResult> = {}): ScopeAuditResult => ({
    changed: [],
    commitsAhead: 0,
    warning: null,
    ...over,
  });

  it('refuses a write-scoped node with no change and no commit', () => {
    const refusal = workProductRefusal(subject(), result());

    expect(refusal).toBeInstanceOf(NodeFailureError);
    expect(refusal?.deflowFailure.reason).toBe('contract.no-work-product');
    // `permanent`: an agent that ran twenty-two minutes and wrote nothing
    // writes nothing again, and four retries is eighty-eight minutes for the
    // same zero. A replan or a human is the repair, and both are reachable.
    expect(refusal?.deflowFailure.class).toBe('permanent');
    expect(refusal?.message).toContain('src/**, packages/**');
    expect(refusal?.deflowFailure.detail).toEqual({
      declared: ['src/**', 'packages/**'],
      changed: 0,
      commitsAhead: 0,
      artifacts: 0,
    });
  });

  it('admits a node that changed one path', () => {
    expect(workProductRefusal(subject(), result({ changed: ['src/a.ts'] }))).toBeNull();
  });

  it('admits the self-committing agent: a clean worktree, one commit ahead', () => {
    // Load-bearing. DeFlow's model is that a node's work sits dirty and is
    // salvage-committed at teardown, so `git status` is normally the whole
    // answer — but an agent that commits its own work shows a *clean* status,
    // and failing that node would be the worst false positive available.
    expect(workProductRefusal(subject(), result({ commitsAhead: 1 }))).toBeNull();
  });

  it('never asks about a node that declared no write scope', () => {
    // The false-positive case, and the reason it needs no exemption: a
    // reviewer, a verification agent or a node that only returns a document
    // declares `pathScopes.write: []`, and the predicate returns immediately.
    expect(workProductRefusal(subject({ declared: [] }), result())).toBeNull();
    expect(workProductRefusal(subject({ declared: undefined }), result())).toBeNull();
  });

  it('still refuses when the turn produced artifacts — spillage is not work', () => {
    // On both routes `artifacts` is transcript spillage: oversized tool results
    // plus the turn's own text when that spilled too. A chatty agent whose
    // apology crossed OUTPUT_INLINE_LIMIT_BYTES would otherwise launder an
    // empty node. The count travels in `detail` so the record is complete; the
    // predicate keys on the diff, which is the only evidence of *work*.
    const refusal = workProductRefusal(subject({ artifacts: 3 }), result());

    expect(refusal?.deflowFailure.reason).toBe('contract.no-work-product');
    expect(refusal?.deflowFailure.detail).toMatchObject({ artifacts: 3 });
  });

  it('does not exempt a read-permission node with a write scope', () => {
    // Considered and rejected: such a node is structurally incapable of the
    // work the plan promised, so failing it blames the right thing, and an
    // exemption would reopen the defect through a second door. The subject
    // carries no permission at all here, which is the point — the rule reads
    // the declared contract and nothing else.
    expect(workProductRefusal(subject(), result())).not.toBeNull();
  });

  it('is reachable through auditCompletionScope, beside the warning', async () => {
    const { sink, appended } = recordingSink();

    const audited = await auditCompletionScope(
      { node: NODE, attempt: 0, worktree: WORKTREE, declared: ['src/**'] },
      { clock: new TestClock(), ledger: sink, scopeAudit: emptyWorktree() },
    );

    expect(audited.warning).toBeNull();
    expect(audited.refusal?.deflowFailure.reason).toBe('contract.no-work-product');
    // The refusal is the *runner's* to act on: this module files no failure of
    // its own, exactly as it files no gate.
    expect(appended).toEqual([]);
  });
});
