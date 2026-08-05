/**
 * The binary's entry point: argv in, exit code out.
 *
 * The transport is `acp.ndJsonStream` over the process's own stdin and stdout,
 * which is what makes this a real subprocess test target rather than an
 * in-process double. Everything above it — the spawn, the argv, the framing,
 * the pull loop, the teardown — is exercised for real by anything that runs it.
 */
import process from 'node:process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { createMockAgent } from './agent.ts';
import { BIN_NAME, type MockAgentOptions, parseArgv, USAGE } from './cli.ts';

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

/** Serves one ACP client over `io`, returning when the connection closes. */
export async function serve(options: MockAgentOptions, io: Io = processIo()): Promise<void> {
  const stream = acp.ndJsonStream(
    Writable.toWeb(io.stdout as Writable) as WritableStream<Uint8Array>,
    Readable.toWeb(io.stdin as Readable) as ReadableStream<Uint8Array>,
  );
  const connection = createMockAgent(options).connect(stream);

  try {
    await connection.closed;
  } catch {
    // stdin reaching EOF is how a well-behaved client says "no further request
    // is coming", and the SDK reports the resulting close as an error. There is
    // nothing left to report it to: stderr is the client's diagnostic channel
    // for a *failed* run, and a clean end of input is not one.
  }
}

export async function run(argv: readonly string[], io: Io = processIo()): Promise<number> {
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

  await serve(parsed.options, io);
  return 0;
}
