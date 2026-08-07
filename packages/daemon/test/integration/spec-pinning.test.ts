/**
 * KAR-10.4 — spec pinning and anti-drift re-injection, against a real ledger
 * and a real git worktree.
 *
 * Integration rather than unit because every claim here is about the join
 * between three things a unit test would have to fake: the digests the ledger
 * recorded at approval, the bytes a packet builder composed afterwards, and the
 * repository the gate can see. Drift lives exactly in those joins — *"the
 * reviewer reads the code, forms a model of what the code is trying to do, and
 * judges the code against that model. It always passes."*
 *
 * `pinned-set.test.ts` and `compile-pinned.test.ts` prove the compiler; the
 * no-retry half of EPIC-10-S23 is `./pin-integrity-no-retry.test.ts` (KAR-09.3
 * built it and this story is the caller that gives it something to check). What
 * is here is what neither of those can say.
 *
 * Verifies: EPIC-10-S20, EPIC-10-S21, EPIC-10-S22, EPIC-10-S23, EPIC-10-S29 ·
 * AC3, AC4, AC5, AC7, AC8 · test plan #4, #5, #6, #7, #9
 */
import type { ContextPacket, Db, PinnedNodeContext, Segment, VerdictV2 } from '@DeFlow/core';
import {
  acceptanceBoard,
  assertPinIntegrity,
  buildPacket,
  compilePinnedSegments,
  findPinViolations,
  gateSpecFromLedger,
  initialRunState,
  PinIntegrityViolation,
  pinnedKept,
  renderPacket,
  staleGateNodes,
  verdictAgainst,
} from '@DeFlow/core';
import { appendEvents, openLedger, readRange, replayAll } from '@DeFlow/ledger';
import { it, makeRepo } from '@DeFlow/testkit';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { approveSpec, editSpec } from '../../src/spec/gate.ts';
import { framed, SPEC_RUN, seedSpecGateRun, T0 } from './support/spec-gate-run.ts';

/** The five archetypes EPIC-10-S20's outline names. Pinning is a property of
 * the *packet*, so a node type that skipped it would be a node judged against
 * whatever it happened to remember. */
const ARCHETYPES = ['agent', 'gate', 'human', 'recon', 'map-child'] as const;

/** What each archetype declares. The point of varying them is that the pinned
 * *spec* rows must come out byte-identical anyway — only the two node-derived
 * rows may differ. */
const NODE_CONTEXT: Readonly<Record<(typeof ARCHETYPES)[number], PinnedNodeContext>> = {
  agent: { pathScopes: ['packages/ui/src/**'], permission: 'worktree' },
  gate: { pathScopes: [], permission: 'read' },
  human: { pathScopes: [], permission: 'read' },
  recon: { pathScopes: [], permission: 'read' },
  'map-child': { pathScopes: ['packages/ui/src/checkout/**'], permission: 'worktree' },
};

const events = (db: Db) => readRange(db, SPEC_RUN, 0, 500).events;

const pinnedDigestsFromLedger = (db: Db): readonly string[] => {
  const pinned = events(db)
    .filter((event) => event.kind === 'spec.pinned')
    .at(-1);
  const payload = pinned?.payload as { segments: { sha256: string }[] } | undefined;
  return (payload?.segments ?? []).map((segment) => segment.sha256);
};

/** A run seeded to the gate and approved, with the ledger open on disk. */
async function approvedRun(tmp: string) {
  const db = openLedger(tmp);
  const spec = await seedSpecGateRun(db);
  const approval = await approveSpec({ db, runId: SPEC_RUN, epoch: 1, ts: T0, by: 'ui' });
  return { db, spec, specHash: approval.specHash };
}

async function packetFor(
  archetype: (typeof ARCHETYPES)[number],
  spec: Awaited<ReturnType<typeof approvedRun>>['spec'],
): Promise<ContextPacket> {
  const build = await buildPacket({
    runId: SPEC_RUN,
    nodeId: `node-${archetype}`,
    attempt: 0,
    builtAtEvent: 1,
    target: { provider: 'claude-code', model: 'the-model-under-test', maxContext: 200_000 },
    pinned: { spec, node: NODE_CONTEXT[archetype], sourceEvent: 1 },
  });
  return build.packet;
}

// ── EPIC-10-S20 / test plan #4 — pinned first, everywhere ────────────────────

suite('EPIC-10-S20 — every node archetype carries the pinned spec first (AC3)', () => {
  for (const archetype of ARCHETYPES) {
    it(`a ${archetype} node's packet opens with the five pinned segments, in §4.1's order`, async ({
      tmp,
    }) => {
      const { spec } = await approvedRun(tmp);
      const packet = await packetFor(archetype, spec);
      const head = packet.segments.slice(0, 5);

      expect(head.map((segment) => segment.kind)).toEqual([
        'pinned.spec',
        'pinned.spec',
        'pinned.constraints',
        'pinned.pathscope',
        'pinned.constraints',
      ]);
      // Pinned implies not compactable — the implication §6 states, on the
      // packet rather than only in the builder that produced it.
      for (const segment of head) {
        expect(segment.pinned).toBe(true);
        expect(segment.compactable).toBe(false);
      }
      // And nothing after them is pinned, so "first" is the whole block.
      expect(packet.segments.slice(5).some((segment) => segment.pinned)).toBe(false);
    });

    it(`assertPinIntegrity passes after rendering a ${archetype} node's prompt`, async ({
      tmp,
    }) => {
      const { spec } = await approvedRun(tmp);
      const packet = await packetFor(archetype, spec);

      await expect(assertPinIntegrity(packet, renderPacket(packet))).resolves.toBeUndefined();
    });
  }

  /**
   * The join the story exists to protect: the digests the *ledger* recorded when
   * the operator approved, and the bytes a packet composes hours later. If those
   * two ever come from different composers, `assertPinIntegrity` still passes —
   * it checks a packet against itself — and nothing else would notice.
   */
  it('matches the digests spec.pinned recorded at approval, for every archetype', async ({
    tmp,
  }) => {
    const { db, spec } = await approvedRun(tmp);
    const recorded = pinnedDigestsFromLedger(db);
    expect(recorded).toHaveLength(3);

    for (const archetype of ARCHETYPES) {
      const packet = await packetFor(archetype, spec);
      const specDerived = packet.segments
        .filter((segment) => segment.id !== 'pinned-pathscope')
        .filter((segment) => segment.id !== 'pinned-constraints-permission')
        .filter((segment) => segment.pinned)
        .map((segment) => segment.contentHash);

      expect(specDerived, archetype).toEqual(recorded);
    }
  });

  /** *"a review gate whose acceptance criteria were compacted away is a review
   * gate that has silently become a code-reads-well check"* (10 §5.2). */
  it('gives a gate node the acceptance criteria and a human node the goal and non-goals', async ({
    tmp,
  }) => {
    const { spec } = await approvedRun(tmp);
    const gate = await packetFor('gate', spec);
    const human = await packetFor('human', spec);

    const textOf = (packet: ContextPacket, id: string): string =>
      packet.segments.find((segment) => segment.id === id)?.text ?? '';

    for (const criterion of spec.acceptanceCriteria) {
      expect(textOf(gate, 'pinned-spec-criteria')).toContain(criterion.statement);
    }
    expect(textOf(human, 'pinned-spec-goal')).toContain(spec.goal);
    for (const nonGoal of spec.nonGoals) {
      expect(textOf(human, 'pinned-spec-goal')).toContain(nonGoal);
    }
  });

  /** The prompt is a rendering; the manifest is the audit record, and it must
   * not carry the bytes twice (F6.2). */
  it('carries a manifest with no segment text', async ({ tmp }) => {
    const { spec } = await approvedRun(tmp);
    const packet = await packetFor('agent', spec);

    const manifest = packet.segments.map(({ text: _text, ...rest }) => rest);
    expect(manifest.every((entry) => !('text' in entry))).toBe(true);
    expect(packet.pinnedDigests).toEqual(
      packet.segments.filter((segment) => segment.pinned).map((segment) => segment.contentHash),
    );
  });

  /**
   * EPIC-10-S20's third scenario, second clause: *"after re-injection the pinned
   * bytes are identical, not paraphrased."*
   *
   * Re-injection — whether the interval came due (AC7) or a compaction forced
   * it — rebuilds the block from the same spec and the same node. That it comes
   * back byte-identical is a property of the compiler being pure rather than
   * something the re-injection site has to be careful about, and this is what
   * says so after everyone who knew that has moved on. The paper's result is
   * about *verbatim* re-injection, so a "tidied" second rendering would be an
   * untested intervention wearing the evidence of a tested one.
   */
  it('re-injects byte-identical bytes, so a second delivery is not a paraphrase', async ({
    tmp,
  }) => {
    const { spec } = await approvedRun(tmp);
    const first = await packetFor('agent', spec);
    const second = await packetFor('agent', spec);

    const pinnedOf = (packet: ContextPacket) =>
      packet.segments.filter((segment) => segment.pinned).map((segment) => segment.text);

    expect(pinnedOf(second)).toEqual(pinnedOf(first));
    expect(second.pinnedDigests).toEqual(first.pinnedDigests);
  });
});

// ── EPIC-10-S23 / test plan #5 — a vanished pin ──────────────────────────────

/** Strips a pinned segment's bytes out of a rendered prompt, the way a mangling
 * adapter or a rendering bug would — after the packet was built and hashed. */
const strip = (rendered: string, segments: readonly Segment[]): string =>
  segments.reduce((text, segment) => text.replace(segment.text, ''), rendered);

suite('EPIC-10-S23 — a vanished pin fails the node, loudly (AC3)', () => {
  it('names the missing digest and its segmentId', async ({ tmp }) => {
    const { spec } = await approvedRun(tmp);
    const packet = await packetFor('agent', spec);
    const dropped = packet.segments.filter((segment) => segment.id === 'pinned-spec-criteria');

    const violations = await findPinViolations(packet, strip(renderPacket(packet), dropped));

    expect(violations).toHaveLength(1);
    expect(violations[0]?.id).toBe('pinned-spec-criteria');
    expect(violations[0]?.contentHash).toBe(dropped[0]?.contentHash);
    expect(violations[0]?.kind).toBe('absent');
  });

  /** *"the event was not truncated to the first violation"* — a report naming
   * one vanished pin out of three sends a human to the wrong rendering path. */
  it('reports every violating segment when three are removed', async ({ tmp }) => {
    const { spec } = await approvedRun(tmp);
    const packet = await packetFor('agent', spec);
    const dropped = packet.segments.filter((segment) =>
      ['pinned-spec-goal', 'pinned-spec-criteria', 'pinned-pathscope'].includes(segment.id),
    );
    expect(dropped).toHaveLength(3);

    const rendered = strip(renderPacket(packet), dropped);
    const thrown = await assertPinIntegrity(packet, rendered).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(PinIntegrityViolation);
    const violation = thrown as PinIntegrityViolation;
    expect(violation.missingDigests).toHaveLength(3);
    expect(violation.missingDigests).toEqual(dropped.map((segment) => segment.contentHash));
    expect(violation.deflowFailure.reason).toBe('safety.pin-integrity-violated');
    // `gate`, never `transient`: a second attempt has an excellent chance of
    // dropping the pin again, and a small chance of dropping a different one.
    expect(violation.deflowFailure.class).toBe('gate');
  });

  /**
   * AC8 / EPIC-10-S23's third scenario. `pinnedKept` is *positive* evidence: it
   * runs the check and returns the digests, so "the check passed" and "the
   * check never ran" are distinguishable in the ledger. Assembling the same
   * list off the packet would record only that a packet had pins.
   */
  it('records the full digest list on the success path, and refuses on the failure path', async ({
    tmp,
  }) => {
    const { spec } = await approvedRun(tmp);
    const packet = await packetFor('agent', spec);
    const rendered = renderPacket(packet);

    await expect(pinnedKept(packet, rendered)).resolves.toEqual(packet.pinnedDigests);

    const dropped = packet.segments.filter((segment) => segment.id === 'pinned-constraints-safety');
    await expect(pinnedKept(packet, strip(rendered, dropped))).rejects.toBeInstanceOf(
      PinIntegrityViolation,
    );
  });
});

// ── EPIC-10-S21 / test plan #6 — anti-drift ──────────────────────────────────

/**
 * The worktree the scenario describes: components deleted rather than migrated,
 * and a README that has quietly redefined the task. Everything in it is a story
 * the code tells about itself, and none of it is the contract.
 */
const DRIFTED_README =
  '# checkout\n\nThis migration covers the components worth migrating. Six legacy components\n' +
  'were removed rather than ported, which is the pragmatic reading of the goal.\n';

suite('EPIC-10-S21 — the gate is judged against the pinned spec, not the code (AC4)', () => {
  it('reads the criteria from the ledger at the run’s specHash, not from the worktree', async ({
    tmp,
  }) => {
    const { db, spec, specHash } = await approvedRun(tmp);
    const repo = await makeRepo({
      dir: join(tmp, 'work'),
      files: {
        'README.md': DRIFTED_README,
        'packages/ui/src/checkout/Cart.vue': '<template><div /></template>\n',
      },
    });

    const resolved = await gateSpecFromLedger(events(db));

    // The contract, byte for byte as the operator approved it — and the README
    // sitting on disk beside it saying something else entirely.
    expect(resolved.specHash).toBe(specHash);
    expect(resolved.criteria).toEqual(spec.acceptanceCriteria);
    const readme = await readFile(join(repo.dir, 'README.md'), 'utf8');
    expect(readme).toContain('worth migrating');
    expect(JSON.stringify(resolved.criteria)).not.toContain('worth migrating');
  });

  /**
   * The reviewer's packet is compiled from the ledger's spec and from nothing
   * else. Stated as a byte comparison rather than as a description of where the
   * builder gets its input, because a later change could add a "helpful"
   * repository-context segment and only this assertion would notice.
   */
  it('builds the gate’s pinned bytes from the ledger’s spec, with nothing from the repo', async ({
    tmp,
  }) => {
    const { db, spec } = await approvedRun(tmp);
    await makeRepo({ dir: join(tmp, 'work'), files: { 'README.md': DRIFTED_README } });

    const resolved = await gateSpecFromLedger(events(db));
    const packet = await packetFor('gate', spec);
    const expected = compilePinnedSegments(resolved.spec, NODE_CONTEXT.gate);

    for (const [index, segment] of packet.segments.slice(0, 5).entries()) {
      expect(segment.text, segment.id).toBe(expected[index]?.text);
    }
    for (const segment of packet.segments) {
      expect(segment.text, segment.id).not.toContain('worth migrating');
    }
  });

  /**
   * The verdict itself: AC-2 is unsatisfied *as written in the spec*, and the
   * verdict names the contract it reached that conclusion under. A verdict that
   * marked it satisfied because the code reads coherently is the failure this
   * whole story exists to make impossible to reach silently.
   */
  it('produces a verdict citing the criterion as written, carrying the run’s specHash', async ({
    tmp,
  }) => {
    const { db, specHash } = await approvedRun(tmp);
    const resolved = await gateSpecFromLedger(events(db));
    const judged = resolved.criteria.find((criterion) => criterion.id === 'ac-2');

    const verdict = verdictAgainst(
      {
        schemaId: 'DeFlow.verdict.v2',
        outcome: 'fail',
        gate: 'codemod-review',
        evaluatedNode: 'node-agent',
        by: { node: 'gate-codemod-review', provider: 'claude-code', model: 'the-reviewing-model' },
        criteria: [{ id: 'ac-2', status: 'unsatisfied' }],
        findings: [],
        summary: `judged against: ${judged?.statement ?? ''}`,
      } as VerdictV2,
      resolved.specHash,
    );

    expect(verdict.specHash).toBe(specHash);
    expect(verdict.summary).toContain('No v-model modifier is silently dropped by the codemod.');
    expect(verdict.criteria).toEqual([{ id: 'ac-2', status: 'unsatisfied' }]);
  });
});

// ── EPIC-10-S22 / EPIC-10-S29 / test plan #7 — the void verdict ──────────────

const passingVerdict = (specHash: string, criterion: string): VerdictV2 =>
  verdictAgainst(
    {
      schemaId: 'DeFlow.verdict.v2',
      outcome: 'pass',
      gate: 'codemod-review',
      evaluatedNode: 'node-agent',
      by: { node: 'gate-codemod-review', provider: 'claude-code', model: 'the-reviewing-model' },
      criteria: [{ id: criterion, status: 'satisfied' }],
      findings: [],
      summary: 'the criterion holds',
    } as VerdictV2,
    specHash,
  );

const recordVerdict = (db: Db, verdict: VerdictV2): void => {
  appendEvents(db, [
    {
      runId: SPEC_RUN,
      ts: T0,
      kind: 'gate.evaluated',
      v: 2,
      epoch: 1,
      nodeId: 'gate-codemod-review',
      payload: { gate: 'codemod-review', node: 'node-agent', verdict },
    },
  ]);
};

const verdictsOf = (db: Db): readonly VerdictV2[] =>
  events(db)
    .filter((event) => event.kind === 'gate.evaluated')
    .map((event) => (event.payload as { verdict: VerdictV2 }).verdict);

suite('EPIC-10-S22 — a verdict at a stale specHash is void and the gate re-runs (AC5)', () => {
  it('excludes the verdict from the board, names both hashes, and re-schedules the gate', async ({
    tmp,
  }) => {
    const { db, spec, specHash } = await approvedRun(tmp);
    recordVerdict(db, passingVerdict(specHash, 'ac-2'));

    // Green while the contract holds.
    const before = acceptanceBoard({
      criteria: spec.acceptanceCriteria,
      verdicts: verdictsOf(db),
      specHash,
    });
    expect(before.find((row) => row.criterion === 'ac-2')?.status).toBe('satisfied');

    // The operator sharpens ac-2 mid-run. `editSpec` re-approves at B in the
    // same transaction, which is what moves the run's identity.
    const edited = framed();
    edited.acceptanceCriteria[1] = {
      ...edited.acceptanceCriteria[1],
      statement: 'No v-model modifier is dropped, and every dropped one is listed in the report.',
    } as (typeof edited.acceptanceCriteria)[number];
    const amendment = await editSpec({
      db,
      runId: SPEC_RUN,
      epoch: 1,
      ts: T0 + 60_000,
      by: 'ui',
      edited,
    });

    expect(amendment.to).not.toBe(specHash);

    const after = acceptanceBoard({
      criteria: amendment.spec.acceptanceCriteria,
      verdicts: verdictsOf(db),
      specHash: amendment.to,
    });
    const row = after.find((entry) => entry.criterion === 'ac-2');

    // Not blank and not green — "re-running against the amended spec".
    expect(row?.status).toBe('revalidating');
    expect(row?.note).toContain('re-running against the amended spec');
    expect(row?.note).toContain(specHash);
    expect(row?.note).toContain(amendment.to);

    // And the gate goes back on the schedule.
    expect(staleGateNodes(verdictsOf(db), amendment.to)).toEqual(['gate-codemod-review']);
  });

  /** NF10 — the board state traces to a specific event, and that event names
   * the old hash and the new one. */
  it('records why the gate re-ran, naming both hashes, in the ledger', async ({ tmp }) => {
    const { db, specHash } = await approvedRun(tmp);
    recordVerdict(db, passingVerdict(specHash, 'ac-2'));

    const edited = framed();
    edited.goal = 'Migrate the checkout module from Vue 2 to Vue 3, keeping the public API frozen.';
    const amendment = await editSpec({
      db,
      runId: SPEC_RUN,
      epoch: 1,
      ts: T0 + 60_000,
      by: 'ui',
      edited,
    });

    const amended = events(db)
      .filter((event) => event.kind === 'spec.amended')
      .at(-1)?.payload as { from: string; to: string };

    expect(amended.from).toBe(specHash);
    expect(amended.to).toBe(amendment.to);
  });

  /** The run-level fold agrees with the board: a criterion satisfied under A is
   * no longer satisfied once the run is at B. */
  it('empties the run’s criteriaSatisfied when the spec moves under it', async ({ tmp }) => {
    const { db, specHash } = await approvedRun(tmp);
    recordVerdict(db, passingVerdict(specHash, 'ac-2'));

    const satisfiedAtA = (replayAll(db).runs.get(SPEC_RUN) ?? initialRunState()).criteriaSatisfied;
    expect(satisfiedAtA).toEqual(['ac-2']);

    const edited = framed();
    edited.goal = 'Migrate the checkout module from Vue 2 to Vue 3, keeping the public API frozen.';
    await editSpec({ db, runId: SPEC_RUN, epoch: 1, ts: T0 + 60_000, by: 'ui', edited });

    const satisfiedAtB = (replayAll(db).runs.get(SPEC_RUN) ?? initialRunState()).criteriaSatisfied;
    expect(satisfiedAtB).toEqual([]);
  });

  /** *"an unchanged spec does not void anything"*. */
  it('voids nothing when the spec is re-approved without an edit', async ({ tmp }) => {
    const { db, specHash } = await approvedRun(tmp);
    recordVerdict(db, passingVerdict(specHash, 'ac-2'));

    appendEvents(db, [
      {
        runId: SPEC_RUN,
        ts: T0 + 60_000,
        kind: 'run.spec.approved',
        v: 1,
        epoch: 1,
        payload: { specHash, by: 'cli' },
      },
    ]);

    const state = replayAll(db).runs.get(SPEC_RUN) ?? initialRunState();
    expect(state.criteriaSatisfied).toEqual(['ac-2']);
    expect(staleGateNodes(verdictsOf(db), specHash)).toEqual([]);
  });

  /** EPIC-10-S29's last scenario: the edit does not rewrite history. */
  it('leaves the pre-edit spec, its pinned digests and the A-hash verdict in the ledger', async ({
    tmp,
  }) => {
    const { db, specHash } = await approvedRun(tmp);
    const digestsAtA = pinnedDigestsFromLedger(db);
    recordVerdict(db, passingVerdict(specHash, 'ac-2'));

    const edited = framed();
    edited.goal = 'Migrate the checkout module from Vue 2 to Vue 3, keeping the public API frozen.';
    await editSpec({ db, runId: SPEC_RUN, epoch: 1, ts: T0 + 60_000, by: 'ui', edited });

    const pins = events(db).filter((event) => event.kind === 'spec.pinned');
    expect(pins).toHaveLength(2);
    expect((pins[0]?.payload as { specHash: string }).specHash).toBe(specHash);
    expect(
      (pins[0]?.payload as { segments: { sha256: string }[] }).segments.map((s) => s.sha256),
    ).toEqual(digestsAtA);

    // The verdict itself is untouched: still there, still citing A.
    expect(verdictsOf(db).map((verdict) => verdict.specHash)).toEqual([specHash]);
  });
});
