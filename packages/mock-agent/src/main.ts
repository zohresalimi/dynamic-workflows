/**
 * The binary's entry point: argv in, exit code out.
 *
 * The transport is `acp.ndJsonStream` over the process's own stdin and stdout,
 * which is what makes this a real subprocess test target rather than an
 * in-process double. Everything above it — the spawn, the argv, the framing,
 * the pull loop, the teardown — is exercised for real by anything that runs it.
 *
 * The order of the first three steps is the contract. The side-effect log is
 * written before anything else, because it is the record that this invocation
 * happened at all and it has to survive an argv that turns out to be unusable.
 * The scenario is loaded before the transport is opened, because AC1 requires
 * a broken script to produce **no ACP frames**: an agent that writes a
 * handshake and only then notices its script is wrong leaves the client with a
 * half-open session to explain, and the resulting failure points at the client.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import process from 'node:process';
import { PassThrough, Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import {
  type CapabilitiesOptions,
  createMockAgent,
  DEFAULT_CAPABILITIES_OPTIONS,
} from './agent.ts';
import { CAPABILITY_PROFILES } from './capability-profiles.ts';
import {
  BIN_NAME,
  type CapabilitiesSelection,
  DISHONEST_CAPABILITY_METHODS,
  MOCK_AGENT_VERSION,
  type MockAgentOptions,
  parseArgv,
  type ReplaySelection,
  SCENARIO_ENV,
  USAGE,
  VERSION_ENV,
} from './cli.ts';
import { createProcessPorts } from './ports.ts';
import { parseRecording, parseRecordingKey } from './recording.ts';
import { lines, runReplay } from './replay.ts';
import { parseScenario, type Scenario } from './scenario.ts';
import { recordInvocation } from './side-effect-log.ts';

export interface Io {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

const processIo = (): Io => ({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});

/** Exit code for a scenario that could not be read or could not be understood. */
export const SCENARIO_EXIT_CODE = 3;

/** Exit code for a --capabilities-file that could not be read or parsed. */
export const CAPABILITIES_EXIT_CODE = 4;

/**
 * Exit code for a recording that could not be read, understood, or found in a
 * directory named `<provider>@<version>` (KAR-04.5 AC4).
 *
 * Like a broken scenario, this is decided before the transport opens, so a
 * rejected recording produces no ACP frames at all: a client that had already
 * seen a handshake would have a half-open session to explain, and the failure
 * would read as its own.
 */
export const RECORDING_EXIT_CODE = 5;

/**
 * KAR-05.5 — `--wire-log`: every complete line that arrived on stdin, appended
 * to a file before it reaches the transport.
 *
 * A tee rather than a hook inside a handler, because the interesting question
 * is often about a method the agent has **no** handler for: "was a
 * `session/resume` frame sent at all" cannot be answered from inside a
 * `session/resume` handler that was never registered. Split on newlines and
 * written synchronously — a chunk boundary can fall mid-frame, and a partial
 * line in the log would read as a malformed frame that never existed.
 */
function teeToWireLog(stdin: NodeJS.ReadableStream, path: string): NodeJS.ReadableStream {
  const tee = new PassThrough();
  let pending = '';
  stdin.on('data', (bytes: Buffer) => {
    pending += bytes.toString('utf8');
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim() !== '') appendFileSync(path, `${line}\n`);
      newline = pending.indexOf('\n');
    }
    tee.write(bytes);
  });
  stdin.on('end', () => tee.end());
  stdin.on('close', () => tee.end());
  return tee;
}

/** Serves one ACP client over `io`, returning when the connection closes. */
export async function serve(
  options: MockAgentOptions,
  scenario: Scenario | null = null,
  io: Io = processIo(),
  capabilities: CapabilitiesOptions = DEFAULT_CAPABILITIES_OPTIONS,
): Promise<void> {
  const inbound = options.wireLog === null ? io.stdin : teeToWireLog(io.stdin, options.wireLog);
  const stream = acp.ndJsonStream(
    Writable.toWeb(io.stdout as Writable) as WritableStream<Uint8Array>,
    Readable.toWeb(inbound as Readable) as ReadableStream<Uint8Array>,
  );
  // The raw-write port wraps the *same* writable the transport wraps, so a
  // malformed line or a 10 MB flood interleaves with ACP frames in the order
  // the script wrote them rather than in whatever order two fd handles
  // happened to flush in.
  const connection = createMockAgent(
    options,
    scenario,
    createProcessPorts(io.stdout),
    capabilities,
  ).connect(stream);

  try {
    await connection.closed;
  } catch {
    // stdin reaching EOF is how a well-behaved client says "no further request
    // is coming", and the SDK reports the resulting close as an error. There is
    // nothing left to report it to: stderr is the client's diagnostic channel
    // for a *failed* run, and a clean end of input is not one.
  }
}

type LoadResult =
  | { readonly ok: true; readonly scenario: Scenario | null }
  | { readonly ok: false; readonly message: string };

function loadScenario(path: string | null): LoadResult {
  if (path === null || path === '') return { ok: true, scenario: null };

  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    return { ok: false, message: `${path}: cannot read scenario (${code})` };
  }

  const parsed = parseScenario(text, path);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  return { ok: true, scenario: parsed.scenario };
}

type LoadCapabilitiesResult =
  | { readonly ok: true; readonly agentCapabilities: unknown }
  | { readonly ok: false; readonly message: string };

/**
 * Resolves `--capabilities` / `--capabilities-file` into the exact block AC1
 * returns verbatim. `--capabilities-file` does real I/O, so — like scenario
 * loading — this runs after `parseArgv` and before the transport opens: a
 * file that cannot be read or parsed must produce no ACP frames, the same
 * rule KAR-04.2 AC1 applies to a broken scenario.
 */
function loadCapabilities(selection: CapabilitiesSelection): LoadCapabilitiesResult {
  if (selection.kind === 'default') {
    return { ok: true, agentCapabilities: DEFAULT_CAPABILITIES_OPTIONS.agentCapabilities };
  }
  if (selection.kind === 'name') {
    return { ok: true, agentCapabilities: CAPABILITY_PROFILES[selection.name] };
  }

  let text: string;
  try {
    text = readFileSync(selection.path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    return { ok: false, message: `${selection.path}: cannot read capabilities file (${code})` };
  }

  try {
    return { ok: true, agentCapabilities: JSON.parse(text) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `${selection.path}: not valid JSON (${reason})` };
  }
}

/** Real elapsed time, for `--replay-speed real`. */
const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * KAR-04.5 — serves `--replay`, and never touches `acp.agent()`.
 *
 * The ACP SDK is a frame *generator*; a replay is a frame *player*, and putting
 * the player behind the generator would mean the recording's bytes were
 * re-derived from the SDK's idea of what they should be. That is exactly the
 * class of upstream change a golden exists to detect, so the recording is
 * written to stdout as it was recorded.
 */
async function replay(selection: ReplaySelection, io: Io): Promise<number> {
  // The version key first: a recording in a directory named `claude-agent-acp`
  // is refused before anything is read, because a golden that is not keyed on
  // an exact version is silently invalidated by the next vendor release.
  const key = parseRecordingKey(basename(dirname(selection.path)));
  if (!key.ok) {
    io.stderr.write(`${BIN_NAME}: ${selection.path}: ${key.message}\n`);
    return RECORDING_EXIT_CODE;
  }

  let text: string;
  try {
    text = readFileSync(selection.path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    io.stderr.write(`${BIN_NAME}: ${selection.path}: cannot read recording (${code})\n`);
    return RECORDING_EXIT_CODE;
  }

  const parsed = parseRecording(text, selection.path);
  if (!parsed.ok) {
    io.stderr.write(`${BIN_NAME}: ${parsed.message}\n`);
    return RECORDING_EXIT_CODE;
  }

  const inbound = lines(io.stdin as AsyncIterable<Uint8Array>);
  try {
    return await runReplay(parsed.frames, {
      io: {
        inbound,
        write: (chunk) =>
          new Promise((resolve, reject) => {
            io.stdout.write(chunk, (error) => {
              if (error === null || error === undefined) resolve();
              else reject(error);
            });
          }),
        warn: (chunk) => {
          io.stderr.write(`${BIN_NAME}: ${chunk}`);
        },
      },
      speed: selection.speed,
      path: selection.path,
      sleep: realSleep,
    });
  } finally {
    // The recording, not the client, decides when a replay is over. Releasing
    // stdin is what lets the process end on the last recorded frame instead of
    // waiting for a client that has no reason to close it.
    await inbound.return(undefined);
    (io.stdin as Readable).pause?.();
  }
}

export async function run(
  argv: readonly string[],
  io: Io = processIo(),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  recordInvocation(argv, env);

  const parsed = parseArgv(argv);

  if (parsed.kind === 'help') {
    io.stdout.write(USAGE);
    return 0;
  }

  // One line on stdout and nothing else. KAR-05.2 AC2 stores this output
  // verbatim as the manifest's `version` column, so a banner, a build date or
  // a "checking for updates…" line here would end up inside a primary key.
  if (parsed.kind === 'version') {
    io.stdout.write(`${BIN_NAME} ${env[VERSION_ENV] ?? MOCK_AGENT_VERSION}\n`);
    return 0;
  }

  if (parsed.kind === 'error') {
    // Non-zero and loud: a mock that starts anyway after an argument it did not
    // understand produces a green test for a behaviour nobody selected.
    io.stderr.write(`${BIN_NAME}: ${parsed.message}\n\n${USAGE}`);
    return 2;
  }

  // AC1: a replay is driven entirely by the file, so neither --scenario nor
  // $DeFlow_MOCK_SCENARIO is consulted. argv already refused the flag; the
  // environment variable is simply not read, because a spawn that exports it
  // globally should not turn a replay into a scripted turn.
  if (parsed.options.replay !== null) return await replay(parsed.options.replay, io);

  const loaded = loadScenario(parsed.options.scenarioPath ?? env[SCENARIO_ENV] ?? null);
  if (!loaded.ok) {
    // One line, and no usage banner: the reader needs the path and the reason,
    // and a scenario problem is not an argv problem.
    io.stderr.write(`${BIN_NAME}: ${loaded.message}\n`);
    return SCENARIO_EXIT_CODE;
  }

  const loadedCapabilities = loadCapabilities(parsed.options.capabilities);
  if (!loadedCapabilities.ok) {
    io.stderr.write(`${BIN_NAME}: ${loadedCapabilities.message}\n`);
    return CAPABILITIES_EXIT_CODE;
  }

  await serve(parsed.options, loaded.scenario, io, {
    agentCapabilities: loadedCapabilities.agentCapabilities,
    dishonestMethod:
      parsed.options.dishonestCapability === null
        ? null
        : DISHONEST_CAPABILITY_METHODS[parsed.options.dishonestCapability],
  });
  return 0;
}
