/**
 * The rules about this layer that only a guard can hold, because each of them
 * fails silently at runtime.
 *
 * Flowing mode still delivers every byte — it just buffers the stream in RAM
 * while you await SQLite, and the daemon OOMs on someone else's machine three
 * hours into a run. A shared ACP/MCP version helper type-checks — ACP's
 * `protocolVersion` is an integer and MCP's is a date string, and the day one
 * of them moves the other silently stops negotiating. A `throw new Error` in
 * adapter code produces a perfectly readable stack — which does not survive
 * `JSON.stringify`, a daemon restart, or the node inspector.
 *
 * Verifies: EPIC-05-S2 (scenario 3), EPIC-05-S3 (scenario 3) · AC7
 */
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

async function sources(): Promise<{ path: string; text: string }[]> {
  const entries = await readdir(SRC, { recursive: true, withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'),
    )
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { path, text: readFileSync(path, 'utf8') };
    });
}

/** Comments say `.on('data'` a lot in this package; code must not. */
function codeOnly(text: string): string {
  return text
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
    .join('\n');
}

suite('flowing mode is not reachable (EPIC-05-S3 scenario 3)', () => {
  it('no source subscribes to a child stream\'s "data" event', async () => {
    const offenders = (await sources())
      .filter((file) => /\.on\(\s*['"]data['"]/.test(codeOnly(file.text)))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('the transport pulls, one chunk at a time, with no buffer of its own', async () => {
    const files = await sources();
    // `codeOnly`, not the raw text: several files in this package *discuss*
    // `ndJsonStream` in their module docs — the frame guard's whole reason to
    // exist is that it sits upstream of it — and only the file that calls it is
    // the transport.
    const transport = files.filter((file) => codeOnly(file.text).includes('ndJsonStream('));
    expect(transport).toHaveLength(1);
    for (const file of transport) {
      // A web ReadableStream whose `pull` reads the paused child stream, with
      // `highWaterMark: 0` so the stream never tops up a buffer of its own.
      expect(file.text).toContain('new ReadableStream');
      expect(file.text).toContain('highWaterMark: 0');
      expect(codeOnly(file.text)).toContain('stdout.read()');
    }
  });
});

suite('ACP and MCP version negotiation are not shared (EPIC-05-S2 scenario 3)', () => {
  it('nothing in this package compares a protocol version against a date-shaped string', async () => {
    const offenders = (await sources())
      .filter((file) => /protocolVersion[^\n]*\d{4}-\d{2}-\d{2}/.test(codeOnly(file.text)))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('the ACP version is the integer the SDK exports, never a literal of our own', async () => {
    const files = await sources();
    const declaring = files.filter((file) => file.text.includes('ACP_PROTOCOL_VERSION ='));
    expect(declaring).toHaveLength(1);
    expect(declaring[0]?.text).toContain('acp.PROTOCOL_VERSION');
  });
});

suite('failures are values, not thrown Errors (AC7)', () => {
  it('no adapter source constructs a bare Error as its failure surface', async () => {
    const offenders = (await sources())
      .filter((file) => /throw new (Error|TypeError|RangeError)\(/.test(codeOnly(file.text)))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it('every throw in this package carries a failure tag', async () => {
    const files = await sources();
    const throwing = files.filter((file) => /\bthrow\b/.test(codeOnly(file.text)));
    for (const file of throwing) {
      // `failures.ts` is where the tagged errors are constructed; everywhere
      // else throws one of its factories.
      expect(file.text).toMatch(/NodeFailureError|failures\.ts/);
    }
  });
});
