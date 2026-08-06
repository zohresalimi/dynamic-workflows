/**
 * EPIC-05-S18 — `terminal/output` is ring-buffered, per terminal, and honest
 * about it.
 *
 * The ACP `terminal/*` methods let an agent poll a long-running command, and a
 * `yarn build` with a progress bar emits tens of megabytes. Three properties
 * follow, and each is here because the obvious implementation gets it wrong:
 *
 * - the buffer is capped on the way **in**, not trimmed on the way out, or the
 *   daemon has already held the whole 5 MB by the time anyone asks;
 * - it keeps the **tail**, because the error is almost always at the end and
 *   the head is what scrolled past;
 * - the cap is **per terminal**, so two concurrent builds do not evict each
 *   other — a single global buffer would make the second one's output depend
 *   on what the first happened to be doing.
 *
 * Truncation is reported explicitly rather than silently returning a prefix:
 * the ACP response has a field for it, so saying so costs nothing and lying
 * costs a debugging session. The full output is still reachable, as a spilled
 * blob handle.
 *
 * Integration, over real subprocesses writing real megabytes to real pipes.
 *
 * Verifies: EPIC-05-S18 · AC7
 */
import { getBlob, openBlobSpill } from '@DeFlow/ledger';
import { makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  createTerminalService,
  DEFAULT_CAPTURE_BYTES,
  type TerminalService,
} from '../../src/index.ts';

let dir = '';
let worktree = '';

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', 'n1');
  await mkdir(worktree, { recursive: true });
});

afterEach(async () => {
  await removeTempDir(dir);
});

/** A service whose full-output capture goes to the real blob store. */
function service(): TerminalService {
  return createTerminalService({
    root: worktree,
    openCapture: () => openBlobSpill(dir, 'text/plain'),
  });
}

/**
 * A command that writes `mb` megabytes and then `trailer`, in 64 KiB writes —
 * a real child on a real pipe, which is the only way the bound under test is
 * ever exercised.
 */
function noisyCommand(mb: number, trailer = ''): { command: string; args: string[] } {
  return {
    command: process.execPath,
    args: [
      '-e',
      `const chunk = 'p'.repeat(65536);
       for (let i = 0; i < ${mb} * 16; i += 1) process.stdout.write(chunk);
       if (${JSON.stringify(trailer)}) process.stdout.write(${JSON.stringify(trailer)});`,
    ],
  };
}

suite('a noisy build is bounded on the way in', () => {
  it('returns at most 1 MiB of a 5 MB command and says it truncated', async () => {
    const terminals = service();
    const id = await terminals.create(noisyCommand(5));
    await terminals.waitForExit(id);

    const output = terminals.output(id);

    expect(DEFAULT_CAPTURE_BYTES).toBe(1024 * 1024);
    expect(Buffer.byteLength(output.output, 'utf8')).toBeLessThanOrEqual(DEFAULT_CAPTURE_BYTES);
    // Explicitly, using the schema's own field — not a silent prefix.
    expect(output.truncated).toBe(true);
    expect(output.exitStatus?.exitCode).toBe(0);
  }, 60_000);

  it('keeps the full output reachable as a spilled blob handle', async () => {
    const terminals = service();
    const id = await terminals.create(noisyCommand(5, 'ERROR: the build failed'));
    await terminals.waitForExit(id);
    terminals.output(id);

    const handle = terminals.fullOutput(id);
    if (handle === null) throw new Error('expected the full output to have been spilled');
    const full = getBlob(dir, handle);
    expect(full.byteLength).toBe(5 * 1024 * 1024 + 'ERROR: the build failed'.length);
    expect(Buffer.from(full.subarray(full.byteLength - 23)).toString('utf8')).toBe(
      'ERROR: the build failed',
    );
  }, 60_000);

  it('does not truncate, and reports no truncation, for a small command', async () => {
    const terminals = service();
    const id = await terminals.create({
      command: process.execPath,
      args: ['-e', 'console.log("ok")'],
    });
    await terminals.waitForExit(id);

    const output = terminals.output(id);
    expect(output.output.trim()).toBe('ok');
    expect(output.truncated).toBe(false);
  }, 60_000);
});

suite('the ring buffer keeps the tail, not the head', () => {
  it('ends with the error the command printed last', async () => {
    const terminals = service();
    const id = await terminals.create(noisyCommand(3, 'FAILED: 1 test did not pass'));
    await terminals.waitForExit(id);

    const output = terminals.output(id);
    expect(output.truncated).toBe(true);
    expect(output.output.endsWith('FAILED: 1 test did not pass')).toBe(true);
    // The head is what scrolled past: the very first bytes are gone.
    expect(Buffer.byteLength(output.output, 'utf8')).toBeLessThanOrEqual(DEFAULT_CAPTURE_BYTES);
  }, 60_000);
});

suite('the bound is the code’s, not the pipe’s', () => {
  it('caps a single write larger than the whole buffer', async () => {
    // With one 50 KB write there is only one chunk to evict, and an
    // implementation that only drops whole chunks has to keep it — so the
    // "1 MiB" bound would silently be "1 MiB, or one chunk, whichever is
    // larger". That holds today only because Node reads a pipe 64 KiB at a
    // time, which is a property of the runtime and not of this service.
    const terminals = createTerminalService({ root: worktree, captureBytes: 1024 });
    const id = await terminals.create({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("z".repeat(50000) + "TAIL")'],
    });
    await terminals.waitForExit(id);

    const output = terminals.output(id);
    expect(Buffer.byteLength(output.output, 'utf8')).toBeLessThanOrEqual(1024);
    expect(output.truncated).toBe(true);
    expect(output.output.endsWith('TAIL')).toBe(true);
  }, 60_000);
});

suite('the cap is per terminal, not global', () => {
  it('gives two concurrent terminals a buffer each', async () => {
    const terminals = createTerminalService({ root: worktree, captureBytes: 1024 * 1024 });
    const first = await terminals.create(noisyCommand(2, 'FIRST TERMINAL TRAILER'));
    const second = await terminals.create(noisyCommand(2, 'SECOND TERMINAL TRAILER'));
    await Promise.all([terminals.waitForExit(first), terminals.waitForExit(second)]);

    const a = terminals.output(first);
    const b = terminals.output(second);

    expect(a.output.endsWith('FIRST TERMINAL TRAILER')).toBe(true);
    expect(b.output.endsWith('SECOND TERMINAL TRAILER')).toBe(true);
    expect(a.output).not.toContain('SECOND TERMINAL TRAILER');
    expect(b.output).not.toContain('FIRST TERMINAL TRAILER');
    for (const output of [a, b]) {
      expect(Buffer.byteLength(output.output, 'utf8')).toBeLessThanOrEqual(1024 * 1024);
    }
  }, 60_000);
});
