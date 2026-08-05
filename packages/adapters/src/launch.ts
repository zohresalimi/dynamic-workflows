/**
 * KAR-05.3 AC4/AC5 — starting a provider, and surviving a deprecation window.
 *
 * One function, no vendor knowledge: everything specific lives in the
 * `ProviderSpec` this is handed (`provider-registry.ts`), and the only thing
 * decided here is what to do when the child rejects the argv it was given.
 *
 * **The fallback is bounded by the spec, not by a rule remembered here.** A
 * vendor with one argv variant gets one spawn. A vendor with a flag
 * mid-deprecation gets exactly one retry, with the next variant, and an event
 * saying so. An unbounded fallback loop against a churning flag surface turns
 * a clear failure into a slow one, and recording that the deprecated path was
 * taken is what makes the monthly `--help` diff actionable.
 *
 * **A retry only happens for an argv-parse rejection.** That is: the child
 * exited, on its own, non-zero, having printed something that reads like an
 * argument parser complaining. Anything else — a handshake that failed, an
 * agent that wedged, a signal — is not a flag problem, and retrying it would
 * spend a second spawn to get the same answer.
 *
 * `drive` is the caller's continuation: the handshake, or the whole turn. It
 * runs while the child is alive and its rejection is what triggers the check
 * above, which is why the "handshake window" in AC5 is the caller's own
 * timeout rather than a second one invented here.
 *
 * Verifies: EPIC-05-S11, EPIC-05-S12 · AC4, AC5
 */
import type { Clock, NodeId } from '@DeFlow/core';
import { Buffer } from 'node:buffer';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import process from 'node:process';
import type { Readable } from 'node:stream';
import type { ResolvedProvider } from './binary-resolver.ts';
import { argvRejected, spawnRefused } from './failures.ts';
import type { LedgerSink } from './ports.ts';
import type { ProviderSpec, SpawnPlan } from './provider-registry.ts';
import { spawnPlan } from './provider-registry.ts';

/** How long, on the injected clock, a rejected child has to exit before its
 * process group is signalled. An argv parser exits in milliseconds. */
export const LAUNCH_EXIT_GRACE_MS = 2_000;

/** How much of the child's stderr is kept for the retry decision and for the
 * failure's detail. Bounded, because the daemon supervises runs for days. */
export const STDERR_TAIL_BYTES = 8 * 1024;

/**
 * What an argument parser sounds like when it refuses a flag.
 *
 * Deliberately a small set of shapes rather than a per-vendor list: this is
 * the one place a wrong answer is cheap in one direction (a missed match costs
 * a fallback that would have worked) and expensive in the other (a false match
 * spends a spawn on a flag that was never the problem).
 */
const ARGV_PARSE_REJECTION =
  /unknown (?:argument|option|flag)|unrecognized (?:argument|option)|invalid (?:argument|option|flag)|unexpected argument|no such (?:option|flag)/i;

export interface LaunchRequest {
  readonly spec: ProviderSpec;
  readonly resolved: ResolvedProvider;
  /** The node's worktree. Becomes the child's cwd, and argv for the one vendor
   * that takes it there. */
  readonly worktree: string;
  /** The vendor version the manifest recorded, for the fallback note. */
  readonly version?: string;
  /** The base environment the child inherits. `process.env` when absent. */
  readonly env?: NodeJS.ProcessEnv;
  /** The node this launch belongs to, when it belongs to one — a probe at
   * daemon start does not, and then the fallback is reported but not appended. */
  readonly nodeId?: NodeId;
  /** The node's 0-based attempt, matching the event envelope. */
  readonly attempt?: number;
}

export interface LaunchPorts {
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  /** Where the deprecated-flag note is appended. */
  readonly ledger?: LedgerSink;
  readonly exitGraceMs?: number;
}

export interface LaunchOutcome<T> {
  /** Whatever `drive` returned. */
  readonly value: T;
  /**
   * Still running, and the caller's to finish with.
   *
   * Its **stderr is already being consumed** by the launcher's bounded tail —
   * that tail is the evidence the argv-parse decision is made on, and it has to
   * be collected from the first byte because a parser rejects before anything
   * else happens. A caller that needs stderr byte-for-byte in `io_chunk` will
   * want the tail teed rather than a second reader attached; noted on MET-303,
   * and nothing in the daemon consumes it yet.
   */
  readonly child: ChildProcessWithoutNullStreams;
  readonly plan: SpawnPlan;
  /** The child's process group — `detached` makes it its own leader (§9.3). */
  readonly pgid: number;
  /** How many children were started in total. 1, or 2 after a fallback. */
  readonly spawns: number;
  /** Whether the deprecated invocation is the one that worked. */
  readonly fellBack: boolean;
}

interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already reaped.
  }
}

/**
 * The last `STDERR_TAIL_BYTES` of a stream, read in paused mode.
 *
 * `'readable'` rather than `'data'`: flowing mode still delivers every byte, it
 * just buffers the stream in RAM on the daemon's behalf, and the whole of this
 * package is built to refuse that (`test/adapter-shape.test.ts`). The tail is
 * capped for the same reason — a chatty agent must not be able to grow the
 * daemon's heap by talking.
 */
function tailOf(stream: Readable, limit: number): { text: () => string; ended: Promise<void> } {
  const chunks: Buffer[] = [];
  let bytes = 0;
  stream.on('readable', () => {
    for (;;) {
      const chunk = stream.read() as Buffer | null;
      if (chunk === null) break;
      chunks.push(chunk);
      bytes += chunk.length;
      while (bytes > limit && chunks.length > 1) {
        const dropped = chunks.shift();
        bytes -= dropped?.length ?? 0;
      }
    }
  });
  const ended = new Promise<void>((resolve) => {
    stream.once('end', () => resolve());
    stream.once('close', () => resolve());
    stream.once('error', () => resolve());
  });
  return { text: () => Buffer.concat(chunks).toString('utf8'), ended };
}

function startChild(
  plan: SpawnPlan,
  request: LaunchRequest,
): {
  child: ChildProcessWithoutNullStreams;
  started: Promise<void>;
  exited: Promise<ProcessExit>;
} {
  const child = spawn(plan.command, [...plan.argv], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // The child leads its own group, so a wedged agent and everything it
    // spawned are reachable with one signal (§9.3).
    detached: true,
    cwd: request.worktree,
    // The vendor overlay last: it is the resolved absolute path the bridge
    // must use, and an inherited value of the same name is exactly what §4.3
    // says not to trust.
    env: { ...(request.env ?? process.env), ...plan.env },
  });
  const started = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (error) => {
      reject(spawnRefused(plan.command, error));
    });
  });
  // Registered at spawn time rather than where it is awaited: an exit that
  // landed in between would otherwise never be observed.
  const exited = new Promise<ProcessExit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, started, exited };
}

/** Whether the child died complaining about its arguments, and nothing else. */
function isArgvParseRejection(exit: ProcessExit, stderr: string): boolean {
  if (exit.signal !== null) return false;
  if (exit.code === null || exit.code === 0) return false;
  return ARGV_PARSE_REJECTION.test(stderr);
}

/**
 * Ends the conversation and waits for the child to go, bounded on the injected
 * clock: stdin EOF first, because a clean exit leaves a clean transcript, and
 * the signal is what a binary that ignores EOF gets.
 */
async function settle(
  child: ChildProcessWithoutNullStreams,
  exited: Promise<ProcessExit>,
  stderr: { ended: Promise<void> },
  ports: LaunchPorts,
): Promise<ProcessExit> {
  const grace = ports.exitGraceMs ?? LAUNCH_EXIT_GRACE_MS;
  const pgid = child.pid ?? 0;
  child.stdin.end();
  const kill = ports.clock.setTimer(grace, () => {
    signalGroup(pgid, 'SIGKILL');
  });
  const exit = await exited;
  kill.cancel();
  // The exit event can win the race against the last bytes still in the pipe,
  // and those bytes are the evidence the retry decision is made on. Bounded on
  // the injected clock like every other wait, because a grandchild holding the
  // pipe open must not be able to stop the daemon here.
  await new Promise<void>((resolve) => {
    const flush = ports.clock.setTimer(grace, resolve);
    void stderr.ended.then(() => {
      flush.cancel();
      resolve();
    });
  });
  return exit;
}

/**
 * Spawns the provider, hands the live child to `drive`, and retries once with
 * the next argv variant if — and only if — the child rejected the arguments.
 *
 * Returns with the child still running and the caller's `drive` result. Throws
 * a tagged `adapter.spawn-failed` when the binary will not start or when every
 * variant was rejected; anything `drive` throws for its own reasons is
 * re-thrown unchanged.
 */
export async function launchProvider<T>(
  request: LaunchRequest,
  ports: LaunchPorts,
  drive: (child: ChildProcessWithoutNullStreams, plan: SpawnPlan) => Promise<T>,
): Promise<LaunchOutcome<T>> {
  const attempted: (readonly string[])[] = [];

  for (let variant = 0; variant < request.spec.argvVariants; variant += 1) {
    const plan = spawnPlan(request.spec, {
      resolved: request.resolved,
      worktree: request.worktree,
      variant,
    });
    attempted.push(plan.argv);

    const { child, started, exited } = startChild(plan, request);
    const stderr = tailOf(child.stderr, STDERR_TAIL_BYTES);
    await started;

    let value: T;
    try {
      value = await drive(child, plan);
    } catch (error) {
      const exit = await settle(child, exited, stderr, ports);
      if (!isArgvParseRejection(exit, stderr.text())) throw error;

      const next = variant + 1;
      if (next >= request.spec.argvVariants) {
        throw argvRejected(request.spec.id, attempted, stderr.text(), exit);
      }
      await recordFallback(request, ports, plan.argv, next);
      continue;
    }

    return {
      value,
      child,
      plan,
      pgid: child.pid ?? 0,
      spawns: variant + 1,
      fellBack: variant > 0,
    };
  }

  // Unreachable: `argvVariants` is at least 1, and the loop either returns or
  // throws on its last pass. Stated rather than assumed, because a spec that
  // ever declared zero variants would otherwise silently succeed at nothing.
  throw argvRejected(request.spec.id, attempted, '', { code: null, signal: null });
}

/**
 * Appends the note that the deprecated invocation was taken.
 *
 * A `node.progress` row with a phase of its own, and not a new event kind: the
 * closed set in docs/04-domain-model.md §9 has no "the vendor's flag surface
 * moved" event, and adding one is a plan change (README §9) that belongs with
 * whoever owns the run header this warning is meant to reach. Follow-up noted
 * on MET-303. Where there is no node — a probe at daemon start — the fallback
 * is still reported through `LaunchOutcome.fellBack`, just not appended.
 */
async function recordFallback(
  request: LaunchRequest,
  ports: LaunchPorts,
  rejected: readonly string[],
  variant: number,
): Promise<void> {
  if (ports.ledger === undefined || request.nodeId === undefined) return;
  const nextArgv = request.spec.argv({
    resolved: request.resolved,
    worktree: request.worktree,
    variant,
  });
  const attempt = request.attempt ?? 0;
  await ports.ledger.append({
    kind: 'node.progress',
    v: 1,
    ts: ports.clock.now(),
    nodeId: request.nodeId,
    attempt,
    payload: {
      node: request.nodeId,
      attempt,
      phase: 'adapter.flag-fallback',
      message:
        `${request.spec.id} ${request.version ?? 'version unknown'} rejected ` +
        `"${rejected.join(' ')}"; retrying once with the deprecated "${nextArgv.join(' ')}"`,
    },
  });
}
