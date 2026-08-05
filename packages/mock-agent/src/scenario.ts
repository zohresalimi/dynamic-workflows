/**
 * The scripted scenario format: a whole agent turn as a data file.
 *
 * Two properties are load-bearing.
 *
 * **Nothing is defaulted silently.** An unknown key, an unknown step type, a
 * status ACP does not define — each is a rejection that names the path to the
 * offending value. The alternative is the failure this story exists to remove:
 * `delayMS` instead of `delayMs` produces a turn that bursts, a cadence
 * assertion that passes for the wrong reason, and nothing to grep for.
 *
 * **The parser is hand-written.** `packages/mock-agent` ships with exactly one
 * dependency (docs/07-provider-adapter-layer.md §13), so ajv cannot come along
 * for the ride. The published JSON Schema in `schema/mock-scenario.v1.json` is
 * the format's contract for anyone writing a scenario; a unit test validates
 * every shipped scenario against both readers so the two cannot drift.
 */
import type * as acp from '@agentclientprotocol/sdk';

/** Every `ToolCallStatus` the ACP schema defines, in lifecycle order. */
export const TOOL_CALL_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'failed',
] as const satisfies readonly acp.ToolCallStatus[];

export const TOOL_KINDS = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
] as const satisfies readonly acp.ToolKind[];

export const STOP_REASONS = [
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
] as const satisfies readonly acp.StopReason[];

export const PERMISSION_OPTION_KINDS = [
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
] as const satisfies readonly acp.PermissionOptionKind[];

export const PLAN_PRIORITIES = ['high', 'medium', 'low'] as const;
export const PLAN_STATUSES = ['pending', 'in_progress', 'completed'] as const;

/**
 * The seven methods an agent may call back into the client, in the order the
 * terminal lifecycle runs them. ACP v2 removes all seven and pushes them onto
 * MCP, which is exactly why a scenario has to be able to name each one: an
 * agent that calls a method the client never advertised would mask that
 * migration.
 */
export const CLIENT_METHODS = [
  'fs/read_text_file',
  'fs/write_text_file',
  'terminal/create',
  'terminal/output',
  'terminal/wait_for_exit',
  'terminal/kill',
  'terminal/release',
] as const;

export type ClientMethod = (typeof CLIENT_METHODS)[number];

export interface PlanEntryScript {
  readonly content: string;
  readonly priority: (typeof PLAN_PRIORITIES)[number];
  readonly status: (typeof PLAN_STATUSES)[number];
}

export interface PlanStep {
  readonly type: 'plan';
  readonly entries: readonly PlanEntryScript[];
}

/** N `agent_message_chunk` notifications, `delayMs` apart. */
export interface ChunksStep {
  readonly type: 'chunks';
  readonly count: number;
  readonly delayMs: number;
  readonly text: string;
  /** Pads each chunk to at least this many characters. */
  readonly sizeBytes: number | null;
}

/** One `agent_message_chunk` whose text is exactly what the script says. */
export interface MessageStep {
  readonly type: 'message';
  readonly text: string;
}

export interface ToolCallStep {
  readonly type: 'toolCall';
  readonly title: string;
  readonly toolKind: acp.ToolKind;
  readonly path: string;
  readonly statuses: readonly acp.ToolCallStatus[];
  readonly delayMs: number;
}

export interface PermissionOptionScript {
  readonly optionId: string;
  readonly name: string;
  readonly kind: acp.PermissionOptionKind;
}

/**
 * Where control goes after a decision, and how the turn ends if it goes there.
 *
 * A `stopReason` of null means "carry on with the rest of the script", which
 * is what makes a branch that only wants to say something different from one
 * that wants to end the turn.
 */
export interface Branch {
  readonly steps: readonly Step[];
  readonly stopReason: acp.StopReason | null;
}

export interface PermissionStep {
  readonly type: 'permission';
  readonly title: string;
  readonly toolKind: acp.ToolKind;
  readonly path: string;
  readonly options: readonly PermissionOptionScript[];
  readonly onAllowed: Branch;
  readonly onRejected: Branch;
  readonly onCancelled: Branch;
}

export interface ClientCallStep {
  readonly type: 'clientCall';
  readonly method: ClientMethod;
  readonly params: Readonly<Record<string, unknown>>;
  readonly onError: Branch | null;
}

export type Step =
  | PlanStep
  | ChunksStep
  | MessageStep
  | ToolCallStep
  | PermissionStep
  | ClientCallStep;

export interface Scenario {
  readonly name: string;
  readonly description: string;
  readonly steps: readonly Step[];
  readonly stopReason: acp.StopReason;
}

export type ScenarioParseResult =
  | { readonly ok: true; readonly scenario: Scenario; readonly value: unknown }
  | { readonly ok: false; readonly message: string };

/** A rejection carrying the path to the value that caused it. */
class ScenarioError extends Error {}

const fail = (at: string, detail: string): never => {
  throw new ScenarioError(at === '' ? detail : `${at}: ${detail}`);
};

// ---------------------------------------------------------------------------
// JSONC
// ---------------------------------------------------------------------------

/**
 * Comment and trailing-comma removal that knows what a string is.
 *
 * The naive version — a regex for `//.*$` — truncates every URL and every
 * Windows-style path in the file at its first slash pair, and the result is
 * still valid JSON. That is worse than a parse error, because it runs.
 *
 * Removed characters become spaces rather than disappearing, so the character
 * offsets in a `JSON.parse` error still point at the right place in the file
 * the author is looking at.
 */
export function stripJsonComments(text: string): string {
  const out = text.split('');
  let inString = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index] as string;

    if (inString) {
      if (char === '\\') index += 2;
      else {
        if (char === '"') inString = false;
        index += 1;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      index += 1;
      continue;
    }

    const pair = text.slice(index, index + 2);
    if (pair === '//') {
      while (index < text.length && text[index] !== '\n') {
        out[index] = ' ';
        index += 1;
      }
      continue;
    }
    if (pair === '/*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (let at = index; at < stop; at += 1) if (out[at] !== '\n') out[at] = ' ';
      index = stop;
      continue;
    }

    index += 1;
  }

  return stripTrailingCommas(out.join(''));
}

function stripTrailingCommas(text: string): string {
  const out = text.split('');
  let inString = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (inString) {
      if (char === '\\') index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char !== ',') continue;

    let ahead = index + 1;
    while (ahead < text.length && /\s/.test(text[ahead] as string)) ahead += 1;
    if (text[ahead] === '}' || text[ahead] === ']') out[index] = ' ';
  }

  return out.join('');
}

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
    // `$schema` is the editor's hook into the published schema and is data
    // about the file rather than data in it.
    if (key === '$schema' || allowed.includes(key)) continue;
    fail(at, `unknown key "${key}" (allowed: ${allowed.join(', ')})`);
  }
}

function requireString(object: Record<string, unknown>, key: string, at: string): string {
  const value = object[key];
  if (typeof value !== 'string' || value === '')
    fail(at, `"${key}" is required and must be a non-empty string`);
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
  fallback: number | null,
): number | null {
  const value = object[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail(at, `"${key}" must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
  return value as number;
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

function asArray(value: unknown, at: string, key: string): unknown[] {
  if (!Array.isArray(value)) fail(at, `"${key}" must be an array`);
  return value as unknown[];
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

const STEP_KEYS: Record<string, readonly string[]> = {
  plan: ['type', 'entries'],
  chunks: ['type', 'count', 'delayMs', 'text', 'sizeBytes'],
  message: ['type', 'text'],
  toolCall: ['type', 'title', 'toolKind', 'path', 'statuses', 'delayMs'],
  permission: [
    'type',
    'title',
    'toolKind',
    'path',
    'options',
    'onAllowed',
    'onRejected',
    'onCancelled',
  ],
  clientCall: ['type', 'method', 'params', 'onError'],
};

const NO_BRANCH: Branch = { steps: [], stopReason: null };

function parseBranch(value: unknown, at: string): Branch {
  const object = asObject(value, at, 'a branch');
  rejectUnknownKeys(object, ['steps', 'stopReason'], at);
  const steps =
    object.steps === undefined
      ? []
      : asArray(object.steps, at, 'steps').map((step, index) =>
          parseStep(step, `${at}.steps[${index}]`),
        );
  const stopReason =
    object.stopReason === undefined
      ? null
      : oneOf(object.stopReason, STOP_REASONS, at, 'stop reason');
  return { steps, stopReason };
}

function parseStep(value: unknown, at: string): Step {
  const object = asObject(value, at, 'a step');
  const type = object.type;
  if (typeof type !== 'string' || STEP_KEYS[type] === undefined) {
    fail(
      at,
      `unknown step type ${JSON.stringify(type)} (expected one of: ${Object.keys(STEP_KEYS).join(', ')})`,
    );
  }
  rejectUnknownKeys(object, STEP_KEYS[type as string] as readonly string[], at);

  if (type === 'plan') {
    const entries = asArray(object.entries, at, 'entries').map((entry, index) => {
      const scope = `${at}.entries[${index}]`;
      const fields = asObject(entry, scope, 'a plan entry');
      rejectUnknownKeys(fields, ['content', 'priority', 'status'], scope);
      return {
        content: requireString(fields, 'content', scope),
        priority: oneOf(fields.priority ?? 'medium', PLAN_PRIORITIES, scope, 'plan priority'),
        status: oneOf(fields.status ?? 'pending', PLAN_STATUSES, scope, 'plan status'),
      };
    });
    if (entries.length === 0) fail(at, '"entries" must list at least one plan entry');
    return { type: 'plan', entries };
  }

  if (type === 'chunks') {
    const count = optionalCount(object, 'count', at, null);
    if (count === null || count === 0) {
      fail(at, `"count" must be a positive integer, got ${JSON.stringify(object.count)}`);
    }
    return {
      type: 'chunks',
      count: count as number,
      delayMs: optionalCount(object, 'delayMs', at, 0) as number,
      text: optionalString(object, 'text', at, 'scripted chunk'),
      sizeBytes: optionalCount(object, 'sizeBytes', at, null),
    };
  }

  if (type === 'message') {
    return { type: 'message', text: requireString(object, 'text', at) };
  }

  if (type === 'toolCall') {
    const statuses = asArray(object.statuses, at, 'statuses').map((status, index) =>
      oneOf(status, TOOL_CALL_STATUSES, `${at}.statuses[${index}]`, 'tool call status'),
    );
    if (statuses.length === 0) fail(at, '"statuses" must list at least one status');
    return {
      type: 'toolCall',
      title: requireString(object, 'title', at),
      toolKind: oneOf(object.toolKind, TOOL_KINDS, at, 'tool kind'),
      // AC3: the location is what lets EPIC-08 enforce path scope at request
      // time rather than detect a violation afterwards, so it is required.
      path: requireString(object, 'path', at),
      statuses,
      delayMs: optionalCount(object, 'delayMs', at, 0) as number,
    };
  }

  if (type === 'permission') {
    const options = asArray(object.options, at, 'options').map((option, index) => {
      const scope = `${at}.options[${index}]`;
      const fields = asObject(option, scope, 'a permission option');
      rejectUnknownKeys(fields, ['optionId', 'name', 'kind'], scope);
      return {
        optionId: requireString(fields, 'optionId', scope),
        name: requireString(fields, 'name', scope),
        kind: oneOf(fields.kind, PERMISSION_OPTION_KINDS, scope, 'permission option kind'),
      };
    });
    if (options.length === 0) fail(at, '"options" must list at least one option');
    return {
      type: 'permission',
      title: requireString(object, 'title', at),
      toolKind: oneOf(object.toolKind, TOOL_KINDS, at, 'tool kind'),
      path: requireString(object, 'path', at),
      options,
      onAllowed:
        object.onAllowed === undefined
          ? NO_BRANCH
          : parseBranch(object.onAllowed, `${at}.onAllowed`),
      onRejected:
        object.onRejected === undefined
          ? NO_BRANCH
          : parseBranch(object.onRejected, `${at}.onRejected`),
      onCancelled:
        object.onCancelled === undefined
          ? NO_BRANCH
          : parseBranch(object.onCancelled, `${at}.onCancelled`),
    };
  }

  return {
    type: 'clientCall',
    method: oneOf(object.method, CLIENT_METHODS, at, 'client method'),
    params: object.params === undefined ? {} : asObject(object.params, `${at}.params`, 'params'),
    onError: object.onError === undefined ? null : parseBranch(object.onError, `${at}.onError`),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Collapses whitespace so a diagnostic is always one line (AC1). */
function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

export function parseScenario(text: string, source?: string): ScenarioParseResult {
  const where = source === undefined ? '' : `${source}: `;

  let value: unknown;
  try {
    value = JSON.parse(stripJsonComments(text));
  } catch (error) {
    return { ok: false, message: oneLine(`${where}not valid JSON: ${(error as Error).message}`) };
  }

  try {
    const object = asObject(value, '', 'a scenario');
    rejectUnknownKeys(object, ['name', 'description', 'steps', 'stopReason'], '');
    const steps = asArray(object.steps, '', 'steps').map((step, index) =>
      parseStep(step, `steps[${index}]`),
    );
    return {
      ok: true,
      value,
      scenario: {
        name: optionalString(object, 'name', '', 'unnamed'),
        description: optionalString(object, 'description', '', ''),
        steps,
        stopReason:
          object.stopReason === undefined
            ? 'end_turn'
            : oneOf(object.stopReason, STOP_REASONS, '', 'stop reason'),
      },
    };
  } catch (error) {
    if (!(error instanceof ScenarioError)) throw error;
    return { ok: false, message: oneLine(`${where}${error.message}`) };
  }
}
