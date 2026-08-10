/**
 * KAR-13.3 — a run with a node genuinely mid-flight, as a real ledger on disk.
 *
 * The story is about steering something that is *already running*, so the
 * fixture has to produce that state rather than assert it: `implement` is an
 * `agent` node on attempt 1 with a `node.started` in the log, and
 * `approve-scope` is a suspended `human` gate beside it. Both are needed —
 * without the gate there is nothing to check the "use respond instead" refusal
 * against, and a fixture with only the gate cannot tell a running node from a
 * waiting one.
 *
 * Two provider rows are probed, differing **only** in whether they advertise
 * mid-turn steering, because that is the fact the delivery answer is supposed
 * to turn on. Same version, same binary, same everything else: if the answers
 * differ, the capability is why.
 */
import type { Db, NodeId, ProviderId, RunId } from '@DeFlow/core';
import { NodeIdSchema, ProviderIdSchema, RunIdSchema } from '@DeFlow/core';
import { appendEvents, type EventDraft, recordProviderCapabilities } from '@DeFlow/ledger';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const INTERJECT_RUN: RunId = RunIdSchema.parse('run_20260810T101500Z_c41d09');

export const IMPL: NodeId = NodeIdSchema.parse('implement');
export const GATE: NodeId = NodeIdSchema.parse('approve-scope');

/** Advertises `_meta.midSessionSteering: true`. */
export const STEERABLE: ProviderId = ProviderIdSchema.parse('mock-steerable');
/** Advertises the field, explicitly `false` — the honest refusal. */
export const UNSTEERABLE: ProviderId = ProviderIdSchema.parse('mock-unsteerable');

export const T0 = 1_754_311_500_000;
export const EPOCH = 4;

export const GUIDANCE = "Use the existing useToast composable, don't add a new one.";

const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const REPO = '/home/u/proj';
const BINARY_SHA = 'b'.repeat(64);

export const IMPL_IKEY = `${INTERJECT_RUN}/${IMPL}/1/0`;

const taskSpec: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

const base = (id: string, deps: readonly string[] = []): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  deps: [...deps],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
});

export const OPTIONS = [
  { id: 'yes', label: 'Extend scope', effect: 'approve' },
  { id: 'no', label: 'Keep scope as-is', effect: 'reject' },
] as const;

export const PROMPT = 'Recon found 3 extra packages. Extend the migration scope?';

function interjectPlan(provider: ProviderId): Record<string, unknown> {
  return {
    schemaId: 'DeFlow.plangraph.v1',
    runId: INTERJECT_RUN,
    version: 1,
    planHash: PLAN_HASH,
    parent: null,
    taskSpecHash: SPEC_HASH,
    createdBy: 'planner',
    createdAt: '2026-08-10T10:15:00.000Z',
    nodes: [
      {
        ...base(IMPL),
        type: 'agent',
        brief: 'Port CheckoutForm.vue to the Composition API.',
        provider: { prefer: [provider], requires: [] },
        resume: 'always-replay',
      },
      {
        ...base(GATE),
        type: 'human',
        prompt: PROMPT,
        options: OPTIONS.map((option) => ({ ...option })),
      },
    ],
    edges: [],
  };
}

const draft = (kind: string, v: number, payload: unknown): EventDraft =>
  ({ runId: INTERJECT_RUN, ts: T0, kind, v, epoch: EPOCH, payload }) as EventDraft;

/** The `initialize` response each probed row stores, verbatim. */
export function capsJson(steering: boolean): string {
  return JSON.stringify({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
      _meta: { midSessionSteering: steering },
    },
    authMethods: [],
  });
}

/** Both providers, probed. Identical but for the one bit under test. */
export function probeProviders(db: Db): void {
  for (const [provider, steering] of [
    [STEERABLE, true],
    [UNSTEERABLE, false],
  ] as const) {
    recordProviderCapabilities(db, {
      provider,
      version: '0.0.0',
      binarySha256: BINARY_SHA,
      binaryPath: '/opt/mock/bin/agent',
      capsJson: capsJson(steering),
      probedAt: T0,
    });
  }
}

export interface SeedOptions {
  /** Which adapter the `implement` node runs on. Defaults to the steerable one. */
  readonly provider?: ProviderId;
  /** Whether the `human` gate is opened and suspended. Defaults to true. */
  readonly openGate?: boolean;
}

/**
 * A run whose `implement` node is running on attempt 1, with the gate beside it.
 *
 * Appended directly rather than driven through the scheduler: what is under
 * test is the interjection path, not the paths that happen to produce a running
 * node, and every payload here is one `appendEvents` validates — so a fixture
 * that drifted from a schema fails at the door.
 */
export function seedInterjectRun(db: Db, options: SeedOptions = {}): void {
  const provider = options.provider ?? STEERABLE;
  probeProviders(db);

  appendEvents(db, [
    draft('run.created', 1, {
      spec: taskSpec,
      cwd: REPO,
      repo: { head: 'e83c516', branch: 'main' },
    }),
    draft('run.spec.approved', 1, { specHash: SPEC_HASH, by: 'ui' }),
    draft('plan.proposed', 2, {
      version: 1,
      planHash: PLAN_HASH,
      graph: interjectPlan(provider),
      by: 'planner',
    }),
    draft('run.started', 1, { planHash: PLAN_HASH }),
    draft('node.scheduled', 1, { node: IMPL, provider, permission: 'read' }),
    draft('node.started', 2, {
      node: IMPL,
      attempt: 1,
      ikey: IMPL_IKEY,
      binary: { path: '/opt/mock/bin/agent', version: '0.0.0', sha256: BINARY_SHA },
    }),
  ]);

  if (options.openGate === false) return;

  appendEvents(db, [
    draft('human.requested', 4, {
      node: GATE,
      prompt: PROMPT,
      options: OPTIONS.map((option) => ({ ...option })),
    }),
    draft('node.suspended', 1, { node: GATE, until: { kind: 'human' } }),
  ]);
}

/** Finishes `implement`, so a spec can post at a node that just completed. */
export function completeImpl(db: Db): void {
  appendEvents(db, [
    draft('node.completed', 1, {
      node: IMPL,
      attempt: 1,
      result: {
        status: 'completed',
        output: { ok: true },
        outputSchemaId: 'DeFlow.finding.v1',
        usage: { inputTokens: 10, outputTokens: 2, source: 'vendor-reported' },
        costUsd: 0,
        producedFacts: [],
        artifacts: [],
      },
    }),
  ]);
}
