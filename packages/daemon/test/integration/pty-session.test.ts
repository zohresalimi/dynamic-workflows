/**
 * KAR-15.8 AC4 — the rule that makes the interactive channel safe: the pty's
 * output is written to `io_chunk` **whether or not anybody is attached**, so
 * closing a terminal panel loses nothing and kills nothing.
 *
 * Integration, with a real pty and a file-backed ledger, because the property
 * is about the two boundaries a unit test removes: a real child process (which
 * must not notice that a viewer left) and a real SQLite file (which must have
 * the bytes on disk afterwards).
 *
 * `@lydell/node-pty` is an `optionalDependency` (docs/02-tech-stack.md §10.9),
 * so the session degrades to a plain pipe spawn where it is unavailable. That
 * degradation is asserted here rather than assumed — a fallback nobody
 * exercises is a fallback that does not work.
 *
 * Verifies: EPIC-15-S48 · KAR-15.8 AC4, AC5 · test plan #4
 */
import { NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { openLedger, openRead, readIoChunks } from '@DeFlow/ledger';
import { it, waitFor } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { systemClock } from '../../src/clock.ts';
import { ledgerPtySink } from '../../src/pty/ledger-pty-sink.ts';
import { openPtySession, type PtySession } from '../../src/pty/pty-session.ts';

const CHILD = fileURLToPath(new URL('./support/pty-child.ts', import.meta.url));

const RUN = RunIdSchema.parse('run_20260810T101500Z_ac1541');
const NODE = NodeIdSchema.parse('n-impl');

const open: PtySession[] = [];

afterEach(() => {
  for (const session of open.splice(0)) session.kill();
});

async function session(tmp: string, sink = ledgerSinkFor(tmp)): Promise<PtySession> {
  const opened = await openPtySession({
    runId: RUN,
    nodeId: NODE,
    attempt: 1,
    command: process.execPath,
    args: [CHILD],
    cwd: tmp,
    env: { PATH: process.env.PATH ?? '', TERM: 'xterm-256color' },
    cols: 80,
    rows: 24,
    sink,
  });
  open.push(opened);
  return opened;
}

function ledgerSinkFor(tmp: string) {
  return ledgerPtySink({
    db: openLedger(tmp),
    runId: RUN,
    nodeId: NODE,
    attempt: 1,
    clock: systemClock,
  });
}

const durableOutput = (tmp: string): string => {
  // Read-only, and its own connection: the session's sink holds the one
  // writer, and SQLite permits exactly one of those per process.
  const db = openRead(join(tmp, 'ledger.db'));
  try {
    const page = readIoChunks(db, { runId: RUN, nodeId: NODE, attempt: 1 }, 0, 10_000);
    return page.chunks.map((chunk) => Buffer.from(chunk.data).toString('utf8')).join('');
  } finally {
    db.close();
  }
};

suite('a live pty session (AC4)', () => {
  it('writes every byte to io_chunk with nobody attached at all', async ({ tmp }) => {
    const live = await session(tmp);

    live.write(Buffer.from('echo alpha\r'));

    await waitFor(() => durableOutput(tmp).includes('echoed alpha'), {
      describe: 'the pty output to reach io_chunk with no subscriber',
    });
  });

  it('keeps writing io_chunk and keeps the child alive after the last detach', async ({ tmp }) => {
    const live = await session(tmp);
    const seen: string[] = [];
    const detach = live.attach({
      onData: (bytes) => seen.push(bytes.toString('utf8')),
      onExit: () => undefined,
    });

    live.write(Buffer.from('emit 6\r'));
    await waitFor(() => seen.join('').includes('line 1'), {
      describe: 'the first emitted line to reach the attached viewer',
    });

    // The panel is closed halfway through the output.
    detach();
    const afterDetach = seen.join('');

    await waitFor(() => durableOutput(tmp).includes('emitted 6'), {
      describe: 'the rest of the output to land in io_chunk after the viewer left',
    });

    // Nothing more reached the detached viewer, and the child never noticed.
    expect(seen.join('')).toBe(afterDetach);
    expect(live.exit).toBeNull();
  });

  it('reports the exit code once, to every attached viewer (AC5)', async ({ tmp }) => {
    const live = await session(tmp);
    const exits: (number | null)[] = [];
    live.attach({ onData: () => undefined, onExit: (exit) => exits.push(exit.code) });

    live.write(Buffer.from('bye 3\r'));

    await waitFor(() => exits.length === 1, { describe: 'the exit to reach the viewer' });
    expect(exits).toEqual([3]);
    expect(live.exit?.code).toBe(3);
    expect(await live.waitForExit()).toEqual(live.exit);
  });

  it('gives the child the window size it was opened with, and resizes it', async ({ tmp }) => {
    const live = await session(tmp);
    const seen: string[] = [];
    live.attach({ onData: (bytes) => seen.push(bytes.toString('utf8')), onExit: () => undefined });

    live.write(Buffer.from('size\r'));
    await waitFor(() => seen.join('').includes('size 80x24'), {
      describe: 'the child to report the initial dimensions',
    });

    live.resize(120, 40);
    await waitFor(() => seen.join('').includes('size 120x40'), {
      describe: 'the child to observe SIGWINCH',
    });
  });

  it('runs under a real tty where node-pty is available', async ({ tmp }) => {
    // The claim `tty: true` makes is checkable from inside the child: a plain
    // pipe spawn reports no columns at all.
    const live = await session(tmp);
    expect(live.tty).toBe(true);
  });
});

suite('the no-TTY degradation (docs/02 §10.9)', () => {
  it('still runs the child, still writes io_chunk, and says it has no tty', async ({ tmp }) => {
    const live = await openPtySession({
      runId: RUN,
      nodeId: NODE,
      attempt: 1,
      command: process.execPath,
      args: [CHILD],
      cwd: tmp,
      env: { PATH: process.env.PATH ?? '' },
      cols: 80,
      rows: 24,
      sink: ledgerSinkFor(tmp),
      // The one switch the fallback has: `loadPty` answering null is what an
      // unsupported platform looks like, and it is injected rather than
      // simulated by deleting a module from the cache.
      loadPty: () => Promise.resolve(null),
    });
    open.push(live);

    expect(live.tty).toBe(false);

    live.write(Buffer.from('echo beta\n'));
    await waitFor(() => durableOutput(tmp).includes('echoed beta'), {
      describe: 'the piped child output to reach io_chunk',
    });

    // A resize is meaningless without a tty, and saying so is better than
    // pretending it worked.
    expect(() => live.resize(120, 40)).not.toThrow();
  });
});
