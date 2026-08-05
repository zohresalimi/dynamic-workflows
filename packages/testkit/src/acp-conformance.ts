/**
 * KAR-05.7 Layer A — every recorded frame, validated against the published ACP
 * schema (docs/07-provider-adapter-layer.md §11.2).
 *
 * **There is no official ACP conformance kit.** Verified negative, 2026-08-02:
 * the `agentclientprotocol/agent-client-protocol` repo has no `conformance/`,
 * `compliance/` or `tests/` directory, and `@agentclientprotocol/conformance`,
 * `acp-conformance` and `@agentclientprotocol/test-kit` all 404 on npm. Web
 * search will confidently assert otherwise; that claim conflates it with an
 * unrelated academic protocol also abbreviated ACP. **Do not chase it.** What
 * does exist is `schema.json` — 262 `$defs` — and `ajv`, which arrives
 * transitively via the MCP SDK. So this layer is free, offline, and it fires
 * the instant an upstream SDK bump changes the wire shape.
 *
 * Three decisions are worth stating.
 *
 * **Validation dispatches on the method, not on the top-level union.** The
 * schema's root is `anyOf: [Agent, Client, ProtocolLevel]` and every one of
 * those branches accepts a `session/update` carrying a `sessionUpdate` nobody
 * has ever heard of, because some other arm of the union always matches.
 * Measured, not assumed: the first version of this file validated whole frames
 * that way and the deliberately-invalid fixture passed. So each frame is
 * validated against the `$def` its *method* names, and the recorded direction
 * is checked against the side the schema says may send it — which is what
 * makes a capture recorded from the wrong perspective fail rather than pass.
 *
 * **The report names file, line and JSON pointer.** A validator that answers
 * "the corpus is broken" is a validator nobody uses. With ajv's `allErrors`
 * under an `anyOf` the error list is long and mostly noise, so the deepest
 * `instancePath` is what gets reported: it is the one that says which *field*
 * moved.
 *
 * **A capture comes in two shapes and both are read here.** The transport tee
 * writes `{t, dir, msg}` frames; the spike's raw tee wrote `{t, dir, b64}`
 * chunks from the client's perspective. Chunks are not frames — one chunk can
 * carry two notifications and one frame can span two chunks — so the bytes are
 * re-framed per direction and the labels flipped, and only then validated. A
 * reader that treated a chunk line as a frame would validate garbage and pass.
 */

import { parseRecordingKey } from '@DeFlow/mock-agent';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';

/** The `$defs` count measured against `@agentclientprotocol/sdk@1.3.0`. */
export const ACP_SCHEMA_DEFS = 262;

export const ACP_SCHEMA_PATH = ((): string => {
  // `import.meta.resolve` rather than a relative walk into node_modules: pnpm's
  // store layout is not a path you can spell, and the SDK is a dependency of
  // this package precisely so the resolver can answer this.
  const url = import.meta.resolve('@agentclientprotocol/sdk/schema/schema.json');
  return url.startsWith('file://') ? new URL(url).pathname : url;
})();

let cachedSchema: Record<string, unknown> | null = null;

export function acpSchema(): Record<string, unknown> {
  cachedSchema ??= JSON.parse(readFileSync(ACP_SCHEMA_PATH, 'utf8')) as Record<string, unknown>;
  return cachedSchema;
}

/** `"in"` is a frame the **agent** received; `"out"` one it wrote. */
export type FrameDirection = 'in' | 'out';

export interface CapturedFrame {
  readonly file: string;
  /** 1-based line in the ndjson file. For a re-framed chunk capture, the line
   * whose bytes completed the frame — which is where a reader has to look. */
  readonly line: number;
  readonly dir: FrameDirection;
  /** `null` when the recorded bytes were not JSON at all. */
  readonly msg: Record<string, unknown> | null;
  /** The recorded text, kept for the frames that did not parse. */
  readonly text?: string;
}

export interface SchemaViolation {
  readonly file: string;
  readonly line: number;
  /** A JSON pointer into the frame, or `''` when the frame is not JSON. */
  readonly pointer: string;
  readonly keyword: string;
  readonly message: string;
}

const NEWLINE = 0x0a;
const decoder = new TextDecoder();

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Every frame in one recording, in file order, from either capture shape.
 *
 * Lines that are not frames — the header, stderr, the exit status — are
 * skipped rather than rejected: they are facts about the process, and the ACP
 * schema has nothing to say about them.
 */
export function readCapturedFrames(text: string, file: string): CapturedFrame[] {
  const frames: CapturedFrame[] = [];
  const pending: Record<FrameDirection, Uint8Array> = {
    in: new Uint8Array(0),
    out: new Uint8Array(0),
  };
  const lines = text.split('\n');

  const push = (line: number, dir: FrameDirection, body: string): void => {
    if (body.trim() === '') return;
    try {
      const parsed: unknown = JSON.parse(body);
      frames.push({ file, line, dir, msg: isObject(parsed) ? parsed : null, text: body });
    } catch {
      frames.push({ file, line, dir, msg: null, text: body });
    }
  };

  for (const [index, raw] of lines.entries()) {
    const number = index + 1;
    if (raw.trim() === '') continue;
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value['header'] !== undefined) continue;
    if (value['stderr'] !== undefined || value['exit'] !== undefined) continue;

    const dir = value['dir'];
    if (dir !== 'in' && dir !== 'out') continue;

    if (value['msg'] !== undefined) {
      const msg = value['msg'];
      frames.push({ file, line: number, dir, msg: isObject(msg) ? msg : null });
      continue;
    }
    if (typeof value['raw'] === 'string') {
      push(number, dir, value['raw']);
      continue;
    }
    if (typeof value['b64'] !== 'string') continue;

    // A raw transport capture, written on the *client's* side: re-frame the
    // bytes and flip the label, because replay serves the other end of the
    // same wire.
    const flipped: FrameDirection = dir === 'out' ? 'in' : 'out';
    const chunk = Buffer.from(value['b64'], 'base64');
    const buffer = new Uint8Array(pending[dir].length + chunk.length);
    buffer.set(pending[dir]);
    buffer.set(chunk, pending[dir].length);
    let from = 0;
    for (;;) {
      const at = buffer.indexOf(NEWLINE, from);
      if (at === -1) break;
      push(number, flipped, decoder.decode(buffer.subarray(from, at)));
      from = at + 1;
    }
    pending[dir] = buffer.subarray(from);
  }

  return frames;
}

/**
 * One ACP method, and the `$defs` its params and result have to satisfy.
 *
 * **This table is derived from the schema, never authored.** The
 * `ClientRequest`/`AgentRequest` unions carry no `const` on `method`, so their
 * arms cannot be dispatched on — validating a whole frame against the union
 * accepts `{"method":"session/update","params":{"update":{"sessionUpdate":
 * "anything_at_all"}}}`, because some other arm always matches. Measured, not
 * assumed: that is exactly what the first version of this file did, and the
 * deliberately-invalid fixture passed.
 *
 * What the schema *does* carry is `x-method` and `x-side` on each payload
 * `$def`, which is the dispatch table spelled out — 74 of the 262 `$defs`
 * carry it. Reading it means an SDK bump that adds, renames or moves a method
 * changes this table on the next install rather than leaving an authored copy
 * quietly behind, which is the failure a conformance layer exists to prevent
 * rather than to have.
 *
 * `x-side` names the **receiver**, so the sender is its opposite; `both` and
 * `protocol` are the two values that constrain neither side.
 */
export interface AcpMethodSpec {
  /** Which side may send it, or `null` where the schema constrains neither. */
  readonly from: 'client' | 'agent' | null;
  /** The `$def` for a request's or notification's `params`. */
  readonly params?: string;
  /** The `$def` for a response's `result`. */
  readonly result?: string;
}

const OPPOSITE: Readonly<Record<string, 'client' | 'agent' | null>> = {
  client: 'agent',
  agent: 'client',
  both: null,
  protocol: null,
};

function deriveMethods(): Record<string, AcpMethodSpec> {
  const defs = acpSchema().$defs as Record<string, Record<string, unknown>>;
  const table: Record<string, AcpMethodSpec> = {};

  for (const [name, def] of Object.entries(defs)) {
    const method = def['x-method'];
    if (typeof method !== 'string') continue;
    const from = OPPOSITE[String(def['x-side'])] ?? null;
    const previous: AcpMethodSpec = table[method] ?? { from: null };
    if (name.endsWith('Response')) {
      // Deliberately not touching `from`. `x-side` is the side that *handles*
      // the method, so it is the same value on the request and the response —
      // and only the request's direction is a fact about the wire that a
      // recording can be checked against.
      table[method] = { ...previous, result: name };
      continue;
    }
    // A request and a notification both describe what travels in `params`;
    // the schema never gives one method both.
    table[method] = { ...previous, from, params: name };
  }

  return table;
}

/** Every ACP method the installed schema describes, keyed by method name. */
export const ACP_METHODS: Readonly<Record<string, AcpMethodSpec>> = deriveMethods();

/** Who wrote a frame, given the direction it was recorded in. */
const author = (dir: FrameDirection): 'client' | 'agent' => (dir === 'in' ? 'client' : 'agent');

const compiled = new Map<string, ValidateFunction>();
let ajv: InstanceType<typeof Ajv2020.default> | null = null;

/** A validator for one `$def` of the real schema, compiled once per run. */
function validatorFor(definition: string): ValidateFunction {
  const cached = compiled.get(definition);
  if (cached !== undefined) return cached;
  if (ajv === null) {
    // strict: false because the schema is generated from Rust types and carries
    // formats ajv has no opinion about (`uint32`, `int64`); logger: false
    // because ajv narrates every one of them and drowns the run.
    ajv = new Ajv2020.default({ allErrors: true, strict: false, logger: false });
    ajv.addSchema(acpSchema(), 'acp');
  }
  const validate = ajv.compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: `acp#/$defs/${definition}`,
  });
  compiled.set(definition, validate);
  return validate;
}

/**
 * The deepest error, which is the one that says which field moved.
 *
 * Under a top-level `anyOf` every branch contributes a rejection, and the
 * shallow ones all say the same uninformative thing about the frame as a
 * whole. Sorting by pointer depth is what turns the list into a location.
 */
function deepest(errors: readonly ErrorObject[]): ErrorObject | undefined {
  return [...errors].sort(
    (a, b) => b.instancePath.split('/').length - a.instancePath.split('/').length,
  )[0];
}

/**
 * Every frame in a recording, against the `$def` its method names.
 *
 * A response carries no method of its own, so the request ids seen earlier in
 * the same file are what say which `$def` applies — a recording is a whole
 * conversation, which is the one context in which that correlation is
 * available at all.
 */
export function validateAcpFrames(frames: readonly CapturedFrame[]): SchemaViolation[] {
  const violations: SchemaViolation[] = [];
  /** Request id → method, per file, so two recordings cannot cross-talk. */
  const inflight = new Map<string, string>();

  const report = (
    frame: CapturedFrame,
    pointer: string,
    keyword: string,
    message: string,
  ): void => {
    violations.push({ file: frame.file, line: frame.line, pointer, keyword, message });
  };

  const check = (frame: CapturedFrame, definition: string, at: string, value: unknown): void => {
    const validate = validatorFor(definition);
    if (validate(value)) return;
    const error = deepest(validate.errors ?? []);
    report(
      frame,
      `${at}${error?.instancePath ?? ''}`,
      error?.keyword ?? 'unknown',
      `${definition}: ${error?.message ?? 'does not validate against schema.json'}`,
    );
  };

  for (const frame of frames) {
    if (frame.msg === null) {
      report(
        frame,
        '',
        'json',
        `recorded bytes are not a JSON object: ${(frame.text ?? '').slice(0, 120)}`,
      );
      continue;
    }
    const msg = frame.msg;
    if (msg['jsonrpc'] !== '2.0') {
      report(frame, '/jsonrpc', 'const', 'every ACP frame carries "jsonrpc": "2.0"');
      continue;
    }

    const id = msg['id'];
    const key = id === undefined ? null : `${frame.file}#${JSON.stringify(id)}`;

    const method = msg['method'];
    if (typeof method === 'string') {
      if (key !== null) inflight.set(key, method);
      // The extension convention: a leading underscore is what the protocol
      // reserves for a vendor's own methods, and the schema has no `$def` to
      // hold one to.
      if (method.startsWith('_')) continue;
      const spec = ACP_METHODS[method];
      if (spec === undefined) {
        report(
          frame,
          '/method',
          'method',
          `unknown ACP method "${method}" — either the vendor invented one or ` +
            "DeFlow's method table is behind the SDK",
        );
        continue;
      }
      if (spec.from !== null && spec.from !== author(frame.dir)) {
        report(
          frame,
          '/method',
          'direction',
          `"${method}" is sent by the ${spec.from}, but this frame was written by the ${author(frame.dir)}`,
        );
        continue;
      }
      if (spec.params !== undefined) check(frame, spec.params, '/params', msg['params'] ?? {});
      continue;
    }

    if (msg['error'] !== undefined) {
      // A JSON-RPC error is an envelope, not an ACP payload: there is no `$def`
      // for it, and its `data` is deliberately free-form.
      const error = msg['error'];
      if (!isObject(error) || typeof error['code'] !== 'number') {
        report(frame, '/error', 'shape', 'a JSON-RPC error carries a numeric "code"');
      }
      if (key !== null) inflight.delete(key);
      continue;
    }

    if (msg['result'] === undefined) {
      report(frame, '', 'shape', 'a frame is a request, a response or a notification');
      continue;
    }

    const requested = key === null ? undefined : inflight.get(key);
    if (requested === undefined) {
      report(frame, '/id', 'correlation', 'a result whose request is not in this recording');
      continue;
    }
    inflight.delete(key as string);
    const spec = ACP_METHODS[requested];
    if (spec?.result !== undefined) check(frame, spec.result, '/result', msg['result']);
  }

  return violations;
}

/** The report an assertion prints: one `file:line pointer — message` per line. */
export function describeViolations(violations: readonly SchemaViolation[]): string {
  return violations
    .map(
      (violation) =>
        `${violation.file}:${violation.line} ${violation.pointer === '' ? '(whole frame)' : violation.pointer} ` +
        `[${violation.keyword}] ${violation.message}`,
    )
    .join('\n');
}

export interface CorpusRecording {
  readonly provider: string;
  readonly version: string;
  readonly case: string;
  /** Relative to the corpus root, so a failure names a path a reader can open. */
  readonly file: string;
}

/**
 * Every recording in the corpus, keyed — and a **throw** for any directory
 * whose name is not `<provider>@<exact-version>` (AC6, test plan #8).
 *
 * Skipping such a directory is the failure mode this exists to prevent: the
 * goldens under it would silently stop being checked, which looks exactly like
 * a corpus that passes.
 */
export function corpusRecordings(
  directories: Readonly<Record<string, readonly string[]>>,
): CorpusRecording[] {
  const recordings: CorpusRecording[] = [];
  for (const name of Object.keys(directories).sort()) {
    const key = parseRecordingKey(name);
    if (!key.ok) throw new Error(key.message);
    for (const file of [...(directories[name] ?? [])].sort()) {
      if (!file.endsWith('.ndjson')) continue;
      recordings.push({
        provider: key.key.provider,
        version: key.key.version,
        case: file.replace(/\.ndjson$/, ''),
        file: `${name}/${file}`,
      });
    }
  }
  return recordings;
}

/** The corpus on disk, as `corpusRecordings` wants it. */
export function readCorpusDirectories(root: string): Record<string, string[]> {
  const directories: Record<string, string[]> = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    directories[entry.name] = readdirSync(join(root, entry.name));
  }
  return directories;
}
