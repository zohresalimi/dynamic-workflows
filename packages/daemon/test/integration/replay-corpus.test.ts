/**
 * KAR-16.5 — the fixture corpus: what each one proves, and where it came
 * from.
 *
 * Verifies: EPIC-16-S32, EPIC-16-S34 · AC6, AC9, AC10
 *
 * Each fixture is asserted **through the replay harness**, not by reading the
 * file: the claim in EPIC-16-S32 is *"given the fixture, when it is served by
 * the replay harness, then it contains …"*, and a test that read the JSON
 * directly would pass for a fixture the harness cannot actually serve.
 *
 * The provenance suite is EPIC-16-S34, and it is a *failure* scenario in the
 * flow file for a reason: *"a hand-written fixture encodes the author's
 * assumptions about the event stream rather than its actual shape, and it rots
 * silently as the emitters change, because the fixture IS the expectation."* So
 * every fixture has to name the script that produces it, and that script has to
 * exist.
 */

import { MAX_INLINE_PAYLOAD_BYTES } from '@DeFlow/ledger';
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { type ReplayHarness, startReplay } from '../../src/replay/harness.ts';
import { parseSpeed } from '../../src/replay/speed.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const FIXTURES = join(ROOT, 'test/fixtures/runs');

/**
 * The corpus, and the acceptance criterion each entry exists to satisfy.
 *
 * `crash-resume-seq-gap` and `gate-failure-repair` carry the names the
 * directories were created with by the stories that recorded them
 * (KAR-15.4, KAR-12.5); the epic's table calls them `crash-resume` and
 * `gate-fail-repair`. Renaming a committed recording to match a table would
 * break every spec that already folds it, for nothing.
 */
const CORPUS = [
  'happy-path-12',
  'three-patches',
  'gate-failure-repair',
  'compaction',
  'crash-resume-seq-gap',
  'stress-400',
  // KAR-17.3's, and the seventh: the only recording with **more than one
  // context packet for the same node**. EPIC-17-S13's side-by-side of attempt 1
  // against attempt 3 has nothing to compare without it, and neither does the
  // node inspector's per-attempt cost or its failure history.
  'repair-attempts',
  // EPIC-17-S35's own, and the eighth. The scenario names a **22-node** run —
  // 18 passed, 1 failed, 2 abandoned, 1 awaiting-human — whose failure is only
  // explicable by walking six views in sequence, and no other fixture in this
  // corpus carries all six stops: `gate-failure-repair` has verdicts and
  // findings but never built a context packet, `repair-attempts` has three
  // packets but no gate ever spoke, and `compaction` is three events with no
  // run at all. A five-minute diagnosis cannot be timed over a fixture that
  // cannot be diagnosed.
  'five-minute-diagnosis',
] as const;

const authorized = authorizedFetch();

let harness: ReplayHarness | undefined;

afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

/** Boots the harness over `name` at `max` and plays it out. */
async function served(tmp: string, name: string): Promise<ReplayHarness> {
  harness = await startReplay({
    fixture: join(FIXTURES, name, 'events.jsonl'),
    speed: parseSpeed('max'),
    port: 0,
    dataDir: join(tmp, name),
    token: TEST_DAEMON_TOKEN,
  });
  await harness.played();
  return harness;
}

const json = async (origin: string, path: string): Promise<unknown> => {
  const response = await authorized(`${origin}${path}`);
  expect(response.status, `${path} answered ${response.status}`).toBe(200);
  return (await response.json()) as unknown;
};

suite('EPIC-16-S32 — every fixture exists, one file per run (AC6)', () => {
  it('holds exactly the ones the corpus names, each as a single events.jsonl', () => {
    const directories = readdirSync(FIXTURES, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(directories).toEqual([...CORPUS].sort());
    for (const name of CORPUS) {
      // *"The production ledger is one global database, but a fixture is
      // exported per run, so a whole run commits as a single file."*
      expect(existsSync(join(FIXTURES, name, 'events.jsonl')), name).toBe(true);
    }
  });

  it('records what produced each one, and that producer exists (EPIC-16-S34)', () => {
    for (const name of CORPUS) {
      const readme = readFileSync(join(FIXTURES, name, 'README.md'), 'utf8');
      const script = /`(packages\/[\w./-]+\.ts)`/.exec(readme)?.[1];

      expect(script, `${name}/README.md names no producing script`).toBeDefined();
      expect(
        existsSync(join(ROOT, script ?? '')),
        `${name} names ${script}, which is missing`,
      ).toBe(true);
      // Never hand-written, and the README has to say so in as many words —
      // this is the sentence a future reader needs before they "fix" a fixture
      // by editing it.
      expect(readme, name).toMatch(
        /never (edited by\s*\n?hand|by\s*\n?hand)|kill -9|generated by/i,
      );
    }
  });

  it('records the mock-agent seed for the fixture a mock agent produced', () => {
    // AC6 asks for *"the mock-agent script and `--seed` that produced it"*.
    // `gate-failure-repair` is the one fixture in the corpus that really is a
    // mock-agent recording — the orchestrator's own harness drove the agent —
    // so it is the one whose README must carry the seed. The others say what
    // they are instead of implying an agent that never ran.
    const readme = readFileSync(join(FIXTURES, 'gate-failure-repair', 'README.md'), 'utf8');
    const script = join(ROOT, 'packages/daemon/scripts/build-gate-repair-fixture.ts');
    const seed = /MOCK_AGENT_SEED = (\d+)/.exec(readFileSync(script, 'utf8'))?.[1];

    expect(seed, 'the fixture script passes no --seed to the mock agent').toBeDefined();
    expect(readme).toMatch(new RegExp(`--seed[^\\n]*${seed ?? ''}`));
  });
});

suite('EPIC-16-S32 — each fixture serves the views it exists for', () => {
  it('happy-path-12: a plan graph, a timeline and a node to inspect', async ({ tmp }) => {
    const replay = await served(tmp, 'happy-path-12');
    const [runId] = replay.runIds;

    const plans = (await json(replay.origin, `/api/runs/${runId}/plans`)) as {
      version: number;
    }[];
    expect(plans.length).toBeGreaterThanOrEqual(1);

    const graph = (await json(replay.origin, `/api/runs/${runId}/plans/1`)) as {
      nodes: unknown[];
    };
    expect(graph.nodes).toHaveLength(12);

    const gates = (await json(replay.origin, `/api/runs/${runId}/gates`)) as unknown[];
    expect(gates.length).toBeGreaterThanOrEqual(1);
  });

  it('three-patches: a version rail with a reason and a decision per step', async ({ tmp }) => {
    const replay = await served(tmp, 'three-patches');
    const [runId] = replay.runIds;

    const plans = (await json(replay.origin, `/api/runs/${runId}/plans`)) as {
      version: number;
      reason: string | null;
      decision: unknown;
    }[];
    expect(plans.map((version) => version.version)).toEqual([1, 2, 3, 4]);

    const diff = (await json(replay.origin, `/api/runs/${runId}/plans/diff?from=1&to=2`)) as {
      reason: string | null;
      decision: unknown;
    };
    expect(diff.reason).toBeTruthy();
    expect(diff.decision).not.toBeNull();
  });

  it('repair-attempts: one node, three attempts, a packet for each', async ({ tmp }) => {
    // KAR-17.3. Asserted through `GET …/nodes/:nodeId/packet?attempt=` rather
    // than by reading the file, for the reason at the top of this module — and
    // because the *endpoint* answering per attempt is precisely what the
    // inspector's attempt selector depends on. A corpus entry that the harness
    // could only serve the latest attempt of would be useless to it.
    const replay = await served(tmp, 'repair-attempts');
    const [runId] = replay.runIds;

    const totals: number[] = [];
    for (const attempt of [0, 1, 2]) {
      const packet = (await json(
        replay.origin,
        `/api/runs/${runId}/nodes/impl-oauth/packet?attempt=${attempt}`,
      )) as { totals: { tokens: number }; segments: unknown[] };
      totals.push(packet.totals.tokens);
    }

    // Three distinct packets, and the last two identical — the repair that
    // changed nothing, which EPIC-17-S13 needs a fixture to demonstrate.
    expect(totals).toEqual([262, 290, 290]);
  });

  it('gate-failure-repair: a failing verdict, then a passing one', async ({ tmp }) => {
    const replay = await served(tmp, 'gate-failure-repair');
    const [runId] = replay.runIds;

    const gates = (await json(replay.origin, `/api/runs/${runId}/gates`)) as {
      outcome: string;
    }[];
    const outcomes = gates.map((one) => one.outcome);
    expect(outcomes).toContain('fail');
    expect(outcomes).toContain('pass');
  });

  it('compaction: both fidelities, including the one with no after count', async ({ tmp }) => {
    const replay = await served(tmp, 'compaction');
    const [runId] = replay.runIds;

    const page = (await json(replay.origin, `/api/runs/${runId}/events?since=0`)) as {
      events: { kind: string; payload: { scope?: string; after?: unknown } }[];
    };
    const compactions = page.events.filter((event) => event.kind === 'context.compacted');

    // Without the `vendor.session` case, KAR-17.4's honest-gap rendering has
    // nothing to be tested against — and it is exactly the case that occurs in
    // real runs against Claude Code.
    expect(compactions.map((one) => one.payload.scope).sort()).toEqual([
      'DeFlow.packet',
      'vendor.session',
    ]);
    const vendor = compactions.find((one) => one.payload.scope === 'vendor.session');
    expect(vendor?.payload.after).toBeNull();
  });

  it('crash-resume-seq-gap: real holes, served without a word about them (AC9)', async ({
    tmp,
  }) => {
    const replay = await served(tmp, 'crash-resume-seq-gap');
    const [runId] = replay.runIds;

    const page = (await json(replay.origin, `/api/runs/${runId}/events?since=0`)) as {
      events: { seq: number }[];
    };
    const seqs = page.events.map((event) => event.seq);

    // The gap is genuinely there — this fixture is worthless without it — and
    // nothing in the response calls it a loss.
    const contiguous = seqs.every(
      (seq, index) => index === 0 || seq === (seqs[index - 1] ?? 0) + 1,
    );
    expect(contiguous).toBe(false);
    expect(JSON.stringify(page)).not.toMatch(/missing|gap|data loss/i);
  });

  it('five-minute-diagnosis: all six stops of EPIC-17-S35, in one run', async ({ tmp }) => {
    // EPIC-17-S35. Asserted stop by stop rather than as "the fixture loads",
    // because the scenario's claim is that **one** run answers all six
    // questions: a corpus entry that answered five of them would still make the
    // timed walk impossible, and the walk is the epic's Definition of Done.
    const replay = await served(tmp, 'five-minute-diagnosis');
    const [runId] = replay.runIds;

    // 1 — orientation: 22 nodes, and the four plan versions behind them.
    const graph = (await json(replay.origin, `/api/runs/${runId}/plans/4`)) as {
      nodes: { id: string }[];
    };
    expect(graph.nodes.length).toBeGreaterThanOrEqual(20);
    const plans = (await json(replay.origin, `/api/runs/${runId}/plans`)) as { version: number }[];
    expect(plans.map((one) => one.version)).toEqual([1, 2, 3, 4]);

    // 2 — what failed, and against what.
    //
    // Read off `/gates` and the verdict itself rather than off `/criteria`:
    // `boardVerdicts` parses gate documents with `VerdictV2Schema`, which has
    // no `blobSha` on a finding's location, so it silently drops every v4
    // verdict whose findings are located — which is every verdict a real gate
    // produces (docs/10 §5 requires the blob). That is a pre-existing defect in
    // this endpoint and it belongs to KAR-15.6, not here; the board the
    // scenario walks is fed by `gate.evaluated` over SSE and is unaffected.
    const gates = (await json(replay.origin, `/api/runs/${runId}/gates`)) as {
      gate: string;
      outcome: string;
      summary: string;
    }[];
    const boundary = gates.find((one) => one.gate === 'import-boundary');
    expect(boundary?.outcome).toBe('fail');
    expect(boundary?.summary).toBe('3 files import from the internal namespace');

    // 3 — where, exactly.
    const findings = (await json(replay.origin, `/api/runs/${runId}/findings`)) as {
      file: string;
      findings: { severity: string; location: { line: number } | null }[];
    }[];
    const button = findings.find((group) => group.file === 'packages/ui/src/Button.vue');
    expect(button?.findings[0]?.severity).toBe('blocker');
    expect(button?.findings[0]?.location?.line).toBe(42);

    // 4 — what the agent was told, and by whom.
    const packet = (await json(
      replay.origin,
      `/api/runs/${runId}/nodes/n-impl-3/packet?attempt=0`,
    )) as { segments: { id: string }[] };
    expect(packet.segments.map((segment) => segment.id)).toContain('fact-import-policy');

    const page = (await json(replay.origin, `/api/runs/${runId}/events?since=0`)) as {
      events: {
        kind: string;
        payload: {
          droppedSegments?: string[];
          fidelity?: string;
          pinnedKept?: string[];
          fact?: { key: string; provenance: { byNode: string; confidence: string } };
          verdict?: { gate: string; criteria: { id: string; status: string }[] };
        };
      }[];
    };
    // The provenance the inspector renders: who wrote the fact, at what
    // confidence. Off the event, because the ledger's fact *index* is written
    // by a live orchestrator and a restored recording has none — `/facts` is
    // empty for every fixture in this corpus, `happy-path-12` included.
    const written = page.events.find((event) => event.kind === 'fact.written');
    expect(written?.payload.fact?.key).toBe('decision/import-policy');
    expect(written?.payload.fact?.provenance.byNode).toBe('n-recon');

    const refusal = page.events.find(
      (event) =>
        event.kind === 'gate.evaluated' && event.payload.verdict?.gate === 'import-boundary',
    );
    expect(refusal?.payload.verdict?.criteria).toEqual([{ id: 'ac-3', status: 'unsatisfied' }]);

    // 5 — what compaction did to it. The dropped segment is the fact segment,
    // and the pinned spec is in `pinnedKept`: a plan defect, not a pin failure.
    const compacted = page.events.find((event) => event.kind === 'context.compacted');
    expect(compacted?.payload.fidelity).toBe('exact');
    expect(compacted?.payload.droppedSegments).toContain('fact-import-policy');
    expect((compacted?.payload.pinnedKept ?? []).length).toBeGreaterThan(0);

    // 6 — why the node exists at all, and why with this provider.
    const split = (await json(replay.origin, `/api/runs/${runId}/plans/diff?from=1&to=2`)) as {
      reason: string | null;
    };
    expect(split.reason).toBe('Recon found 3 additional packages; splitting the migration node');
    const reroute = (await json(replay.origin, `/api/runs/${runId}/plans/diff?from=2&to=3`)) as {
      reason: string | null;
    };
    expect(reroute.reason).toContain('codex');
  });

  it('stress-400: at least 400 plan nodes, served from one file (AC10)', async ({ tmp }) => {
    const replay = await served(tmp, 'stress-400');
    const [runId] = replay.runIds;

    const graph = (await json(replay.origin, `/api/runs/${runId}/plans/1`)) as {
      nodes: { id: string }[];
    };
    expect(graph.nodes.length).toBeGreaterThanOrEqual(400);

    // The children are real nodes with real `<mapNodeId>--<itemId>` ids, which
    // is what makes this a 400-node render rather than one node with a count.
    const children = graph.nodes.filter((node) => node.id.startsWith('migrate-views--'));
    expect(children).toHaveLength(400);

    // And the whole plan still fits inline: a payload over the ceiling would
    // have spilled to the blob store in a real run, and the fixture would no
    // longer be one self-contained file.
    const proposed = readFileSync(join(FIXTURES, 'stress-400', 'events.jsonl'), 'utf8')
      .split('\n')
      .find((line) => line.includes('"kind":"plan.proposed"'));
    expect(Buffer.byteLength(proposed ?? '', 'utf8')).toBeLessThan(MAX_INLINE_PAYLOAD_BYTES);
  });
});
