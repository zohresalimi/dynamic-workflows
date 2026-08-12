/**
 * KAR-18.3 AC7 — the two renderings of one event stream.
 *
 * *"The human renderer and the JSON renderer are two renderings of one event
 * stream, not two clients"* (EPIC-18-S25). That is enforced structurally here:
 * both are the same interface over the same `Event`, and the command body
 * builds exactly one of them and feeds it whatever `followRun` delivers. There
 * is no branch anywhere upstream of this file on `--json`, so there is nothing
 * for a second client to grow out of.
 *
 * **`isTty` is a function.** The usual way colour leaks into a pipe is a TTY
 * check evaluated once at module import; making it a callback consulted per
 * line means the check cannot be captured early even by accident, and
 * `./render.test.ts` flips it mid-renderer to prove it.
 *
 * **`--json`'s stdout is only events.** The verdict sentence goes to stderr as
 * its own JSON object, because "every line of stdout parses as a single JSON
 * object" is a promise a pipeline reads with `while read line; do jq …`, and a
 * summary line with no `seq` in the middle of a `seq`-ordered stream is the
 * thing that breaks it at 3am. The human renderer puts the same sentence on
 * stdout, where a person is looking.
 */
import type { Event, RunId } from '@DeFlow/core';
import type { RunVerdict } from './exit-codes.ts';

/** Money as the rollup carries it: four cells, any of them `null`, never
 * added across substances (@DeFlow/core's cost-rollup.ts). */
export interface RenderedCost {
  readonly subscription: number | null;
  readonly apiKey: number | null;
  readonly vendorReported: number | null;
  readonly estimated: number | null;
}

export interface RunTotals {
  readonly costUsd: RenderedCost;
  /** Measured by the command through its injected `Clock`, never `Date.now()`. */
  readonly wallclockMs: number;
}

export interface FinalLines {
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunRenderer {
  /** What this event looks like, or `''` when this rendering has nothing to
   * say about it. Always ends in a newline when it is not empty. */
  event(event: Event): string;
  final(verdict: RunVerdict, totals: RunTotals): FinalLines;
}

export interface RendererOptions {
  readonly mode: 'human' | 'json';
  /** Consulted per line. Never captured. */
  readonly isTty: () => boolean;
  readonly runId: RunId;
}

// ── colour ───────────────────────────────────────────────────────────────────

const CODES = {
  dim: '\u001B[2m',
  red: '\u001B[31m',
  green: '\u001B[32m',
  yellow: '\u001B[33m',
  reset: '\u001B[0m',
} as const;

type Colour = keyof Omit<typeof CODES, 'reset'>;

// ── the human transcript ─────────────────────────────────────────────────────

/** `1.5s`, `320ms`, `2m 04s` — a duration a person reads, not a number of ms. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * The four cost cells, named rather than summed.
 *
 * Subscription quota and real currency are different substances and adding
 * them produces a number that is true of nothing, so they are printed side by
 * side. A run nobody could price says so instead of printing `$0.00`, which
 * would read as "this was free".
 */
export function formatCost(cost: RenderedCost): string {
  const parts: string[] = [];
  if (cost.apiKey !== null) parts.push(`$${cost.apiKey.toFixed(2)} api-key`);
  if (cost.subscription !== null) parts.push(`$${cost.subscription.toFixed(2)} subscription`);
  return parts.length === 0 ? 'no cost recorded' : parts.join(', ');
}

/** The column the second word starts at, so the statuses line up. */
const NODE_COLUMN = 22;

interface Line {
  readonly glyph: string;
  readonly colour: Colour | null;
  readonly subject: string;
  readonly status: string;
  readonly detail: string;
}

/** What this event says in a transcript, or `null` for one a transcript is
 * quieter about than a log would be. */
function humanLine(event: Event): Line | null {
  switch (event.kind) {
    case 'task.submitted':
      return {
        glyph: '·',
        colour: 'dim',
        subject: 'task',
        status: 'submitted',
        detail: `from ${event.payload.provenance.kind}`,
      };

    case 'run.created':
      return { glyph: '·', colour: 'dim', subject: 'run', status: 'created', detail: '' };

    case 'node.scheduled':
      return {
        glyph: '◦',
        colour: 'dim',
        subject: event.payload.node,
        status: 'scheduled',
        detail: [event.payload.provider, event.payload.permission, event.payload.worktree]
          .filter((part) => part !== undefined && part !== '')
          .join(' · '),
      };

    case 'node.started':
      return {
        glyph: '▸',
        colour: null,
        subject: event.payload.node,
        status: 'started',
        detail: `attempt ${event.payload.attempt + 1}`,
      };

    case 'node.completed':
      return {
        glyph: '✓',
        colour: 'green',
        subject: event.payload.node,
        status: 'completed',
        detail: '',
      };

    case 'node.failed':
      return {
        glyph: '✗',
        colour: 'red',
        subject: event.payload.node,
        status: 'failed',
        detail: event.payload.failure.reason,
      };

    case 'gate.evaluated':
      return {
        glyph: event.payload.verdict.outcome === 'pass' ? '✓' : '✗',
        colour: event.payload.verdict.outcome === 'pass' ? 'green' : 'red',
        subject: event.payload.gate,
        status: `gate ${event.payload.verdict.outcome}`,
        detail: event.payload.verdict.summary,
      };

    case 'human.requested':
      return {
        glyph: '?',
        colour: 'yellow',
        subject: event.payload.node,
        status: 'asking',
        detail: event.payload.prompt,
      };

    case 'run.paused':
      return {
        glyph: '‖',
        colour: 'yellow',
        subject: 'run',
        status: 'paused',
        detail: event.payload.reason ?? `by ${event.payload.by}`,
      };

    case 'run.needs_human':
      return {
        glyph: '?',
        colour: 'yellow',
        subject: 'run',
        status: 'needs a human',
        detail: event.payload.reason,
      };

    case 'run.completed':
    case 'run.aborted':
      return {
        glyph: event.kind === 'run.completed' ? '✓' : '✗',
        colour: event.kind === 'run.completed' ? 'green' : 'red',
        subject: 'run',
        status: event.kind === 'run.completed' ? 'completed' : 'aborted',
        detail: event.payload.outcome,
      };

    default:
      return null;
  }
}

// ── the renderers ────────────────────────────────────────────────────────────

export function createRenderer(options: RendererOptions): RunRenderer {
  const paint = (text: string, colour: Colour | null): string =>
    colour === null || !options.isTty() ? text : `${CODES[colour]}${text}${CODES.reset}`;

  if (options.mode === 'json') {
    return {
      event: (event) => `${JSON.stringify(event)}\n`,
      final: (verdict, totals) => ({
        stdout: '',
        stderr: `${JSON.stringify({
          kind: 'DeFlow.cli.verdict',
          runId: options.runId,
          exitCode: verdict.exitCode,
          reason: verdict.reason,
          costUsd: totals.costUsd,
          wallclockMs: totals.wallclockMs,
        })}\n`,
      }),
    };
  }

  return {
    event(event) {
      const line = humanLine(event);
      if (line === null) return '';
      const head = `${line.glyph} ${line.subject}`.padEnd(NODE_COLUMN);
      const tail = line.detail === '' ? '' : `  ${paint(line.detail, 'dim')}`;
      return `${paint(`${head}${line.status}`, line.colour)}${tail}\n`;
    },
    final(verdict, totals) {
      const colour: Colour = verdict.exitCode === 0 ? 'green' : 'red';
      return {
        stdout:
          `${paint(`run ${options.runId} ${verdict.reason}`, colour)}  ` +
          `${paint(`(${formatCost(totals.costUsd)}, ${formatDuration(totals.wallclockMs)})`, 'dim')}\n`,
        stderr: '',
      };
    },
  };
}
