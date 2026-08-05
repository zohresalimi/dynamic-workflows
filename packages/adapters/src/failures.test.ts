/**
 * KAR-05.1 AC7 — the adapter's single exit from "something threw" to "the
 * ledger has a value".
 *
 * `@DeFlow/core`'s `toNodeFailure` is the mapper; this module is the adapter's
 * vocabulary on top of it — the tagged throws the ACP client raises, so that
 * every one of them arrives at the mapper already carrying the `reason` and the
 * `class` only the raising code could know (docs/04-domain-model.md §8).
 *
 * Verifies: EPIC-05-S2 (failure half) · AC1, AC7 · test plan #7
 */
import { NODE_FAILURE_REASONS } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import {
  ACP_PROTOCOL_VERSION,
  handshakeMismatch,
  spawnRefused,
  toAdapterFailure,
} from './failures.ts';

/** A capture port that keeps what it was given, the way the daemon's blob
 * store would, so a spec can read the evidence back rather than trust it. */
function evidenceStore(): {
  capture: (text: string) => `artifact://${string}`;
  read: (handle: string) => string | undefined;
} {
  const stored = new Map<string, string>();
  let next = 0;
  return {
    capture: (text) => {
      next += 1;
      const handle = `artifact://${next.toString(16).padStart(64, '0')}` as const;
      stored.set(handle, text);
      return handle;
    },
    read: (handle) => stored.get(handle),
  };
}

const context = (evidence: ReturnType<typeof evidenceStore>) => ({
  occurredAtEvent: 12 as never,
  attempt: 0,
  captureEvidence: evidence.capture as never,
});

suite('an unmapped throw (test plan #7)', () => {
  it('becomes reason "internal" with the stack captured as a handle', () => {
    const evidence = evidenceStore();
    const failure = toAdapterFailure(new TypeError('cannot read properties of undefined'), {
      ...context(evidence),
    });

    expect(failure.reason).toBe('internal');
    expect(failure.class).toBe('permanent');
    expect(failure.message).toBe('cannot read properties of undefined');
    expect(failure.evidence).toHaveLength(1);
    // The stack goes to the blob, never into the payload: a V8 stack in a
    // `message` is what §8 exists to keep out of the ledger.
    expect(evidence.read(failure.evidence[0] as string)).toContain('failures.test.ts');
    expect(failure.message).not.toContain('\n');
  });

  it('survives a thrown non-Error without inventing a message', () => {
    const evidence = evidenceStore();
    const failure = toAdapterFailure({ nope: true }, context(evidence));

    expect(failure.reason).toBe('internal');
    expect(failure.message).toContain('non-Error');
    expect(evidence.read(failure.evidence[0] as string)).toContain('nope');
  });
});

suite('the handshake mismatch (AC1)', () => {
  it('is permanent, and names the offered and the expected version', () => {
    const evidence = evidenceStore();
    const failure = toAdapterFailure(handshakeMismatch(2), context(evidence));

    expect(failure.reason).toBe('adapter.handshake-failed');
    expect(failure.class).toBe('permanent');
    expect(failure.detail).toEqual({ offered: 2, expected: ACP_PROTOCOL_VERSION });
    expect(failure.message).toContain('2');
    expect(failure.message).toContain(`${ACP_PROTOCOL_VERSION}`);
  });

  it('keeps a date-shaped version intact in the detail, rather than coercing it', () => {
    // MCP's protocol version is a date string and ACP's is an integer. An
    // agent that answers with one is a bug worth reading in the ledger
    // verbatim, so the value is recorded as it arrived.
    const evidence = evidenceStore();
    const failure = toAdapterFailure(handshakeMismatch('2025-11-25'), context(evidence));

    expect(failure.detail).toEqual({ offered: '2025-11-25', expected: ACP_PROTOCOL_VERSION });
    expect(failure.reason).toBe('adapter.handshake-failed');
  });

  it('rejects the integer 0 as loudly as it rejects 2', () => {
    const evidence = evidenceStore();
    expect(toAdapterFailure(handshakeMismatch(0), context(evidence)).reason).toBe(
      'adapter.handshake-failed',
    );
  });
});

suite('a spawn that never started', () => {
  it('carries the errno through, so the class is decided from it and not from the reason', () => {
    const evidence = evidenceStore();
    const enoent = Object.assign(new Error('spawn /nope ENOENT'), {
      code: 'ENOENT',
      syscall: 'spawn /nope',
    });
    const failure = toAdapterFailure(spawnRefused('/nope', enoent), context(evidence));

    expect(failure.reason).toBe('adapter.spawn-failed');
    expect(failure.class).toBe('permanent');
  });

  it('is transient when the machine, not the binary, was the problem', () => {
    const evidence = evidenceStore();
    const emfile = Object.assign(new Error('spawn EMFILE'), {
      code: 'EMFILE',
      syscall: 'spawn',
    });
    expect(toAdapterFailure(spawnRefused('/bin/true', emfile), context(evidence)).class).toBe(
      'transient',
    );
  });
});

suite('every reason the adapter raises is in the closed taxonomy', () => {
  it('names only reasons @DeFlow/core declares', () => {
    const evidence = evidenceStore();
    const raised = [
      handshakeMismatch(2),
      spawnRefused('/nope', new Error('boom')),
      new Error('unmapped'),
    ];
    for (const thrown of raised) {
      expect(NODE_FAILURE_REASONS).toContain(toAdapterFailure(thrown, context(evidence)).reason);
    }
  });
});
