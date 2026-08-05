/**
 * KAR-05.2 — probing an installed agent, and persisting what it actually said.
 *
 * A probe is deliberately the smallest possible conversation: spawn, one
 * `initialize`, terminate. **It never sends `session/new`**, which is what
 * makes probing free — a session costs the user quota on every one of the five
 * providers, and a daemon that probed on every boot by opening a session would
 * be spending someone's subscription to answer a question it could ask for
 * nothing.
 *
 * It is written against the raw wire rather than through the SDK connection,
 * for one reason: `caps_json` is stored **byte-for-byte as received**. A parsed
 * object re-serialised on the way to SQLite is this build's rendering of the
 * response, not the response, and the entire value of persisting it unmodified
 * is being able to answer a question nobody has thought to ask yet. The
 * handshake sent is the same one `runAcpNode` sends — same version, same
 * client capabilities — because an agent may legitimately answer differently
 * depending on what the client advertised, and a probe that negotiated
 * something else would record capabilities no real session will see.
 *
 * `--version` is run as its own child, before the handshake. `initialize`'s
 * `agentInfo` is optional in the ACP schema and absent from most of the
 * measured five, so the version in the manifest's primary key has to come from
 * the one interface every CLI has.
 */
import type { Clock, ProviderId } from '@DeFlow/core';
import { NodeFailureError } from '@DeFlow/core';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { isAbsolute } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { text } from 'node:stream/consumers';
import type { CapabilityRow } from './capabilities.ts';
import { CLIENT_CAPABILITIES, CLIENT_INFO } from './client-capabilities.ts';
import { ACP_PROTOCOL_VERSION, spawnRefused } from './failures.ts';
import type { CapabilityStore, LedgerSink } from './ports.ts';
import { sliceMember } from './raw-frame.ts';
import type { ProcessExit } from './run-node.ts';

/** How long, on the injected clock, a probed agent has to exit after its stdin
 * closes before its process group is signalled. */
export const PROBE_TERMINATE_GRACE_MS = 2_000;

/**
 * How long, on the injected clock, an agent has to answer `initialize`.
 *
 * Generous, because a cold vendor CLI resolving its own node_modules is not a
 * wedge; bounded, because probing runs at daemon start and an agent that never
 * answers must not be a boot that never finishes.
 */
export const PROBE_HANDSHAKE_TIMEOUT_MS = 30_000;

/** The id the probe's one and only request carries. */
const INITIALIZE_ID = 0;

export interface ProbeRequest {
  readonly provider: ProviderId;
  /** Absolute, resolved. Never a bare name for `PATH` to answer at spawn time. */
  readonly binaryPath: string;
  /** The vendor's ACP-mode invocation — KAR-05.3 owns which one that is. */
  readonly argv?: readonly string[];
  /** How this binary is asked its version. Verbatim `--version` by default. */
  readonly versionArgv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export interface ProbePorts {
  /** Time enters here and nowhere else (NF9). `probed_at` is `clock.now()`. */
  readonly clock: Clock;
  /** Where `provider.probed` is appended. */
  readonly ledger: LedgerSink;
  readonly capabilities: CapabilityStore;
  readonly terminateGraceMs?: number;
  readonly handshakeTimeoutMs?: number;
}

export interface ProbeOutcome {
  readonly status: 'probed';
  readonly row: CapabilityRow;
  /** False when this exact `(provider, version, sha256)` was already recorded. */
  readonly inserted: boolean;
  readonly exit: ProcessExit;
}

function probeFailed(message: string, detail: Record<string, unknown>): NodeFailureError {
  return new NodeFailureError(message, {
    reason: 'adapter.protocol-error',
    class: 'permanent',
    detail,
  });
}

/** sha256 of the resolved entry file, streamed — a vendor bin can be tens of MB. */
async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return hash.digest('hex');
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Already reaped.
  }
}

function spawnChild(
  request: ProbeRequest,
  argv: readonly string[],
): {
  child: ChildProcessWithoutNullStreams;
  started: Promise<void>;
  exited: Promise<ProcessExit>;
} {
  const child = spawn(request.binaryPath, [...argv], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // Same rule as a real turn (§9.3): the child leads its own group, so a
    // wedged agent and everything it spawned are reachable with one signal.
    detached: true,
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.env === undefined ? {} : { env: request.env }),
  });
  const started = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (error) => {
      reject(spawnRefused(request.binaryPath, error));
    });
  });
  // Registered at spawn time rather than where it is awaited: an exit that
  // landed in between would otherwise never be observed.
  const exited = new Promise<ProcessExit>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, started, exited };
}

/**
 * The verbatim `--version` output.
 *
 * Trailing whitespace is dropped and nothing else is: the newline a CLI ends
 * its line with is an artefact of writing to a terminal, and it would
 * otherwise end up inside a primary key. Stderr is read as a fallback because
 * some CLIs print their banner there.
 */
async function readVersion(request: ProbeRequest): Promise<string> {
  const { child, started, exited } = spawnChild(request, request.versionArgv ?? ['--version']);
  await started;
  child.stdin.end();

  // Drained to the end of the *stream*, not to the 'exit' event: a CLI that
  // calls process.exit right after writing leaves bytes in the pipe, and
  // 'exit' can win the race against them.
  const [stdout, stderr] = await Promise.all([text(child.stdout), text(child.stderr)]);
  await exited;

  const version = stdout.trim() === '' ? stderr.trim() : stdout.trim();
  if (version === '') {
    throw probeFailed(
      `${request.binaryPath} printed nothing for ${(request.versionArgv ?? ['--version']).join(' ')}; ` +
        'the manifest keys a row on the reported version and cannot record an empty one',
      { binaryPath: request.binaryPath },
    );
  }
  return version;
}

/**
 * Sends `initialize` and returns the raw source text of the response's
 * `result` member, then ends the conversation.
 *
 * Reading with `readline` rather than the SDK's transport is the same decision
 * as writing raw ndjson: what is wanted here is the bytes, and every layer
 * between the pipe and the string is a layer that could have normalised them.
 */
async function handshake(
  request: ProbeRequest,
  clock: Clock,
  grace: { terminateMs: number; handshakeMs: number },
): Promise<{ capsJson: string; exit: ProcessExit }> {
  const { child, started, exited } = spawnChild(request, request.argv ?? []);
  await started;
  const pgid = child.pid ?? 0;

  // The whole conversation is bounded, measured on the injected clock: an
  // agent that answers nothing and exits never is otherwise a daemon boot that
  // never finishes. Armed before the first byte is read, because the wedge
  // this guards against can happen before the first byte too.
  // An object rather than a `let`, for the reason run-node.ts records: this is
  // assigned from inside a timer callback, and the compiler's control-flow
  // analysis cannot see that assignment — it reads the flag as permanently
  // `false` and the linter says so out loud.
  const timing = { wedged: false };
  const deadline = clock.setTimer(grace.handshakeMs, () => {
    timing.wedged = true;
    signalGroup(pgid, 'SIGKILL');
  });

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: INITIALIZE_ID,
      method: 'initialize',
      params: {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: CLIENT_CAPABILITIES,
        clientInfo: { ...CLIENT_INFO },
      },
    })}\n`,
  );

  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  let capsJson: string | null = null;
  try {
    for await (const line of lines) {
      if (line.trim() === '') continue;
      let frame: { id?: unknown; error?: unknown };
      try {
        frame = JSON.parse(line) as { id?: unknown; error?: unknown };
      } catch {
        // A notification the agent volunteered, or a log line on stdout.
        // Neither answers the request; keep reading.
        continue;
      }
      if (frame.id !== INITIALIZE_ID) continue;
      if (frame.error !== undefined) {
        throw probeFailed(
          `${request.binaryPath} refused initialize: ${JSON.stringify(frame.error)}`,
          { binaryPath: request.binaryPath, error: frame.error },
        );
      }
      capsJson = sliceMember(line, 'result');
      break;
    }
  } finally {
    lines.close();
    // AC1's "and terminates the process". stdin EOF first, because a clean
    // exit leaves a clean transcript; the signal is what a binary that ignores
    // EOF gets, measured on the injected clock like every other deadline.
    child.stdin.end();
    const kill = clock.setTimer(grace.terminateMs, () => {
      signalGroup(pgid, 'SIGKILL');
    });
    await exited;
    kill.cancel();
    deadline.cancel();
  }

  if (capsJson === null) {
    throw probeFailed(
      timing.wedged
        ? `${request.binaryPath} did not answer initialize inside the handshake window and was signalled`
        : `${request.binaryPath} closed without answering initialize, so there is nothing to record`,
      { binaryPath: request.binaryPath, wedged: timing.wedged },
    );
  }
  return { capsJson, exit: await exited };
}

/**
 * Probes one provider and records the row.
 *
 * Throws a tagged `NodeFailureError` when the binary cannot be probed at all.
 * A probe happens outside any node — at daemon start, or under `DeFlow doctor`
 * — so there is no ledger position to hang a `NodeFailure` on; the caller,
 * which has one, maps it through `toAdapterFailure`.
 */
export async function probeProvider(
  request: ProbeRequest,
  ports: ProbePorts,
): Promise<ProbeOutcome> {
  if (!isAbsolute(request.binaryPath)) {
    throw probeFailed(
      `probe needs an absolute binary path, resolved once and persisted; got ` +
        `${JSON.stringify(request.binaryPath)}. DeFlowd's PATH is not the user's login-shell PATH.`,
      { binaryPath: request.binaryPath },
    );
  }

  const binarySha256 = await sha256File(request.binaryPath);
  const version = await readVersion(request);
  const { capsJson, exit } = await handshake(request, ports.clock, {
    terminateMs: ports.terminateGraceMs ?? PROBE_TERMINATE_GRACE_MS,
    handshakeMs: ports.handshakeTimeoutMs ?? PROBE_HANDSHAKE_TIMEOUT_MS,
  });

  const row: CapabilityRow = {
    provider: request.provider,
    version,
    binarySha256,
    binaryPath: request.binaryPath,
    capsJson,
    probedAt: ports.clock.now(),
  };

  const { inserted } = ports.capabilities.record(row);

  // Appended on every probe, including one that changed no row: "we looked
  // again and it was the same binary" is a fact, and the reducer treats
  // `provider.probed` as a per-binary fact rather than run state, so a repeat
  // is idempotent by construction rather than by suppression.
  await ports.ledger.append({
    kind: 'provider.probed',
    v: 1,
    ts: ports.clock.now(),
    payload: {
      provider: row.provider,
      version: row.version,
      capsJson: JSON.parse(row.capsJson) as unknown,
      binarySha256: row.binarySha256,
    },
  });

  return { status: 'probed', row, inserted, exit };
}
