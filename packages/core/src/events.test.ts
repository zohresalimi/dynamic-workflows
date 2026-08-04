/**
 * KAR-02.7 — the envelope, `parseEvent`, and the two payload shapes that
 * carry a design decision rather than a list of fields.
 *
 * Verifies: EPIC-02-S19, EPIC-02-S23 · AC1, AC3, AC6, AC7
 */
import { expect, it, describe as suite } from 'vitest';
import { ContextCompactedSchema } from './event-payloads.ts';
import { EventEnvelopeSchema, parseEvent } from './events.ts';

const RUN_ID = 'run_20260802T141133Z_9f2a1c';

const envelope = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  seq: 9001,
  runId: RUN_ID,
  ts: 1,
  kind: 'run.stalled',
  v: 1,
  epoch: 3,
  payload: { watermarkSeq: 8000, idleMs: 900_000, runningNodes: ['recon-auth-surface'] },
  ...overrides,
});

/** Runs `body` with `console.error` captured, so "does not log at error
 * level" (EPIC-02-S19) is an assertion rather than a claim. */
function withCapturedConsoleError<T>(body: () => T): { value: T; errors: unknown[][] } {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]): void => {
    errors.push(args);
  };
  try {
    return { value: body(), errors };
  } finally {
    console.error = original;
  }
}

suite('an unknown kind is reported, not thrown (AC1, EPIC-02-S19)', () => {
  it('returns unknown-kind carrying the kind and the seq', () => {
    const captured = withCapturedConsoleError(() =>
      parseEvent(envelope({ kind: 'future.thing', payload: { anything: true } })),
    );

    expect(captured.value).toEqual({
      status: 'unknown-kind',
      kind: 'future.thing',
      seq: 9001,
    });
    expect(captured.errors).toEqual([]);
  });

  it('does not throw, whatever the payload of the unknown kind is', () => {
    for (const payload of [undefined, null, 42, 'text', [], { nested: { deep: true } }]) {
      expect(() => parseEvent(envelope({ kind: 'future.thing', payload }))).not.toThrow();
    }
  });
});

suite('a known kind at a future version is not guessed at (AC3, EPIC-02-S19)', () => {
  it('returns future-version naming the arriving and the current version', () => {
    const result = parseEvent(
      envelope({ kind: 'node.completed', v: 4, seq: 12, payload: { totally: 'unparseable' } }),
    );

    expect(result).toEqual({
      status: 'future-version',
      kind: 'node.completed',
      v: 4,
      current: 1,
      seq: 12,
    });
  });

  it('does not parse the payload, so an unreadable future payload is still skipped', () => {
    // If the payload were parsed, this would come back invalid-payload — and a
    // downgraded daemon would report a corrupt ledger rather than a newer one.
    const result = parseEvent(envelope({ kind: 'run.stalled', v: 99, payload: null }));

    expect(result).toMatchObject({ status: 'future-version', v: 99 });
  });
});

suite('a known kind at a known version parses (EPIC-02-S19)', () => {
  it('returns ok with the envelope and the typed payload', () => {
    const result = parseEvent(envelope());

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    expect(result.event.kind).toBe('run.stalled');
    expect(result.event.seq).toBe(9001);
    expect(result.event.epoch).toBe(3);
    expect(result.event.payload).toEqual({
      watermarkSeq: 8000,
      idleMs: 900_000,
      runningNodes: ['recon-auth-surface'],
    });
  });

  it('reports a malformed payload of a known kind as invalid-payload, naming the field', () => {
    const result = parseEvent(envelope({ payload: { watermarkSeq: 8000, idleMs: 'a while' } }));

    expect(result.status).toBe('invalid-payload');
    if (result.status !== 'invalid-payload') throw new Error('unreachable');
    expect(result.kind).toBe('run.stalled');
    expect(result.issues.join(' ')).toContain('idleMs');
  });
});

suite('the envelope (AC7)', () => {
  it('requires epoch on every event', () => {
    const { epoch: _dropped, ...withoutEpoch } = envelope();

    const result = parseEvent(withoutEpoch);

    expect(result.status).toBe('invalid-envelope');
    if (result.status !== 'invalid-envelope') throw new Error('unreachable');
    expect(result.issues.join(' ')).toContain('epoch');
  });

  it('rejects an unknown envelope field rather than dropping it', () => {
    expect(EventEnvelopeSchema.safeParse(envelope({ surprise: true })).success).toBe(false);
  });

  it('accepts the optional nodeId, attempt and ikey', () => {
    const parsed = EventEnvelopeSchema.safeParse(
      envelope({
        nodeId: 'recon-auth-surface',
        attempt: 2,
        ikey: `${RUN_ID}/recon-auth-surface/2/0`,
      }),
    );

    expect(parsed.success, JSON.stringify(parsed, null, 2)).toBe(true);
  });

  it('rejects a malformed ikey rather than branding it', () => {
    expect(EventEnvelopeSchema.safeParse(envelope({ ikey: 'not-a-key' })).success).toBe(false);
  });

  it('rejects a non-integer seq — order is seq, and a float has no successor', () => {
    expect(EventEnvelopeSchema.safeParse(envelope({ seq: 1.5 })).success).toBe(false);
  });
});

suite('context.compacted cannot fabricate an "after" (AC6, EPIC-02-S23)', () => {
  const pinned = `sha256-${'a'.repeat(64)}`;
  const handle = `artifact://${'b'.repeat(64)}`;

  const exact = {
    node: 'recon-auth-surface',
    scope: 'DeFlow.packet',
    fidelity: 'exact',
    trigger: 'threshold',
    before: 148_000,
    after: 60_000,
    droppedSegments: ['seg-history'],
    demotedToHandles: [handle],
    pinnedKept: [pinned],
    originalHandle: handle,
  };

  const partial = {
    node: 'recon-auth-surface',
    scope: 'vendor.session',
    fidelity: 'partial',
    trigger: 'vendor.auto',
    before: 148_000,
    after: null,
    droppedSegments: [],
    demotedToHandles: [],
    pinnedKept: [pinned],
    originalHandle: null,
  };

  it("accepts DeFlow's own exact compaction, numbers and all", () => {
    const parsed = ContextCompactedSchema.safeParse(exact);
    expect(parsed.success, JSON.stringify(parsed, null, 2)).toBe(true);
  });

  it('accepts the vendor-reported partial shape Claude Code actually emits', () => {
    const parsed = ContextCompactedSchema.safeParse(partial);
    expect(parsed.success, JSON.stringify(parsed, null, 2)).toBe(true);
  });

  it('rejects partial + a fabricated after, naming "after"', () => {
    const parsed = ContextCompactedSchema.safeParse({ ...partial, after: 60_000 });

    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('unreachable');
    expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toContain('after');
  });

  it('rejects partial + a droppedSegments list, naming "droppedSegments"', () => {
    const parsed = ContextCompactedSchema.safeParse({ ...partial, droppedSegments: ['seg-1'] });

    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('unreachable');
    expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toContain('droppedSegments');
  });

  it('rejects partial + a handle to the original, which the vendor never gives us', () => {
    const parsed = ContextCompactedSchema.safeParse({ ...partial, originalHandle: handle });

    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('unreachable');
    expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toContain('originalHandle');
  });

  it('rejects exact + a null after — an exact compaction knows its own numbers', () => {
    const parsed = ContextCompactedSchema.safeParse({ ...exact, after: null });

    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('unreachable');
    expect(parsed.error.issues.map((issue) => issue.path.join('.'))).toContain('after');
  });
});
