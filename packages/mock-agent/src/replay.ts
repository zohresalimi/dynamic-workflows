/**
 * `--replay <file>`: a captured real session served as a provider.
 *
 * Nothing in this path touches `acp.agent()`, the id factory or the synthetic
 * clock. The engine walks the recording, writes every `"out"` frame verbatim
 * and reads every `"in"` frame off stdin to compare it with what was recorded.
 * That is what makes AC6 true by construction: with no generator anywhere in
 * the loop there is nothing for `--seed` to influence, and two replays of one
 * file write the same bytes.
 *
 * **The one substitution.** A response carries the id of the request it
 * answers, and the client's id is not the recording's: the SDK's client
 * numbers its outbound requests from 0, while the capture under
 * `recordings/claude-agent-acp@0.64.1/` was taken with a client that numbered
 * from 1. Emitting the recorded id would leave the client's promise pending
 * for ever, and AC2's "compare modulo id" would be a tolerance with nothing
 * behind it — the replay would accept a differently-numbered client and then
 * fail to answer it. So the recorded id decides *which* pending request a
 * recorded response answers, and the client's own id goes on the wire.
 * Requests the agent originates (`session/request_permission`) keep their
 * recorded id, because there the recording is the originator.
 *
 * **Truncation is answered, never waited out** (AC5). A capture that ends
 * mid-turn — a crashed recorder, a killed vendor CLI — leaves a `session/prompt`
 * with no response in the file. The engine answers it with a declared
 * `stopReason` and says on stderr that the recording was truncated, because a
 * replay that instead blocked would present itself to the layer above as a
 * hung agent and send someone hunting for a timeout bug that does not exist.
 */
import {
  frameDiff,
  framesEqual,
  type Json,
  type JsonObject,
  type RecordedFrame,
} from './recording.ts';

export const REPLAY_SPEEDS = ['real', 'max'] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** CI's default: recorded cadence is a property worth having, not worth waiting for. */
export const DEFAULT_REPLAY_SPEED: ReplaySpeed = 'max';

/** A client frame that is not the recorded one. */
export const REPLAY_MISMATCH_EXIT_CODE = 6;

/** The recording ended mid-turn; the session was terminated rather than hung. */
export const REPLAY_TRUNCATED_EXIT_CODE = 7;

/** The client closed stdin with frames still to come. */
export const REPLAY_STDIN_EXIT_CODE = 8;

export interface ReplayIo {
  /** Inbound ndjson lines. `done` is the client closing stdin. */
  readonly inbound: AsyncIterator<string>;
  /** Writes to stdout, resolving once the bytes are flushed. */
  write(text: string): Promise<void>;
  /** Writes a diagnostic to stderr. */
  warn(text: string): void;
}

export interface ReplayRun {
  readonly io: ReplayIo;
  readonly speed: ReplaySpeed;
  /** The recording's path, quoted in every diagnostic. */
  readonly path: string;
  /** Time enters here and nowhere else. */
  sleep(ms: number): Promise<void>;
}

/** A client request whose recorded response has not been emitted yet. */
interface PendingRequest {
  readonly method: string;
  /** The id the client actually used, which is the id its response must carry. */
  readonly actualId: Json;
  readonly line: number;
}

const idKey = (id: Json): string => JSON.stringify(id);

function isResponse(msg: JsonObject): boolean {
  return msg['id'] !== undefined && (msg['result'] !== undefined || msg['error'] !== undefined);
}

function isRequest(msg: JsonObject): boolean {
  return typeof msg['method'] === 'string' && msg['id'] !== undefined;
}

/** Serves one recording. Returns the process exit code. */
export async function runReplay(frames: readonly RecordedFrame[], run: ReplayRun): Promise<number> {
  /** recorded id → the id the client used, for every request still in flight. */
  const pending = new Map<string, PendingRequest>();
  /** The same mapping, kept after the answer, so a late frame still resolves. */
  const clientIds = new Map<string, Json>();

  let lastT = frames[0]?.t ?? 0;

  const emit = async (frame: RecordedFrame): Promise<void> => {
    if (run.speed === 'real') {
      const delta = frame.t - lastT;
      if (delta > 0) await run.sleep(delta);
    }
    lastT = frame.t;

    let msg = frame.msg;
    if (isResponse(msg)) {
      const key = idKey(msg['id'] as Json);
      const actualId = clientIds.get(key);
      if (actualId !== undefined) msg = { ...msg, id: actualId };
      pending.delete(key);
    }
    await run.io.write(`${JSON.stringify(msg)}\n`);
  };

  const nextInboundLine = async (): Promise<string | null> => {
    for (;;) {
      const read = await run.io.inbound.next();
      if (read.done === true) return null;
      const line = read.value;
      if (line.trim() !== '') return line;
    }
  };

  for (const frame of frames) {
    if (frame.dir === 'out') {
      await emit(frame);
      continue;
    }

    const line = await nextInboundLine();
    if (line === null) {
      run.io.warn(
        `${run.path}:${frame.line}: the client closed stdin before sending the recorded ` +
          `${describe(frame.msg)}; the recording still had frames to replay.\n`,
      );
      return REPLAY_STDIN_EXIT_CODE;
    }

    let received: unknown;
    try {
      received = JSON.parse(line);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      run.io.warn(
        `${run.path}:${frame.line}: the client sent a line that is not JSON (${reason})\n`,
      );
      return REPLAY_MISMATCH_EXIT_CODE;
    }
    if (typeof received !== 'object' || received === null || Array.isArray(received)) {
      run.io.warn(`${run.path}:${frame.line}: the client sent a frame that is not an object\n`);
      return REPLAY_MISMATCH_EXIT_CODE;
    }
    const actual = received as JsonObject;

    if (!framesEqual(frame.msg, actual)) {
      run.io.warn(
        `${run.path}:${frame.line}: the client frame does not match the recorded ` +
          `"in" frame (compared modulo JSON-RPC id and _meta)\n` +
          frameDiff(frame.msg, actual),
      );
      return REPLAY_MISMATCH_EXIT_CODE;
    }

    lastT = frame.t;

    if (isRequest(frame.msg)) {
      const key = idKey(frame.msg['id'] as Json);
      const actualId = actual['id'] ?? (frame.msg['id'] as Json);
      clientIds.set(key, actualId);
      pending.set(key, {
        method: frame.msg['method'] as string,
        actualId,
        line: frame.line,
      });
    }
  }

  if (pending.size === 0) return 0;

  // AC5. Everything the client is still waiting on gets an answer, oldest
  // first, so the layer above unwinds in the order it stacked up.
  const unanswered = [...pending.values()];
  for (const request of unanswered) {
    const msg: JsonObject =
      request.method === 'session/prompt'
        ? { jsonrpc: '2.0', id: request.actualId, result: { stopReason: 'cancelled' } }
        : {
            jsonrpc: '2.0',
            id: request.actualId,
            error: {
              code: -32001,
              message: `recording truncated: ${run.path} ends before ${request.method} was answered`,
            },
          };
    await run.io.write(`${JSON.stringify(msg)}\n`);
  }

  run.io.warn(
    `${run.path}: recording truncated — the capture ends mid-turn with ` +
      `${unanswered.map((request) => `${request.method} (line ${request.line})`).join(', ')} ` +
      `unanswered. The session was terminated with stopReason "cancelled" rather than ` +
      `left hanging.\n`,
  );
  return REPLAY_TRUNCATED_EXIT_CODE;
}

function describe(msg: JsonObject): string {
  const method = msg['method'];
  if (typeof method === 'string') return `${method} request`;
  return 'response';
}

/** Splits a byte stream into ndjson lines, for the binary's real stdin. */
export async function* lines(stream: AsyncIterable<Uint8Array | string>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of stream) {
    buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    for (;;) {
      const at = buffer.indexOf('\n');
      if (at < 0) break;
      yield buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
    }
  }
  if (buffer.trim() !== '') yield buffer;
}
