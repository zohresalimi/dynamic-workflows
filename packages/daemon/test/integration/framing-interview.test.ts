/**
 * KAR-10.2 — the framing interview, end to end, against a real file-backed
 * ledger, the real Ajv2020 validator over the repository's emitted schemas, the
 * real Tier-2 tokenizer and a real git repository.
 *
 * Integration rather than unit because every claim here is about something
 * durable or something real: *how many* `run.created` rows a run has, that a
 * schema-invalid interview leaves none, that the `repo.head` on the one that
 * does exist is the commit `git rev-parse` really answers with, and that the
 * document is refused by Ajv rather than by a hand-written check that agrees
 * with Ajv on the cases somebody thought of.
 *
 * The "session" is a port with a scripted queue, exactly as
 * ./handoff-contract.test.ts scripts one: the transport half — the schema
 * reaching the process on `--json-schema` and `structured_output` coming back —
 * is `packages/adapters/test/integration/structured-output.test.ts`, where a
 * real process really is spawned, and the read-permission half is
 * ./framing-read-only.test.ts, where a real agent really does call back into
 * the client.
 *
 * Verifies: EPIC-10-S6, EPIC-10-S10, EPIC-10-S11 · AC2, AC3, AC10, AC11 ·
 * test plan #3, #4, #10
 */
import { shimCapabilityRow } from '@DeFlow/adapters';
import type { Db, NodeId, RunId, StructuredOutput, TaskSpec } from '@DeFlow/core';
import {
  buildFramingPacket,
  FRAMING_RETURN_MAX_TOKENS,
  HandleSchema,
  NodeIdSchema,
  RunIdSchema,
} from '@DeFlow/core';
import { appendEvents, openLedger, readRange } from '@DeFlow/ledger';
import { it, makeRepo } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import {
  type FramingAgent,
  type FramingSession,
  type FramingTurn,
  gitRepoState,
  runFramingInterview,
} from '../../src/framing/interview.ts';
import { Git } from '../../src/git/git.ts';
import { loadSchemaDirectory } from '../../src/schema-store.ts';
import { o200kTokenizer } from '../../src/tokens/tokenizer.ts';

/** The repository's own emitted documents — the same bytes `deflow init`
 * copies into a run's `.DeFlow/schemas/`. */
const SCHEMAS_DIR = fileURLToPath(new URL('../../../../schemas/', import.meta.url));

const RUN: RunId = RunIdSchema.parse('run_20260807T101500Z_ac1002');
const FRAMING: NodeId = NodeIdSchema.parse('framing');
const T0 = 1_754_380_800_000;
const PROVIDER = 'claude';

const RAW_TASK = 'Migrate the design system to Vue 3. Keep the public component API stable.';

/** A `DeFlow.taskspecdraft.v1` the criteria contract accepts, with `extra`
 * folded over it so one case can be put on the wrong side of the contract. */
function draft(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaId: 'DeFlow.taskspecdraft.v1',
    goal: 'Migrate every component under packages/ui to Vue 3 with no public API change.',
    scope: { included: ['packages/ui'], paths: ['packages/ui/src/**'] },
    nonGoals: ['Do not touch packages/legacy.'],
    constraints: ['No new runtime dependency.'],
    priorDecisions: [
      {
        decision: 'Keep the options API shim.',
        source: 'repository',
        rationale: 'Still imported.',
      },
    ],
    acceptanceCriteria: [
      { id: 'ac-1', statement: 'pnpm typecheck passes.', verifiedBy: ['typecheck'] },
      { id: 'ac-2', statement: 'pnpm build passes.', verifiedBy: ['build'] },
    ],
    knownFailureModes: [
      {
        id: 'fm-1',
        description: 'A component silently loses its default slot.',
        detection: 'The snapshot suite for that component changes.',
      },
    ],
    ...extra,
  };
}

const present = (value: unknown): StructuredOutput => ({ present: true, value });

/** A session that answers with the scripted turns in order and records every
 * prompt it was sent. */
function scripted(...turns: readonly FramingTurn[]): FramingSession & {
  readonly prompts: string[];
  readonly repairs: string[];
} {
  const prompts: string[] = [];
  const repairs: string[] = [];
  let at = 0;
  const next = (): FramingTurn => {
    const turn = turns[at];
    at += 1;
    if (turn === undefined) throw new Error('the framing session was asked for an unscripted turn');
    return turn;
  };
  return {
    prompts,
    repairs,
    steerable: true,
    answer(text: string) {
      prompts.push(text);
      return Promise.resolve(next());
    },
    repair(prompt: string) {
      repairs.push(prompt);
      const turn = next();
      return Promise.resolve(turn.structuredOutput);
    },
  };
}

function agentOf(session: FramingSession, first: FramingTurn): FramingAgent & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    open(prompt: string) {
      opened.push(prompt);
      return Promise.resolve({ session, turn: first });
    },
  };
}

const turn = (
  structuredOutput: StructuredOutput,
  extra: Partial<FramingTurn> = {},
): FramingTurn => ({
  question: null,
  structuredOutput,
  ...extra,
});

/** The ledger up to the instant framing is scheduled: intake has appended its
 * one event (KAR-10.1) and nothing has interpreted it. */
function seedIntake(db: Db): void {
  appendEvents(db, [
    {
      runId: RUN,
      ts: T0,
      kind: 'task.submitted',
      v: 1,
      epoch: 1,
      payload: {
        sha256: 'a'.repeat(64),
        raw: RAW_TASK,
        provenance: { kind: 'text', by: 'cli', submittedAt: T0 },
      },
    },
  ]);
}

const CAPABILITY_ROW = shimCapabilityRow({
  provider: PROVIDER,
  version: '2.1.220',
  binaryPath: '/opt/DeFlow/claude',
  binarySha256: 'b'.repeat(64),
  probedAt: T0,
});

interface HarnessOptions {
  readonly agent: FramingAgent;
  readonly capabilityRow?: Parameters<typeof runFramingInterview>[0]['capabilityRow'];
  readonly provider?: string;
}

async function harness(tmp: string, options: HarnessOptions) {
  const repoDir = join(tmp, 'repo');
  const repo = await makeRepo({ dir: repoDir, files: { 'package.json': '{"name":"ui"}\n' } });
  await mkdir(join(tmp, 'data'), { recursive: true });
  const db = openLedger(join(tmp, 'data'));
  seedIntake(db);

  const packet = await buildFramingPacket({
    runId: RUN,
    nodeId: FRAMING,
    attempt: 0,
    builtAtEvent: 2,
    target: { provider: PROVIDER, model: 'claude-sonnet-4-6', maxContext: 200_000 },
    task: { text: RAW_TASK, sourceEvent: 1 },
    constraints: [{ form: 'require', statement: 'never commit a credential' }],
  });

  const run = () =>
    runFramingInterview({
      db,
      runId: RUN,
      node: FRAMING,
      attempt: 0,
      epoch: 1,
      ts: T0,
      provider: options.provider ?? PROVIDER,
      capabilityRow: options.capabilityRow === undefined ? CAPABILITY_ROW : options.capabilityRow,
      packet,
      schemas: loadSchemaDirectory(SCHEMAS_DIR),
      tokenizer: o200kTokenizer(),
      agent: options.agent,
      readRepo: () => gitRepoState(new Git(repoDir), repoDir),
      captureEvidence: () => HandleSchema.parse(`artifact://${'c'.repeat(64)}`),
    });

  return { db, repo, repoDir, packet, run };
}

const events = (db: Db) => readRange(db, RUN, 0, 500).events;
const kinds = (db: Db) => events(db).map((event) => event.kind);
const payloadsOf = (db: Db, kind: string) =>
  events(db)
    .filter((event) => event.kind === kind)
    .map((event) => event.payload as Record<string, unknown>);

suite('EPIC-10-S6 — a complete spec lands in the ledger (test plan #3, #10)', () => {
  it('seals the returned document and appends exactly one run.created', async ({ tmp }) => {
    const session = scripted();
    const agent = agentOf(session, turn(present(draft())));
    const { db, repoDir, repo, run } = await harness(tmp, { agent });

    const outcome = await run();

    expect(outcome.outcome).toBe('completed');
    if (outcome.outcome !== 'completed') return;

    // AC4/AC5: the sealed spec is a DeFlow.taskspec.v1 with a minted digest and
    // no approval — approving it is KAR-10.3's gate, not framing's.
    expect(outcome.spec.schemaId).toBe('DeFlow.taskspec.v1');
    expect(outcome.spec.approvedBy).toBeNull();
    expect(outcome.spec.specHash).toMatch(/^sha256-[0-9a-f]{64}$/);
    expect(outcome.spec.nonGoals).toEqual(['Do not touch packages/legacy.']);
    expect(outcome.spec.acceptanceCriteria.map((criterion) => criterion.id)).toEqual([
      'ac-1',
      'ac-2',
    ]);

    // AC11 — one run.created, after the node succeeded, carrying the real repo.
    const created = payloadsOf(db, 'run.created');
    expect(created).toHaveLength(1);
    expect(created[0]?.cwd).toBe(repoDir);
    expect((created[0]?.spec as TaskSpec).specHash).toBe(outcome.spec.specHash);
    const head = (await repo.git('rev-parse', 'HEAD')).trim();
    expect(created[0]?.repo).toEqual({ head, branch: 'main' });

    // The run is created and its spec is not approved — which is what the API
    // reports as "awaiting-spec-approval" (docs/11-api-and-realtime.md §7.1).
    // `RunStatus` has no member of that name; the approval event is the one
    // that moves it on, and nothing here appends one.
    expect(kinds(db)).not.toContain('run.spec.approved');
    expect(kinds(db)).not.toContain('node.failed');
    db.close();
  });

  it('reads the document from structured_output and never from a message', async ({ tmp }) => {
    // The agent said the whole spec in prose and left `structured_output`
    // absent. There is no prose fallback: the return is re-asked for once as a
    // structured object, and an agent that still will not send one fails the
    // node. No regex, no JSON-block extraction, no heuristic parse.
    const session = scripted(turn({ present: false }));
    const agent = agentOf(session, turn({ present: false }));
    const { db, run } = await harness(tmp, { agent });

    const outcome = await run();

    expect(outcome.outcome).toBe('failed');
    if (outcome.outcome !== 'failed') return;
    expect(outcome.failure.deflowFailure.reason).toBe('contract.schema-invalid');
    expect(session.repairs[0]).toContain('DeFlow.taskspecdraft.v1');
    expect(payloadsOf(db, 'run.created')).toEqual([]);
    db.close();
  });

  it('holds the framing node to a 4000-token return budget, not the 1500 default', async ({
    tmp,
  }) => {
    expect(FRAMING_RETURN_MAX_TOKENS).toBe(4000);

    // A document 4000 tokens cannot hold, twice: the budget is what the
    // oversize event reports, and it reports the framing node's own figure.
    const long = { constraints: [`No new runtime dependency. ${'detail '.repeat(4000)}`] };
    const session = scripted(turn(present(draft(long))));
    const agent = agentOf(session, turn(present(draft(long))));
    const { db, run } = await harness(tmp, { agent });

    const outcome = await run();

    const oversize = payloadsOf(db, 'handoff.oversize');
    expect(oversize).toHaveLength(2);
    expect(oversize.map((entry) => entry.budget)).toEqual([
      FRAMING_RETURN_MAX_TOKENS,
      FRAMING_RETURN_MAX_TOKENS,
    ]);
    expect(oversize.map((entry) => entry.repairAttempted)).toEqual([false, true]);
    // Never cut at 4000 — repaired once, then failed (roadmap §7).
    expect(outcome.outcome).toBe('failed');
    expect(payloadsOf(db, 'run.created')).toEqual([]);
    db.close();
  });
});

suite('EPIC-10-S11 — one bounded repair, then a typed node failure', () => {
  it('sends exactly one repair prompt carrying the Ajv errors, and completes', async ({ tmp }) => {
    const invalid = draft({ knownFailureModes: undefined });
    delete invalid.knownFailureModes;
    const session = scripted(turn(present(draft())));
    const agent = agentOf(session, turn(present(invalid)));
    const { db, run } = await harness(tmp, { agent });

    const outcome = await run();

    expect(session.repairs).toHaveLength(1);
    expect(session.repairs[0]).toContain('knownFailureModes');
    expect(outcome.outcome).toBe('completed');
    if (outcome.outcome !== 'completed') return;
    expect(outcome.repairs).toBe(1);
    expect(payloadsOf(db, 'run.created')).toHaveLength(1);
    db.close();
  });

  it('fails with contract.schema-invalid and writes no spec when the repair does not fix it', async ({
    tmp,
  }) => {
    const invalid = draft();
    delete invalid.knownFailureModes;
    const session = scripted(turn(present(invalid)));
    const agent = agentOf(session, turn(present(invalid)));
    const { db, run } = await harness(tmp, { agent });

    const outcome = await run();

    expect(outcome.outcome).toBe('failed');
    if (outcome.outcome !== 'failed') return;
    expect(outcome.failure.deflowFailure.reason).toBe('contract.schema-invalid');
    expect(session.repairs).toHaveLength(1);
    // Not a partial one, not a defaulted one, and no half-born run.
    expect(payloadsOf(db, 'run.created')).toEqual([]);
    expect(payloadsOf(db, 'node.failed')).toHaveLength(1);
    db.close();
  });

  it('a criterion that names no gate is a schema failure, not a warning (AC4)', async ({ tmp }) => {
    const naked = draft({
      acceptanceCriteria: [
        { id: 'ac-1', statement: 'pnpm typecheck passes.', verifiedBy: ['typecheck'] },
        { id: 'ac-7', statement: 'The migration does not regress bundle size.', verifiedBy: [] },
      ],
    });
    const session = scripted(turn(present(naked)));
    const agent = agentOf(session, turn(present(naked)));
    const { db, run } = await harness(tmp, { agent });

    const outcome = await run();

    expect(outcome.outcome).toBe('failed');
    expect(session.repairs[0]).toContain('acceptanceCriteria');
    expect(payloadsOf(db, 'run.created')).toEqual([]);
    db.close();
  });

  it('does not stack its own repair on top of a vendor that already exhausted one', async ({
    tmp,
  }) => {
    const session = scripted();
    const agent = agentOf(session, turn({ present: false }, { vendorRepairExhausted: true }));
    const { db, run } = await harness(tmp, { agent });

    const outcome = await run();

    expect(outcome.outcome).toBe('failed');
    if (outcome.outcome !== 'failed') return;
    expect(outcome.failure.deflowFailure.reason).toBe('agent.schema-repair-exhausted');
    expect(session.repairs).toEqual([]);
    expect(payloadsOf(db, 'run.created')).toEqual([]);
    db.close();
  });
});

suite('EPIC-10-S10 — structured output at the adapter boundary, or refuse (AC3)', () => {
  it('refuses an unprobed adapter before a session is opened, and creates no run', async ({
    tmp,
  }) => {
    const session = scripted();
    const agent = agentOf(session, turn(present(draft())));
    const { db, run } = await harness(tmp, { agent, capabilityRow: null });

    const outcome = await run();

    expect(outcome.outcome).toBe('failed');
    if (outcome.outcome !== 'failed') return;
    expect(outcome.failure.deflowFailure.reason).toBe('adapter.capability-missing');
    expect((agent as { opened: string[] }).opened).toEqual([]);
    expect(payloadsOf(db, 'run.created')).toEqual([]);
    expect(payloadsOf(db, 'node.failed')).toHaveLength(1);
    db.close();
  });
});
