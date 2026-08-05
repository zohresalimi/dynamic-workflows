/**
 * What a recording may not carry off the machine it was taken on.
 *
 * A golden recording is a transcript of a real, authenticated session, and the
 * repository it is committed to is public. None of what follows is a
 * credential — which is precisely why it survives review: absolute paths under
 * the developer's home (an nvm node binary, the checkout itself), the temporary
 * directory the spike ran the agent in, the machine's own installed slash
 * commands (Claude Code announces every one of them in a single
 * `available_commands_update` frame), and the vendor's session and message ids.
 *
 * So the redactor sits in the *write* paths rather than in a checklist: the
 * transport tee that captures a live session (`spikes/s1-acp/src/recording.ts`)
 * and the converter that derives a replay recording from a capture
 * (`fromTransportCapture` in ./recording.ts). A recording that reached the disk
 * unredacted would mean one of those two was bypassed, and
 * `test/recordings-scrubbed.test.ts` is the backstop that says so.
 *
 * Three constraints shape every rule below.
 *
 * **Protocol shape is untouched.** `t`, `dir`, method names, JSON-RPC ids, key
 * order, frame order, chunk boundaries: all preserved. Only leaf values change,
 * and only the ones named here. A recording is evidence about a vendor's wire
 * behaviour; a redaction that reshaped it would make it fiction.
 *
 * **Placeholders are deterministic.** Ids are numbered by order of first
 * appearance rather than hashed or randomised, so two runs of the redactor
 * produce the same bytes, a replay stays byte-identical (AC6), and redacting an
 * already-redacted file is a no-op — which is what lets the same function sit
 * in two paths without the second one undoing the first.
 *
 * **A session id stays uuid-shaped.** `session-1` would read better, but the
 * id is a value clients parse and assert on, so the placeholder keeps the shape
 * the vendor used and carries its ordinal in the last group:
 * `00000000-0000-4000-8000-000000000001`.
 */
import { homedir, tmpdir } from 'node:os';
import type { Direction, Json, JsonObject } from './recording.ts';

/** Stands in for the home directory of whoever recorded. */
export const HOME_PLACEHOLDER = '<HOME>';

/** Stands in for the temporary directory the recorded session ran in. */
export const TMPDIR_PLACEHOLDER = '<TMPDIR>';

/** Keys whose string value is a vendor session id. */
const SESSION_KEY = 'sessionId';

/** Keys whose string value is a provider message id (`msg_01…`). */
const MESSAGE_KEY = 'messageId';

/** The frame field that enumerates the machine's installed slash commands. */
const COMMANDS_KEY = 'availableCommands';

export interface RedactionOptions {
  /** Home directory to collapse. Defaults to the running user's. */
  readonly home?: string;
  /** Temporary directory to collapse. Defaults to the platform's. */
  readonly tmpdir?: string;
}

interface Rule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

/** Escapes a literal for embedding in a regular expression. */
const quote = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The path rules, longest match first.
 *
 * The generic home and temp patterns matter more than the machine-specific
 * ones: the recording that leaks is the one taken on a laptop nobody thought
 * about, so "the home directory of whoever happens to run the redactor" is the
 * wrong rule to rely on. macOS reports its temp root two ways in one session —
 * `/var/folders/…` as the session cwd, `/private/var/folders/…` in the tool
 * call that writes there — and both have to go.
 */
function pathRules(options: RedactionOptions): Rule[] {
  const home = options.home ?? homedir();
  const temp = options.tmpdir ?? tmpdir();
  const rules: Rule[] = [];
  const literal = (value: string, replacement: string) => {
    if (value.length > 1) rules.push({ pattern: new RegExp(quote(value), 'g'), replacement });
  };
  literal(`/private${temp}`, TMPDIR_PLACEHOLDER);
  literal(temp, TMPDIR_PLACEHOLDER);
  rules.push({
    pattern: /(?:\/private)?\/var\/folders\/[^/\s"']+\/[^/\s"']+\/T/g,
    replacement: TMPDIR_PLACEHOLDER,
  });
  literal(home, HOME_PLACEHOLDER);
  rules.push({ pattern: /\/(?:Users|home)\/[^/\s"']+/g, replacement: HOME_PLACEHOLDER });
  return rules;
}

/** The index of the `]` closing the `[` at `open`, or -1 if the text ends first. */
function matchingBracket(text: string, open: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = open; index < text.length; index += 1) {
    const character = text[index];
    if (escaped) escaped = false;
    else if (inString) {
      if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
    } else if (character === '"') inString = true;
    else if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * `"availableCommands":[…]` emptied in text that will not parse.
 *
 * Only a frame the capture cut in half reaches here — the structural rule
 * handles every frame that is whole — and half a frame is exactly the case
 * where the list may never be closed, so an unterminated one takes the rest of
 * the text with it.
 */
function stripCommandListText(text: string): string {
  const key = `"${COMMANDS_KEY}"`;
  let out = '';
  let rest = text;
  for (;;) {
    const at = rest.indexOf(key);
    if (at < 0) return out + rest;
    const open = rest.indexOf('[', at);
    const between = open < 0 ? '' : rest.slice(at + key.length, open);
    if (open < 0 || !/^\s*:\s*$/.test(between)) {
      // The key is there but its list is not (yet). Nothing after it can be
      // trusted to be a command list, so the text stops at the key.
      return `${out}${rest.slice(0, at + key.length)}`;
    }
    const close = matchingBracket(rest, open);
    out += `${rest.slice(0, open)}[]`;
    if (close < 0) return out;
    rest = rest.slice(close + 1);
  }
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * One recording's worth of redaction state.
 *
 * The instance is the numbering: ids are per recording, in order of first
 * appearance, so a converter that derives one file from another reproduces the
 * same placeholders rather than inventing a second set.
 */
export class RecordingRedactor {
  readonly #rules: Rule[];
  readonly #ids = new Map<string, string>();
  readonly #pending = new Map<Direction, Uint8Array>();
  #sessions = 0;
  #messages = 0;

  constructor(options: RedactionOptions = {}) {
    this.#rules = pathRules(options);
  }

  /** Path redaction only — for text that is not a frame. */
  paths(text: string): string {
    let out = text;
    for (const rule of this.#rules) out = out.replace(rule.pattern, rule.replacement);
    return out;
  }

  /** One JSON value, redacted at every depth. */
  value(value: Json): Json {
    if (Array.isArray(value)) return value.map((item) => this.value(item));
    if (isObject(value)) {
      const out: JsonObject = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] = this.#field(key, item);
      }
      return out;
    }
    if (typeof value === 'string') return this.#string(value);
    return value;
  }

  /** One complete frame. Text that will not parse is path-redacted instead. */
  frame(text: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return stripCommandListText(this.paths(text));
    }
    return JSON.stringify(this.value(parsed as Json));
  }

  /**
   * A raw transport chunk, redacted to the frames it completed.
   *
   * Chunks are not frames — one chunk can carry two notifications, and one
   * frame can span two chunks — and a frame cannot be redacted until it is
   * whole. So bytes are buffered per direction and come back out with the chunk
   * that completes them, which is also the chunk whose receipt time the
   * recording assigns to the frame. A chunk that completes nothing returns no
   * bytes and writes no line.
   */
  chunk(dir: Direction, bytes: Uint8Array): Uint8Array {
    const buffer = Buffer.concat([this.#pending.get(dir) ?? new Uint8Array(0), bytes]);
    const parts: string[] = [];
    let rest = buffer;
    for (;;) {
      const at = rest.indexOf(0x0a);
      if (at < 0) break;
      const frame = rest.subarray(0, at).toString('utf8');
      rest = rest.subarray(at + 1);
      parts.push(frame.trim() === '' ? frame : this.frame(frame));
    }
    this.#pending.set(dir, rest);
    if (parts.length === 0) return new Uint8Array(0);
    return new Uint8Array(Buffer.from(`${parts.join('\n')}\n`, 'utf8'));
  }

  /** Whatever is still buffered for `dir`: a frame the capture cut in half. */
  flush(dir: Direction): Uint8Array {
    const rest = this.#pending.get(dir) ?? new Uint8Array(0);
    this.#pending.set(dir, new Uint8Array(0));
    if (rest.length === 0) return rest;
    return new Uint8Array(Buffer.from(this.frame(Buffer.from(rest).toString('utf8')), 'utf8'));
  }

  #field(key: string, value: Json): Json {
    if (key === COMMANDS_KEY && Array.isArray(value)) return [];
    if (key === SESSION_KEY && typeof value === 'string') {
      return this.#placeholder(value, () => {
        this.#sessions += 1;
        return `00000000-0000-4000-8000-${String(this.#sessions).padStart(12, '0')}`;
      });
    }
    if (key === MESSAGE_KEY && typeof value === 'string') {
      return this.#placeholder(value, () => {
        this.#messages += 1;
        return `msg-${this.#messages}`;
      });
    }
    return this.value(value);
  }

  #placeholder(value: string, mint: () => string): string {
    const known = this.#ids.get(value);
    if (known !== undefined) return known;
    const minted = mint();
    this.#ids.set(value, minted);
    return minted;
  }

  /** Paths, plus any id this recording has already introduced. */
  #string(value: string): string {
    let out = this.paths(value);
    for (const [id, placeholder] of this.#ids) {
      if (out.includes(id)) out = out.replaceAll(id, placeholder);
    }
    return out;
  }
}

interface RecordingLine {
  readonly header?: Json;
  readonly t?: number;
  readonly dir?: Direction;
  readonly b64?: string;
  readonly msg?: Json;
}

/**
 * A whole recording file, in either shape it comes in: the raw transport
 * capture a spike's tee writes (`b64` chunks) and the replay recording the
 * converter derives from it (`msg` frames). Line order, offsets and directions
 * come out exactly as they went in.
 */
export function redactRecording(text: string, options: RedactionOptions = {}): string {
  const redactor = new RecordingRedactor(options);
  const out: string[] = [];
  const last = new Map<Direction, { t: number }>();

  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    let line: RecordingLine;
    try {
      line = JSON.parse(raw) as RecordingLine;
    } catch {
      out.push(redactor.paths(raw));
      continue;
    }
    if (line.header !== undefined) {
      out.push(JSON.stringify({ header: redactor.value(line.header) }));
      continue;
    }
    const t = line.t ?? 0;
    const dir = line.dir;
    if (dir !== undefined && line.b64 !== undefined) {
      last.set(dir, { t });
      const bytes = redactor.chunk(dir, new Uint8Array(Buffer.from(line.b64, 'base64')));
      if (bytes.length === 0) continue;
      out.push(JSON.stringify({ t, dir, b64: Buffer.from(bytes).toString('base64') }));
      continue;
    }
    if (dir !== undefined && line.msg !== undefined) {
      out.push(JSON.stringify({ t, dir, msg: redactor.value(line.msg) }));
      continue;
    }
    out.push(redactor.paths(raw));
  }

  // A capture that ended mid-frame still has bytes to account for, and they are
  // attributed to the last chunk that carried any.
  for (const dir of ['in', 'out'] as const) {
    const rest = redactor.flush(dir);
    if (rest.length === 0) continue;
    out.push(
      JSON.stringify({
        t: last.get(dir)?.t ?? 0,
        dir,
        b64: Buffer.from(rest).toString('base64'),
      }),
    );
  }

  return out.length === 0 ? '' : `${out.join('\n')}\n`;
}
