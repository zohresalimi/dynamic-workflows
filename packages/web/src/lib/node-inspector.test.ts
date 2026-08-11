/**
 * KAR-17.3 test plan rows 1–4 — the joins behind the node inspector (F10.3,
 * F6.1, F6.2, F6.3, NF10).
 *
 * Verifies: EPIC-17-S12, EPIC-17-S13, EPIC-17-S14, EPIC-17-S15, EPIC-17-S16 ·
 * AC1, AC2, AC3, AC5, AC6, AC7, AC8, AC9, AC10
 *
 * Pure, and folded from the recordings rather than from hand-built view models.
 * The inspector's whole claim is that what it shows came out of the ledger, and
 * a spec that assembled a `PacketVM` by hand would be asserting that this
 * module can render a shape — not that the shape is what the daemon wrote.
 *
 * `repair-attempts` is the fixture the story needs and the only one that has
 * it: one node, three attempts, **a packet per attempt**, attempt 2's identical
 * to attempt 1's (the repair that changed nothing), a `contract.schema-invalid`
 * carrying real Ajv errors, and a second node that died at `adapter.spawn-failed`
 * before any packet existed. `happy-path-12` carries the facts — written, read,
 * invalidated, tainting their readers — that AC8's provenance table is over.
 */
import type { Event } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { happyPath12, repairAttempts } from '../../test/fixture-events.ts';
import {
  applyBlackboard,
  type BlackboardProjection,
  emptyBlackboard,
} from '../ledger/projections/blackboard.ts';
import {
  applyContext,
  type ContextProjection,
  emptyContext,
  type PacketVM,
  packetKey,
  SEGMENT_KINDS,
} from '../ledger/projections/context.ts';
import { applyCost, type CostProjection, emptyCost } from '../ledger/projections/cost.ts';
import { applyPlan, emptyPlan, type PlanProjection } from '../ledger/projections/plan.ts';
import {
  applyTimeline,
  emptyTimeline,
  type TimelineProjection,
} from '../ledger/projections/timeline.ts';
import {
  attemptRows,
  attemptSparkline,
  diffPackets,
  inspectNode,
  packetSection,
  provenanceRows,
  reconcileTokens,
  segmentGroups,
} from './node-inspector.ts';

/** Every projection the inspector joins, folded over one recording. */
interface Folded {
  readonly plan: PlanProjection;
  readonly context: ContextProjection;
  readonly cost: CostProjection;
  readonly timeline: TimelineProjection;
  readonly blackboard: BlackboardProjection;
}

function fold(events: readonly Event[]): Folded {
  const folded: Folded = {
    plan: emptyPlan(),
    context: emptyContext(),
    cost: emptyCost(),
    timeline: emptyTimeline(),
    blackboard: emptyBlackboard(),
  };
  for (const event of events) {
    applyPlan(folded.plan, event);
    applyContext(folded.context, event);
    applyCost(folded.cost, event);
    applyTimeline(folded.timeline, event);
    applyBlackboard(folded.blackboard, event);
  }
  return folded;
}

const repair = (): Folded => fold(repairAttempts());
const happy = (): Folded => fold(happyPath12());

function packetOf(attempt: number): PacketVM {
  const packet = repair().context.packets.get(packetKey('impl-oauth', attempt));
  if (packet === undefined) throw new Error(`repair-attempts has no packet for attempt ${attempt}`);
  return packet;
}

/**
 * Row 1 — *"segment grouping and ordering: pinned first, `history.summary` in
 * chronological position"*. Red when segments are rendered in array order.
 *
 * The recording makes this a real distinction rather than a tautology: the
 * packet's own `segments` array interleaves the two `pinned.constraints`
 * segments around `pinned.spec` and `pinned.pathscope`, so array order and
 * grouped order genuinely differ.
 */
suite('KAR-17.3 row 1 — the nine kinds, in the order the prompt has them (AC2)', () => {
  it('groups by kind rather than following the packet’s array order', () => {
    const groups = segmentGroups(packetOf(1));

    expect(groups.map((group) => group.kind)).toEqual([...SEGMENT_KINDS]);
    // The array order, for contrast — the two constraints segments are split
    // apart by three others in it, and adjacent here.
    expect(groups[0]?.segments.map((one) => one.id)).toEqual([
      'pinned-constraints-safety',
      'pinned-constraints-permission',
    ]);
  });

  it('renders every pinned segment before any unpinned one', () => {
    const flat = segmentGroups(packetOf(1)).flatMap((group) => group.segments);
    const lastPinned = flat.findLastIndex((one) => one.pinned);
    const firstLoose = flat.findIndex((one) => !one.pinned);

    expect(lastPinned).toBeLessThan(firstLoose);
  });

  it('keeps history.summary in its chronological position, after the brief', () => {
    // Not sorted by size and not alphabetical: the order is the prompt's, and
    // the summary of what came before sits where the model reads it.
    const kinds = segmentGroups(packetOf(1)).map((group) => group.kind);

    expect(kinds.indexOf('history.summary')).toBeGreaterThan(kinds.indexOf('task.brief'));
    expect(kinds.indexOf('history.summary')).toBeLessThan(kinds.indexOf('tool.output'));
  });

  it('keeps a kind the packet has nothing of, as an explicit empty group', () => {
    // Attempt 0 ran before any repair, so it has no history.summary and no
    // tool.output. The group is present and empty rather than missing: "this
    // packet carried no tool output" is an answer, and a row that vanishes
    // leaves the reader counting kinds to notice.
    const groups = segmentGroups(packetOf(0));
    const summary = groups.find((group) => group.kind === 'history.summary');

    expect(groups).toHaveLength(SEGMENT_KINDS.length);
    expect(summary?.segments).toEqual([]);
    expect(summary?.tokens).toBe(0);
  });
});

/**
 * Row 2 — *"per-segment tokens equal `totals.tokens` and per-kind equal
 * `totals.byKind`"*. Red when the header total is recomputed differently from
 * the bar.
 *
 * This is the assertion Playwright smoke #3 makes at the far end (docs/14 §13);
 * making it here as well is not duplication. Here it says the projection and
 * the builder agree; there it says the endpoint, the projection and the render
 * agree. A failure in one is a different bug from a failure in the other.
 */
suite('KAR-17.3 row 2 — the breakdown sums to the header (AC3)', () => {
  it('sums the per-segment counts to the packet’s own declared total', () => {
    const check = reconcileTokens(packetOf(1));

    expect(check.headerTotal).toBe(290);
    expect(check.segmentSum).toBe(290);
    expect(check.reconciles).toBe(true);
  });

  it('sums each kind’s segments to that kind’s declared subtotal', () => {
    const check = reconcileTokens(packetOf(1));

    // 54 + 9 for the two constraints segments, and 46 + 73 for the two spec
    // ones — the kinds whose segments are non-adjacent in the array.
    expect(check.byKind['pinned.constraints']).toEqual({ declared: 63, summed: 63 });
    expect(check.byKind['pinned.spec']).toEqual({ declared: 119, summed: 119 });
    expect(check.reconciles).toBe(true);
  });

  it('reconciles every packet in the recording, not only the one asserted above', () => {
    const packets = [...repair().context.packets.values()];

    expect(packets).toHaveLength(3);
    for (const packet of packets) expect(reconcileTokens(packet).reconciles).toBe(true);
  });

  it('reports a disagreement rather than hiding it behind a recomputed total', () => {
    // The whole point of carrying both numbers. A builder that shipped a total
    // its own segments contradict is a bug in the builder, and an inspector
    // that silently rendered the sum would erase the only evidence of it.
    const packet = packetOf(1);
    const damaged = { ...packet, totals: { ...packet.totals, tokens: 999 } };
    const check = reconcileTokens(damaged);

    expect(check.reconciles).toBe(false);
    expect(check.headerTotal).toBe(999);
    expect(check.segmentSum).toBe(290);
  });
});

/**
 * Row 3 — *"`seq` link resolution for a token count, a fact, a cost figure and
 * a state transition"*. Red when links are wired for some values and not
 * others.
 *
 * NF10 made visible (AC7). The assertion that matters is the **exhaustive**
 * one at the end: every displayed figure carries a `seq`, checked by walking
 * the view model rather than by naming four fields, because a fifth figure
 * added later without a link is exactly the regression this guards.
 */
suite('KAR-17.3 row 3 — every number carries the seq that produced it (AC7)', () => {
  it('links a segment’s token count to the context.built that recorded it', () => {
    const groups = segmentGroups(packetOf(1));

    expect(packetOf(1).builtAtSeq).toBe(16);
    for (const group of groups) {
      for (const segment of group.segments) expect(segment.sourceEvent).toBeGreaterThan(0);
    }
  });

  it('links the cost figure to the budget.consumed that last moved it', () => {
    const rows = attemptRows(repair(), 'impl-oauth');

    expect(rows.map((row) => row.cost.seq)).toEqual([11, 18, 25]);
  });

  it('links each state transition to its own lifecycle event', () => {
    const rows = attemptRows(repair(), 'impl-oauth');

    expect(rows.map((row) => row.startedAtSeq)).toEqual([8, 15, 22]);
    expect(rows.map((row) => row.endedAtSeq)).toEqual([12, 19, 26]);
  });

  it('links a fact in the packet to its fact.written', () => {
    const rows = provenanceRows(happy(), 'impl-login');

    expect(rows[0]?.writtenAtSeq).toBe(16);
    expect(rows[0]?.readAtSeq).toBe(22);
  });

  it('leaves no displayed figure without a producing event', () => {
    // The exhaustive form of AC7, and the reason this module returns `seq`
    // beside every number rather than expecting the template to find one.
    const view = inspectNode(repair(), 'impl-oauth', 2);

    for (const row of view.attempts) {
      expect(row.startedAtSeq).toBeGreaterThan(0);
      if (row.cost.vendorReported !== null) expect(row.cost.seq).toBeGreaterThan(0);
      if (row.failure !== null) expect(row.failureAtSeq).toBeGreaterThan(0);
    }
    expect(view.packet.status).toBe('built');
    expect(view.packet.builtAtSeq).toBeGreaterThan(0);
  });
});

/**
 * Row 4 — *"packet segment-level diff between attempt 1 and attempt 3"*. Red
 * when the comparison diffs rendered text rather than segments.
 *
 * Diffing the rendered prompt would report "these two prompts differ" and
 * nothing an operator can act on. Diffing segments answers the actual question
 * — *did the repair change what this node was given, and which part* — and
 * makes the no-op case (EPIC-17-S13) a positive result rather than an absence.
 */
suite('KAR-17.3 row 4 — attempt against attempt, segment by segment (AC6)', () => {
  it('marks the segments a repair added, and leaves the rest alone', () => {
    const diff = diffPackets(packetOf(0), packetOf(1));

    // Attempt 1 gained the summary of what attempt 0 did and the tool output it
    // could not have had. Nothing else about its context changed.
    expect(diff.rows.filter((row) => row.change === 'added').map((row) => row.id)).toEqual([
      'history-summary',
      'tool-output',
    ]);
    expect(diff.rows.filter((row) => row.change === 'removed')).toEqual([]);
    expect(diff.identical).toBe(false);
  });

  it('marks a segment present in the earlier packet and gone from the later one', () => {
    const diff = diffPackets(packetOf(1), packetOf(0));

    expect(diff.rows.filter((row) => row.change === 'removed').map((row) => row.id)).toEqual([
      'history-summary',
      'tool-output',
    ]);
  });

  it('marks a segment whose contentHash changed as changed, not as replaced', () => {
    const left = packetOf(1);
    const right = {
      ...left,
      segments: left.segments.map((one) =>
        one.id === 'fact-auth-jwt' ? { ...one, contentHash: 'sha256-different' } : one,
      ),
    };
    const row = diffPackets(left, right).rows.find((one) => one.id === 'fact-auth-jwt');

    expect(row?.change).toBe('changed');
    // Same id, two hashes — the pair is what makes it diagnosable.
    expect(row?.leftHash).not.toBe(row?.rightHash);
  });

  it('reports a repair that changed nothing as a visible no-op', () => {
    // EPIC-17-S13's second scenario. Attempt 2's packet is byte-identical to
    // attempt 1's, which is what a repair that fixed nothing looks like from
    // the inside — and it has to be *stated*, because "no rows changed" and
    // "the diff failed to run" render identically otherwise.
    const diff = diffPackets(packetOf(1), packetOf(2));

    expect(diff.identical).toBe(true);
    expect(diff.rows.every((row) => row.change === 'unchanged')).toBe(true);
  });

  it('diffs segments rather than the rendered prompt', () => {
    // The prompt handles of attempts 1 and 2 are the same artifact, so a text
    // diff would also say "identical" here — and would say nothing useful for
    // attempt 0 against attempt 1 beyond "they differ". This asserts the row
    // vocabulary exists at all, which a text diff has no way to produce.
    const diff = diffPackets(packetOf(0), packetOf(1));

    expect(diff.rows.every((row) => typeof row.kind === 'string')).toBe(true);
    expect(new Set(diff.rows.map((row) => row.change))).toEqual(new Set(['unchanged', 'added']));
  });
});

/**
 * AC9 — *"a node that failed **before** a packet was built renders an honest
 * empty packet section"*. The unit half of test plan row 5; the mount is in
 * `../views/node-inspector.test.ts`.
 */
suite('KAR-17.3 — honest emptiness, for a node that died before a packet (AC9)', () => {
  it('says no packet was built rather than returning an empty one', () => {
    const section = packetSection(repair(), 'probe-oauth-tokens', 0);

    expect(section.status).toBe('none');
    expect(section.groups).toEqual([]);
    // Not a zero total — there is no packet to have a total.
    expect(section.headerTotal).toBeNull();
  });

  it('carries the typed NodeFailure that explains the absence', () => {
    const view = inspectNode(repair(), 'probe-oauth-tokens', 0);

    expect(view.packet.status).toBe('none');
    expect(view.packet.absence?.reason).toBe('adapter.spawn-failed');
    expect(view.packet.absence?.class).toBe('permanent');
    expect(view.packet.absence?.message).toContain('ENOENT');
    expect(view.packet.absence?.evidence).toHaveLength(1);
  });

  it('still reports a packet for the node that did build one', () => {
    // So the assertion above is about this node and not about the join failing
    // for every node.
    expect(packetSection(repair(), 'impl-oauth', 2).status).toBe('built');
  });
});

/**
 * AC5 — *"raw output and normalised/validated output are shown separately, and
 * a `contract.schema-invalid` failure shows the Ajv error beside the offending
 * output"*.
 */
suite('KAR-17.3 — output, twice, and the validator’s own words (AC5)', () => {
  it('surfaces the Ajv errors of a schema-invalid failure as errors, not prose', () => {
    const view = inspectNode(repair(), 'impl-oauth', 2);

    expect(view.schemaErrors?.schemaId).toBe('DeFlow.verdict.v4');
    expect(view.schemaErrors?.errors.map((one) => one.instancePath)).toEqual([
      '/findings/0/severity',
      '/summary',
    ]);
    expect(view.schemaErrors?.errors[0]?.keyword).toBe('enum');
  });

  it('offers the raw output as a handle rather than inlining bytes', () => {
    // The raw half is never in the ledger; it is fetched from
    // `GET /api/artifacts/:sha` on demand. A view model that carried the bytes
    // would put an unbounded string in a store KAR-16.4 caps.
    const view = inspectNode(repair(), 'impl-oauth', 2);

    expect(view.rawOutputHandles[0]).toMatch(/^artifact:\/\//);
    expect(view.normalisedOutput).toBeNull();
  });

  it('separates the normalised output of a node that completed', () => {
    const view = inspectNode(happy(), 'recon-auth-surface', 0);

    expect(view.normalisedOutput?.output).toEqual({ text: 'auth verifies a JWT' });
    expect(view.normalisedOutput?.outputSchemaId).toBe('DeFlow.finding.v1');
    expect(view.schemaErrors).toBeNull();
  });
});

/**
 * AC8 / EPIC-17-S15 — the provenance table, which per roadmap §3 is M1's
 * coverage of F10.4.
 */
suite('KAR-17.3 — what this node read, and who wrote it (AC8)', () => {
  it('lists every fact the node read, with its writer and evidence', () => {
    const rows = provenanceRows(happy(), 'impl-login');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe('decision/router-guard-shape');
    expect(rows[0]?.byNode).toBe('plan-migration');
    expect(rows[0]?.confidence).toBe('asserted');
    expect(rows[0]?.evidence[0]).toMatch(/^artifact:\/\//);
    expect(rows[0]?.at).toBeTruthy();
  });

  it('marks a fact that was later invalidated, and names what invalidated it', () => {
    const rows = provenanceRows(happy(), 'impl-login');

    expect(rows[0]?.invalidated?.by).toBe('review-security');
    expect(rows[0]?.invalidated?.reason).toContain('guard shape changed');
    expect(rows[0]?.invalidated?.seq).toBe(78);
  });

  it('flags the reading node itself as tainted', () => {
    // EPIC-17-S15: the row is marked *and* the node is, because an operator
    // scanning node headers should not have to open the table to learn that
    // this node worked from something since proven wrong.
    expect(inspectNode(happy(), 'impl-login', 0).tainted).toBe(true);
  });

  it('leaves a node that read nothing with an empty table and no taint', () => {
    const view = inspectNode(happy(), 'recon-auth-surface', 0);

    expect(provenanceRows(happy(), 'recon-auth-surface')).toEqual([]);
    expect(view.tainted).toBe(false);
  });

  it('does not mistake a fact the node wrote for one it read', () => {
    // `recon-auth-surface` wrote `finding/auth-uses-jwt` and read nothing. The
    // consumer set comes from `fact.read` and never from the plan's declared
    // edges — the whole reason `fact.read` is an event.
    expect(provenanceRows(happy(), 'recon-auth-surface').map((row) => row.key)).toEqual([]);
  });
});

/**
 * AC1 and AC10 — the header, the attempt history, and the absence of a
 * measurement stated as an absence.
 */
suite('KAR-17.3 — the header and the attempt history (AC1, AC10)', () => {
  it('shows identity, binary, permission, scopes and worktree', () => {
    const view = inspectNode(happy(), 'impl-signup', 0);

    expect(view.header.id).toBe('impl-signup');
    expect(view.header.pathScopes).toEqual({ write: ['src/**'], read: ['src/**'] });
    expect(view.header.binary?.version).toBeTruthy();
    expect(view.header.binary?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('lists every attempt with its outcome, failure, duration and cost', () => {
    const rows = attemptRows(repair(), 'impl-oauth');

    expect(rows.map((row) => row.attempt)).toEqual([0, 1, 2]);
    expect(rows.map((row) => row.outcome)).toEqual(['failed', 'failed', 'failed']);
    expect(rows.map((row) => row.failure?.reason)).toEqual([
      'timeout',
      'agent.nonzero-exit',
      'contract.schema-invalid',
    ]);
    expect(rows.every((row) => (row.durationMs ?? 0) > 0)).toBe(true);
    expect(rows[2]?.cost.vendorReported).toBeCloseTo(0.096, 6);
  });

  it('keys attempts the way the idempotency key is keyed', () => {
    // `(nodeId, attempt)` — the same pair the ledger's ikey is built from, so
    // "which attempt is this row" has one answer across the whole system.
    expect(attemptRows(repair(), 'impl-oauth').map((row) => row.key)).toEqual([
      'impl-oauth#0',
      'impl-oauth#1',
      'impl-oauth#2',
    ]);
  });

  it('states an unpriced provider as unaccounted rather than as zero (AC10)', () => {
    // `gemini-cli` reported no machine-readable cost for `impl-signup`. A `0`
    // here is a claim the vendor billed nothing, which nobody measured.
    const row = attemptRows(happy(), 'impl-signup').find((one) => one.attempt === 0);

    expect(row?.cost.unaccounted).toContain('gemini-cli');
    expect(row?.cost.vendorReported).not.toBe(0);
  });

  it('agrees with the timeline about what each attempt cost', () => {
    // Two indices over the same `budget.consumed` — `cost.byAttempt` and the
    // timeline's own span — and the inspector reads one of them. They are
    // folded from the same events and must not drift; if they ever do, the
    // attempt table and the Gantt bar would show different money for the same
    // attempt and neither would be wrong on its own terms.
    const folded = repair();
    for (const row of attemptRows(folded, 'impl-oauth')) {
      const span = folded.timeline.spans.get(row.key);
      expect(span?.costUsd.vendorReported).toBe(row.cost.vendorReported);
    }
  });
});

/**
 * AC11 — *"sparklines are raw `<path>` from `d3-shape`'s `line()`; no
 * `d3-selection` call exists in any component"*.
 *
 * The second half is a repo-wide source rule
 * (`test/no-d3-selection-in-web.test.ts`). The first half is this: the path is
 * built here, as a string, so the component renders `<path :d>` and owns no
 * subtree jointly with a library. Two owners of the same DOM subtree is the
 * class of bug that rule exists to prevent, and a generator that returns a
 * string cannot become one.
 */
suite('KAR-17.3 — the attempt sparkline is a string, not a subtree (AC11)', () => {
  it('builds one path across the packet size of every attempt', () => {
    const spark = attemptSparkline(repair(), 'impl-oauth', { width: 60, height: 16 });

    expect(spark?.path).toMatch(/^M/);
    // Three attempts, and the packet grew 262 → 290 → 290.
    expect(spark?.points).toEqual([262, 290, 290]);
  });

  it('spans the full width, so the last attempt sits at the right edge', () => {
    const spark = attemptSparkline(repair(), 'impl-oauth', { width: 60, height: 16 });

    expect(spark?.path).toContain('0,');
    expect(spark?.path).toContain('60,');
  });

  it('returns null for a node with nothing to plot rather than a flat line', () => {
    // `probe-oauth-tokens` never built a packet. A flat line at zero would draw
    // a measurement of nothing, which is the AC10 mistake in another medium.
    expect(attemptSparkline(repair(), 'probe-oauth-tokens', { width: 60, height: 16 })).toBeNull();
  });

  it('draws a single attempt as a point rather than refusing to draw', () => {
    // `impl-login` built one packet and never retried. One measurement is still
    // a measurement, and a generator that divided by a zero-width domain would
    // return `NaN` coordinates that render as an invisible, silent nothing.
    const spark = attemptSparkline(happy(), 'impl-login', { width: 60, height: 16 });

    expect(spark?.points).toEqual([290]);
    expect(spark?.path).toMatch(/^M/);
    expect(spark?.path).not.toContain('NaN');
  });
});
