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
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { createMockAgent } from './agent.ts';
import { BIN_NAME, type MockAgentOptions, parseArgv, SCENARIO_ENV, USAGE } from './cli.ts';
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

/** Serves one ACP client over `io`, returning when the connection closes. */
export async function serve(
  options: MockAgentOptions,
  scenario: Scenario | null = null,
  io: Io = processIo(),
): Promise<void> {
  const stream = acp.ndJsonStream(
    Writable.toWeb(io.stdout as Writable) as WritableStream<Uint8Array>,
    Readable.toWeb(io.stdin as Readable) as ReadableStream<Uint8Array>,
  );
  const connection = createMockAgent(options, scenario).connect(stream);

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

  if (parsed.kind === 'error') {
    // Non-zero and loud: a mock that starts anyway after an argument it did not
    // understand produces a green test for a behaviour nobody selected.
    io.stderr.write(`${BIN_NAME}: ${parsed.message}\n\n${USAGE}`);
    return 2;
  }

  const loaded = loadScenario(parsed.options.scenarioPath ?? env[SCENARIO_ENV] ?? null);
  if (!loaded.ok) {
    // One line, and no usage banner: the reader needs the path and the reason,
    // and a scenario problem is not an argv problem.
    io.stderr.write(`${BIN_NAME}: ${loaded.message}\n`);
    return SCENARIO_EXIT_CODE;
  }

  await serve(parsed.options, loaded.scenario, io);
  return 0;
}
