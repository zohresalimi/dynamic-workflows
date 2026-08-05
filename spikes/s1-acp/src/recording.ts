/**
 * The transport tee.
 *
 * Every byte in either direction is written here *before* anything parses it,
 * because a recording of the parsed interpretation records the client's
 * opinion rather than the agent's behaviour — and the whole point of the spike
 * is that the two had never been compared. Each line carries the client-side
 * receipt time, which is what makes the streaming claim in AC4 a measurement
 * rather than an impression.
 *
 * These recordings are the seed of `recordings/<provider>@<exact-version>/`
 * that EPIC-05's golden suite replays.
 *
 * Which is also why nothing reaches the file un-redacted. A capture is a
 * transcript of a real session on somebody's laptop and `recordings/` is
 * public, so the tee writes through `RecordingRedactor` — the same class the
 * replay-side converter uses, imported from its source because this spike
 * carries its own two dependencies and must not gain a third.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RecordingRedactor } from '../../../packages/mock-agent/src/redaction.ts';
import { CappedLineFramer } from './framing.ts';

export type Direction = 'in' | 'out';

/** Metadata about the run, not about any frame. Always the first line. */
export interface RecordingHeader {
  readonly agent: string;
  readonly version: string;
  readonly command: string;
  readonly args: readonly string[];
  /** The session cwd the live run used; replay reuses it so frames match. */
  readonly cwd: string;
  readonly startedAt: string;
  readonly frameCapBytes: number;
}

export interface RecordingEntry {
  /** Milliseconds since the transport opened, from the injected clock. */
  readonly t: number;
  readonly dir: Direction;
  readonly bytes: Uint8Array;
  /** The chunk decoded as UTF-8. For grepping, never for framing. */
  readonly raw: string;
}

export interface RecordedFrame {
  /** Receipt time of the chunk that completed this line. */
  readonly t: number;
  readonly dir: Direction;
  readonly text: string;
  readonly json: JsonValue;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

const decoder = new TextDecoder();

/**
 * Appends redacted chunks to an ndjson file, header first.
 *
 * A chunk is written when it completes at least one frame, carrying every frame
 * it completed — which is the chunk whose receipt time the recording already
 * attributed to those frames, so no timing moves. A frame that spans two chunks
 * is held until the second, because half a frame cannot be redacted.
 */
export class Recorder {
  readonly #path: string;
  readonly #redactor = new RecordingRedactor();
  /** Receipt time of the last chunk seen in each direction, for `close()`. */
  readonly #lastT = new Map<Direction, number>();

  constructor(path: string, header: RecordingHeader) {
    this.#path = path;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${this.#redactor.frame(JSON.stringify({ header }))}\n`);
  }

  note(t: number, dir: Direction, bytes: Uint8Array): void {
    this.#lastT.set(dir, t);
    this.#append(t, dir, this.#redactor.chunk(dir, bytes));
  }

  /** Writes out a frame the session ended in the middle of, and nothing else. */
  close(): void {
    for (const dir of ['in', 'out'] as const) {
      this.#append(this.#lastT.get(dir) ?? 0, dir, this.#redactor.flush(dir));
    }
  }

  #append(t: number, dir: Direction, bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const line = JSON.stringify({
      t: Number(t.toFixed(3)),
      dir,
      b64: Buffer.from(bytes).toString('base64'),
    });
    appendFileSync(this.#path, `${line}\n`);
  }
}

interface RawLine {
  readonly header?: RecordingHeader;
  readonly t?: number;
  readonly dir?: Direction;
  readonly b64?: string;
}

function parse(path: string): RawLine[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as RawLine);
}

export function readHeader(path: string): RecordingHeader {
  const first = parse(path)[0];
  if (!first?.header) throw new Error(`${path} has no header line`);
  return first.header;
}

export function readRecording(path: string): RecordingEntry[] {
  const entries: RecordingEntry[] = [];
  for (const line of parse(path)) {
    if (line.header || line.b64 === undefined || line.dir === undefined) continue;
    const bytes = new Uint8Array(Buffer.from(line.b64, 'base64'));
    entries.push({ t: line.t ?? 0, dir: line.dir, bytes, raw: decoder.decode(bytes) });
  }
  return entries;
}

/**
 * Re-frames the recorded chunks per direction. A frame's timestamp is the
 * receipt time of the chunk that carried its terminating newline, which is the
 * earliest moment the client could have acted on it.
 */
export function readFrames(entries: readonly RecordingEntry[]): RecordedFrame[] {
  const framers: Record<Direction, CappedLineFramer> = {
    in: new CappedLineFramer(),
    out: new CappedLineFramer(),
  };
  const frames: RecordedFrame[] = [];
  for (const entry of entries) {
    for (const line of framers[entry.dir].push(entry.bytes)) {
      const decoded = decoder.decode(line);
      if (decoded.trim() === '') continue;
      frames.push({
        t: entry.t,
        dir: entry.dir,
        text: decoded,
        json: JSON.parse(decoded) as JsonValue,
      });
    }
  }
  return frames;
}

/** Client-side receipt times of every inbound `session/update` notification. */
export function sessionUpdateArrivals(entries: readonly RecordingEntry[]): number[] {
  return readFrames(entries)
    .filter(
      (frame) =>
        frame.dir === 'in' &&
        typeof frame.json === 'object' &&
        frame.json !== null &&
        !Array.isArray(frame.json) &&
        frame.json['method'] === 'session/update',
    )
    .map((frame) => frame.t);
}
