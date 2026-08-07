/**
 * KAR-10.1 test plan #1 — `normaliseInput` is total, pure and byte-preserving.
 *
 * Verifies: KAR-10.1 test plan #1 · AC2, AC3
 */
import { expect, it, describe as suite } from 'vitest';
import { sha256HexBytes } from './hash.ts';
import type { Handle } from './ids.ts';
import {
  INTAKE_INLINE_THRESHOLD_BYTES,
  type NormaliseInputPorts,
  normaliseInput,
  TaskSubmittedSchema,
} from './task-intake.ts';

const NOW = 1_754_470_000_000;

function ports(overrides: Partial<NormaliseInputPorts> = {}): NormaliseInputPorts {
  return {
    now: NOW,
    by: 'ui',
    store: () => {
      throw new Error('store must not be called for an inline-sized source');
    },
    ...overrides,
  };
}

suite('normaliseInput — text', () => {
  it('returns a payload whose raw is byte-identical to the input and whose sha256 matches', async () => {
    const text = 'Migrate the design system across packages/ui';
    const payload = await normaliseInput({ kind: 'text', text }, ports());

    expect(payload.raw).toBe(text);
    expect(payload.handle).toBeUndefined();
    expect(payload.sha256).toBe(await sha256HexBytes(new TextEncoder().encode(text)));
    expect(payload.provenance).toEqual({ kind: 'text', by: 'ui', submittedAt: NOW });
  });

  it('preserves CRLF, a trailing space, a tab-indented block, an emoji and a literal ```', async () => {
    const text = 'line one\r\nline two \r\n\tindented\r\nemoji: 🎉\r\nfence: ```\r\n';
    const payload = await normaliseInput({ kind: 'text', text }, ports());
    expect(payload.raw).toBe(text);
  });

  it('records by: "cli" when the CLI submitted it (AC7)', async () => {
    const payload = await normaliseInput({ kind: 'text', text: 'x' }, ports({ by: 'cli' }));
    expect(payload.provenance).toMatchObject({ by: 'cli' });
  });

  it('validates against TaskSubmittedSchema', async () => {
    const payload = await normaliseInput({ kind: 'text', text: 'x' }, ports());
    expect(() => TaskSubmittedSchema.parse(payload)).not.toThrow();
  });
});

suite('normaliseInput — file', () => {
  it('inlines a small file and carries its provenance', async () => {
    const bytes = new TextEncoder().encode('# spec\n\nDo the thing.\n');
    const payload = await normaliseInput(
      { kind: 'file', bytes, resolvedPath: '/repo/docs/spec.md', mediaType: 'text/markdown' },
      ports(),
    );

    expect(payload.raw).toBe('# spec\n\nDo the thing.\n');
    expect(payload.handle).toBeUndefined();
    expect(payload.sha256).toBe(await sha256HexBytes(bytes));
    expect(payload.provenance).toEqual({
      kind: 'file',
      by: 'ui',
      submittedAt: NOW,
      resolvedPath: '/repo/docs/spec.md',
      bytes: bytes.byteLength,
      mediaType: 'text/markdown',
    });
  });

  it('stores a file over the inline threshold and carries a handle instead of raw', async () => {
    const bytes = new TextEncoder().encode('x'.repeat(INTAKE_INLINE_THRESHOLD_BYTES + 1));
    const handle = 'artifact://' + 'a'.repeat(64);
    const captured: { bytes: Uint8Array; mediaType: string }[] = [];

    const payload = await normaliseInput(
      { kind: 'file', bytes, resolvedPath: '/repo/docs/big.md', mediaType: 'text/markdown' },
      ports({
        store: (b, mediaType) => {
          captured.push({ bytes: b, mediaType });
          return handle as Handle;
        },
      }),
    );

    expect(payload.raw).toBeUndefined();
    expect(payload.handle).toBe(handle);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.bytes.byteLength).toBe(bytes.byteLength);
    expect(captured[0]?.mediaType).toBe('text/markdown');
  });

  it('inlines a file exactly at the threshold', async () => {
    const bytes = new TextEncoder().encode('x'.repeat(INTAKE_INLINE_THRESHOLD_BYTES));
    const payload = await normaliseInput(
      { kind: 'file', bytes, resolvedPath: '/repo/f.md', mediaType: 'text/markdown' },
      ports(),
    );
    expect(payload.raw).toBeDefined();
    expect(payload.handle).toBeUndefined();
  });
});

suite('normaliseInput — issue', () => {
  it('carries the resolver, URL, httpStatus and fetchedAt', async () => {
    const raw = JSON.stringify({ title: 'Flaky checkout test', number: 412 });
    const payload = await normaliseInput(
      {
        kind: 'issue',
        raw,
        url: 'https://github.com/acme/web/issues/412',
        resolver: 'gh',
        httpStatus: 200,
      },
      ports(),
    );

    expect(payload.raw).toBe(raw);
    expect(payload.provenance).toEqual({
      kind: 'issue',
      by: 'ui',
      submittedAt: NOW,
      url: 'https://github.com/acme/web/issues/412',
      resolver: 'gh',
      httpStatus: 200,
      fetchedAt: NOW,
    });
  });
});

suite('TaskSubmittedSchema', () => {
  it('rejects a payload carrying both raw and handle', () => {
    const result = TaskSubmittedSchema.safeParse({
      sha256: 'a'.repeat(64),
      raw: 'x',
      handle: `artifact://${'a'.repeat(64)}`,
      provenance: { kind: 'text', by: 'ui', submittedAt: NOW },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a payload carrying neither raw nor handle', () => {
    const result = TaskSubmittedSchema.safeParse({
      sha256: 'a'.repeat(64),
      provenance: { kind: 'text', by: 'ui', submittedAt: NOW },
    });
    expect(result.success).toBe(false);
  });
});
