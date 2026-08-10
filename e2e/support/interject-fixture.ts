/**
 * A data directory holding one run with a node genuinely mid-flight, seeded
 * before any daemon is started over it (KAR-13.3, EPIC-13-S17).
 *
 * The run is seeded rather than driven through a real planner and a real agent
 * because what the e2e is about is the *interjection* reaching a daemon that
 * owns the directory — the paths that produce a running node have their own
 * suites against real spawned processes
 * (`packages/adapters/test/integration/*`).
 *
 * The write happens with no daemon running and the connection is closed before
 * one is spawned: `boot()` takes an exclusive lease on the directory, and two
 * writers is the failure EPIC-03-S21 exists to prevent, not one to reproduce
 * here by accident.
 */
import { RunIdSchema } from '@DeFlow/core';
import { appendEvents, openLedger, recordProviderCapabilities } from '@DeFlow/ledger';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const INTERJECT_RUN = RunIdSchema.parse('run_20260810T114500Z_e21b73');

export const IMPL = 'implement';
export const GATE = 'approve-scope';
export const PROVIDER = 'mock-steerable';

export const GUIDANCE = "Use the existing useToast composable, don't add a new one.";

const T0 = 1_754_566_500_000;
const EPOCH = 1;
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;
const BINARY_SHA = 'b'.repeat(64);

const taskSpec: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../packages/core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

const base = (id: string): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
});

export const GATE_PROMPT = 'Recon found 3 extra packages. Extend the migration scope?';

export const GATE_OPTIONS = [
  { id: 'yes', label: 'Extend scope', effect: 'approve' },
  { id: 'no', label: 'Keep scope as-is', effect: 'reject' },
];

const plan = {
  schemaId: 'DeFlow.plangraph.v1',
  runId: INTERJECT_RUN,
  version: 1,
  planHash: PLAN_HASH,
  parent: null,
  taskSpecHash: SPEC_HASH,
  createdBy: 'planner',
  createdAt: '2026-08-10T11:45:00.000Z',
  nodes: [
    {
      ...base(IMPL),
      type: 'agent',
      brief: 'Port CheckoutForm.vue to the Composition API.',
      provider: { prefer: [PROVIDER], requires: [] },
      resume: 'always-replay',
    },
    { ...base(GATE), type: 'human', prompt: GATE_PROMPT, options: GATE_OPTIONS },
  ],
  edges: [],
};

const draft = (kind: string, v: number, payload: unknown) =>
  ({ runId: INTERJECT_RUN, ts: T0, kind, v, epoch: EPOCH, payload }) as never;

/**
 * One run: `implement` running on attempt 1 on an adapter that advertises
 * mid-turn steering, and a `human` gate suspended beside it.
 */
export async function seedRunningNode(dataDir: string): Promise<string> {
  const db = openLedger(dataDir);
  try {
    recordProviderCapabilities(db, {
      provider: PROVIDER,
      version: '0.0.0',
      binarySha256: BINARY_SHA,
      binaryPath: '/opt/mock/bin/agent',
      capsJson: JSON.stringify({
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false },
          _meta: { midSessionSteering: true },
        },
        authMethods: [],
      }),
      probedAt: T0,
    });

    appendEvents(db, [
      draft('run.created', 1, {
        spec: taskSpec,
        cwd: '/home/u/proj',
        repo: { head: 'e83c516', branch: 'main' },
      }),
      draft('run.spec.approved', 1, { specHash: SPEC_HASH, by: 'ui' }),
      draft('plan.proposed', 2, { version: 1, planHash: PLAN_HASH, graph: plan, by: 'planner' }),
      draft('run.started', 1, { planHash: PLAN_HASH }),
      draft('node.scheduled', 1, { node: IMPL, provider: PROVIDER, permission: 'read' }),
      draft('node.started', 2, {
        node: IMPL,
        attempt: 1,
        ikey: `${INTERJECT_RUN}/${IMPL}/1/0`,
        binary: { path: '/opt/mock/bin/agent', version: '0.0.0', sha256: BINARY_SHA },
      }),
      draft('human.requested', 4, { node: GATE, prompt: GATE_PROMPT, options: GATE_OPTIONS }),
      draft('node.suspended', 1, { node: GATE, until: { kind: 'human' } }),
      // Paused so the spec is deterministic rather than racing a live
      // scheduler. Boot recovery still runs — it concludes the attempt the
      // dead daemon was holding (KAR-06.9 step 5) — but `decide()` admits
      // nothing afterwards, so every write past that point is the
      // interjection's and can be attributed to it.
      draft('run.paused', 1, { by: 'user', reason: 'seeded paused for a deterministic spec' }),
    ]);
  } finally {
    db.close();
  }
  return dataDir;
}
