/**
 * KAR-18.4 — `DeFlow doctor`'s status model: one reducer, two printers.
 *
 * Every category in the command produces `DoctorCheck`s and nothing else.
 * `reduceReport` is the only place a section status, an overall status or an
 * exit code is computed, and both `renderText` and `renderJson` read what it
 * decided rather than deciding again. EPIC-18-S36's note is the whole design
 * rationale: *"CI consumes the exit code, humans consume the text, and the
 * fastest way to get them out of step is to compute status in the renderer."*
 *
 * **An empty section is a failure, not a silence** (AC1). A category that
 * produced no checks did not pass — it did not run — and a heading with
 * nothing under it reads as green to every human who has ever skimmed a
 * health check. So the reducer substitutes a `fail` naming the section, which
 * also makes "a probe threw and swallowed its own result" impossible to ship
 * unnoticed.
 *
 * The exit-code contract is deliberately two-valued (AC11): `0` when
 * everything is `ok` or `warn`, `5` when anything is `fail`. Nothing else, so
 * a CI job can branch on it without a table.
 */

/** The only three verdicts a check may carry. `warn` does not fail the run. */
export type CheckStatus = 'ok' | 'warn' | 'fail';

/** sysexits(3)-adjacent, and the same code `DeFlow init` uses for a refusal. */
export const DOCTOR_EX_FAIL = 5;

/** The eight categories of docs/03-local-development.md §8, in report order. */
export const DOCTOR_SECTION_IDS = [
  'runtime',
  'git',
  'sandboxing',
  'agents',
  'capabilities',
  'conformance',
  'auth',
  'memory',
] as const;

export type DoctorSectionId = (typeof DOCTOR_SECTION_IDS)[number];

/** The heading each section prints under — the names EPIC-18-S26 asserts. */
export const DOCTOR_SECTION_TITLES: Readonly<Record<DoctorSectionId, string>> = {
  runtime: 'Runtime',
  git: 'git',
  sandboxing: 'Sandboxing',
  agents: 'Agents',
  capabilities: 'Capabilities',
  conformance: 'Conformance',
  auth: 'Auth shadowing',
  memory: 'PTY and Memory layer',
};

export interface DoctorCheck {
  /** Stable and machine-readable — what `--json` is keyed on, and what a CI
   * job greps for. Never the human sentence. */
  readonly id: string;
  readonly status: CheckStatus;
  /** Why it is that status. Never empty: AC1's "with a reason" is a property
   * of every check, including the passing ones. */
  readonly detail: string;
  /** Structured extras that belong in `--json` but would clutter the text —
   * the resolved binary path, the parsed version, the capability matrix. */
  readonly data?: Readonly<Record<string, unknown>>;
}

/** What a category hands the reducer. It states no status of its own. */
export interface DoctorSectionInput {
  readonly id: DoctorSectionId;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorSection {
  readonly id: DoctorSectionId;
  readonly title: string;
  /** The worst status among `checks`. */
  readonly status: CheckStatus;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorReport {
  readonly sections: readonly DoctorSection[];
  readonly status: CheckStatus;
  /** `0` for ok/warn, `DOCTOR_EX_FAIL` for any fail. Nothing else (AC11). */
  readonly exitCode: number;
}

/** Worst-wins, in severity order. */
const SEVERITY: Readonly<Record<CheckStatus, number>> = { ok: 0, warn: 1, fail: 2 };

export function worstStatus(statuses: readonly CheckStatus[]): CheckStatus {
  return statuses.reduce<CheckStatus>(
    (worst, status) => (SEVERITY[status] > SEVERITY[worst] ? status : worst),
    'ok',
  );
}

/** The substitute for a category that produced nothing at all (AC1). */
function emptySectionCheck(id: DoctorSectionId): DoctorCheck {
  return {
    id: `${id}.empty`,
    status: 'fail',
    detail:
      `the ${DOCTOR_SECTION_TITLES[id]} section produced no checks — a category that reports ` +
      'nothing has not passed, it has not run, and this is a bug in doctor itself rather than a ' +
      'fact about this machine',
  };
}

/**
 * The one place a status or an exit code is decided.
 *
 * Sections are emitted in `DOCTOR_SECTION_IDS` order regardless of the order
 * they were collected in, so the report a human reads and the document CI
 * parses are stable across a change to the collection order.
 */
export function reduceReport(inputs: readonly DoctorSectionInput[]): DoctorReport {
  const byId = new Map(inputs.map((input) => [input.id, input]));

  const sections: DoctorSection[] = DOCTOR_SECTION_IDS.map((id) => {
    const checks = byId.get(id)?.checks ?? [];
    const filled = checks.length === 0 ? [emptySectionCheck(id)] : checks;
    return {
      id,
      title: DOCTOR_SECTION_TITLES[id],
      status: worstStatus(filled.map((check) => check.status)),
      checks: filled,
    };
  });

  const status = worstStatus(sections.map((section) => section.status));
  return { sections, status, exitCode: status === 'fail' ? DOCTOR_EX_FAIL : 0 };
}

/** Indents a multi-line reason under its own bullet, so a paragraph does not
 * fall out of the list it belongs to. */
function indent(detail: string, prefix: string): string {
  return detail
    .split('\n')
    .map((line, index) => (index === 0 ? line : `${prefix}${line}`))
    .join('\n');
}

/**
 * The human rendering.
 *
 * No colour and no TTY detection anywhere: the renderer is a pure function of
 * the report, which is what keeps `DeFlow doctor > report.txt` free of escape
 * sequences without a `process.stdout.isTTY` branch that gets evaluated at
 * import time (the failure EPIC-18-S25's note describes).
 */
export function renderText(report: DoctorReport): string {
  const lines: string[] = ['DeFlow doctor'];

  for (const section of report.sections) {
    lines.push('', `${section.title} — ${section.status}`);
    for (const check of section.checks) {
      lines.push(`  [${check.status}] ${check.id}: ${indent(check.detail, '        ')}`);
    }
  }

  // The exit code is printed as well as returned, because the number a human
  // sees and the number their CI branched on being the same number is the
  // whole of AC10 and the first thing anyone doubts when they disagree.
  lines.push('', `overall: ${report.status} — exit ${report.exitCode}`);
  return `${lines.join('\n')}\n`;
}

/**
 * The machine rendering (AC10): the same information and the same exit code,
 * as one document rather than a stream of lines — a doctor report is a single
 * value, and NDJSON would invite a consumer to read the first section and act
 * on it.
 */
export function renderJson(report: DoctorReport): string {
  return `${JSON.stringify(
    {
      status: report.status,
      exitCode: report.exitCode,
      sections: report.sections.map((section) => ({
        id: section.id,
        title: section.title,
        status: section.status,
        checks: section.checks.map((check) => ({
          id: check.id,
          status: check.status,
          detail: check.detail,
          ...(check.data === undefined ? {} : { data: check.data }),
        })),
      })),
    },
    null,
    2,
  )}\n`;
}
