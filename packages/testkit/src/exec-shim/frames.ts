/**
 * The lines each dialect puts on stdout.
 *
 * The Claude Code envelope is the one that was **verified by execution**
 * (docs/07-provider-adapter-layer.md §8.1, 2026-08-02) and it is recorded in
 * `fixtures/cli-shapes/claude-code@2.1.220.json`. A unit test compares what
 * this file builds against that fixture key for key, because a fake that
 * invents a field teaches the shim to read a field no real agent sends, and the
 * whole suite downstream then proves something about a CLI that does not exist.
 *
 * Two properties of the envelope carry weight beyond looking right:
 *
 * - **Every line's `uuid` is the shim path's dedup key** — the equivalent of
 *   the ACP notification id, and what makes replay-after-crash idempotent
 *   (F4.3). A fake emitting a constant `uuid` would let a broken dedup pass.
 * - **`rate_limit_event.rate_limit_info.resetsAt`** is what a backoff scheduler
 *   is supposed to use instead of retrying blindly (F9.4, F4.8), so it has to
 *   be a real timestamp derived from a real clock reading rather than a
 *   placeholder.
 *
 * The Codex and Copilot shapes are **not** verified — neither binary was
 * installed on the capture machine (`fixtures/cli-flags/2026-08-04.json` records
 * Codex as `not-installed`). What is contractual about them is what the specs
 * assert: that Codex's `--json` is one JSON object per line including a 10 MB
 * one, and that Copilot's `--output-format json` is a single document. Nothing
 * downstream may match on their field names.
 */
import { randomUUID } from 'node:crypto';
import { mulberry32 } from '../random.ts';
import { RESULT_SUBTYPES, type ResultScript } from './scenario.ts';

export { RESULT_SUBTYPES };

export type Line = Record<string, unknown>;

export interface FrameContext {
  readonly sessionId: string;
  readonly nextUuid: () => string;
  /** Read once, from the caller's clock — never `Date.now()` in here. */
  readonly nowMs: number;
  /** The model name the envelope reports. */
  readonly model?: string;
}

const DEFAULT_MODEL = 'claude-sonnet-4-5-20260514';

/**
 * A stream of v4-shaped uuids from a seed, so a whole run replays byte for byte.
 *
 * `null` means "no seed", and then it is a real `randomUUID` rather than a
 * quietly deterministic stand-in: an unseeded fake that only *looks* random is
 * worse than one that is honestly random, because the first failure it causes
 * is impossible to explain.
 */
export function uuidsFromSeed(seed: number | null): () => string {
  if (seed === null) return () => randomUUID();

  const next = mulberry32(seed);
  const hex = (digits: number): string => {
    let out = '';
    while (out.length < digits)
      out += Math.floor(next() * 0x1_00_00)
        .toString(16)
        .padStart(4, '0');
    return out.slice(0, digits);
  };

  return () => {
    // Version 4, variant 10xx — the shape a reader validates, produced from the
    // seeded stream rather than from entropy.
    const variant = (8 + Math.floor(next() * 4)).toString(16);
    return `${hex(8)}-${hex(4)}-4${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
  };
}

/** 64 characters that need no JSON escaping, so a byte count means what it says. */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';

/**
 * `length` bytes of the payload as if starting at absolute offset `at`.
 *
 * Generated rather than checked in: ten megabytes of fixture would balloon the
 * repository for a value that can be recomputed in a millisecond, and random
 * bytes would break seed reproducibility.
 */
export function patternSlice(at: number, length: number): string {
  if (length <= 0) return '';
  const period = ALPHABET.length;
  const start = ((at % period) + period) % period;
  const rotated = (ALPHABET + ALPHABET).slice(start, start + period);
  return rotated.repeat(Math.ceil(length / period)).slice(0, length);
}

/** The two halves of a line whose middle is written in chunks. */
export interface HugeLineParts {
  readonly prefix: string;
  readonly suffix: string;
}

const usageOf = (script: ResultScript): Line => ({
  input_tokens: 1_024,
  output_tokens: Math.max(1, script.text.length),
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
});

export interface ClaudeStreamJson {
  systemInit(): Line;
  activeGoal(goal: string): Line;
  assistant(text: string): Line;
  rateLimit(status: string, resetsInSeconds: number): Line;
  result(script: ResultScript): Line;
  hugeLineParts(): HugeLineParts;
}

/** Claude Code 2.1.220's `stream-json`, as recorded. */
export function claudeStreamJson(context: FrameContext): ClaudeStreamJson {
  const model = context.model ?? DEFAULT_MODEL;
  const stamp = (line: Line): Line => ({
    ...line,
    session_id: context.sessionId,
    uuid: context.nextUuid(),
  });

  return {
    systemInit: () =>
      stamp({
        type: 'system',
        subtype: 'init',
        cwd: '.',
        model,
        permissionMode: 'manual',
        tools: [],
      }),

    activeGoal: (goal) => stamp({ type: 'active_goal', goal }),

    assistant: (text) =>
      stamp({
        type: 'assistant',
        message: {
          id: `msg_${context.nextUuid().slice(0, 8)}`,
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text }],
          stop_reason: null,
        },
        parent_tool_use_id: null,
        request_id: `req_${context.nextUuid().slice(0, 8)}`,
      }),

    rateLimit: (status, resetsInSeconds) =>
      stamp({
        type: 'rate_limit_event',
        rate_limit_info: {
          status,
          // Epoch **seconds**, which is the unit a scheduler has to be told
          // about: reading it as milliseconds schedules the retry in 1970.
          resetsAt: Math.floor(context.nowMs / 1000) + resetsInSeconds,
        },
      }),

    result: (script) =>
      stamp({
        type: 'result',
        subtype: script.subtype,
        is_error: script.isError,
        stop_reason: script.stopReason,
        total_cost_usd: script.totalCostUsd,
        usage: usageOf(script),
        modelUsage: {
          [model]: {
            inputTokens: 1_024,
            outputTokens: Math.max(1, script.text.length),
            costUSD: script.totalCostUsd,
          },
        },
        permission_denials: script.permissionDenials.map((denial) => ({
          tool_name: denial.toolName,
          tool_use_id: denial.toolUseId,
          tool_input: denial.toolInput,
        })),
        terminal_reason: script.isError ? 'error' : 'complete',
        result: script.text,
      }),

    hugeLineParts: () => {
      const line = stamp({ type: 'assistant', message: { role: 'assistant', text: '' } });
      const rendered = JSON.stringify(line);
      // Split inside the empty `"text":""` so the payload lands in a string
      // field: a 10 MB line only exercises the frame cap if the reader has to
      // buffer it as one line, and a broken JSON document would be a different
      // hazard entirely.
      const at = rendered.lastIndexOf('""') + 1;
      return { prefix: rendered.slice(0, at), suffix: rendered.slice(at) };
    },
  };
}

export interface CodexJsonl {
  taskStarted(): Line;
  agentMessage(text: string): Line;
  taskComplete(script: ResultScript): Line;
  hugeLineParts(): HugeLineParts;
}

/** Codex `exec --json`: JSONL, shape unverified — see the file header. */
export function codexJsonl(context: FrameContext): CodexJsonl {
  const envelope = (msg: Line): Line => ({ id: context.nextUuid(), msg });

  return {
    taskStarted: () => envelope({ type: 'task_started', session_id: context.sessionId }),
    agentMessage: (text) => envelope({ type: 'agent_message', message: text }),
    taskComplete: (script) =>
      envelope({
        type: 'task_complete',
        last_agent_message: script.text,
        is_error: script.isError,
      }),
    hugeLineParts: () => {
      const rendered = JSON.stringify(envelope({ type: 'agent_message', message: '' }));
      const at = rendered.lastIndexOf('""') + 1;
      return { prefix: rendered.slice(0, at), suffix: rendered.slice(at) };
    },
  };
}

/** Copilot `--output-format json`: one document, shape unverified. */
export function copilotJson(context: FrameContext): { document(script: ResultScript): Line } {
  return {
    document: (script) => ({
      session_id: context.sessionId,
      type: 'result',
      is_error: script.isError,
      result: script.text,
      usage: usageOf(script),
    }),
  };
}
