/**
 * KAR-08.3 — command mediation at the ACP `terminal/create` boundary.
 *
 * @DeFlow/core decides; this is the half that can touch a filesystem and the
 * half that can ask a human. Three things only exist here and each is a place
 * a plausible implementation goes wrong.
 *
 * **A gate is not a denial with extra steps.** It suspends the request, emits
 * `human.requested`, and *then* runs or refuses what the operator saw. Nothing
 * is spawned optimistically and nothing is spawned after a rejection.
 *
 * **The command shown is the command run.** The escalation carries the argv as
 * data, not as a shell line, because a queue that renders a normalised or
 * quoted form and then runs a different string is an approval of something the
 * operator did not see. There is no re-quoting step between the two, and
 * ../../test/integration/command-mediation.test.ts proves it against what
 * `spawn` actually received.
 *
 * **A gate with nowhere to go is a rejection.** EPIC-13 owns the approval
 * queue; until it is wired up, `escalate` is absent and this fails closed. The
 * one thing it must never do is fail open.
 *
 * The filesystem is a port here, so the cwd check stays in the unit slice; the
 * integration suite re-proves it against a real symlink.
 *
 * Verifies: EPIC-08-S12, EPIC-08-S13, EPIC-08-S15 · AC1, AC2, AC5, AC7, AC8
 */
import {
  HumanRequestedSchema,
  NodeIdSchema,
  PermissionDeniedSchema,
  type PermissionScope,
} from '@DeFlow/core';
import { expect, it, describe as suite, vi } from 'vitest';
import {
  type CommandApproval,
  type CommandDecision,
  type CommandGate,
  commandGatePayload,
  createCommandMediator,
  humanCommandGate,
} from './command-mediation.ts';
import type { PathFs } from './path-mediation.ts';
import { permissionDeniedPayload } from './path-mediation.ts';

const WORKTREE = '/wt';
const NODE = NodeIdSchema.parse('n1');

const SCOPE: PermissionScope = {
  worktree: WORKTREE,
  allowlist: ['git', 'pnpm', 'node', 'rm'],
  readOnlyCommands: ['git status'],
  allowedDomains: ['registry.npmjs.org'],
  scrubbedEnv: [],
};

/** A filesystem that knows exactly which directories exist and what each one
 * really is — so "the cwd is a symlink pointing out" is a state the test
 * constructs rather than discovers. */
function fs(real: Readonly<Record<string, string>> = { [WORKTREE]: WORKTREE }): PathFs {
  return {
    realpath: (path) =>
      real[path] === undefined
        ? Promise.reject(Object.assign(new Error(`ENOENT: realpath '${path}'`), { code: 'ENOENT' }))
        : Promise.resolve(real[path]),
    sameEntry: () => Promise.resolve(false),
  };
}

interface Harness {
  readonly mediate: (
    command: string,
    args?: readonly string[],
    cwd?: string | null,
  ) => Promise<string>;
  readonly gates: CommandGate[];
  readonly decisions: CommandDecision[];
}

function harness(
  options: {
    readonly level?: 'read' | 'worktree' | 'worktree+net' | 'full';
    readonly scope?: PermissionScope;
    readonly real?: Readonly<Record<string, string>>;
    /** Absent means no queue is wired up, which must fail closed. */
    readonly answer?: CommandApproval | null;
    readonly escalate?: boolean;
  } = {},
): Harness {
  const gates: CommandGate[] = [];
  const decisions: CommandDecision[] = [];
  const mediator = createCommandMediator({
    level: options.level ?? 'worktree',
    scope: options.scope ?? SCOPE,
    fs: fs(options.real),
    record: (decision) => decisions.push(decision),
    ...(options.escalate === false
      ? {}
      : {
          escalate: (gate: CommandGate) => {
            gates.push(gate);
            return Promise.resolve(options.answer ?? null);
          },
        }),
  });

  return {
    gates,
    decisions,
    mediate: async (command, args = [], cwd = null) => {
      const result = await mediator.mediate({ command, args, cwd });
      if (result.outcome === 'allow') return 'allow';
      const { code, detail } = result.denial.reason;
      return detail === undefined ? code : `${code}:${detail}`;
    },
  };
}

suite('EPIC-08-S12 — the common case costs nothing (AC2)', () => {
  it('allows an allowlisted binary in the worktree and asks nobody', async () => {
    const spec = harness({ answer: 'approve' });

    expect(await spec.mediate('pnpm', ['test'])).toBe('allow');
    expect(spec.gates).toEqual([]);
    expect(spec.decisions.map((decision) => decision.outcome)).toEqual(['allow']);
  });

  it('matches the allowlist on the resolved binary, not the raw string', async () => {
    const spec = harness();

    expect(await spec.mediate('./node_modules/.bin/pnpm', ['test'])).toBe('allow');
  });

  it('defaults the cwd to the worktree, and answers with the resolved one', async () => {
    const mediator = createCommandMediator({ level: 'worktree', scope: SCOPE, fs: fs() });
    const result = await mediator.mediate({ command: 'pnpm', args: ['test'], cwd: null });

    expect(result.outcome).toBe('allow');
    if (result.outcome !== 'allow') return;
    // The mediator answers with the cwd to *use*, and the terminal service has
    // no other source for one: resolving twice is how the checked path and the
    // spawned path come apart.
    expect(result.cwd).toBe(WORKTREE);
  });

  it('resolves a relative cwd inside the worktree', async () => {
    const mediator = createCommandMediator({
      level: 'worktree',
      scope: SCOPE,
      fs: fs({ [WORKTREE]: WORKTREE, '/wt/packages': '/wt/packages' }),
    });
    const result = await mediator.mediate({ command: 'pnpm', args: ['test'], cwd: 'packages' });

    expect(result.outcome).toBe('allow');
    if (result.outcome !== 'allow') return;
    expect(result.cwd).toBe('/wt/packages');
  });
});

suite('EPIC-08-S12 — a cwd outside the worktree is a denial, not a question', () => {
  it('denies an absolute cwd elsewhere, even for an allowlisted binary', async () => {
    const spec = harness({ answer: 'approve' });

    expect(await spec.mediate('git', ['status'], '/elsewhere')).toBe('path-escape:cwd');
    // Not escalated: a path escape is refused, not negotiated.
    expect(spec.gates).toEqual([]);
  });

  it('denies a cwd that is lexically inside and really somewhere else', async () => {
    // The route a resolve()-only check misses entirely: the agent creates the
    // symlink with a legal in-scope write and then runs a command through it.
    const spec = harness({
      real: { [WORKTREE]: WORKTREE, '/wt/link': '/elsewhere' },
      answer: 'approve',
    });

    expect(await spec.mediate('git', ['status'], '/wt/link')).toBe('path-escape:cwd');
  });

  it('denies a traversal spelled as a relative cwd', async () => {
    const spec = harness();

    expect(await spec.mediate('git', ['status'], '../../etc')).toBe('path-escape:cwd');
  });
});

suite('EPIC-08-S13 — default deny, then ask (AC1)', () => {
  it('gates an unknown binary and carries the whole request to the operator', async () => {
    const spec = harness({ answer: 'approve' });

    expect(await spec.mediate('rsync', ['-av', '/', '/backup'])).toBe('allow');
    expect(spec.gates).toHaveLength(1);
    expect(spec.gates[0]?.reason).toEqual({ code: 'not-allowlisted', detail: 'rsync' });
    // "carrying the full command, args and cwd verbatim"
    expect(spec.gates[0]?.request).toEqual({
      command: 'rsync',
      args: ['-av', '/', '/backup'],
      cwd: WORKTREE,
    });
  });

  it('refuses the command when the operator rejects it', async () => {
    const spec = harness({ answer: 'reject' });

    expect(await spec.mediate('rsync', ['-av', '/', '/backup'])).toBe('not-allowlisted:rsync');
    expect(spec.gates).toHaveLength(1);
  });

  it('refuses when nobody will ever answer, because the run was cancelled', async () => {
    const spec = harness({ answer: null });

    expect(await spec.mediate('rsync')).toBe('not-allowlisted:rsync');
    expect(spec.decisions[0]?.answered).toBe('cancelled');
  });

  it('fails closed when no approval queue is wired up at all', async () => {
    const spec = harness({ escalate: false });

    expect(await spec.mediate('rsync')).toBe('not-allowlisted:rsync');
    expect(spec.gates).toEqual([]);
    expect(spec.decisions[0]?.outcome).toBe('gate');
    expect(spec.decisions[0]?.answered).toBe('reject');
  });

  it('records what the ladder said and what the operator answered, separately', async () => {
    // The gate budget counts `outcome === 'gate'`; the audit trail needs to
    // know the operator said yes. Collapsing the two loses one of them.
    const spec = harness({ answer: 'approve' });
    await spec.mediate('rsync');

    expect(spec.decisions).toEqual([
      {
        level: 'worktree',
        command: 'rsync',
        args: [],
        cwd: WORKTREE,
        outcome: 'gate',
        reason: { code: 'not-allowlisted', detail: 'rsync' },
        answered: 'allow',
      },
    ]);
  });
});

suite('the syntactic layer reaches the boundary too (AC3, AC5)', () => {
  it('gates an allowlisted binary at an infrastructure boundary', async () => {
    const spec = harness({ answer: 'reject' });

    expect(await spec.mediate('rm', ['-rf', '/'])).toBe('destructive-command:rm-recursive-shallow');
  });

  it('gates a command that needs a variable the child environment lost', async () => {
    const spec = harness({
      scope: { ...SCOPE, scrubbedEnv: ['AWS_PROFILE'] },
      answer: 'reject',
    });

    expect(await spec.mediate('pnpm', ['deploy', '--profile', '$AWS_PROFILE'])).toBe(
      'scrubbed-env:AWS_PROFILE',
    );
  });

  it('lets the safe form through without a question', async () => {
    const spec = harness({ answer: 'reject' });

    expect(
      await spec.mediate('git', ['push', '--force-with-lease', 'origin', 'DeFlow/r1__n1']),
    ).toBe('allow');
    expect(spec.gates).toEqual([]);
  });
});

suite('AC6 — egress is the ladder’s row, decided before the allowlist', () => {
  it('denies outright at worktree and gates a non-allowlisted domain at worktree+net', async () => {
    const closed = harness();
    expect(await closed.mediate('node', ['fetch.mjs', 'https://evil.example/x'])).toBe(
      'level-no-network',
    );

    const open = harness({ level: 'worktree+net', answer: 'reject' });
    expect(await open.mediate('node', ['fetch.mjs', 'https://evil.example/x'])).toBe(
      'domain-not-allowlisted:evil.example',
    );
    expect(await open.mediate('node', ['fetch.mjs', 'https://registry.npmjs.org/x'])).toBe('allow');
  });
});

suite('AC8 — what the ledger records is a code, never a prose blob', () => {
  it('builds a permission.denied payload the schema accepts', async () => {
    const spec = harness({ escalate: false });
    const mediator = createCommandMediator({ level: 'worktree', scope: SCOPE, fs: fs() });
    const result = await mediator.mediate({ command: 'git', args: ['status'], cwd: '/elsewhere' });

    expect(spec.decisions).toEqual([]);
    expect(result.outcome).toBe('deny');
    if (result.outcome !== 'deny') return;
    const payload = permissionDeniedPayload(result.denial, { node: NODE, attempt: 0 });

    expect(PermissionDeniedSchema.safeParse(payload).success).toBe(true);
    expect(payload.method).toBe('terminal/create');
    expect(payload.reason).toEqual({ code: 'path-escape', detail: 'cwd' });
    // The request itself is what was requested — the whole argv, not a
    // fragment of it, because a command line is the thing being audited.
    expect(JSON.parse(payload.requested)).toEqual({
      command: 'git',
      args: ['status'],
      cwd: '/elsewhere',
    });
  });

  it('builds a human.requested payload the schema accepts, carrying the reason code', () => {
    const gate: CommandGate = {
      level: 'worktree',
      request: { command: 'rsync', args: ['-av', '/', '/backup'], cwd: WORKTREE },
      reason: { code: 'not-allowlisted', detail: 'rsync' },
    };
    const payload = commandGatePayload(gate, NODE);

    expect(HumanRequestedSchema.safeParse(payload).success).toBe(true);
    expect(payload.reason).toEqual({ code: 'not-allowlisted', detail: 'rsync' });
    expect(payload.options.map((option) => option.effect)).toEqual(['approve', 'reject']);
  });

  it('renders the argv as data, so the command shown is the command run', () => {
    const gate: CommandGate = {
      level: 'worktree',
      request: {
        command: 'rsync',
        // The argument a shell rendering would quote, mangle or split.
        args: ['--exclude', 'a b "c"', '/', '/backup'],
        cwd: WORKTREE,
      },
      reason: { code: 'not-allowlisted', detail: 'rsync' },
    };
    const payload = commandGatePayload(gate, NODE);
    const rendered = payload.prompt.split('\n').at(-1) ?? '';

    // Byte for byte: what the operator reads parses back into the argv that
    // will be spawned, with no shell interpolation step between the two.
    expect(JSON.parse(rendered)).toEqual(gate.request);
    expect(payload.prompt).toContain('not-allowlisted:rsync');
  });
});

suite('AC1 — the event is emitted before anybody is asked', () => {
  it('emits human.requested, then waits, and never the other way round', async () => {
    const order: string[] = [];
    // The executor runs synchronously, so `release` is set before the promise
    // is handed out — no tick, no timer, nothing to race.
    const operator: { release: ((approval: CommandApproval) => void) | null } = { release: null };
    const answered = new Promise<CommandApproval>((settle) => {
      operator.release = settle;
    });

    const mediator = createCommandMediator({
      level: 'worktree',
      scope: SCOPE,
      fs: fs(),
      escalate: humanCommandGate({
        node: NODE,
        emit: (payload) => order.push(`emit:${payload.reason.code}`),
        ask: () => {
          order.push('ask');
          return answered;
        },
      }),
    });

    const pending = mediator.mediate({ command: 'rsync', args: [], cwd: null });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.waitFor(() => {
      expect(order).toEqual(['emit:not-allowlisted', 'ask']);
    });

    // The event is in the queue and the mediation is *still* outstanding: the
    // operator is being waited for, not caught up with afterwards.
    expect(settled).toBe(false);

    operator.release?.('approve');
    expect((await pending).outcome).toBe('allow');
  });
});
