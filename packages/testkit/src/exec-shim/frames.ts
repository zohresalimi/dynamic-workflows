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

const INPUT_TOKENS = 1_024;
const CACHE_READ_TOKENS = 900;
const CACHE_CREATION_TOKENS = 12;

/**
 * The window and output ceiling the envelope reports back.
 *
 * Present because the real CLI reports them, and because KAR-09.7 reads the
 * window off the turn rather than off a per-model table — a fake that omitted
 * them would let a parser that *did* keep a table pass its specs.
 */
const CONTEXT_WINDOW = 200_000;
const MAX_OUTPUT_TOKENS = 64_000;

const outputTokensOf = (script: ResultScript): number => Math.max(1, script.text.length);

/** What the turn reports as its input tokens. Scriptable because KAR-09.6's
 * partial recovery reads exactly this number off the turn *after* a
 * compaction, and a constant here would let the recovery be asserted against
 * the fake's own default rather than against a figure the scenario chose. */
const inputTokensOf = (script: ResultScript): number => script.inputTokens ?? INPUT_TOKENS;

/**
 * The envelope's `usage` block: the raw Anthropic object the CLI passes
 * through, snake_cased, and typed `z.unknown()` in the CLI's own schema.
 *
 * DeFlow never reads it (KAR-09.7 AC2) — it is emitted because the vendor emits
 * it, and a fake that dropped it would stop being a reproduction of the wire.
 * Its figures agree with `modelUsage` for the same reason: the real CLI's do,
 * and a fake that made them disagree would be a detector rather than a double.
 * The detector lives in `packages/adapters/test/tier1-model-usage.test.ts`,
 * where a synthetic envelope populates the trap with numbers nothing may read.
 */
const usageOf = (script: ResultScript): Line => ({
  input_tokens: inputTokensOf(script),
  output_tokens: outputTokensOf(script),
  cache_creation_input_tokens: CACHE_CREATION_TOKENS,
  cache_read_input_tokens: CACHE_READ_TOKENS,
});

export interface ClaudeStreamJson {
  systemInit(): Line;
  activeGoal(goal: string): Line;
  assistant(text: string): Line;
  rateLimit(status: string, resetsInSeconds: number): Line;
  /** The live indicator that precedes a compaction. Drives a spinner and
   * nothing else — a consumer that appended an event for it would double
   * every compaction (EPIC-09-S31, second scenario). */
  compactingStatus(): Line;
  /** `system` / `compact_boundary`, whose `compact_metadata` carries
   * `pre_tokens` and nothing else (KAR-09.6). */
  compactBoundary(trigger: 'auto' | 'manual', preTokens: number): Line;
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

    compactingStatus: () => stamp({ type: 'system', subtype: 'status', status: 'compacting' }),

    // `pre_tokens` is the only figure the frame carries: no post count, no
    // dropped list, no handle to the pre-compaction transcript. A fake that
    // invented a `post_tokens` here would let a parser that read one pass, and
    // the whole of KAR-09.6 is about not drawing a bar nobody measured.
    compactBoundary: (trigger, preTokens) =>
      stamp({
        type: 'system',
        subtype: 'compact_boundary',
        compact_metadata: { trigger, pre_tokens: preTokens },
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
            inputTokens: inputTokensOf(script),
            outputTokens: outputTokensOf(script),
            cacheReadInputTokens: CACHE_READ_TOKENS,
            cacheCreationInputTokens: CACHE_CREATION_TOKENS,
            webSearchRequests: 0,
            costUSD: script.totalCostUsd,
            contextWindow: CONTEXT_WINDOW,
            maxOutputTokens: MAX_OUTPUT_TOKENS,
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
