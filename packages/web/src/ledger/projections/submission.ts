/**
 * KAR-22.2 AC6 — `submission.ts`: what the operator asked this run to do.
 *
 * The ninth projection, and the second-smallest. It folds one event kind and
 * holds one object, because the question it answers is asked once per run:
 * `task.submitted` is the first thing in every run's ledger, it carries the
 * source and its provenance verbatim, and until this projection no surface in
 * the tab could say what any of it was.
 *
 * ## Why it is a projection rather than something the composer remembers
 *
 * A composer that kept its own copy would answer *"what did I ask for?"* in the
 * tab that submitted it and nowhere else — not on a second tab, not after a
 * reload, and not at all for the runs an operator started from a terminal.
 * docs/12-frontend-architecture.md §3.4's rule settles it: the answer changes
 * because an event was appended, so it is a projection.
 *
 * ## What it does not do
 *
 * It does not fetch the body of a source too large to inline. Above intake's
 * 64 KiB threshold the payload carries a `handle` instead of `raw`, and the
 * honest rendering of that is the handle plus the file it came from — a
 * projection that went and fetched the blob would be a projection doing I/O,
 * and `./purity.test.ts` is what stops that.
 *
 * Verifies: EPIC-22-S27 · AC6
 */
import type { Event } from '@DeFlow/core';
import { type Ignorable, ignored } from './kinds.ts';

/** The three intake shapes, as the payload spells them (`@DeFlow/core`'s
 * `INTAKE_KINDS`). Read off the payload rather than re-imported, because this
 * is a *record of what was submitted* and a kind a newer daemon added must
 * render as "not something this build can read" rather than throw. */
const KINDS = ['text', 'file', 'issue'] as const;

export type SubmittedKind = (typeof KINDS)[number];

export interface SubmittedTask {
  readonly kind: SubmittedKind;
  /** `'ui'` or `'cli'` — which door the run came in through. */
  readonly by: string;
  readonly submittedAt: number;
  /**
   * The one line that identifies the submission on screen: the prompt itself
   * for `text`, the resolved path for `file`, the URL for `issue`.
   *
   * Derived here rather than at each renderer, because three surfaces would
   * otherwise each pick a field and they would not pick the same one.
   */
  readonly summary: string;
  /** The source, verbatim, or `null` when it was too large to inline. */
  readonly raw: string | null;
  /** `artifact://<sha256>` when `raw` is `null`; `null` otherwise. */
  readonly handle: string | null;
  /** The repository the run was submitted against (KAR-19.3). */
  readonly cwd: string | null;
  /** The project it belongs to (KAR-22.1 AC7), or `null` for a terminal run. */
  readonly projectId: string | null;
}

export interface SubmissionProjection {
  /** `null` until the run's `task.submitted` has been folded. */
  task: SubmittedTask | null;
  /** The highest `seq` folded. The cursor moves for **every** event, including
   * kinds this build cannot read: a frame that was seen has been seen, and a
   * client that forgot would re-request it on every reconnect for the life of
   * the run (EPIC-16-S11). */
  appliedSeq: number;
}

export const emptySubmission = (): SubmissionProjection => ({ task: null, appliedSeq: 0 });

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The identifying line, per kind. `null` where the payload does not carry it,
 * which is a payload this build cannot read rather than an empty submission. */
function summaryOf(
  kind: SubmittedKind,
  raw: string | null,
  p: Record<string, unknown>,
): string | null {
  switch (kind) {
    case 'text':
      return raw;
    case 'file':
      return str(p.resolvedPath);
    case 'issue':
      return str(p.url);
  }
}

export function applySubmission(state: SubmissionProjection, event: Event): void {
  if (event.seq <= state.appliedSeq) return;
  state.appliedSeq = event.seq;

  switch (event.kind) {
    case 'task.submitted': {
      const payload = event.payload as { raw?: unknown; handle?: unknown; provenance?: unknown };
      const provenance = (payload.provenance ?? {}) as Record<string, unknown>;
      const kind = provenance.kind;
      if (!(KINDS as readonly unknown[]).includes(kind)) return;

      const raw = str(payload.raw);
      const summary = summaryOf(kind as SubmittedKind, raw, provenance);
      if (summary === null) return;

      state.task = {
        kind: kind as SubmittedKind,
        by: str(provenance.by) ?? 'ui',
        submittedAt: typeof provenance.submittedAt === 'number' ? provenance.submittedAt : event.ts,
        summary,
        raw,
        handle: str(payload.handle),
        cwd: str(provenance.cwd),
        projectId: str(provenance.projectId),
      };
      return;
    }
    default:
      ignored<'submission'>(event as Ignorable<'submission'>);
  }
}
