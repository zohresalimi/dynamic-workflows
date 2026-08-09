/**
 * KAR-12.1 — the shape every parser produces, and the id that makes it
 * addressable (docs/10-verification-gates.md §4).
 *
 * A `Finding` is what lets a gate result be attached to a diff line, counted,
 * deduplicated across repair attempts and traced to an acceptance criterion. A
 * prose blob can do none of those, which is why nothing below has a free-text
 * field a consumer is expected to read for meaning.
 *
 * **The id is a function of what the finding is *about*, never of where it
 * appeared.** `sha256(gate|file|rule|normalisedMessage)` deliberately omits the
 * line number: attempt 2 of a repair loop that shifted the file by three lines
 * has not introduced a new finding, and a consumer that thought so would show
 * the same lint error four times and stop being read. The normalisation is what
 * removes the *other* place a line number hides — inside the message text — and
 * it is why `expected 3 to be 4` and `expected 5 to be 6` are the same finding
 * of the same assertion.
 *
 * The full stability contract, the `blobSha` anchor and the schema this shape
 * is validated against belong to KAR-12.3. What lives here is the minimum the
 * deterministic runner needs to produce one.
 */
import type { CriterionId, Handle } from '@DeFlow/core';
import { createHash } from 'node:crypto';

/**
 * §4's severities, which are the *tool's* vocabulary rather than the domain
 * model's (`blocker | major | minor | info`, ./verdict-finding.ts).
 *
 * Three rather than four because that is what `tsc`, oxlint, biome and every
 * JUnit producer actually emit, and a parser that had to invent a fourth level
 * would be guessing. `severityFloor` is expressed in the same vocabulary, so a
 * gate author reads one word in the definition file and sees the same word in
 * the tool output they are calibrating against.
 */
export const GATE_SEVERITIES = ['error', 'warning', 'info'] as const;

export type GateSeverity = (typeof GATE_SEVERITIES)[number];

export interface FindingRange {
  /** 1-based, always. A tool that reports a whole-file diagnostic is anchored
   * at line 1 rather than at 0, because 0 is not a line anybody can open. */
  readonly startLine: number;
  readonly startCol?: number;
  readonly endLine?: number;
  readonly endCol?: number;
}

/**
 * What a parser produces: everything readable from the tool's own output.
 *
 * There is no `blobSha` here and there cannot be one — the tool says `line 42`
 * and says nothing about which file content line 42 belonged to. That is a fact
 * about the worktree, read by `anchorFindings` (./anchor.ts) immediately after.
 */
export interface ParsedFinding {
  /** 12 hex characters — see `findingId`. */
  readonly id: string;
  readonly severity: GateSeverity;
  /** Repo-relative, POSIX separators. */
  readonly file: string;
  readonly range: FindingRange;
  /** `ts2345`, `no-floating-promises`, `merge/conflict`. Never empty. */
  readonly rule: string;
  readonly message: string;
  /** The acceptance criterion this bears on, when the gate declared one. */
  readonly criterion?: CriterionId;
  /** The full tool output this finding was read out of. */
  readonly artifact?: Handle;
}

/**
 * A parsed finding with its anchor (KAR-12.3 AC6).
 *
 * **`blobSha` is optional in this type and mandatory on the wire**, and the
 * split is deliberate rather than a loose end. A finding whose file could not
 * be read — a path the tool invented, a file the attempt deleted — is still a
 * true report and is kept; what it cannot have is a trustworthy line anchor. So
 * the gate tier can hold an unanchored finding, and `toDomainFinding` writes no
 * `location` for one. `DeFlow.finding.v2` then rejects a `location` with no
 * `blobSha` outright, which is where AC6 is actually enforced: nothing can
 * record a line number whose revision is unknown.
 */
export interface GateFinding extends ParsedFinding {
  /** The exact blob the range refers to. Absent only when the file could not
   * be read at all; see the note above. */
  readonly blobSha?: string;
}

/**
 * The message with its variable parts removed.
 *
 * Two transformations, each answering a way the same finding re-renders
 * differently between two runs of the same tool:
 *
 * - **Runs of digits become `<n>`.** Line and column numbers embedded in a
 *   message (`failed at App.ts:8:17`) move whenever anything above them does,
 *   and byte counts move on every build. Neither changes what is wrong.
 * - **Whitespace collapses.** Terminal width decides where a tool wraps, and a
 *   finding is not a different finding on a narrower terminal.
 */
export function normaliseMessage(message: string): string {
  return message.replace(/\d+/g, '<n>').replace(/\s+/g, ' ').trim();
}

/**
 * `sha256(gate|file|rule|normalisedMessage).slice(0, 12)`.
 *
 * The gate is in the digest so two gates reporting the same file and rule —
 * a typecheck and a build both surfacing `ts2345` — stay two findings that can
 * be resolved independently, rather than one that flickers.
 */
export function findingId(gate: string, file: string, rule: string, message: string): string {
  return createHash('sha256')
    .update([gate, file, rule, normaliseMessage(message)].join('|'))
    .digest('hex')
    .slice(0, 12);
}

/** Backslashes to slashes. Tool output on win32 is the only producer of one. */
export function toPosix(path: string): string {
  return path.replaceAll('\\', '/');
}

/**
 * The path a finding carries: repo-relative and POSIX, whatever the tool said.
 *
 * A path outside the repository is returned unchanged rather than turned into
 * a `../..` climb. Both are useless as a diff anchor; only one of them is
 * legible in a failure message, and a finding pointing at `/etc/hosts` is
 * information about a misconfigured gate.
 */
export function repoRelativePosix(repoRoot: string, file: string): string {
  const root = toPosix(repoRoot).replace(/\/+$/, '');
  const path = toPosix(file);
  if (!path.startsWith('/')) return path;
  if (path === root) return '';
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
