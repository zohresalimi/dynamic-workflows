/**
 * KAR-13.4 tests 1, 2 and 3 — the escalate/auto split, the payload, and the
 * run scope of `_always`.
 *
 * Written before ./permission-escalation.ts existed. The three questions the
 * story turns on are all answerable without a filesystem, a process or a
 * ledger, and each of them is a place a plausible implementation is wrong in a
 * way no integration test would name:
 *
 * 1. *which* requests reach the operator — everything escalating and nothing
 *    escalating both pass a test that only counts events;
 * 2. *what* the request carries — a payload that is a sentence renders and
 *    tests identically to one that is six fields, right up until somebody has
 *    to decide in five seconds;
 * 3. *how long* an `_always` lasts — a decision that outlives its run is the
 *    Kiro incident's ambient authority with a nicer name, and the only way to
 *    see it is to look at a second run's state.
 *
 * Verifies: EPIC-13-S22, EPIC-13-S23, EPIC-13-S24 · AC2, AC3, AC4
 */
import { expect, it, describe as suite } from 'vitest';
import { HumanRequestedSchema, PermissionContextSchema } from './event-payloads.ts';
import type { Event } from './events.ts';
import { planHumanResponse } from './human-gate.ts';
import type { NodeId } from './ids.ts';
import { NodeIdSchema } from './ids.ts';
import type { PermissionRequest, PermissionScope } from './permission.ts';
import {
  ESCALATION_DEFAULT_OPTION_ID,
  type EscalationDecision,
  escalationDecision,
  PERMISSION_ESCALATION_OPTIONS,
  type PermissionEscalationRequest,
  permissionAutoAnswer,
  permissionEscalationPayload,
  permissionSignature,
  runPermissionPolicy,
} from './permission-escalation.ts';
import type { PermissionLevel } from './plan-graph.ts';
import { reduce } from './reduce.ts';
import { initialRunState, type RunState } from './run-state.ts';

const NODE: NodeId = NodeIdSchema.parse('n-impl-3');
const WORKTREE = '/tmp/deflow/wt/r1__n-impl-3';

const SCOPE: PermissionScope = {
  worktree: WORKTREE,
  allowlist: ['git', 'pnpm', 'node'],
  readOnlyCommands: ['git status', 'ls'],
  allowedDomains: ['registry.npmjs.org'],
  scrubbedEnv: [],
};

/* -------------------------------------------------------------------------- *
 * test 1 — the escalate/auto decision, table-driven (EPIC-13-S22)
 * -------------------------------------------------------------------------- */

suite('EPIC-13-S22 — the ladder decides, per method and level (test 1)', () => {
  const rows: {
    readonly level: PermissionLevel;
    readonly request: PermissionRequest;
    readonly decision: EscalationDecision;
  }[] = [
    {
      level: 'read',
      request: { method: 'fs/write_text_file', path: `${WORKTREE}/src/a.ts` },
      decision: 'reject',
    },
    {
      level: 'read',
      request: { method: 'terminal/create', command: 'pnpm', args: ['test'] },
      decision: 'reject',
    },
    {
      level: 'worktree',
      request: { method: 'fs/write_text_file', path: `${WORKTREE}/src/a.ts` },
      decision: 'allow',
    },
    {
      level: 'worktree',
      request: { method: 'fs/write_text_file', path: '/tmp/outside/the/worktree' },
      decision: 'reject',
    },
    {
      level: 'worktree',
      request: { method: 'terminal/create', command: 'pnpm', args: ['test'] },
      decision: 'allow',
    },
    {
      level: 'worktree',
      request: { method: 'terminal/create', command: 'curl', args: ['https://example.com'] },
      decision: 'escalate',
    },
    {
      level: 'worktree+net',
      request: { method: 'terminal/create', command: 'pnpm', args: ['install'] },
      decision: 'allow',
    },
    {
      level: 'full',
      request: {
        method: 'terminal/create',
        command: 'kubectl',
        args: ['delete', 'ns', 'staging'],
      },
      decision: 'escalate',
    },
  ];

  for (const row of rows) {
    const target =
      row.request.method === 'terminal/create'
        ? `${row.request.command} ${(row.request.args ?? []).join(' ')}`
        : row.request.method === 'network'
          ? row.request.url
          : row.request.path;

    it(`${row.level} · ${row.request.method} · ${target} → ${row.decision}`, () => {
      expect(escalationDecision(row.level, row.request, SCOPE).decision).toBe(row.decision);
    });
  }

  it('names the rule that matched on every answer that is not a plain allow', () => {
    const egress = escalationDecision(
      'worktree',
      { method: 'terminal/create', command: 'curl', args: ['https://example.com'] },
      SCOPE,
    );
    expect(egress.reason).toEqual({ code: 'level-no-network' });

    const destructive = escalationDecision(
      'full',
      { method: 'terminal/create', command: 'kubectl', args: ['delete', 'ns', 'staging'] },
      SCOPE,
    );
    expect(destructive.reason?.code).toBe('destructive-command');
    expect(destructive.reason?.detail).toBe('kubectl-delete');
  });

  it('a path escape is refused rather than negotiated, at every level', () => {
    // The one category AC2 lists that is deliberately *not* escalated: an
    // operator who can approve a write into /etc is an operator who will.
    for (const level of ['worktree', 'worktree+net', 'full'] as const) {
      const answer = escalationDecision(
        level,
        { method: 'fs/write_text_file', path: '/etc/passwd' },
        SCOPE,
      );
      expect(answer.decision).toBe('reject');
      expect(answer.reason?.code).toBe('path-escape');
    }
  });

  it('offers the four PermissionOptionKind values, and defaults to reject_once', () => {
    expect(PERMISSION_ESCALATION_OPTIONS.map((option) => option.id)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
      'reject_always',
    ]);
    expect(PERMISSION_ESCALATION_OPTIONS.map((option) => option.effect)).toEqual([
      'approve',
      'approve',
      'reject',
      'reject',
    ]);
    expect(ESCALATION_DEFAULT_OPTION_ID).toBe('reject_once');
  });
});

/* -------------------------------------------------------------------------- *
 * test 2 — the escalation payload (EPIC-13-S23)
 * -------------------------------------------------------------------------- */

const EGRESS = {
  node: NODE,
  level: 'worktree',
  cwd: WORKTREE,
  request: {
    method: 'terminal/create',
    command: 'curl',
    args: ['-sS', 'https://registry.example.com/token'],
    cwd: WORKTREE,
  },
  reason: { code: 'level-no-network' },
  pathScopes: ['packages/ui/src/**'],
  brief: 'Migrate the toast component to the new design system',
  enforcement: 'sandbox-runtime',
  sessionId: 'sess_7c1',
} as const;

suite('EPIC-13-S23 — an escalation carries enough to decide in five seconds (test 2)', () => {
  it('carries the command, args, cwd, matched rule, level and pathScopes as fields', () => {
    const payload = permissionEscalationPayload(EGRESS);

    expect(payload.node).toBe(NODE);
    expect(payload.reason).toEqual({ code: 'level-no-network' });
    expect(payload.permission).toEqual({
      method: 'terminal/create',
      command: 'curl',
      args: ['-sS', 'https://registry.example.com/token'],
      cwd: WORKTREE,
      rule: 'level-no-network',
      level: 'worktree',
      pathScopes: ['packages/ui/src/**'],
      enforcement: 'sandbox-runtime',
      sessionId: 'sess_7c1',
    });
    // The schema the queue reads it back through has to accept it verbatim.
    expect(PermissionContextSchema.safeParse(payload.permission).success).toBe(true);
  });

  it('offers all four option kinds', () => {
    expect(permissionEscalationPayload(EGRESS).options.map((option) => option.id)).toEqual([
      'allow_once',
      'allow_always',
      'reject_once',
      'reject_always',
    ]);
  });

  it('shows the resolved path as well as the requested one', () => {
    const payload = permissionEscalationPayload({
      node: NODE,
      level: 'worktree',
      request: { method: 'fs/write_text_file', path: './tmp/x' },
      cwd: WORKTREE,
      resolved: '/etc/x',
      reason: { code: 'path-escape', detail: 'symlink' },
    });

    expect(payload.permission?.requested).toBe('./tmp/x');
    expect(payload.permission?.resolved).toBe('/etc/x');
    expect(payload.permission?.rule).toBe('path-escape:symlink');
  });

  it('carries the node brief and the argv in the prompt, so the row reads on its own', () => {
    const prompt = permissionEscalationPayload(EGRESS).prompt;

    expect(prompt).toContain('curl');
    expect(prompt).toContain('https://registry.example.com/token');
    expect(prompt).toContain(EGRESS.brief);
    // The argv is JSON on its own line: what is shown is what would run, with
    // nothing re-quoted between here and spawn.
    expect(prompt).toContain('["-sS","https://registry.example.com/token"]');
  });

  it('inherits a declared deadline, and declares none when the node has none', () => {
    const deadline = {
      wakeAt: '2026-08-10T10:00:00.000Z',
      onTimeout: 'default',
      default: 'reject_once',
    } as const;
    expect(permissionEscalationPayload({ ...EGRESS, deadline }).deadline).toEqual(deadline);
    expect(permissionEscalationPayload(EGRESS).deadline).toBeUndefined();
  });

  it('does not invent the other method’s fields', () => {
    const write = permissionEscalationPayload({
      node: NODE,
      level: 'worktree',
      request: { method: 'fs/write_text_file', path: `${WORKTREE}/x` },
      cwd: WORKTREE,
      reason: { code: 'scope-violation', detail: 'x' },
    });
    expect(write.permission?.command).toBeUndefined();
    expect(write.permission?.args).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- *
 * test 3 — `_always` is run-scoped (EPIC-13-S24)
 * -------------------------------------------------------------------------- */

const CONTEXT = permissionEscalationPayload(EGRESS).permission;

/** The two events answering an escalation appends, folded into a `RunState`. */
function answered(optionId: string): RunState {
  const request = {
    seq: 1,
    runId: 'run_20260810T090000Z_b71c04',
    ts: 1,
    kind: 'human.requested',
    v: 5,
    epoch: 1,
    nodeId: NODE,
    attempt: 0,
    payload: permissionEscalationPayload(EGRESS),
  } as unknown as Event;
  const response = {
    seq: 2,
    runId: 'run_20260810T090000Z_b71c04',
    ts: 2,
    kind: 'human.responded',
    v: 2,
    epoch: 1,
    nodeId: NODE,
    attempt: 0,
    payload: { node: NODE, optionId, at: '2026-08-10T09:00:02.000Z', by: 'operator' },
  } as unknown as Event;

  return [request, response].reduce(reduce, initialRunState());
}

suite('EPIC-13-S24 — the four kinds, and the run scope of _always (test 3)', () => {
  it('records allow_always as run-scoped policy, and auto-allows the next match', () => {
    const state = answered('allow_always');
    expect(runPermissionPolicy(state).size).toBe(1);
    expect(permissionAutoAnswer(state, CONTEXT!)).toBe('allow');
  });

  it('records reject_always the same way, with the opposite polarity', () => {
    expect(permissionAutoAnswer(answered('reject_always'), CONTEXT!)).toBe('reject');
  });

  it('leaves nothing behind for allow_once or reject_once: the next match asks again', () => {
    for (const optionId of ['allow_once', 'reject_once']) {
      const state = answered(optionId);
      expect(runPermissionPolicy(state).size).toBe(0);
      expect(permissionAutoAnswer(state, CONTEXT!)).toBeNull();
    }
  });

  it('is absent from a second run’s state: nothing survives the run', () => {
    // A `RunState` is folded per run, so an `_always` chosen in r1 is not in
    // r2's projection at all — which is the property, not a consequence of it.
    expect(runPermissionPolicy(initialRunState()).size).toBe(0);
    expect(permissionAutoAnswer(initialRunState(), CONTEXT!)).toBeNull();
  });

  it('matches narrowly: the same command against a different host asks again', () => {
    const state = answered('allow_always');
    const otherHost = permissionEscalationPayload({
      ...EGRESS,
      request: { ...EGRESS.request, args: ['-sS', 'https://elsewhere.example.com/token'] },
    }).permission;

    expect(permissionSignature(otherHost!)).not.toBe(permissionSignature(CONTEXT!));
    expect(permissionAutoAnswer(state, otherHost!)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- *
 * answering an escalation decides the request, never the node
 * -------------------------------------------------------------------------- */

suite('an escalation is answered without completing or failing the node', () => {
  it('appends human.responded and nothing else', () => {
    const state = [
      {
        seq: 1,
        runId: 'run_20260810T090000Z_b71c04',
        ts: 1,
        kind: 'human.requested',
        v: 5,
        epoch: 1,
        nodeId: NODE,
        attempt: 0,
        payload: permissionEscalationPayload(EGRESS),
      },
    ].reduce((state, event) => reduce(state, event as unknown as Event), initialRunState());

    const planned = planHumanResponse(state, {
      node: NODE,
      optionId: 'reject_once',
      by: 'policy',
      at: 2,
    });

    expect(planned.status).toBe('ok');
    if (planned.status !== 'ok') return;
    // The node is an *agent* node that is still running: its result comes from
    // the agent, and a terminal event here would end a turn that has not ended.
    expect(planned.events.map((event) => event.kind)).toEqual(['human.responded']);
    expect(planned.effect).toBe('reject');
  });

  it('still completes or fails an ordinary human node', () => {
    const state = [
      {
        seq: 1,
        runId: 'run_20260810T090000Z_b71c04',
        ts: 1,
        kind: 'human.requested',
        v: 5,
        epoch: 1,
        nodeId: NODE,
        attempt: 0,
        payload: {
          node: NODE,
          prompt: 'Extend the migration scope?',
          options: [{ id: 'yes', label: 'Yes', effect: 'approve' }],
        },
      },
    ].reduce((state, event) => reduce(state, event as unknown as Event), initialRunState());

    const planned = planHumanResponse(state, { node: NODE, optionId: 'yes', at: 2 });
    expect(planned.status).toBe('ok');
    if (planned.status !== 'ok') return;
    expect(planned.events.map((event) => event.kind)).toEqual([
      'human.responded',
      'node.completed',
    ]);
  });
});

/* -------------------------------------------------------------------------- *
 * the payload has to survive its own replay
 * -------------------------------------------------------------------------- */

suite('every escalation payload is one `parseEvent` accepts', () => {
  // The failure this guards is silent and total: `foldEvents` runs every row
  // through `parseEvent`, so a `human.requested` the schema rejects is written
  // to the ledger, dropped from the projection, never queued and never
  // answerable — the agent waits for ever and nothing anywhere reports an
  // error. It is worth a table.
  const shapes: readonly PermissionEscalationRequest[] = [
    EGRESS,
    {
      node: NODE,
      level: 'worktree',
      cwd: WORKTREE,
      request: { method: 'network', url: 'https://evil.example/payload' },
      reason: { code: 'level-no-network' },
    },
    {
      node: NODE,
      level: 'worktree',
      cwd: WORKTREE,
      request: { method: 'fs/write_text_file', path: './tmp/x' },
      resolved: '/etc/x',
      reason: { code: 'path-escape', detail: 'symlink' },
    },
    {
      node: NODE,
      level: 'read',
      cwd: WORKTREE,
      request: { method: 'fs/read_text_file', path: `${WORKTREE}/src/a.ts` },
      reason: { code: 'level-read' },
    },
  ];

  for (const shape of shapes) {
    it(`${shape.request.method} · ${shape.reason.code}`, () => {
      const parsed = HumanRequestedSchema.safeParse(permissionEscalationPayload(shape));
      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(parsed.success).toBe(true);
    });
  }
});
