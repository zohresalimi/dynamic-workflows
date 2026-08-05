/**
 * A whole exec-shim invocation as a data file (docs/14-testing-strategy.md §3.2).
 *
 * The ACP mock's scenario format (KAR-04.2) and this one are siblings, not the
 * same thing: that one scripts a *protocol conversation*, this one scripts a
 * *process* — bytes on stdout, a signal handler, files on disk, an exit code.
 * They share the property that matters, which is that **nothing is defaulted
 * silently**. `delayMS` for `delayMs` produces a turn that bursts and a cadence
 * assertion that passes for the wrong reason, so an unknown key is a rejection
 * naming the path to it.
 *
 * Strict JSON rather than JSONC, deliberately. Comments would need a stripper
 * that knows what a string is, the testkit has no business owning a second copy
 * of one, and the naive version — a regex for `//.*$` — truncates every URL in
 * the file at its first slash pair and leaves valid JSON behind, which is worse
 * than a parse error because it runs. The `description` field carries the prose
 * a comment would have.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where a bare scenario name resolves. */
export const EXEC_SHIM_SCENARIO_DIR = fileURLToPath(
  new URL('../../scenarios/', import.meta.url),
).replace(/\/$/, '');

/** The environment variable the binary reads its scenario from. */
export const SCENARIO_ENV = 'DeFlow_FAKE_SCENARIO';

/**
 * The `result.subtype` values the shim path has to be able to produce.
 *
 * `error_max_structured_output_retries` is the one with a downstream customer:
 * it is the only honest source for `agent.schema-repair-exhausted`
 * (docs/04-domain-model.md §8), and a taxonomy entry with no way to produce its
 * stimulus is a branch nobody has ever run.
 */
export const RESULT_SUBTYPES = [
  'success',
  'error_during_execution',
  'error_max_turns',
  'error_max_structured_output_retries',
] as const;
export type ResultSubtype = (typeof RESULT_SUBTYPES)[number];

export interface PermissionDenial {
  readonly toolName: string;
  readonly toolUseId: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
}

export interface ResultScript {
  readonly subtype: ResultSubtype;
  readonly isError: boolean;
  readonly stopReason: string;
  readonly text: string;
  readonly totalCostUsd: number;
  readonly permissionDenials: readonly PermissionDenial[];
}

/** N assistant lines, `delayMs` apart. */
export interface ChunksStep {
  readonly type: 'chunks';
  readonly count: number;
  readonly delayMs: number;
  readonly text: string;
}

export interface MessageStep {
  readonly type: 'message';
  readonly text: string;
}

/** A `rate_limit_event` whose `resetsAt` is `resetsInSeconds` ahead of now (AC5). */
export interface RateLimitStep {
  readonly type: 'rateLimit';
  readonly resetsInSeconds: number;
  readonly status: string;
}

/** A complete line that is not JSON at all. */
export interface MalformedLineStep {
  readonly type: 'malformedLine';
  readonly text: string;
}

/** One line of `totalBytes`, written `chunkBytes` at a time, then a newline. */
export interface HugeLineStep {
  readonly type: 'hugeLine';
  readonly totalBytes: number;
  readonly chunkBytes: number;
}

export type ExecStep = ChunksStep | MessageStep | RateLimitStep | MalformedLineStep | HugeLineStep;

/** `count` backgrounded `sleep <sleepSeconds>` children (AC6). */
export interface GrandchildrenScript {
  readonly count: number;
  readonly sleepSeconds: number;
}

/** A file the invocation writes, relative to `cwd` — `..` included (AC7). */
export interface FileScript {
  readonly path: string;
  readonly content: string;
}

export interface ExecShimScenario {
  readonly name: string;
  readonly description: string;
  /** Null means "derive one from the seed", which keeps a run reproducible. */
  readonly sessionId: string | null;
  readonly steps: readonly ExecStep[];
  readonly result: ResultScript | null;
  readonly exitCode: number;
  readonly stderr: string;
  /**
   * Exit having written **zero bytes** to both streams.
   *
   * The worst outcome in the conformance battery: a node that looks successful
   * and carries nothing, so an empty result propagates downstream instead of
   * failing. It has no natural cause in a scripted happy path, which is why it
   * is a knob rather than an accident.
   */
  readonly noOutput: boolean;
  /** Install a no-op `SIGTERM` handler, so the SIGKILL escalation is real. */
  readonly ignoreSigterm: boolean;
  /** Never exit on our own. Only a signal ends this invocation. */
  readonly hangForever: boolean;
  readonly spawnGrandchildren: GrandchildrenScript | null;
  readonly writeFiles: readonly FileScript[];
}

export type ExecShimScenarioResult =
  | { readonly ok: true; readonly scenario: ExecShimScenario }
  | { readonly ok: false; readonly message: string };

class ScenarioError extends Error {}

const fail = (at: string, detail: string): never => {
  throw new ScenarioError(at === '' ? detail : `${at}: ${detail}`);
};

// ---------------------------------------------------------------------------
// Validation primitives
// ---------------------------------------------------------------------------

function asObject(value: unknown, at: string, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(at, `${what} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  object: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
): void {
  for (const key of Object.keys(object)) {
    if (key === '$schema' || allowed.includes(key)) continue;
    fail(at, `unknown key "${key}" (allowed: ${allowed.join(', ')})`);
  }
}

function requireString(object: Record<string, unknown>, key: string, at: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value === '') {
    fail(at, `"${key}" is required and must be a non-empty string`);
  }
  return value as string;
}

function optionalString(
  object: Record<string, unknown>,
  key: string,
  at: string,
  fallback: string,
): string {
  if (object[key] === undefined) return fallback;
  if (typeof object[key] !== 'string') fail(at, `"${key}" must be a string`);
  return object[key] as string;
}

function optionalCount(
  object: Record<string, unknown>,
  key: string,
  at: string,
  fallback: number,
): number {
  const value = object[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(at, `"${key}" must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return value as number;
}

function positiveCount(
  object: Record<string, unknown>,
  key: string,
  at: string,
  fallback: number,
): number {
  const value = optionalCount(object, key, at, fallback);
  if (value === 0) fail(at, `"${key}" must be a positive integer, got 0`);
  return value;
}

function optionalNumber(
  object: Record<string, unknown>,
  key: string,
  at: string,
  fallback: number,
): number {
  const value = object[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(at, `"${key}" must be a finite number, got ${JSON.stringify(value)}`);
  }
  return value as number;
}

function optionalBoolean(
  object: Record<string, unknown>,
  key: string,
  at: string,
  fallback: boolean,
): boolean {
  const value = object[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(at, `"${key}" must be a boolean`);
  return value as boolean;
}

function asArray(value: unknown, at: string, key: string): unknown[] {
  if (!Array.isArray(value)) fail(at, `"${key}" must be an array`);
  return value as unknown[];
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  at: string,
  what: string,
): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    fail(at, `unknown ${what} ${JSON.stringify(value)} (expected one of: ${allowed.join(', ')})`);
  }
  return value as T;
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const STEP_KEYS: Record<string, readonly string[]> = {
  chunks: ['type', 'count', 'delayMs', 'text'],
  message: ['type', 'text'],
  rateLimit: ['type', 'resetsInSeconds', 'status'],
  malformedLine: ['type', 'text'],
  hugeLine: ['type', 'totalBytes', 'chunkBytes'],
};

/** The default 10 MB payload: one line, no newline inside it. */
export const HUGE_LINE_TOTAL_BYTES = 10 * 1024 * 1024;
/** The write size for the flood, so the reader sees the line grow. */
export const HUGE_LINE_CHUNK_BYTES = 64 * 1024;

function parseStep(value: unknown, at: string): ExecStep {
  const object = asObject(value, at, 'a step');
  const type = object.type;
  if (typeof type !== 'string' || STEP_KEYS[type] === undefined) {
    fail(
      at,
      `unknown step type ${JSON.stringify(type)} (expected one of: ${Object.keys(STEP_KEYS).join(', ')})`,
    );
  }
  rejectUnknownKeys(object, STEP_KEYS[type as string] as readonly string[], at);

  if (type === 'chunks') {
    return {
      type: 'chunks',
      count: positiveCount(object, 'count', at, 1),
      // Capped by convention rather than by code: a scripted delay is a real
      // sleep, and tens of milliseconds is what keeps the slice fast.
      delayMs: optionalCount(object, 'delayMs', at, 0),
      text: optionalString(object, 'text', at, 'scripted chunk'),
    };
  }

  if (type === 'message') return { type: 'message', text: requireString(object, 'text', at) };

  if (type === 'rateLimit') {
    return {
      type: 'rateLimit',
      resetsInSeconds: positiveCount(object, 'resetsInSeconds', at, 900),
      status: optionalString(object, 'status', at, 'allowed_warning'),
    };
  }

  if (type === 'malformedLine') {
    return { type: 'malformedLine', text: optionalString(object, 'text', at, '{"type":') };
  }

  return {
    type: 'hugeLine',
    totalBytes: positiveCount(object, 'totalBytes', at, HUGE_LINE_TOTAL_BYTES),
    chunkBytes: positiveCount(object, 'chunkBytes', at, HUGE_LINE_CHUNK_BYTES),
  };
}

function parseResult(value: unknown, at: string): ResultScript {
  const object = asObject(value, at, 'a result envelope');
  rejectUnknownKeys(
    object,
    ['subtype', 'isError', 'stopReason', 'text', 'totalCostUsd', 'permissionDenials'],
    at,
  );

  const subtype =
    object.subtype === undefined
      ? 'success'
      : oneOf(object.subtype, RESULT_SUBTYPES, at, 'result subtype');

  const denials = (
    object.permissionDenials === undefined
      ? []
      : asArray(object.permissionDenials, at, 'permissionDenials')
  ).map((entry, index) => {
    const scope = `${at}.permissionDenials[${index}]`;
    const fields = asObject(entry, scope, 'a permission denial');
    rejectUnknownKeys(fields, ['toolName', 'toolUseId', 'toolInput'], scope);
    return {
      toolName: requireString(fields, 'toolName', scope),
      toolUseId: optionalString(fields, 'toolUseId', scope, 'toolu_denied'),
      toolInput:
        fields.toolInput === undefined
          ? {}
          : asObject(fields.toolInput, `${scope}.toolInput`, 'toolInput'),
    };
  });

  return {
    subtype,
    // Defaulted from the subtype rather than to `false`: a result whose subtype
    // is an error and whose `is_error` is false is a shape no real run
    // produces, and it would quietly teach a parser to trust the wrong field.
    isError: optionalBoolean(object, 'isError', at, subtype !== 'success'),
    stopReason: optionalString(object, 'stopReason', at, subtype === 'success' ? 'end_turn' : ''),
    text: optionalString(object, 'text', at, ''),
    totalCostUsd: optionalNumber(object, 'totalCostUsd', at, 0),
    permissionDenials: denials,
  };
}

function parseGrandchildren(value: unknown, at: string): GrandchildrenScript {
  const object = asObject(value, at, 'spawnGrandchildren');
  rejectUnknownKeys(object, ['count', 'sleepSeconds'], at);
  return {
    count: positiveCount(object, 'count', at, 2),
    sleepSeconds: positiveCount(object, 'sleepSeconds', at, 300),
  };
}

function parseFile(value: unknown, at: string): FileScript {
  const object = asObject(value, at, 'a file');
  rejectUnknownKeys(object, ['path', 'content'], at);
  return {
    // Never resolved here. `../outside.txt` has to survive parsing intact, or
    // the one positive case path-scope detection has stops being a positive
    // case (AC7).
    path: requireString(object, 'path', at),
    content: optionalString(object, 'content', at, ''),
  };
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEYS = [
  'name',
  'description',
  'sessionId',
  'steps',
  'result',
  'exitCode',
  'stderr',
  'noOutput',
  'ignoreSigterm',
  'hangForever',
  'spawnGrandchildren',
  'writeFiles',
] as const;

/** Collapses whitespace so a diagnostic is always one line. */
const oneLine = (text: string): string => text.replaceAll(/\s+/g, ' ').trim();

export function parseExecShimScenario(text: string, source?: string): ExecShimScenarioResult {
  const where = source === undefined ? '' : `${source}: `;

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: oneLine(`${where}not valid JSON: ${(error as Error).message}`) };
  }

  try {
    const object = asObject(value, '', 'a scenario');
    rejectUnknownKeys(object, TOP_LEVEL_KEYS, '');
    return {
      ok: true,
      scenario: {
        name: optionalString(object, 'name', '', 'unnamed'),
        description: optionalString(object, 'description', '', ''),
        sessionId: object.sessionId === undefined ? null : requireString(object, 'sessionId', ''),
        steps:
          object.steps === undefined
            ? []
            : asArray(object.steps, '', 'steps').map((step, index) =>
                parseStep(step, `steps[${index}]`),
              ),
        result: object.result === undefined ? null : parseResult(object.result, 'result'),
        exitCode: optionalCount(object, 'exitCode', '', 0),
        stderr: optionalString(object, 'stderr', '', ''),
        noOutput: optionalBoolean(object, 'noOutput', '', false),
        ignoreSigterm: optionalBoolean(object, 'ignoreSigterm', '', false),
        hangForever: optionalBoolean(object, 'hangForever', '', false),
        spawnGrandchildren:
          object.spawnGrandchildren === undefined
            ? null
            : parseGrandchildren(object.spawnGrandchildren, 'spawnGrandchildren'),
        writeFiles:
          object.writeFiles === undefined
            ? []
            : asArray(object.writeFiles, '', 'writeFiles').map((file, index) =>
                parseFile(file, `writeFiles[${index}]`),
              ),
      },
    };
  } catch (error) {
    if (!(error instanceof ScenarioError)) throw error;
    return { ok: false, message: oneLine(`${where}${error.message}`) };
  }
}

/**
 * Resolves what `$DeFlow_FAKE_SCENARIO` holds: a document written inline, a
 * path, or the bare name of one of the shipped scenarios.
 *
 * Three spellings rather than one because they answer different needs and the
 * rule between them is unambiguous — a leading `{` is a document, anything with
 * a separator or an extension is a path, and everything else is a name. Inline
 * is what lets a spec vary one field without a near-duplicate file on disk.
 */
export function loadExecShimScenario(spec: string): ExecShimScenarioResult {
  const trimmed = spec.trim();
  if (trimmed === '') {
    return { ok: false, message: `${SCENARIO_ENV} is set to an empty string` };
  }

  if (trimmed.startsWith('{')) return parseExecShimScenario(trimmed, '<inline>');

  const path =
    isAbsolute(trimmed) || trimmed.includes('/') || trimmed.endsWith('.json')
      ? trimmed
      : join(EXEC_SHIM_SCENARIO_DIR, `${trimmed}.json`);

  if (!existsSync(path)) {
    return {
      ok: false,
      message:
        `${SCENARIO_ENV}="${spec}" resolved to ${path}, which does not exist ` +
        `(a bare name is looked up in ${EXEC_SHIM_SCENARIO_DIR})`,
    };
  }

  return parseExecShimScenario(readFileSync(path, 'utf8'), path);
}
