/**
 * KAR-02.10 — the closed failure taxonomy, its class field, and the single
 * boundary function that turns a thrown value into a `NodeFailure`.
 *
 * Two rules from docs/04-domain-model.md §8 carry the weight here:
 * `class` is assigned where the failure is constructed (the same reason is
 * transient or permanent depending on context), and every failure survives
 * `JSON.stringify` — a thrown `Error` with a V8 stack survives neither a
 * round trip nor a daemon restart.
 *
 * Verifies: EPIC-02-S27, EPIC-02-S28 · AC1, AC2, AC3, AC4, AC5, AC6
 */
import { expect, it, describe as suite } from 'vitest';
import type { EventSeq, Handle } from './ids.ts';
import type { NodeFailure, ToNodeFailureContext } from './node-failure.ts';
import {
  FAILURE_CLASSES,
  GATE_ONLY_REASONS,
  NODE_FAILURE_REASONS,
  NodeFailureError,
  NodeFailureSchema,
  readInternalFailureCount,
  resetInternalFailureCount,
  toNodeFailure,
} from './node-failure.ts';

/**
 * AC1: the committed list. Hand-copied from docs/04-domain-model.md §8 in the
 * order the six groups appear there, so that adding a literal to the union
 * without adding it here — or the reverse — is a failing test rather than a
 * silent divergence. `packages/core/test/failure-taxonomy.test.ts` holds the
 * other half of the guard, comparing both against the document itself.
 */
const REASONS_FROM_THE_SPEC = [
  // adapter / transport
  'adapter.spawn-failed',
  'adapter.handshake-failed',
  'adapter.frame-too-large',
  'adapter.protocol-error',
  'adapter.malformed-output',
  'adapter.capability-missing',
  // agent-reported
  'agent.nonzero-exit',
  'agent.refused',
  'agent.max-turns',
  'agent.schema-repair-exhausted',
  // contract
  'contract.schema-invalid',
  'contract.handoff-oversize',
  // safety
  'safety.pin-integrity-violated',
  'safety.pathscope-violation',
  'safety.permission-unschedulable',
  'safety.execution-boundary',
  // resource
  'budget.cost-exceeded',
  'budget.wallclock-exceeded',
  'timeout',
  'provider.rate-limited',
  'provider.unavailable',
  // orchestration
  'effect.reconcile-unknown',
  'effect.request-hash-mismatch',
  'dependency.failed',
  'gate.failed',
  'internal',
] as const;

const HANDLE = `artifact://${'a'.repeat(64)}`;

function failure(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    reason: 'timeout',
    class: 'transient',
    message: 'the agent produced no frame for 900s',
    evidence: [HANDLE],
    occurredAtEvent: 42,
    attempt: 1,
    ...overrides,
  };
}

/** AC4: one fixture per reason, with a class chosen for its situation. */
const CORPUS: Record<string, unknown>[] = NODE_FAILURE_REASONS.map((reason) =>
  failure({
    reason,
    class: (GATE_ONLY_REASONS as readonly string[]).includes(reason) ? 'gate' : 'permanent',
    message: `failure: ${reason}`,
  }),
);

/**
 * An in-memory stand-in for the evidence store the daemon injects. Core is
 * pure (R1), so capturing a stack is a port, not a `writeFile` — and the test
 * can then assert on what the handle actually points at.
 */
function evidenceStore(): { blobs: Map<string, string>; capture: (text: string) => Handle } {
  const blobs = new Map<string, string>();
  const capture = (text: string): Handle => {
    const handle = `artifact://${String(blobs.size + 1).padStart(64, '0')}` as Handle;
    blobs.set(handle, text);
    return handle;
  };
  return { blobs, capture };
}

function context(store = evidenceStore()): ToNodeFailureContext {
  return {
    occurredAtEvent: 7 as EventSeq,
    attempt: 2,
    captureEvidence: store.capture,
  };
}

suite('NodeFailureReason is a closed union (AC1)', () => {
  it('is exactly the committed list, in order', () => {
    expect(NODE_FAILURE_REASONS).toEqual(REASONS_FROM_THE_SPEC);
  });

  it.each(REASONS_FROM_THE_SPEC)('%s parses', (reason) => {
    const gateOnly = (GATE_ONLY_REASONS as readonly string[]).includes(reason);
    const result = NodeFailureSchema.safeParse(
      failure({ reason, class: gateOnly ? 'gate' : 'permanent' }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects a reason that is not in the union', () => {
    expect(NodeFailureSchema.safeParse(failure({ reason: 'vibes.bad' })).success).toBe(false);
  });

  it('has no duplicates', () => {
    expect(new Set(NODE_FAILURE_REASONS).size).toBe(NODE_FAILURE_REASONS.length);
  });
});

suite('class is required and not derived from reason (AC2, EPIC-02-S28)', () => {
  it('is required', () => {
    const { class: _dropped, ...withoutClass } = failure();
    expect(NodeFailureSchema.safeParse(withoutClass).success).toBe(false);
  });

  it.each([
    ['provider.unavailable', 'transient', 'vendor returned 429 with a reset time'],
    ['provider.unavailable', 'permanent', 'the binary was uninstalled mid-run'],
    ['timeout', 'transient', 'the agent hung mid-turn, attempt 1 of 3'],
    ['timeout', 'permanent', 'the agent hung mid-turn, attempt 3 of 3'],
    ['gate.failed', 'gate', 'a deterministic gate returned fail'],
  ])('%s is %s when %s', (reason, failureClass) => {
    const parsed = NodeFailureSchema.safeParse(failure({ reason, class: failureClass }));
    expect(parsed.success).toBe(true);
  });

  it('rejects a class outside the three the scheduler understands', () => {
    expect(NodeFailureSchema.safeParse(failure({ class: 'retryable' })).success).toBe(false);
    expect(FAILURE_CLASSES).toEqual(['transient', 'permanent', 'gate']);
  });
});

suite('some reasons are schema-constrained to gate (AC5, AC6, EPIC-02-S28)', () => {
  it('lists exactly the three the architecture constrains', () => {
    expect(GATE_ONLY_REASONS).toEqual([
      'budget.cost-exceeded',
      'budget.wallclock-exceeded',
      'effect.reconcile-unknown',
    ]);
  });

  it.each([
    ['effect.reconcile-unknown', 'gate', true],
    ['effect.reconcile-unknown', 'transient', false],
    ['effect.reconcile-unknown', 'permanent', false],
    ['budget.cost-exceeded', 'gate', true],
    ['budget.cost-exceeded', 'permanent', false],
    ['budget.wallclock-exceeded', 'gate', true],
    ['budget.wallclock-exceeded', 'transient', false],
  ])('%s + %s -> ok=%s', (reason, failureClass, ok) => {
    const result = NodeFailureSchema.safeParse(failure({ reason, class: failureClass }));
    expect(result.success).toBe(ok);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(['class']);
      expect(result.error.issues[0]?.message).toContain(reason);
    }
  });
});

suite('a NodeFailure is a value on the wire (AC4)', () => {
  it.each(CORPUS.map((f) => [f.reason as string, f]))(
    '%s survives JSON.parse(JSON.stringify(…))',
    (_reason, fixture) => {
      const parsed = NodeFailureSchema.parse(fixture);
      expect(JSON.parse(JSON.stringify(parsed))).toEqual(parsed);
    },
  );

  it('refuses a stack field outright (AC3)', () => {
    expect(NodeFailureSchema.safeParse(failure({ stack: 'Error: boom\n  at …' })).success).toBe(
      false,
    );
  });

  it('refuses a multi-line message: it is rendered in a board cell', () => {
    expect(NodeFailureSchema.safeParse(failure({ message: 'boom\nat line two' })).success).toBe(
      false,
    );
  });

  it('refuses inline evidence: evidence is always a handle', () => {
    expect(NodeFailureSchema.safeParse(failure({ evidence: ['the whole stdout'] })).success).toBe(
      false,
    );
  });
});

suite('toNodeFailure is the only boundary between throw and ledger (AC3, EPIC-02-S27)', () => {
  const spawnEnoent = Object.assign(new Error('spawn claude ENOENT'), {
    name: 'SpawnFailed',
    code: 'ENOENT',
    syscall: 'spawn claude',
  });
  const spawnEagain = Object.assign(new Error('spawn claude EAGAIN'), {
    name: 'SpawnFailed',
    code: 'EAGAIN',
    syscall: 'spawn claude',
  });
  const ajv = Object.assign(new Error('data/foo must be string'), {
    name: 'AjvValidationError',
    errors: [{ instancePath: '/foo', message: 'must be string' }],
  });
  const frameTooLarge = Object.assign(new Error('frame of 8388609 bytes exceeds the 8 MiB cap'), {
    name: 'FrameTooLargeError',
    code: 'adapter.frame-too-large',
  });

  it.each([
    ['new Error("boom")', new Error('boom'), 'internal'],
    ['a bare string', 'a bare string', 'internal'],
    ['undefined', undefined, 'internal'],
    [
      'an AggregateError',
      new AggregateError([new Error('e1'), new Error('e2')], 'all failed'),
      'internal',
    ],
    ['a SpawnFailed with code ENOENT', spawnEnoent, 'adapter.spawn-failed'],
    ['an AjvValidationError', ajv, 'contract.schema-invalid'],
    ['a FrameTooLarge over 8 MiB', frameTooLarge, 'adapter.frame-too-large'],
  ])('%s -> %s', (_label, thrown, reason) => {
    const result = toNodeFailure(thrown, context());
    expect(NodeFailureSchema.safeParse(result).success).toBe(true);
    expect(result.reason).toBe(reason);
    expect(result.message).not.toContain('\n');
    expect(result.message.length).toBeGreaterThan(0);
    expect(Object.hasOwn(result, 'stack')).toBe(false);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it('carries the context it was given', () => {
    const result = toNodeFailure(new Error('boom'), context());
    expect(result.occurredAtEvent).toBe(7);
    expect(result.attempt).toBe(2);
  });

  it('classes an unmapped throw permanent, because a bug does not get better on retry', () => {
    expect(toNodeFailure(new Error('boom'), context()).class).toBe('permanent');
  });

  it('keeps the stack as evidence, not as a payload field', () => {
    const store = evidenceStore();
    const thrown = new Error('boom');
    const result = toNodeFailure(thrown, context(store));

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]).toMatch(/^artifact:\/\/[0-9a-f]{64}$/);
    const blob = store.blobs.get(result.evidence[0] as string);
    expect(blob).toContain('boom');
    expect(blob).toContain(thrown.stack ?? 'no stack');
  });

  it('captures both arms of an AggregateError as evidence', () => {
    const store = evidenceStore();
    const result = toNodeFailure(
      new AggregateError([new Error('first'), new Error('second')], 'all failed'),
      context(store),
    );
    const blob = store.blobs.get(result.evidence[0] as string) ?? '';
    expect(blob).toContain('first');
    expect(blob).toContain('second');
  });

  it('assigns the class the thrower chose, not one derived from the reason', () => {
    const rateLimited = new NodeFailureError('vendor returned 429', {
      reason: 'provider.unavailable',
      class: 'transient',
      detail: { retryAfterSeconds: 30 },
    });
    const uninstalled = new NodeFailureError('the binary went away mid-run', {
      reason: 'provider.unavailable',
      class: 'permanent',
    });

    expect(toNodeFailure(rateLimited, context()).class).toBe('transient');
    expect(toNodeFailure(uninstalled, context()).class).toBe('permanent');
    expect(toNodeFailure(rateLimited, context()).detail).toEqual({ retryAfterSeconds: 30 });
  });

  it('separates a retryable spawn failure from a permanent one under one reason', () => {
    const enoent = toNodeFailure(spawnEnoent, context());
    const eagain = toNodeFailure(spawnEagain, context());

    expect([enoent.reason, eagain.reason]).toEqual([
      'adapter.spawn-failed',
      'adapter.spawn-failed',
    ]);
    expect(enoent.class).toBe('permanent');
    expect(eagain.class).toBe('transient');
  });

  it('drops a tagged failure whose class the schema forbids rather than trusting it', () => {
    const wrong = new NodeFailureError('the probe could not tell', {
      reason: 'effect.reconcile-unknown',
      class: 'transient',
    });
    expect(toNodeFailure(wrong, context()).class).toBe('gate');
  });
});

suite("reason 'internal' is a bug, and is counted (EPIC-02-S27)", () => {
  it('counts nothing while every mapped throw is mapped', () => {
    resetInternalFailureCount();
    const mapped: unknown[] = [
      Object.assign(new Error('spawn claude ENOENT'), { name: 'SpawnFailed', code: 'ENOENT' }),
      Object.assign(new Error('bad'), { name: 'AjvValidationError', errors: [] }),
      Object.assign(new Error('too big'), { name: 'FrameTooLargeError' }),
      new NodeFailureError('agent refused', { reason: 'agent.refused', class: 'permanent' }),
    ];
    for (const thrown of mapped) toNodeFailure(thrown, context());
    expect(readInternalFailureCount()).toBe(0);
  });

  it('counts an unmapped throw so the daemon can surface it', () => {
    resetInternalFailureCount();
    toNodeFailure(new Error('boom'), context());
    toNodeFailure('and again', context());
    expect(readInternalFailureCount()).toBe(2);
  });
});

suite('NodeFailureError is the tag a thrower uses (AC2)', () => {
  it('is an Error, so it still unwinds the stack', () => {
    const error = new NodeFailureError('boom', { reason: 'agent.refused', class: 'permanent' });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('boom');
    expect(error.stack).toBeTruthy();
  });

  it('round-trips its own tag through toNodeFailure', () => {
    const error = new NodeFailureError('over the ceiling', {
      reason: 'budget.cost-exceeded',
      class: 'gate',
    });
    const result: NodeFailure = toNodeFailure(error, context());
    expect(result.reason).toBe('budget.cost-exceeded');
    expect(result.class).toBe('gate');
  });
});
