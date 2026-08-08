/**
 * KAR-11.1 / KAR-11.2 — plan validation diagnostics as **values**
 * (docs/06-planning-and-replanning.md §3, §3.5).
 *
 * §3.5 is the rule this module exists to make possible: *"a failing v1 goes
 * back to the planner once with the diagnostics as input; a second failure
 * escalates to a `human` node with the diagnostics rendered"*. That is only
 * implementable if a validation failure is a value the compiler can put in an
 * event and then in a packet — a thrown exception has nowhere to go but a stack
 * trace, and a stack trace is not something a planner can act on.
 *
 * **This is the vocabulary, not the validator.** The closed code set, the two
 * severities, the shape of one finding, and the rendering the retry packet and
 * `run.needs_human` carry all live here, because the ledger's payload schema
 * (`plan.validation_failed`) reads the code list from this file and a code
 * invented at a call site is one nothing downstream can recognise. The checks
 * themselves are `validatePlan` in ./validate-plan.ts — one entry point, so
 * there is no partial validation anybody can accidentally call instead.
 *
 * Verifies: EPIC-11-S5 · KAR-11.1 AC3, KAR-11.2 AC1
 */
/**
 * Every diagnostic code this epic can produce, with the ones KAR-11.2 adds
 * listed alongside the one KAR-11.1 emits.
 *
 * Stated as a closed set here rather than grown ad hoc, because the codes are
 * what `plan.validation_failed` carries into the ledger: a code invented at a
 * call site is one nothing downstream — the API, the plan-evolution scrubber,
 * an operator's grep — can be taught to recognise.
 */
export const PLAN_DIAGNOSTIC_CODES = [
  /** F6.2, §3.1 — a declared read no ancestor writes and the spec does not pin. */
  'READ_UNREACHABLE',
  /** §3.1 — `topoSort` threw; the graph is not a DAG. KAR-11.2. */
  'PLAN_CYCLE',
  /** §3.1 — a key nothing reads. A warning, never an error. KAR-11.2. */
  'ORPHAN_WRITE',
  /** §3.2 — the five capability refusals. KAR-11.2. */
  'PROVIDER_NOT_PROBED',
  'NO_STRUCTURED_OUTPUT',
  'NO_RESUME',
  'PERMISSION_UNSUPPORTED',
  'PACKET_EXCEEDS_BUDGET',
  /** §3.3 — a node id git or DeFlow will not accept. KAR-11.2. */
  'INVALID_NODE_ID',
  /** F7.4 — an acceptance criterion no gate node covers. KAR-11.2. */
  'CRITERION_UNCOVERED',
] as const;

export type PlanDiagnosticCode = (typeof PLAN_DIAGNOSTIC_CODES)[number];

export const PLAN_DIAGNOSTIC_SEVERITIES = ['error', 'warning'] as const;

export type PlanDiagnosticSeverity = (typeof PLAN_DIAGNOSTIC_SEVERITIES)[number];

/**
 * One finding about one plan document, in §3.1's shape.
 *
 * `node` and `key` are separate fields rather than folded into `message`
 * because the UI joins on them: F10.1 highlights the offending node in the
 * graph, and it cannot do that from a sentence.
 */
export interface PlanDiagnostic {
  readonly severity: PlanDiagnosticSeverity;
  readonly code: PlanDiagnosticCode;
  readonly node: string;
  /** The declared read, the written key, or the criterion id. */
  readonly key: string;
  readonly message: string;
}

/** Whether anything here blocks the plan. A `warning` does not (§3.1). */
export function hasBlockingDiagnostic(diagnostics: readonly PlanDiagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'error');
}

/**
 * The diagnostics as the retry packet and the `run.needs_human` payload carry
 * them.
 *
 * One line each, code first, so a planner scanning the text can group by fault
 * kind, and so a human reading the escalation sees the same lines the planner
 * was shown rather than a second, kinder summary of them.
 */
export function renderPlanDiagnostics(diagnostics: readonly PlanDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return 'no diagnostics: the plan satisfied every check that ran.';
  }
  return diagnostics
    .map(
      (diagnostic) =>
        `[${diagnostic.severity}] ${diagnostic.code} ${diagnostic.node}: ${diagnostic.message}`,
    )
    .join('\n');
}
