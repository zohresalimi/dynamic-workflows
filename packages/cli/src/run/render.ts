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
import type { Event, NodeId, RunId } from '@DeFlow/core';
import { RUN_STATUS_LABELS } from '@DeFlow/core';
import type { IoChunkLine } from '@DeFlow/web';
import { PART_SEPARATORS, TRANSCRIPT_GLYPHS, type TranscriptGlyph } from '../render/glyphs.ts';
import { wrapDetail } from '../render/layout.ts';
import { createStyle, type Style, type StyleColour } from '../render/style.ts';
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
  /**
   * KAR-19.4 AC3 — one `io_chunk` from a node that is still running.
   *
   * The **human** rendering is the bytes, unchanged and unwrapped: this is the
   * agent's own output on the operator's own terminal, and a renderer that
   * prefixed, wrapped or re-coloured it would be editing a transcript somebody
   * is reading in order to decide whether to intervene. It is deliberately not
   * padded to `NODE_COLUMN` like an event line — those are DeFlow speaking,
   * this is the agent.
   *
   * The **`--json`** rendering is one object per line, like every other frame on
   * that stream. `JSON.stringify` escapes control characters, so an agent that
   * emitted ANSI cannot put a raw escape byte on a machine-readable pipe — the
   * content is preserved as `\u001b`, which is what a consumer can act on.
   */
  io(node: NodeId, chunk: IoChunkLine): string;
  final(verdict: RunVerdict, totals: RunTotals): FinalLines;
}

export interface RendererOptions {
  readonly mode: 'human' | 'json';
  /**
   * Consulted per line. Never captured.
   *
   * KAR-18.9 moved every escape sequence and every glyph into
   * `src/render/`, but not this: `run` is a *live transcript*, and AC7's
   * once-per-process decision is about a report that is rendered in one go.
   * A renderer whose stream can change under it — which is what
   * `./render.test.ts` flips mid-run to prove — asks each time.
   */
  readonly isTty: () => boolean;
  readonly runId: RunId;
  /**
   * The width and charset half of the decision, which does *not* change under
   * a live renderer. `bin.ts` passes the process's own; a caller that says
   * nothing gets 80 columns and whatever the locale established.
   */
  readonly style?: Style;
}

type Colour = StyleColour;

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
  readonly glyph: TranscriptGlyph;
  readonly colour: Colour | null;
  readonly subject: string;
  readonly status: string;
  readonly detail: string;
  /** A detail assembled from parts, joined with the charset's own separator
   * rather than with a literal this file would have to spell. */
  readonly parts?: readonly string[];
}

/** What this event says in a transcript, or `null` for one a transcript is
 * quieter about than a log would be. */
function humanLine(event: Event): Line | null {
  switch (event.kind) {
    case 'task.submitted':
      return {
        glyph: 'note',
        colour: 'dim',
        subject: 'task',
        status: 'submitted',
        detail: `from ${event.payload.provenance.kind}`,
      };

    case 'run.created':
      return { glyph: 'note', colour: 'dim', subject: 'run', status: 'created', detail: '' };

    /**
     * KAR-19.1 AC7 — F4.7's report, rendered as one line.
     *
     * `subject` carries the run id rather than the bare word `run`, because a
     * stall is the one line an operator is likely to read out of context — in a
     * scrollback beside three other runs, or pasted into a message — and
     * *which* run has gone quiet is the first thing they need. The detail names
     * `DeFlow status` because a line that says something is wrong and not what
     * to do next is the line people learn to ignore.
     *
     * Nothing here says failed, and nothing here says killed: F4.7 is
     * "surfaced, never auto-killed", and a long build, a large test suite and a
     * wedged agent are indistinguishable from out here.
     */
    case 'run.stalled':
      return {
        glyph: 'paused',
        colour: 'yellow',
        subject: event.runId,
        status: 'stalled',
        detail:
          `no progress for ${formatDuration(event.payload.idleMs)}` +
          `${event.payload.runningNodes.length === 0 ? ', nothing in flight' : ''}` +
          " — run 'DeFlow status' to see where it is",
      };

    case 'node.scheduled':
      return {
        glyph: 'pending',
        colour: 'dim',
        subject: event.payload.node,
        status: 'scheduled',
        parts: [event.payload.provider, event.payload.permission, event.payload.worktree].filter(
          (part): part is string => part !== undefined && part !== '',
        ),
        detail: '',
      };

    case 'node.started':
      return {
        glyph: 'active',
        colour: null,
        subject: event.payload.node,
        status: 'started',
        detail: `attempt ${event.payload.attempt + 1}`,
      };

    case 'node.completed':
      return {
        glyph: 'done',
        colour: 'green',
        subject: event.payload.node,
        status: 'completed',
        detail: '',
      };

    /**
     * KAR-19.9 AC4 — the line an operator watching a failing run needs, printed
     * as each attempt fails rather than summarised at the end.
     *
     * Three things or it is not worth printing: which node, which attempt *out
     * of the ceiling*, and the typed reason. The ceiling comes off the event —
     * the failing node's own `RetryPolicy.maxAttempts`, stated by the scheduler
     * that applied it — because a `3` spelled here would be a second copy of a
     * policy that lives in another process, and the two would disagree the
     * first time a plan set `maxAttempts: 5`. A failure recorded by something
     * that never consulted a policy says `attempt 1` and stops there rather
     * than inventing a denominator.
     */
    case 'node.failed': {
      const ceiling = event.payload.maxAttempts;
      const attempt = `attempt ${event.payload.attempt + 1}${
        ceiling === undefined ? '' : ` of ${ceiling}`
      }`;
      return {
        glyph: 'gone',
        colour: 'red',
        subject: event.payload.node,
        status: 'failed',
        parts: [attempt, event.payload.failure.reason],
        detail: '',
      };
    }

    case 'gate.evaluated':
      return {
        glyph: event.payload.verdict.outcome === 'pass' ? 'done' : 'gone',
        colour: event.payload.verdict.outcome === 'pass' ? 'green' : 'red',
        subject: event.payload.gate,
        status: `gate ${event.payload.verdict.outcome}`,
        detail: event.payload.verdict.summary,
      };

    case 'human.requested':
      return {
        glyph: 'asking',
        colour: 'yellow',
        subject: event.payload.node,
        status: 'asking',
        detail: event.payload.prompt,
      };

    case 'run.paused':
      return {
        glyph: 'paused',
        colour: 'yellow',
        subject: 'run',
        // KAR-19.1 AC6 — every run-level status this view prints comes from
        // `@DeFlow/core`'s table, so this surface cannot acquire a fourth word
        // for a state `DeFlow status` and the UI already describe.
        status: RUN_STATUS_LABELS.paused,
        detail: event.payload.reason ?? `by ${event.payload.by}`,
      };

    case 'run.needs_human':
      return {
        glyph: 'asking',
        colour: 'yellow',
        subject: 'run',
        status: RUN_STATUS_LABELS['needs-human'],
        detail: event.payload.reason,
      };

    case 'run.completed':
    case 'run.aborted':
      return {
        glyph: event.kind === 'run.completed' ? 'done' : 'gone',
        colour: event.kind === 'run.completed' ? 'green' : 'red',
        subject: 'run',
        status:
          event.kind === 'run.completed' ? RUN_STATUS_LABELS.completed : RUN_STATUS_LABELS.aborted,
        detail: event.payload.outcome,
      };

    default:
      return null;
  }
}

// ── the renderers ────────────────────────────────────────────────────────────

/** The painter, and only the painter: a style whose sole job is to hold the
 * escape sequences, so this file never spells one. */
const ANSI = createStyle({ isTty: true, env: { TERM: 'xterm' } });

export function createRenderer(options: RendererOptions): RunRenderer {
  // The layout half of the decision, taken once: neither the width nor the
  // charset changes while a run is being watched.
  const layout = options.style ?? createStyle({ isTty: false, env: {} });
  const glyphs: Readonly<Record<TranscriptGlyph, string>> = TRANSCRIPT_GLYPHS[layout.charset];

  // The colour half, asked per line — @see RendererOptions.isTty. Two gates,
  // and they answer different questions: `layout.colour` is whether this
  // *environment* permits colour at all (`NO_COLOR`, `TERM=dumb`, `--json`,
  // `--no-color`), decided once by `bin.ts`; `isTty()` is whether the stream is
  // a terminal *right now*. Painting itself is still `src/render/`'s — this
  // file spells no escape sequence of its own.
  const permitted = options.style === undefined || options.style.colour;
  const paint = (text: string, colour: Colour | null): string =>
    colour === null || !permitted || !options.isTty() ? text : ANSI.paint(text, colour);

  if (options.mode === 'json') {
    return {
      event: (event) => `${JSON.stringify(event)}\n`,
      io: (node, chunk) =>
        `${JSON.stringify({
          kind: 'DeFlow.cli.io',
          runId: options.runId,
          node,
          seq: chunk.seq,
          stream: chunk.stream,
          ts: chunk.ts,
          data: chunk.data,
        })}\n`,
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
    io: (_node, chunk) => chunk.data,
    event(event) {
      const line = humanLine(event);
      if (line === null) return '';
      const head = `${glyphs[line.glyph]} ${line.subject}`.padEnd(NODE_COLUMN);
      const painted = paint(`${head}${line.status}`, line.colour);
      const detailText =
        line.parts === undefined ? line.detail : line.parts.join(PART_SEPARATORS[layout.charset]);
      if (detailText === '') return `${painted}\n`;

      // KAR-18.9 AC4 — a detail that would run off the edge wraps under itself
      // rather than off it, and a worktree path stays one token an operator can
      // copy. The column is where the detail starts, so a continuation line
      // reads as part of the event above it.
      const column = head.length + line.status.length + 2;
      const detail = wrapDetail(detailText, { width: layout.width, indent: column });
      const tail = detail
        .map((part, index) => (index === 0 ? `  ${paint(part, 'dim')}` : paint(part, 'dim')))
        .join('\n');
      return `${painted}${tail}\n`;
    },
    final(verdict, totals) {
      const colour: Colour = verdict.exitCode === 0 ? 'green' : 'red';
      const totalsLine = `(${formatCost(totals.costUsd)}, ${formatDuration(totals.wallclockMs)})`;
      const head = `run ${options.runId} ${verdict.reason}`;
      // One line when it fits, wrapped when it does not — the totals belong
      // beside the verdict, and a verdict that runs off the edge is the last
      // line of a run nobody can read.
      if (head.length + 2 + totalsLine.length <= layout.width) {
        return { stdout: `${paint(head, colour)}  ${paint(totalsLine, 'dim')}\n`, stderr: '' };
      }
      const wrapped = wrapDetail(head, { width: layout.width, indent: 2 });
      return {
        stdout: `${wrapped.map((line) => paint(line, colour)).join('\n')}\n${paint(
          totalsLine,
          'dim',
        )}\n`,
        stderr: '',
      };
    },
  };
}
