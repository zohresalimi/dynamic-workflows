/**
 * KAR-02.7 — the upcaster registry (docs/04-domain-model.md §9.2 rule 3).
 *
 * Events are never rewritten on disk. The ledger is append-only and
 * immutable, so a v1 payload written in March is still a v1 payload in
 * December; the chain from v1 to v4 must still exist when v5 ships.
 * Upcasters are therefore pure, append-only, and never deleted, and they run
 * on the way *into* the reducer, not on the way onto disk.
 *
 * Two properties are load-bearing enough to be enforced here rather than
 * documented:
 *
 * 1. **Completeness is checked eagerly.** The alternative to
 *    `assertUpcasterChainsComplete()` is discovering a missing hop during
 *    replay of a nine-hour run, at the one moment the data is least
 *    recoverable. The check is O(kinds × versions) over a static table, so
 *    running it at every daemon boot costs nothing.
 * 2. **Purity is enforced structurally.** `upcast` hands each hop a fresh
 *    deep copy, so an upcaster that mutates its argument in place — the
 *    single easiest mistake to make here — cannot reach the caller's value or
 *    the next reader of the same event.
 *
 * If an upcaster cannot be written, the schema change is genuinely lossy and
 * that is a new `kind`, not a new `v`. `checkUpcastersPreserveRequiredFields`
 * is the mechanical half of that rule; schemas/CHANGELOG.md is the other
 * half.
 *
 * Verifies: EPIC-02-S20, EPIC-02-S21, EPIC-02-S22 · AC2, AC4, AC5, AC8
 */
import type { z } from 'zod';
import {
  BudgetConsumedSchema,
  BudgetExceededSchema,
  EVENT_CURRENT_VERSIONS,
  GateEvaluatedSchema,
  PlanPatchProposedSchema,
  PlanPatchRejectedSchema,
  PlanProposedSchema,
  PlanValidationFailedSchema,
  RunNeedsHumanSchema,
} from './event-payloads.ts';

/** A single hop: version `n` in, version `n + 1` out. Pure. */
export type Upcaster = (payload: unknown) => unknown;

/**
 * One registered hop.
 *
 * `to` and `fixture` are part of the registration rather than of a separate
 * test file on purpose: they are what lets the suite check every hop
 * mechanically — a hop whose output its own target schema rejects, or that
 * drops a field that target marks required, is caught by a test over the
 * registry instead of by the one replay that happens to contain that event.
 */
export interface UpcasterRegistration {
  readonly kind: string;
  /** The version this hop accepts; it produces `from + 1`. */
  readonly from: number;
  /** The schema of version `from + 1`. */
  readonly to: z.ZodType;
  /** A representative payload at version `from`. */
  readonly fixture: unknown;
  readonly up: Upcaster;
}

export class DuplicateUpcaster extends Error {
  readonly kind: string;
  readonly version: number;

  constructor(kind: string, version: number) {
    super(
      `duplicate-upcaster: an upcaster is already registered for ("${kind}", ${version}); ` +
        'upcasters are append-only and a registration is never replaced.',
    );
    this.name = 'DuplicateUpcaster';
    this.kind = kind;
    this.version = version;
  }
}

export class UnknownUpcasterKind extends Error {
  readonly kind: string;

  constructor(kind: string) {
    super(`unknown-kind: "${kind}" has no current payload version in this registry.`);
    this.name = 'UnknownUpcasterKind';
    this.kind = kind;
  }
}

export class UpcasterFutureVersion extends Error {
  readonly kind: string;
  readonly version: number;
  readonly current: number;

  constructor(kind: string, version: number, current: number) {
    super(
      `future-version: "${kind}" arrived at v${version} but this build knows v${current}; ` +
        'a future payload is skipped, never downcast.',
    );
    this.name = 'UpcasterFutureVersion';
    this.kind = kind;
    this.version = version;
    this.current = current;
  }
}

export class UpcasterChainIncomplete extends Error {
  readonly kind: string;
  readonly version: number;

  constructor(kind: string, version: number, total: number) {
    super(
      `upcaster-chain-incomplete: no upcaster is registered for ("${kind}", ${version}), ` +
        `so a v${version} payload cannot be read by this build ` +
        `(${total} hop${total === 1 ? '' : 's'} missing in total). ` +
        'Add the upcaster, or ship the change as a new kind if it is lossy.',
    );
    this.name = 'UpcasterChainIncomplete';
    this.kind = kind;
    this.version = version;
  }
}

/** A hop that is required by some kind's current version but not registered. */
export interface MissingHop {
  readonly kind: string;
  readonly version: number;
}

/** What the registry guards report. Empty means clean. */
export interface UpcasterViolation {
  readonly kind: string;
  readonly from: number;
  readonly message: string;
}

export class UpcasterRegistry {
  readonly #current: ReadonlyMap<string, number>;
  readonly #hops = new Map<string, Map<number, UpcasterRegistration>>();

  constructor(currentVersions: Readonly<Record<string, number>>) {
    this.#current = new Map(Object.entries(currentVersions));
  }

  /** The version this build writes for `kind`, or `undefined` if unknown. */
  currentVersion(kind: string): number | undefined {
    return this.#current.get(kind);
  }

  register(registration: UpcasterRegistration): void {
    const current = this.#current.get(registration.kind);
    if (current === undefined) throw new UnknownUpcasterKind(registration.kind);

    const byVersion = this.#hops.get(registration.kind) ?? new Map<number, UpcasterRegistration>();
    if (byVersion.has(registration.from)) {
      throw new DuplicateUpcaster(registration.kind, registration.from);
    }
    byVersion.set(registration.from, registration);
    this.#hops.set(registration.kind, byVersion);
  }

  /** Every registration, sorted by kind then version. */
  registrations(): readonly UpcasterRegistration[] {
    return [...this.#hops.entries()]
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap(([, byVersion]) =>
        [...byVersion.entries()].toSorted(([a], [b]) => a - b).map(([, hop]) => hop),
      );
  }

  /**
   * Lifts `payload` from version `v` to `kind`'s current version, applying
   * every hop in ascending order.
   *
   * Throws on an unknown kind, on a future version (never downcast, never
   * guessed at) and on a missing hop. Every one of those is a programming or
   * a deployment error rather than data the reducer should try to interpret;
   * `parseEvent` in ./events.ts turns the first two into values before they
   * ever reach here.
   */
  upcast(kind: string, v: number, payload: unknown): unknown {
    const current = this.#current.get(kind);
    if (current === undefined) throw new UnknownUpcasterKind(kind);
    if (v > current) throw new UpcasterFutureVersion(kind, v, current);

    const byVersion = this.#hops.get(kind);
    let value = clone(payload);
    for (let version = v; version < current; version += 1) {
      const hop = byVersion?.get(version);
      if (hop === undefined) {
        throw new UpcasterChainIncomplete(kind, version, this.missingHops().length);
      }
      // A fresh copy per hop: an upcaster that mutates in place then mutates
      // a value nobody else holds.
      value = clone(hop.up(value));
    }
    return value;
  }

  /** Every hop some kind needs and does not have, kind-then-version ordered. */
  missingHops(): readonly MissingHop[] {
    const missing: MissingHop[] = [];
    for (const kind of [...this.#current.keys()].toSorted()) {
      const current = this.#current.get(kind) ?? 1;
      const byVersion = this.#hops.get(kind);
      for (let version = 1; version < current; version += 1) {
        if (!byVersion?.has(version)) missing.push({ kind, version });
      }
    }
    return missing;
  }

  /** AC4: fails loudly, naming `(kind, v)`, at registry-build time. */
  assertChainsComplete(): void {
    const missing = this.missingHops();
    const first = missing[0];
    if (first !== undefined) {
      throw new UpcasterChainIncomplete(first.kind, first.version, missing.length);
    }
  }
}

/**
 * A structured deep copy. `structuredClone` is a language global, not a
 * `node:` import, so it stays inside R1's "core performs no I/O" boundary —
 * and it is a genuine deep copy, unlike a spread.
 */
function clone(value: unknown): unknown {
  return structuredClone(value);
}

/**
 * Test 6 / EPIC-02-S20: for every registered hop, its own target schema must
 * accept what it produces from its own fixture.
 */
export function checkUpcasterFixtures(registry: UpcasterRegistry): UpcasterViolation[] {
  const violations: UpcasterViolation[] = [];
  for (const hop of registry.registrations()) {
    let produced: unknown;
    try {
      produced = hop.up(clone(hop.fixture));
    } catch (thrown) {
      violations.push({
        kind: hop.kind,
        from: hop.from,
        message: `threw on its own fixture: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
      });
      continue;
    }
    const parsed = hop.to.safeParse(produced);
    if (!parsed.success) {
      violations.push({
        kind: hop.kind,
        from: hop.from,
        message: `produced a payload its own v${hop.from + 1} schema rejects: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      });
    }
  }
  return violations;
}

/**
 * AC8 / EPIC-02-S22: no upcaster may drop a field its target schema marks
 * required.
 *
 * The guard cannot prove intent — "is this change lossy?" is a judgement — but
 * it catches the mechanical version of the mistake, which would otherwise
 * fail only when that one historical event is replayed.
 */
export function checkUpcastersPreserveRequiredFields(
  registry: UpcasterRegistry,
): UpcasterViolation[] {
  const violations: UpcasterViolation[] = [];
  for (const hop of registry.registrations()) {
    const required = requiredKeysOf(hop.to);
    if (required === null) continue;

    let produced: unknown;
    try {
      produced = hop.up(clone(hop.fixture));
    } catch {
      // Already reported, with its message, by checkUpcasterFixtures.
      continue;
    }
    if (produced === null || typeof produced !== 'object') {
      violations.push({
        kind: hop.kind,
        from: hop.from,
        message: `produced ${produced === null ? 'null' : typeof produced} where its target is an object`,
      });
      continue;
    }
    const record = produced as Record<string, unknown>;
    const dropped = required.filter((key) => record[key] === undefined);
    if (dropped.length > 0) {
      violations.push({
        kind: hop.kind,
        from: hop.from,
        message:
          `drops ${dropped.map((key) => `"${key}"`).join(', ')}, which its v${hop.from + 1} ` +
          'schema marks required — a change with no pure function from the old payload to the ' +
          'new one is a new kind, not a new v',
      });
    }
  }
  return violations;
}

/** The required keys of an object schema, or `null` if it is not one. */
function requiredKeysOf(schema: z.ZodType): string[] | null {
  const shape = (schema as { shape?: unknown }).shape;
  if (shape === null || typeof shape !== 'object') return null;
  return Object.entries(shape as Record<string, z.ZodType>)
    .filter(([, field]) => !field.safeParse(undefined).success)
    .map(([key]) => key);
}

/**
 * The registry the daemon reads events through: every event kind this build
 * knows, at the version this build writes.
 *
 * A `v: 2` in ./event-payloads.ts must arrive with its `registerUpcaster` call
 * in the same commit, or `assertUpcasterChainsComplete` fails in the unit suite
 * and at daemon boot. The registrations themselves are at the bottom of this
 * file rather than in a module of their own, because a registration in a file
 * nobody imports is a hop that silently does not exist.
 */
export const eventUpcasters = new UpcasterRegistry(EVENT_CURRENT_VERSIONS);

export function registerUpcaster(registration: UpcasterRegistration): void {
  eventUpcasters.register(registration);
}

export function upcast(kind: string, v: number, payload: unknown): unknown {
  return eventUpcasters.upcast(kind, v, payload);
}

export function assertUpcasterChainsComplete(registry: UpcasterRegistry = eventUpcasters): void {
  registry.assertChainsComplete();
}

// ── registered hops ──────────────────────────────────────────────────────────

/**
 * `budget.consumed` v1 → v2 (KAR-14.1). See schemas/CHANGELOG.md.
 *
 * v2 widens `costUsd` from `number` to `number | null` — every v1 value still
 * fits — and adds two fields:
 *
 * - `authMode`, defaulted to `'subscription'`. It is a **computable** default
 *   rather than a guess: KAR-08.8 makes `'api_key'` something a plan can only
 *   reach by explicitly opting in, so a payload written before the field
 *   existed cannot have been an api-key spend.
 * - `attempt`, left absent, because v1 recorded no attempt and inventing `0`
 *   would file a retry's spend under the attempt it replaced. Absent reads as
 *   "this contribution belongs to the node's cumulative figure and to no
 *   single attempt", which is exactly what a v1 payload knows.
 */
registerUpcaster({
  kind: 'budget.consumed',
  from: 1,
  to: BudgetConsumedSchema,
  fixture: {
    node: 'n-impl',
    provider: 'claude',
    usage: { inputTokens: 18_420, outputTokens: 2310, source: 'vendor-reported' },
    costUsd: 0.42,
  },
  up: (payload) => ({ ...(payload as Record<string, unknown>), authMode: 'subscription' }),
});

/**
 * `budget.consumed` v2 → v3 (KAR-14.3). See schemas/CHANGELOG.md.
 *
 * v3 adds one optional field, `estimate`, and it is left **absent**. A v2
 * payload was written before there was a pre-flight estimator, so there is no
 * figure to lift and none to invent: filling it in with the actual would make
 * every historical attempt read as perfectly estimated and drag the per-run
 * accuracy figure toward a 1.0 nobody measured.
 */
registerUpcaster({
  kind: 'budget.consumed',
  from: 2,
  to: BudgetConsumedSchema,
  fixture: {
    node: 'n-impl',
    attempt: 0,
    provider: 'claude',
    usage: { inputTokens: 18_420, outputTokens: 2310, source: 'vendor-reported' },
    costUsd: 0.42,
    authMode: 'subscription',
  },
  up: (payload) => payload,
});

/**
 * `budget.exceeded` v1 → v2 (KAR-14.2). See schemas/CHANGELOG.md.
 *
 * v2 adds three fields and widens nothing, so every v1 payload still fits:
 *
 * - `failureClass`, filled with `'gate'`. Not a guess — it is the only value the
 *   v2 schema accepts, and the only one `NodeFailureSchema` has ever accepted
 *   for `budget.cost-exceeded` and `budget.wallclock-exceeded`. A v1 breach was
 *   a gate; the field merely says so on the log.
 * - `firedBy`, filled with `'deflow'`. A v1 payload predates the vendor-ceiling
 *   path entirely (`--max-budget-usd`, AC9), so every breach written under it
 *   came from DeFlow's own admission check.
 * - `basis` and `node`, left **absent**. v1 recorded neither the rollup
 *   breakdown nor which node a node-scoped breach was about, and inventing
 *   either would put a figure on the timeline nobody measured.
 */
registerUpcaster({
  kind: 'budget.exceeded',
  from: 1,
  to: BudgetExceededSchema,
  fixture: { scope: 'run', dimension: 'cost', limit: 20, actual: 21.4 },
  up: (payload) => ({
    ...(payload as Record<string, unknown>),
    failureClass: 'gate',
    firedBy: 'deflow',
  }),
});

/**
 * `plan.patch.proposed` v1 → v2 (KAR-14.4). See schemas/CHANGELOG.md.
 *
 * v2 adds one optional field, `cause`, and it is left **absent**. A v1 payload
 * was written before the reactive rate-limit path existed, so a quota cannot
 * have been the reason for it — and filling one in would make every historical
 * planner-proposed patch read as a vendor swap in the plan scrubber, which is
 * the one surface F3.9 exists to make trustworthy.
 */
registerUpcaster({
  kind: 'plan.patch.proposed',
  from: 1,
  to: PlanPatchProposedSchema,
  fixture: {
    patch: {
      schemaId: 'DeFlow.planpatch.v1',
      id: 'reroute-run_20260802T141133Z_9f2a1c-impl-1-1',
      proposedBy: 'scheduler',
      reason: 'impl-1 failed with provider.rate-limited; retrying attempt 1 on codex',
      ops: [{ op: 'replace-provider', node: 'impl-1', provider: 'codex' }],
      policy: {
        estimatedCostDeltaUsd: 0,
        estimatedWallClockDeltaMs: 0,
        blastRadius: { paths: [], nodeCount: 1 },
        replanDepth: 0,
        escalatesPermission: null,
        addsWriteCapability: false,
      },
    },
  },
  up: (payload) => payload,
});

/**
 * `run.needs_human` v1 → v2 (KAR-10.3). See schemas/CHANGELOG.md.
 *
 * v2 widens `reason` by one member, `spec-revalidation`, and changes nothing
 * else — so the hop is the identity and every v1 payload is already a valid v2
 * one. It is still a version, because the direction that matters is the other
 * one: a v2 payload carrying the new reason must be *refused* by a daemon that
 * predates it rather than folded into a `needsHuman` whose reason that build
 * cannot render.
 */
registerUpcaster({
  kind: 'run.needs_human',
  from: 1,
  to: RunNeedsHumanSchema,
  fixture: {
    reason: 'churn',
    detail: 'three replans moved nothing; the plan rests on a premise only you can supply',
  },
  up: (payload) => payload,
});

/**
 * `gate.evaluated` v1 → v2 (KAR-10.4). See schemas/CHANGELOG.md.
 *
 * v2's verdict is `DeFlow.verdict.v2`, which adds one optional field —
 * `specHash`, the contract the gate judged against — so the hop is the
 * identity and it is left **absent**.
 *
 * There is no honest value to lift. A v1 payload was written before a verdict
 * named its contract at all, so filling in the run's current hash would assert
 * that a historical reviewer was shown a document that did not exist when it
 * ran, and would make a criterion go green on the strength of it. Leaving it
 * absent is the safe direction: `isVerdictVoid` treats an unnamed contract
 * exactly as it treats a mismatched one, so the worst outcome of the hop is a
 * gate that re-runs.
 */
registerUpcaster({
  kind: 'gate.evaluated',
  from: 1,
  to: GateEvaluatedSchema,
  fixture: {
    gate: 'codemod-review',
    node: 'step-04',
    verdict: {
      schemaId: 'DeFlow.verdict.v1',
      outcome: 'pass',
      gate: 'codemod-review',
      evaluatedNode: 'step-04',
      by: { node: 'gate-04', provider: 'codex', model: 'the-model-the-gate-ran-on' },
      criteria: [{ id: 'unit-tests-pass', status: 'satisfied' }],
      findings: [],
      summary: 'Every criterion this gate speaks to is satisfied.',
    },
  },
  up: (payload) => payload,
});

/**
 * `run.needs_human` v2 → v3 (KAR-11.1). See schemas/CHANGELOG.md.
 *
 * v3 widens `reason` by one member, `plan-invalid`, and changes nothing else,
 * so the hop is the identity for exactly the reason the v1 → v2 hop above is:
 * every v2 payload is already a valid v3 one, and what the version buys is the
 * *other* direction — a daemon that predates `plan-invalid` refuses the event
 * instead of rendering an escalation whose reason it cannot name.
 */
registerUpcaster({
  kind: 'run.needs_human',
  from: 2,
  to: RunNeedsHumanSchema,
  fixture: {
    reason: 'spec-revalidation',
    detail: 'the amended spec adds a criterion the current plan does not cover',
  },
  up: (payload) => payload,
});

/**
 * `plan.proposed` v1 → v2 (KAR-11.1). See schemas/CHANGELOG.md.
 *
 * v2 adds the optional `planner` attribution — which model planned, at what
 * reasoning effort, in which tier (06 §6, AC6) — so the hop is the identity and
 * the field is left **absent**.
 *
 * There is no honest value to lift, and the shape of the dishonesty is worth
 * naming because it is tempting: the run's *current* planner model is right
 * there in the config, and stamping it on a historical proposal would make the
 * one measurement this field exists for — join the tier against gate first-pass
 * rate and replans-per-run — report a comparison between a model and itself.
 * Absent is a value the analysis can exclude; a plausible wrong one is not.
 */
registerUpcaster({
  kind: 'plan.proposed',
  from: 1,
  to: PlanProposedSchema,
  fixture: {
    version: 1,
    planHash: `sha256-${'a'.repeat(64)}`,
    graph: {
      schemaId: 'DeFlow.plangraph.v1',
      runId: 'run_20260802T141133Z_9f2a1c',
      version: 1,
      planHash: `sha256-${'a'.repeat(64)}`,
      parent: null,
      taskSpecHash: `sha256-${'b'.repeat(64)}`,
      createdBy: 'planner',
      createdAt: '2026-08-02T14:11:33.000Z',
      nodes: [
        {
          id: 'implement',
          title: 'Implement the change',
          type: 'agent',
          deps: [],
          lifecycle: 'active',
          reads: [{ kind: 'spec', section: 'goal' }],
          writes: [],
          permission: 'worktree',
          pathScopes: { write: ['packages/ui/**'] },
          returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
          retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
          budget: {},
          brief: 'Migrate the components named in the spec.',
          provider: { prefer: ['claude'], requires: ['structuredOutput'] },
          resume: 'always-replay',
        },
      ],
      edges: [],
    },
    by: 'planner',
  },
  up: (payload) => payload,
});

/**
 * `plan.validation_failed` v1 → v2 (KAR-11.2). See schemas/CHANGELOG.md.
 *
 * v2 widens `diagnostics[].node` from `NodeId` to a non-empty string, so every
 * v1 payload still fits and the hop is the identity.
 *
 * The widening is not a relaxation of a rule: it is what lets the two
 * diagnostics that *cannot* name a valid `NodeId` be recorded at all —
 * `INVALID_NODE_ID`, whose whole subject is an id the charset refuses, and
 * `CRITERION_UNCOVERED`, which is a fault of the document and carries
 * `PLAN_SCOPE`. A payload schema that refused them would make the validator
 * crash on exactly the faults it exists to catch.
 */
registerUpcaster({
  kind: 'plan.validation_failed',
  from: 1,
  to: PlanValidationFailedSchema,
  fixture: {
    version: 1,
    planHash: `sha256-${'c'.repeat(64)}`,
    by: 'planner',
    attempt: 0,
    diagnostics: [
      {
        severity: 'error',
        code: 'READ_UNREACHABLE',
        node: 'implement',
        key: 'finding/db-schema',
        message:
          "node 'implement' reads 'finding/db-schema' but no ancestor writes it and it is not " +
          'in the pinned spec',
      },
    ],
  },
  up: (payload) => payload,
});

/**
 * `plan.patch.rejected` v1 → v2 (KAR-11.2). See schemas/CHANGELOG.md.
 *
 * v2 widens `by` with a third value, `'validation'`, and adds an optional
 * `diagnostics` array. Both are additive, so the hop is the identity — and
 * `by` is deliberately *not* rewritten: a v1 rejection really was a policy or a
 * human decision, because structural revalidation did not exist to reject
 * anything when it was written.
 */
registerUpcaster({
  kind: 'plan.patch.rejected',
  from: 1,
  to: PlanPatchRejectedSchema,
  fixture: {
    patchId: 'patch_01j9v1s5t1m1q9x8y7z6w5v4u3',
    rule: 'replan-depth-exceeded',
    by: 'policy',
  },
  up: (payload) => payload,
});
