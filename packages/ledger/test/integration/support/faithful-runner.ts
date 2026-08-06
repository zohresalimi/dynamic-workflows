/**
 * The effect boundary EPIC-06-S5's fourth scenario is about: a loop that
 * performs the command stream `decide()` returns, faithfully and with no
 * judgement of its own.
 *
 * `reduce` the log → `decide` → perform → append → repeat. That is
 * docs/05-durable-execution.md §4's loop and it is all this is. Three rules
 * make it worth running:
 *
 * 1. **It contains no exclusion.** There is no queue, no mutex, no "one write
 *    node at a time" anywhere below. Every `StartNode` in a tick is spawned
 *    immediately and none is awaited, so if `decide()` ever returned two of
 *    them for two nodes that write the same repository, two real `git add`
 *    processes would be inside the same index at the same moment. That is what
 *    makes this an observation rather than a restatement of the unit test: the
 *    only thing standing between the two agents is the scheduler's answer.
 * 2. **It performs commands, it does not invent events.** A lock is taken
 *    because an `AcquireLock` said so and given back because a `ReleaseLock`
 *    did; the runner never decides a lock is free. A command kind it has not
 *    been taught is a throw, not a shrug — a silently ignored `AcquireLock`
 *    would make this whole file pass while proving nothing.
 * 3. **`now` is a parameter here too.** Ticks advance a synthetic clock, so
 *    the scheduler's view of time is fixed by the loop rather than by how long
 *    the machine took. Only the polling between ticks uses a real timer, and it
 *    has to: there is a live child process, and a fake timer around one
 *    deadlocks (docs/14-testing-strategy.md §8).
 *
 * When `EffectRunner` lands with KAR-06.3 it takes this over. Until then this
 * is the honest minimum, and it is deliberately dumb: everything interesting
 * that happens here happened in `decide()`.
 */
import {
  type Command,
  type Db,
  decide,
  foldEvents,
  initialRunState,
  type RunId,
  type RunState,
  type StartNode,
} from '@DeFlow/core';
import { type Crashable, GIT_ENV, sleep, startCrashable } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appendEvents, drainEvents, type EventDraft } from '../../../src/index.ts';

const AGENT = fileURLToPath(new URL('./git-writer-agent.ts', import.meta.url));

/** The binary identity `node.started` records, computed rather than invented. */
const AGENT_SHA256 = createHash('sha256').update(readFileSync(AGENT)).digest('hex');

/**
 * The environment an agent is spawned with: this process's, minus every
 * ambient `GIT_*`, plus the testkit's isolated one.
 *
 * The agent runs real `git`, so without this the developer's own ~/.gitconfig
 * — `core.hooksPath`, `status.showUntrackedFiles`, an alias — decides what the
 * spec observes (docs/14-testing-strategy.md §6). Composed here rather than in
 * the child because `GIT_ENV` lives in the testkit's package root, which a
 * non-vitest process cannot import.
 */
const hermeticEnv = (): Record<string, string | undefined> => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
  ...GIT_ENV,
});

/** How long the loop waits between ticks, on a real clock. */
const TICK_MS = 20;

/** How far the synthetic `now` handed to `decide()` moves per tick. */
const TICK_STEP_MS = 1_000;

export interface Tick {
  /** The instant this tick was decided at. */
  readonly now: number;
  readonly commands: readonly Command[];
}

export interface DriveOptions {
  readonly db: Db;
  readonly runId: RunId;
  readonly repoDir: string;
  /** The NDJSON file both agents append their observations to. */
  readonly logPath: string;
  /** How long each agent holds the index once it has staged its file. */
  readonly holdMs: number;
  /** The synthetic instant of the first tick. */
  readonly startAt: number;
  readonly timeoutMs?: number;
}

export interface DriveResult {
  readonly ticks: readonly Tick[];
  /** The projection after the loop went quiet. */
  readonly finalState: RunState;
}

const foldLedger = (db: Db, runId: RunId): RunState =>
  foldEvents(drainEvents(db, runId), initialRunState()).state;

/**
 * Runs the loop until there is nothing left to do and nobody still working.
 *
 * "Nothing to do" is `decide()` returning no commands, and it is the only
 * termination condition: a spec that stopped after N ticks would pass on a run
 * that wedged.
 */
export async function driveUntilQuiet(options: DriveOptions): Promise<DriveResult> {
  const { db, runId, repoDir, logPath, holdMs, startAt } = options;
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);

  const ticks: Tick[] = [];
  const children: Crashable[] = [];
  const inflight = new Set<Promise<void>>();
  const thrown: unknown[] = [];

  /** Appends `node.started` and spawns the agent — without waiting for it. */
  const start = (command: StartNode): void => {
    const ikey = `${runId}/${command.node}/${command.attempt}/0`;
    append(db, runId, {
      kind: 'node.started',
      nodeId: command.node,
      attempt: command.attempt,
      ikey,
      payload: {
        node: command.node,
        attempt: command.attempt,
        ikey,
        binary: { path: AGENT, version: '1.0.0', sha256: AGENT_SHA256 },
      },
    });

    const child = startCrashable({
      script: AGENT,
      args: [repoDir, command.node, logPath, String(holdMs)],
      env: hermeticEnv(),
    });
    children.push(child);

    const finished = child.exited.then((exit) => {
      // The terminal event, and nothing else: the lock this node holds is given
      // back by the `ReleaseLock` the *next* tick returns, which is EPIC-06-S5
      // scenario 2's "a ReleaseLock command is returned on the next tick". A
      // release appended here would be the runner holding an opinion about
      // locks, which is the one thing it must not do.
      append(db, runId, terminalEvent(command, exit.code, child.stderr()));
    });
    inflight.add(finished);
    void finished
      .catch((error: unknown) => {
        thrown.push(error);
      })
      .finally(() => inflight.delete(finished));
  };

  try {
    for (let index = 0; ; index += 1) {
      const now = startAt + index * TICK_STEP_MS;
      const commands = decide(foldLedger(db, runId), now);
      ticks.push({ now, commands });

      for (const command of commands) perform(db, runId, command, start);
      if (thrown.length > 0) throw thrown[0];
      if (commands.length === 0 && inflight.size === 0) break;

      if (Date.now() > deadline) {
        throw new Error(
          `the run never went quiet: ${JSON.stringify(commands)} after ${ticks.length} ticks`,
        );
      }
      await sleep(TICK_MS);
    }
  } finally {
    // Only reachable with a child still alive if something above threw; a
    // survivor would otherwise outlive the tmpdir it is writing into.
    await Promise.all(children.map((child) => child.sigkill()));
  }

  return { ticks, finalState: foldLedger(db, runId) };
}

/**
 * Performs one command. The `switch` is exhaustive on purpose — a member added
 * to `Command` becomes a compile error here rather than a silently skipped
 * effect.
 */
function perform(
  db: Db,
  runId: RunId,
  command: Command,
  start: (command: StartNode) => void,
): void {
  switch (command.kind) {
    case 'StartNode':
      start(command);
      return;

    case 'AcquireLock':
      append(db, runId, {
        kind: 'node.lock.acquired',
        nodeId: command.node,
        payload: { node: command.node, lock: command.lock, key: command.key },
      });
      return;

    case 'ReleaseLock':
      append(db, runId, {
        kind: 'node.lock.released',
        nodeId: command.node,
        payload: {
          node: command.node,
          lock: command.lock,
          key: command.key,
          reason: command.reason,
        },
      });
      return;

    case 'EmitEvent':
      append(db, runId, {
        kind: command.event.kind,
        ...(command.node === null ? {} : { nodeId: command.node }),
        ...(command.attempt === null ? {} : { attempt: command.attempt }),
        payload: command.event.payload,
      });
      return;

    case 'CancelNode':
    case 'ScheduleWake':
      throw new Error(`this loop was never taught to perform ${command.kind}`);
  }
}

function terminalEvent(
  command: StartNode,
  code: number | null,
  stderr: string,
): Omit<EventDraft, 'runId' | 'ts' | 'v' | 'epoch'> {
  if (code === 0) {
    return {
      kind: 'node.completed',
      nodeId: command.node,
      attempt: command.attempt,
      payload: {
        node: command.node,
        attempt: command.attempt,
        result: {
          status: 'completed',
          output: { summary: `${command.node} staged its file` },
          outputSchemaId: 'DeFlow.artifact.v1',
          usage: { inputTokens: 0, outputTokens: 0, source: 'vendor-reported' },
          costUsd: 0,
          producedFacts: [],
          artifacts: [],
        },
      },
    };
  }

  return {
    kind: 'node.failed',
    nodeId: command.node,
    attempt: command.attempt,
    payload: {
      node: command.node,
      attempt: command.attempt,
      failure: {
        reason: 'agent.nonzero-exit',
        class: 'permanent',
        message: `the agent exited ${String(code)}`,
        detail: { exitCode: code, stderr: stderr.slice(0, 500) },
        evidence: [],
        occurredAtEvent: 1,
        attempt: command.attempt,
      },
    },
  };
}

/** One append, with the envelope fields the loop always knows filled in. */
function append(
  db: Db,
  runId: RunId,
  event: Omit<EventDraft, 'runId' | 'ts' | 'v' | 'epoch'>,
): void {
  appendEvents(db, [{ runId, ts: Date.now(), v: 1, epoch: 1, ...event }]);
}
