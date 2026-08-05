/**
 * KAR-03.5 — the read path into the reducer (docs/04-domain-model.md §9.2,
 * docs/05-durable-execution.md §4).
 *
 * `reduce` is the law. This is the two lines around it: parse and upcast a
 * stored row into an `Event` (./events.ts), fold what came back, and **count
 * what did not**.
 *
 * The counting is the reason this exists as its own function rather than as a
 * loop inside the daemon. EPIC-03-S16 asks a downgraded daemon for exactly one
 * aggregate line — "skipped 40 events of 1 unknown kind" — and explicitly
 * forbids an error-level line per skipped event, because during the replay of
 * a nine-hour run that is its own denial of service. A pure function returning
 * a tally lets the imperative shell log once; a `console.warn` in here would
 * make the tally impossible to test and the volume impossible to control.
 *
 * Everything here stays inside R1: no I/O, no clock. The rows arrive from
 * `@DeFlow/ledger`; this file never asks where from.
 */
import type { Event, ParseEventResult } from './events.ts';
import { parseEvent } from './events.ts';
import { reduce } from './reduce.ts';
import { initialRunState, type RunState } from './run-state.ts';
import { eventUpcasters, type UpcasterRegistry } from './upcasters.ts';

/** Why a row never reached the reducer, other than by being from the future. */
export type FoldRejectionReason =
  | 'invalid-envelope'
  | 'invalid-payload'
  | 'future-version'
  | 'upcast-failed';

export interface FoldRejection {
  /** `0` when the row was so malformed that it had no readable `seq`. */
  readonly seq: number;
  readonly kind: string;
  readonly reason: FoldRejectionReason;
  /** One line, for the operator: the schema issues or the upcaster's message. */
  readonly detail: string;
}

export interface FoldReport {
  readonly state: RunState;
  /** How many events `reduce` actually saw. */
  readonly applied: number;
  /**
   * The highest `seq` observed, applied or not. A resume cursor is built from
   * this rather than from `applied`: skipping an event a newer daemon wrote
   * must not make an older one read it again forever.
   */
  readonly lastSeq: number;
  /** Kinds this build has never heard of, and how many of each were skipped. */
  readonly skippedByKind: Readonly<Record<string, number>>;
  readonly unreadable: readonly FoldRejection[];
}

export interface FoldOptions {
  /**
   * The upcaster registry to read through. Defaults to the one the daemon
   * ships; a test supplies its own to exercise a version chain this build does
   * not happen to have yet.
   */
  readonly registry?: UpcasterRegistry;
}

/**
 * Folds stored rows into `RunState`, reporting what it could not read.
 *
 * Never throws. The `event` table is append-only, so a row written malformed
 * by some future bug is permanent — a replay that throws on it is a run that
 * can never be opened again.
 */
export function foldEvents(
  rows: Iterable<unknown>,
  from: RunState = initialRunState(),
  options: FoldOptions = {},
): FoldReport {
  const registry = options.registry ?? eventUpcasters;
  const skippedByKind: Record<string, number> = {};
  const unreadable: FoldRejection[] = [];
  let state = from;
  let applied = 0;
  let lastSeq = 0;

  for (const row of rows) {
    const parsed = parseEvent(row, registry);
    lastSeq = Math.max(lastSeq, seqOf(row));

    if (parsed.status === 'ok') {
      state = reduce(state, parsed.event as Event);
      applied += 1;
      continue;
    }

    // §9.2 rule 2: an unknown kind is the forward-compatibility path, not an
    // error. It is counted, and nothing else happens to it.
    if (parsed.status === 'unknown-kind') {
      skippedByKind[parsed.kind] = (skippedByKind[parsed.kind] ?? 0) + 1;
      continue;
    }

    unreadable.push(rejectionOf(parsed, row));
  }

  return { state, applied, lastSeq, skippedByKind, unreadable };
}

/**
 * The one aggregate line EPIC-03-S16 asks for, or `null` when there is nothing
 * to say. Rendered here rather than in the daemon so that the wording is
 * asserted by a unit test instead of by reading a log.
 */
export function describeSkipped(report: FoldReport): string | null {
  const kinds = Object.keys(report.skippedByKind).toSorted();
  if (kinds.length === 0) return null;

  const events = kinds.reduce((total, kind) => total + (report.skippedByKind[kind] ?? 0), 0);
  return (
    `skipped ${events} ${plural(events, 'event')} of ` +
    `${kinds.length} unknown ${plural(kinds.length, 'kind')}: ${kinds.join(', ')}`
  );
}

const plural = (count: number, word: string): string => (count === 1 ? word : `${word}s`);

function seqOf(row: unknown): number {
  if (row === null || typeof row !== 'object') return 0;
  const seq = (row as { seq?: unknown }).seq;
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : 0;
}

function kindOf(row: unknown): string {
  if (row === null || typeof row !== 'object') return '<unreadable>';
  const kind = (row as { kind?: unknown }).kind;
  return typeof kind === 'string' ? kind : '<unreadable>';
}

function rejectionOf(parsed: ParseEventResult, row: unknown): FoldRejection {
  switch (parsed.status) {
    case 'invalid-envelope':
      return {
        seq: seqOf(row),
        kind: kindOf(row),
        reason: 'invalid-envelope',
        detail: parsed.issues.join('; '),
      };
    case 'invalid-payload':
      return {
        seq: parsed.seq,
        kind: parsed.kind,
        reason: 'invalid-payload',
        detail: parsed.issues.join('; '),
      };
    case 'future-version':
      return {
        seq: parsed.seq,
        kind: parsed.kind,
        reason: 'future-version',
        detail: `payload v${parsed.v} is newer than this build's v${parsed.current}`,
      };
    case 'upcast-failed':
      return {
        seq: parsed.seq,
        kind: parsed.kind,
        reason: 'upcast-failed',
        detail: parsed.message,
      };
    default:
      // 'ok' and 'unknown-kind' are handled by the caller; this arm exists so
      // that a new ParseEventResult member cannot silently become a throw.
      return { seq: seqOf(row), kind: kindOf(row), reason: 'invalid-envelope', detail: '' };
  }
}
