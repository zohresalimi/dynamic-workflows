/**
 * EPIC-11-S24 — the policy table is hashed into the run manifest, so a mid-run
 * edit of `.DeFlow/config.yaml` cannot silently change the rules a live run is
 * playing by (docs/06-planning-and-replanning.md §4.3, KAR-11.4 AC10).
 *
 * Integration because the claim is about a **real file being edited underneath
 * a running run**, and the failure it guards against is precisely an engine
 * that re-reads that file per patch. A unit test that handed the engine two
 * tables would prove the engine prefers the one it was given; only a test that
 * writes the second table to disk and does not hand it over can prove nothing
 * reaches for it.
 *
 * **One deviation from the scenario's wording, stated out loud.** The scenario
 * edits the *cost* threshold and proposes a patch with `costUsdDelta 6.20`. The
 * engine does not rule on the figure a proposer declares about itself — it
 * rules on what DeFlow's own estimator measured, which for any patch small
 * enough to write into a test file is a few cents. Driving the assertion off
 * the declared cost would therefore have tested nothing, and inflating a
 * fixture price table until a one-node insert cost six dollars would have been
 * a number chosen to make a test pass. So the threshold this test moves is
 * `replanDepth`, which the engine reads off the run's own lineage: the run
 * below really has replanned three times, and its fourth patch really is at
 * depth 4. The cost threshold is raised alongside it, because that is the edit
 * the scenario describes and it must not change this run's behaviour either.
 *
 * Verifies: EPIC-11-S24 · KAR-11.4 AC3, AC10 · test plan #10
 */
import { DEFAULT_PATCH_RULE_SPECS, patchPolicyHash, type RunId, RunIdSchema } from '@DeFlow/core';
import { appendEvents, type EventDraft, openLedger, readRange, replayRun } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { rulePatch } from '../../src/budget/patch-gate.ts';
import { pinPatchPolicy, workspacePatchPolicy } from '../../src/plan/patch-policy.ts';
import { o200kTokenizer } from '../../src/tokens/tokenizer.ts';

const RUN: RunId = RunIdSchema.parse('run_20260808T111500Z_aa11bb');
const SECOND: RunId = RunIdSchema.parse('run_20260808T121500Z_cc22dd');
const T0 = 1_754_643_600_000;
const PLAN_HASH = `sha256-${'a'.repeat(64)}`;
const SPEC_HASH = `sha256-${'c'.repeat(64)}`;

const taskSpec: unknown = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../core/test/fixtures/specs/vue3-migration.json', import.meta.url),
    ),
    'utf8',
  ),
);

/**
 * 06 §4.3's table, written out as an operator would write it — plus §4.4's one
 * added rule, `quota-reroute-equivalent`, in the position the shipped default
 * puts it: below every escalate and reject arm, so no `cause: 'quota'` can
 * carry a patch past a permission escalation or an exhausted budget.
 *
 * It is the shipped table spelled in YAML, which is why the digest below has to
 * equal `patchPolicyHash(DEFAULT_PATCH_RULE_SPECS)`: writing out the documented
 * defaults by hand must produce the defaults, or the file and the code have
 * drifted and the operator's copy is not what runs.
 */
const DEFAULT_YAML = `policy:
  patch:
    rules:
      - id: escalates-permission
        when: { permissionEscalation: true }
        decision: approve
      - id: touches-execution-boundary
        when: { touchesExecutionBoundary: true }
        decision: approve
      - id: replan-depth-exceeded
        when: { replanDepth: "> 3" }
        decision: reject
      - id: budget-exhausted
        when: { elapsedBudgetFraction: ">= 1.0" }
        decision: reject
      - id: quota-reroute-equivalent
        when: { rerouteEquivalent: true }
        decision: auto
      - id: expensive
        when: { costDeltaUsd: "> 5.00" }
        decision: approve
      - id: wide-blast-radius
        when: { blastRadiusFiles: "> 25" }
        decision: approve
      - id: read-only-analysis
        when: { maxPermission: read, costDeltaUsd: "<= 5.00" }
        decision: auto
      - id: default
        decision: approve
`;

/**
 * The same table with two thresholds raised, as the scenario's operator edits it
 * mid-run: the cost ceiling to 50.00, and the replan depth to 30.
 *
 * The depth is the one that separates the two tables by *outcome* — see the
 * deviation note at the top of this file — and having a second, inert edit
 * beside it is deliberate: a run that ignores the file must ignore all of it.
 */
const RAISED_YAML = DEFAULT_YAML.replace('"> 5.00"', '"> 50.00"').replace('"> 3"', '"> 30"');

const node = (id: string): Record<string, unknown> => ({
  id,
  title: `node ${id}`,
  type: 'agent',
  deps: [],
  lifecycle: 'active',
  reads: [],
  writes: [],
  permission: 'read',
  pathScopes: { write: [] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  retry: { maxAttempts: 3, backoff: { base: 2000, cap: 300_000, jitter: 'full' } },
  budget: {},
  brief: `brief for ${id}`,
  provider: { prefer: ['claude'], requires: [] },
  model: 'claude-sonnet-4-5',
  resume: 'always-replay',
});

/**
 * The fourth patch of a run that has already replanned three times: a cheap,
 * read-only insert, refused for its depth alone.
 *
 * It matches `replan-depth-exceeded` under the shipped thresholds and
 * `read-only-analysis` under the raised ones, which is what makes the two tables
 * distinguishable by outcome rather than only by digest.
 */
const FOURTH_REPLAN = {
  schemaId: 'DeFlow.planpatch.v1',
  id: 'patch-analysis',
  proposedBy: 'n-recon',
  reason: 'three more packages import the v2 API and each needs its own analysis pass',
  ops: [{ op: 'insert-nodes', nodes: [node('n-analyse-more')], edges: [] }],
  policy: {
    estimatedCostDeltaUsd: 6.2,
    estimatedWallClockDeltaMs: 0,
    blastRadius: { paths: [], nodeCount: 1 },
    replanDepth: 4,
    escalatesPermission: null,
    addsWriteCapability: false,
  },
} as const;

const draft = (runId: RunId, kind: string, payload: unknown, v = 1): EventDraft =>
  ({ runId, ts: T0, kind, v, epoch: 1, payload }) as EventDraft;

function seedRun(dataDir: string, runId: RunId): void {
  const db = openLedger(dataDir);
  try {
    appendEvents(db, [
      draft(runId, 'run.created', {
        spec: taskSpec,
        cwd: '/home/u/proj',
        repo: { head: 'e83c516', branch: 'main' },
      }),
      draft(runId, 'run.spec.approved', { specHash: SPEC_HASH, by: 'ui' }),
      draft(
        runId,
        'plan.proposed',
        {
          // v4: this run has already replanned three times, which is what
          // makes its next patch a depth-4 one. The depth is read off the
          // lineage, never off the proposer's claim about itself.
          version: 4,
          planHash: PLAN_HASH,
          graph: {
            schemaId: 'DeFlow.plangraph.v1',
            runId,
            version: 4,
            planHash: PLAN_HASH,
            parent: `sha256-${'9'.repeat(64)}`,
            taskSpecHash: SPEC_HASH,
            createdBy: 'planner',
            createdAt: '2026-08-08T11:15:00.000Z',
            nodes: [node('n-recon')],
            edges: [],
          },
          by: 'planner',
        },
        2,
      ),
      draft(runId, 'run.started', { planHash: PLAN_HASH }),
    ]);
  } finally {
    db.close();
  }
}

/** A workspace with a config file and a ledger beside it. */
async function workspace(tmp: string, name: string, yaml: string | null) {
  const cwd = join(tmp, name);
  const dataDir = join(cwd, 'data');
  await mkdir(join(cwd, '.DeFlow'), { recursive: true });
  await mkdir(dataDir, { recursive: true });
  if (yaml !== null) await writeFile(join(cwd, '.DeFlow/config.yaml'), yaml, 'utf8');
  return { cwd, dataDir };
}

const estimator = () => ({
  tokenizer: o200kTokenizer(),
  accounting: () => 'exact' as const,
  family: () => 'anthropic',
  calibration: () => ({ n: 24, ratio: 1.18 }),
  countFiles: () => 0,
});

suite('the table is pinned at run start', () => {
  it('records the sha256 of the canonicalised rule table on the log', async ({ tmp }) => {
    const { cwd, dataDir } = await workspace(tmp, 'pinned', DEFAULT_YAML);
    seedRun(dataDir, RUN);

    const policy = await workspacePatchPolicy(cwd);
    const db = openLedger(dataDir);
    try {
      pinPatchPolicy(db, { runId: RUN, ts: T0, epoch: 1, policy });

      const loaded = readRange(db, RUN, 0, 1000).events.filter(
        (event) => event.kind === 'policy.patch.loaded',
      );
      expect(loaded).toHaveLength(1);
      expect(loaded[0]?.payload).toMatchObject({ source: 'config', hash: policy.hash });

      // The file the operator wrote is the shipped table, so it hashes to the
      // shipped table's digest. That equality is the whole reason the yaml in
      // this file is transcribed from 06 §4.3 rather than invented.
      expect(policy.hash).toBe(await patchPolicyHash(DEFAULT_PATCH_RULE_SPECS));

      const state = replayRun(db, RUN).state;
      expect(state.patchPolicy?.rules).toEqual(DEFAULT_PATCH_RULE_SPECS);
      expect(state.patchPolicy?.drift).toBeNull();
    } finally {
      db.close();
    }
  });

  it('pins the documented defaults, and their hash, for a file with no policy.patch', async ({
    tmp,
  }) => {
    const { cwd, dataDir } = await workspace(
      tmp,
      'nopolicy',
      'providers:\n  claude:\n    pinReinjectTurns: 8\n',
    );
    seedRun(dataDir, RUN);

    const policy = await workspacePatchPolicy(cwd);
    expect(policy.source).toBe('default');
    expect(policy.rules).toEqual(DEFAULT_PATCH_RULE_SPECS);

    const db = openLedger(dataDir);
    try {
      pinPatchPolicy(db, { runId: RUN, ts: T0, epoch: 1, policy });
      expect(replayRun(db, RUN).state.patchPolicy).toMatchObject({
        source: 'default',
        hash: await patchPolicyHash(DEFAULT_PATCH_RULE_SPECS),
      });
    } finally {
      db.close();
    }
  });
});

suite('editing the config mid-run', () => {
  it('judges the patch by the manifest-hashed table and surfaces the mismatch', async ({ tmp }) => {
    const { cwd, dataDir } = await workspace(tmp, 'edited', DEFAULT_YAML);
    seedRun(dataDir, RUN);

    const pinned = await workspacePatchPolicy(cwd);
    const db = openLedger(dataDir);
    try {
      pinPatchPolicy(db, { runId: RUN, ts: T0, epoch: 1, policy: pinned });

      // The operator raises the cost threshold to 50.00, mid-run.
      await writeFile(join(cwd, '.DeFlow/config.yaml'), RAISED_YAML, 'utf8');
      const onDisk = await workspacePatchPolicy(cwd);
      expect(onDisk.hash).not.toBe(pinned.hash);

      appendEvents(db, [draft(RUN, 'plan.patch.proposed', { patch: FOURTH_REPLAN }, 3)]);

      const ruling = rulePatch(db, {
        runId: RUN,
        state: replayRun(db, RUN).state,
        patch: FOURTH_REPLAN,
        estimator: estimator(),
        now: T0 + 60_000,
        configPolicyHash: onDisk.hash,
      });

      // Under the file on disk a depth of 4 is well inside the limit and this
      // patch would auto-apply. Under the table this run pinned it is a fourth
      // replan, and it is refused.
      expect(ruling).toMatchObject({ decision: 'reject', ruleId: 'replan-depth-exceeded' });
      expect(ruling.configDrifted).toBe(true);

      const events = readRange(db, RUN, 0, 1000).events;
      const drifted = events.filter((event) => event.kind === 'policy.patch.drifted');
      expect(drifted).toHaveLength(1);
      expect(drifted[0]?.payload).toEqual({ pinnedHash: pinned.hash, configHash: onDisk.hash });
    } finally {
      db.close();
    }
  });

  it('tells the operator once per edit rather than once per patch', async ({ tmp }) => {
    const { cwd, dataDir } = await workspace(tmp, 'once', DEFAULT_YAML);
    seedRun(dataDir, RUN);

    const pinned = await workspacePatchPolicy(cwd);
    const db = openLedger(dataDir);
    try {
      pinPatchPolicy(db, { runId: RUN, ts: T0, epoch: 1, policy: pinned });
      await writeFile(join(cwd, '.DeFlow/config.yaml'), RAISED_YAML, 'utf8');
      const onDisk = await workspacePatchPolicy(cwd);

      for (const round of [0, 1, 2]) {
        rulePatch(db, {
          runId: RUN,
          state: replayRun(db, RUN).state,
          patch: { ...FOURTH_REPLAN, id: `patch-${round}` },
          estimator: estimator(),
          now: T0 + 60_000 * (round + 1),
          configPolicyHash: onDisk.hash,
        });
      }

      const drifted = readRange(db, RUN, 0, 1000).events.filter(
        (event) => event.kind === 'policy.patch.drifted',
      );
      expect(drifted).toHaveLength(1);

      // All three patches were still ruled on by the pinned table.
      const rejected = readRange(db, RUN, 0, 1000).events.filter(
        (event) => event.kind === 'plan.patch.rejected',
      );
      expect(rejected.map((event) => (event.payload as { rule: string }).rule)).toEqual([
        'replan-depth-exceeded',
        'replan-depth-exceeded',
        'replan-depth-exceeded',
      ]);
    } finally {
      db.close();
    }
  });

  it('gives a new run the edited thresholds — the pin binds a run, not a workspace', async ({
    tmp,
  }) => {
    const { cwd, dataDir } = await workspace(tmp, 'second', RAISED_YAML);
    seedRun(dataDir, SECOND);

    const policy = await workspacePatchPolicy(cwd);
    const db = openLedger(dataDir);
    try {
      pinPatchPolicy(db, { runId: SECOND, ts: T0, epoch: 1, policy });
      expect(policy.hash).not.toBe(await patchPolicyHash(DEFAULT_PATCH_RULE_SPECS));

      const ruling = rulePatch(db, {
        runId: SECOND,
        state: replayRun(db, SECOND).state,
        patch: FOURTH_REPLAN,
        estimator: estimator(),
        now: T0 + 60_000,
        configPolicyHash: policy.hash,
      });

      // A depth of 4 is under the new limit of 30, so the same patch the first
      // run refused this run auto-applies.
      expect(ruling).toMatchObject({ decision: 'auto', ruleId: 'read-only-analysis' });
      expect(ruling.configDrifted).toBe(false);
    } finally {
      db.close();
    }
  });
});
