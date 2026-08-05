/**
 * The golden-recording format: `recordings/<provider>@<version>/<case>.ndjson`,
 * one JSON object per line, `{"t": <msOffset>, "dir": "in"|"out", "msg": {…}}`
 * (docs/07-provider-adapter-layer.md §11.4).
 *
 * Three decisions are worth stating.
 *
 * **`dir` is written from the agent's point of view.** `"in"` is a frame the
 * agent received; `"out"` is one it wrote. Replay serves the agent's side, so
 * this is the perspective that lets a recording be read straight down the file.
 * A capture taken on the client side is byte-identical apart from those two
 * labels, which makes mixing them up both easy and silent — so the parser
 * refuses a recording whose first frame is `"out"`. In ACP the client always
 * speaks first, so an agent-relative recording always opens inbound.
 *
 * **The directory name is the version key, and it must carry an exact
 * version.** `claude-agent-acp@latest` would let a vendor release silently
 * invalidate every golden underneath it; `claude-agent-acp@0.64.1` makes a
 * version bump a new directory in a pull request, which is the whole point.
 *
 * **`id` and `_meta` are the only two fields a client is entitled to differ
 * on.** A naive `deepEqual` fails on the first JSON-RPC id; comparing only
 * `method` would call a completely different prompt a match. `_meta` is
 * stripped at every depth because it is ACP's extension bag wherever it
 * appears; `id` only at the top level, because a plan entry's `id` or an MCP
 * server's `id` is content.
 */
import { unifiedDiff } from './diff.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export type Direction = 'in' | 'out';

/** The shape a recording directory's name must have, quoted in every rejection. */
export const RECORDING_DIR_SHAPE = '<provider>@<version>';

/** Where a raw transport capture is turned into a replay recording. */
const CONVERTER = 'packages/mock-agent/scripts/capture-to-replay.ts';

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

export interface RecordingKey {
  readonly provider: string;
  readonly version: string;
}

export type RecordingKeyResult =
  | { readonly ok: true; readonly key: RecordingKey }
  | { readonly ok: false; readonly message: string };

/** Splits `claude-agent-acp@0.64.1` into its provider and its exact version. */
export function parseRecordingKey(dirName: string): RecordingKeyResult {
  const at = dirName.lastIndexOf('@');
  const provider = at <= 0 ? '' : dirName.slice(0, at);
  const version = at < 0 ? '' : dirName.slice(at + 1);
  if (provider === '' || !EXACT_VERSION.test(version)) {
    return {
      ok: false,
      message:
        `recording directory "${dirName}" is not named ${RECORDING_DIR_SHAPE} with an ` +
        `exact version (for example "claude-agent-acp@0.64.1"). A moving tag such as ` +
        `"@latest" is refused on purpose: a vendor release would silently invalidate ` +
        `every golden in the directory instead of producing a new one in a pull request.`,
    };
  }
  return { ok: true, key: { provider, version } };
}

export interface RecordedFrame {
  /** 1-based line number in the ndjson file, quoted in every mismatch. */
  readonly line: number;
  /** Milliseconds since the recorded transport opened. */
  readonly t: number;
  readonly dir: Direction;
  readonly msg: JsonObject;
}

export type RecordingResult =
  | {
      readonly ok: true;
      readonly frames: readonly RecordedFrame[];
      readonly header: JsonObject | null;
    }
  | { readonly ok: false; readonly message: string };

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseRecording(text: string, path = '<recording>'): RecordingResult {
  const fail = (message: string): RecordingResult => ({
    ok: false,
    message: `${path}: ${message}`,
  });
  const lines = text.split('\n');
  const frames: RecordedFrame[] = [];
  let header: JsonObject | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const number = index + 1;
    if (raw.trim() === '') continue;

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return fail(`line ${number} is not JSON (${reason})`);
    }
    if (!isObject(value)) return fail(`line ${number} is not a JSON object`);

    if (value['header'] !== undefined) {
      if (frames.length > 0) {
        return fail(`line ${number} carries a header after a frame; the header is the first line`);
      }
      header = isObject(value['header']) ? value['header'] : null;
      continue;
    }

    const dir = value['dir'];
    if (dir !== 'in' && dir !== 'out') {
      return fail(`line ${number} has dir ${JSON.stringify(dir)}, expected "in" or "out"`);
    }

    const msg = value['msg'];
    if (msg === undefined) {
      if (value['b64'] !== undefined) {
        return fail(
          `line ${number} has "b64" but no "msg" — that is a raw transport capture, ` +
            `whose lines are chunks rather than frames. Convert it with ${CONVERTER}.`,
        );
      }
      return fail(`line ${number} has no "msg"`);
    }
    if (!isObject(msg)) return fail(`line ${number}: "msg" is not a JSON object`);

    const t = value['t'];
    if (typeof t !== 'number' || !Number.isFinite(t)) {
      return fail(`line ${number} has no numeric "t" offset`);
    }

    if (frames.length === 0 && dir === 'out') {
      return fail(
        `line ${number} is the first frame and is outbound. A replay recording is ` +
          `written from the agent's perspective, and in ACP the client always speaks ` +
          `first, so this file was captured from the client's perspective. Convert it ` +
          `with ${CONVERTER}.`,
      );
    }

    frames.push({ line: number, t, dir, msg });
  }

  if (frames.length === 0) return fail('no frames');
  return { ok: true, frames, header };
}

/**
 * The frame as it is compared: `_meta` gone at every depth, the top-level
 * JSON-RPC `id` gone, and every object's keys in a fixed order so that two
 * clients serialising the same frame differently still match.
 */
function comparable(value: Json, top = false): Json {
  if (Array.isArray(value)) return value.map((item) => comparable(item));
  if (!isObject(value)) return value;
  const out: JsonObject = {};
  for (const key of Object.keys(value).sort()) {
    if (key === '_meta') continue;
    if (top && key === 'id') continue;
    out[key] = comparable(value[key] as Json);
  }
  return out;
}

/** The comparable form, pretty-printed — the text a diff is taken over. */
export function comparableText(msg: JsonObject): string {
  return JSON.stringify(comparable(msg, true), null, 2);
}

/** AC2 — equal modulo the JSON-RPC `id` and every `_meta`. */
export function framesEqual(recorded: JsonObject, received: JsonObject): boolean {
  return comparableText(recorded) === comparableText(received);
}

/** AC2 — a unified diff of the two frames, in their comparable form. */
export function frameDiff(recorded: JsonObject, received: JsonObject): string {
  return unifiedDiff(comparableText(recorded), comparableText(received), {
    fromLabel: 'recorded',
    toLabel: 'received',
  });
}

export interface CaptureConversionOptions {
  /** Recorded in the derived file's header, so provenance survives review. */
  readonly derivedFrom?: string;
  /** Keeps only the first n frames, so a case can be a prefix of a session. */
  readonly frameLimit?: number;
}

const NEWLINE = 0x0a;

/**
 * Turns a raw transport capture into a replay recording.
 *
 * A capture is written by a tee in the *client's* transport: each line is a
 * base64 chunk as it left or arrived at the socket, `"out"` meaning the client
 * wrote it. Two things follow. Chunks are not frames — one chunk can carry two
 * notifications, and one frame can span two chunks — so the bytes are re-framed
 * per direction. And every direction label flips, because replay serves the
 * other end of the same wire.
 */
export function fromTransportCapture(text: string, options: CaptureConversionOptions = {}): string {
  const pending: Record<Direction, Buffer> = { in: Buffer.alloc(0), out: Buffer.alloc(0) };
  const out: string[] = [];
  let header: JsonObject | null = null;
  const frames: { t: number; dir: Direction; msg: JsonObject }[] = [];

  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    const line = JSON.parse(raw) as JsonObject;
    if (line['header'] !== undefined) {
      header = isObject(line['header']) ? line['header'] : null;
      continue;
    }
    const dir = line['dir'];
    if (dir !== 'in' && dir !== 'out') throw new Error(`unknown direction ${JSON.stringify(dir)}`);
    const b64 = line['b64'];
    if (typeof b64 !== 'string') throw new Error('a capture line carries no "b64" chunk');
    const t = typeof line['t'] === 'number' ? line['t'] : 0;

    pending[dir] = Buffer.concat([pending[dir], Buffer.from(b64, 'base64')]);
    for (;;) {
      const at = pending[dir].indexOf(NEWLINE);
      if (at < 0) break;
      const frame = pending[dir].subarray(0, at).toString('utf8');
      pending[dir] = pending[dir].subarray(at + 1);
      if (frame.trim() === '') continue;
      const msg = JSON.parse(frame) as Json;
      if (!isObject(msg)) throw new Error(`a captured frame is not a JSON object: ${frame}`);
      // The flip: what the client wrote is what the agent received.
      frames.push({ t, dir: dir === 'out' ? 'in' : 'out', msg });
    }
  }

  const kept = options.frameLimit === undefined ? frames : frames.slice(0, options.frameLimit);

  if (header !== null || options.derivedFrom !== undefined) {
    out.push(
      JSON.stringify({
        header: {
          ...(header ?? {}),
          ...(options.derivedFrom === undefined ? {} : { derivedFrom: options.derivedFrom }),
          perspective: 'agent',
        },
      }),
    );
  }
  for (const frame of kept) out.push(JSON.stringify(frame));
  return `${out.join('\n')}\n`;
}
