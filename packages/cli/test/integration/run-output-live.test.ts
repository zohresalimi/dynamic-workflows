/**
 * KAR-19.4 AC3 / EPIC-19-S25 — agent output on the terminal **while the node is
 * still running**.
 *
 * The operator on 2026-08-12 saw no output at all. The failure that would
 * replace it is subtler and is what this spec is written against: output
 * buffered and flushed at `node.completed`, which is indistinguishable from
 * working on a two-second mock node and useless on a ten-minute real one.
 *
 * So the node is scripted to emit chunk A, **wait on a gate this spec holds**,
 * and only then emit chunk B. "Before" therefore means something: the assertion
 * is made while the daemon is provably still inside the node, with no
 * `node.completed` in the ledger and chunk B not yet produced. A CLI that
 * buffered would show nothing at that instant and the spec would hang rather
 * than pass.
 *
 * Integration, and through a **real process over a real socket**: the daemon is
 * booted in this process so the spec can hold the gate, and `DeFlow run
 * --attach` is a spawned binary whose stdout is a real file descriptor on a
 * real file — the same thing a shell's `> out.log` produces. Nothing between
 * the renderer and that descriptor is faked, which is the only way to settle
 * that the bytes actually arrive rather than that a function was called.
 *
 * Verifies: EPIC-19-S25 · KAR-19.4 AC3 · test plan #2
 */
import type { Db, NodeId, RunId } from '@DeFlow/core';
import { NodeIdSchema } from '@DeFlow/core';
import {
  type Booted,
  boot,
  createEffectRunner,
  createRunExecution,
  type ExecContext,
  type NodePerformer,
  systemClock,
} from '@DeFlow/daemon';
import { appendEvents, appendIoChunk, listRunIds, readRange } from '@DeFlow/ledger';
import { it, makeRepo } from '@DeFlow/testkit';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, describe as suite } from 'vitest';
import { spawnRun, until } from './support/cli-process.ts';
import { plannedRun } from './support/run-fixture.ts';

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.shutdown();
  booted = undefined;
});

/** The ESC byte that must never reach a pipe. */
const ESC = '';

const NODE: NodeId = NodeIdSchema.parse('implement');
const CHUNK_A = 'first: the agent started thinking\n';
const CHUNK_B = 'second: the agent finished\n';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

/**
 * A performer that emits, waits, and emits — the node EPIC-19-S25 describes.
 *
 * The gate is a promise this spec resolves, which is the whole design of the
 * scenario: the assertion about *when* chunk A was visible is made while the
 * node is demonstrably unfinished, rather than after the fact against a
 * timestamp.
 */
function twoChunkPerformer(
  db: Db,
  runId: RunId,
  epoch: number,
  release: Promise<void>,
): NodePerformer {
  return async (command, ctx: ExecContext): Promise<void> => {
    const at = (): number => ctx.clock.now();
    appendEvents(db, [
      {
        runId,
        ts: at(),
        kind: 'node.started',
        v: 2,
        epoch,
        nodeId: command.node,
        attempt: command.attempt,
        payload: {
          node: command.node,
          attempt: command.attempt,
          ikey: `${runId}/${command.node}/${String(command.attempt)}/0`,
          // Required by `node.started` v2 — an event without it is appended
          // and then skipped at read time, so the node never appears to start.
          binary: { path: '/opt/DeFlow/claude', version: '2.1.220', sha256: 'b'.repeat(64) },
        },
      },
    ]);

    appendIoChunk(db, {
      runId,
      nodeId: command.node,
      attempt: command.attempt + 1,
      stream: 'stdout',
      ts: at(),
      data: encode(CHUNK_A),
    });

    await release;

    appendIoChunk(db, {
      runId,
      nodeId: command.node,
      attempt: command.attempt + 1,
      stream: 'stdout',
      ts: at(),
      data: encode(CHUNK_B),
    });

    appendEvents(db, [
      {
        runId,
        ts: at(),
        kind: 'node.completed',
        v: 1,
        epoch,
        nodeId: command.node,
        attempt: command.attempt,
        payload: {
          node: command.node,
          attempt: command.attempt,
          result: {
            status: 'completed',
            output: { summary: 'done' },
            outputSchemaId: 'DeFlow.finding.v1',
            usage: { inputTokens: 10, outputTokens: 10, source: 'vendor-reported' },
            costUsd: 0,
            producedFacts: [],
            artifacts: [],
          },
        },
      },
    ]);
  };
}

interface Watched {
  readonly runId: RunId;
  readonly out: string;
  readonly fd: number;
  readonly cli: ReturnType<typeof spawnRun>;
  readonly release: () => void;
}

/**
 * A daemon with a planned run on it, and a spawned `DeFlow run --attach`
 * watching it.
 *
 * The plan is seeded through the shipped `plannedRun` helper rather than framed:
 * what is under test here is the output path, and the framing → recon → planner
 * chain is `packages/daemon/test/integration/live-chain.test.ts`'s.
 */
async function watching(tmp: string, args: readonly string[]): Promise<Watched> {
  const dataDir = join(tmp, 'data');
  mkdirSync(dataDir, { recursive: true });
  const repo = await makeRepo({ dir: join(tmp, 'repo') });

  let releaseGate = (): void => undefined;
  const release = new Promise<void>((resolve) => {
    releaseGate = () => {
      resolve();
    };
  });

  let db: Db | null = null;
  let epoch = 0;
  const execution = createRunExecution({
    resolve: () =>
      Promise.resolve(
        db === null
          ? null
          : {
              perform: twoChunkPerformer(db, runIdOf(db), epoch, release),
              effects: createEffectRunner({
                db,
                clock: systemClock,
                daemonStartedAt: Date.now(),
                epoch,
              }),
              tickMs: 5,
              tickStepMs: 0,
            },
      ),
  });

  booted = await boot({
    dataDir,
    port: 0,
    dev: false,
    tickIntervalMs: 20,
    executeNodes: execution.executeNodes,
  });
  db = booted.db;
  epoch = booted.epoch;

  const runId = plannedRun(NODE, {
    db: booted.db,
    epoch: booted.epoch,
    ts: Date.now(),
    cwd: repo.dir,
  });

  const out = join(tmp, 'out.log');
  const fd = openSync(out, 'w');
  const cli = spawnRun({
    dataDir,
    cwd: repo.dir,
    args: [...args, '--attach', runId],
    stdoutFd: fd,
  });

  return { runId, out, fd, cli, release: releaseGate };
}

const runIdOf = (db: Db): RunId => {
  const [runId] = listRunIds(db);
  if (runId === undefined) throw new Error('the ledger holds no run yet');
  return runId;
};

suite('EPIC-19-S25 — output reaches the terminal while the node runs (AC3)', () => {
  it('shows the first chunk before the second is produced', async ({ tmp }) => {
    const w = await watching(tmp, []);
    try {
      await until('the first chunk reached the CLI', () =>
        readFileSync(w.out, 'utf8').includes(CHUNK_A.trim()) ? true : null,
      );

      // The instant that matters. The node is still inside its turn: chunk B
      // has not been produced and nothing has ended the node.
      const transcript = readFileSync(w.out, 'utf8');
      expect(transcript).not.toContain(CHUNK_B.trim());
      expect(kindsOf(booted?.db)).not.toContain('node.completed');

      w.release();

      await until('the second chunk reached the CLI', () =>
        readFileSync(w.out, 'utf8').includes(CHUNK_B.trim()) ? true : null,
      );

      const final = readFileSync(w.out, 'utf8');
      expect(final.indexOf(CHUNK_A.trim())).toBeLessThan(final.indexOf(CHUNK_B.trim()));

      const exit = await w.cli.exited;
      expect(exit.code).toBe(0);
    } finally {
      closeSync(w.fd);
      w.release();
      if (w.cli.child.exitCode === null) w.cli.child.kill('SIGKILL');
    }
  });

  it('emits the same content as NDJSON with no ANSI under --json', async ({ tmp }) => {
    const w = await watching(tmp, ['--json']);
    try {
      await until('the first chunk reached the CLI', () =>
        readFileSync(w.out, 'utf8').includes(CHUNK_A.trim()) ? true : null,
      );
      w.release();
      await until('the second chunk reached the CLI', () =>
        readFileSync(w.out, 'utf8').includes(CHUNK_B.trim()) ? true : null,
      );
      await w.cli.exited;

      const text = readFileSync(w.out, 'utf8');
      expect(text).not.toContain(ESC);

      const lines = text.split('\n').filter(Boolean);
      const objects = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const io = objects.filter((object) => object.kind === 'DeFlow.cli.io');
      expect(io.map((object) => object.data)).toEqual([CHUNK_A, CHUNK_B]);
      for (const frame of io) {
        expect(frame).toMatchObject({ runId: w.runId, node: NODE, stream: 'stdout' });
        expect(typeof frame.seq).toBe('number');
      }
    } finally {
      closeSync(w.fd);
      w.release();
      if (w.cli.child.exitCode === null) w.cli.child.kill('SIGKILL');
    }
  });
});

const kindsOf = (db: Db | undefined): string[] =>
  db === undefined ? [] : readRange(db, runIdOf(db), 0, 500).events.map((event) => event.kind);
