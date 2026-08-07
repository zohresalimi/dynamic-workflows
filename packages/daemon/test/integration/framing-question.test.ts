/**
 * KAR-10.2 AC7, AC8 — the interview is genuinely an interview.
 *
 * The framing agent may block for operator input mid-interview, and what makes
 * that affordable is that the wait is a **row**: one `node_wake` with
 * `reason = 'human_gate'`, which costs the same whether the operator answers in
 * six seconds or six hours. Integration rather than unit for exactly that
 * reason — the claim is about a durable row and a real ledger, not about a
 * branch.
 *
 * The second half is about honesty. An answer delivered into the live session
 * and an answer replayed into a fresh one are different events, and
 * [11 §7.5](../../../../docs/11-api-and-realtime.md) is explicit that the UI
 * *"must render that honestly rather than showing a delivered guidance bubble
 * that never arrived"*. So the delivery is reported as what it was, and the
 * ledger says which.
 *
 * Verifies: EPIC-10-S7 · AC7, AC8 · test plan #6, #7
 */
import { shimCapabilityRow } from '@DeFlow/adapters';
import type { Db, NodeId, RunId, StructuredOutput } from '@DeFlow/core';
import {
  buildFramingPacket,
  HandleSchema,
  NodeIdSchema,
  RunIdSchema,
  SPEC_GATE_NODE,
} from '@DeFlow/core';
import {
  appendEvents,
  dueWakes,
  openLedger,
  readRange,
  readWakes,
  replayAll,
} from '@DeFlow/ledger';
import { it, makeRepo, TestClock } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import {
  answerFramingQuestion,
  type FramingAgent,
  type FramingQuestion,
  type FramingSession,
  type FramingTurn,
  gitRepoState,
  runFramingInterview,
} from '../../src/framing/interview.ts';
import { Git } from '../../src/git/git.ts';
import { loadSchemaDirectory } from '../../src/schema-store.ts';
import { o200kTokenizer } from '../../src/tokens/tokenizer.ts';

const SCHEMAS_DIR = fileURLToPath(new URL('../../../../schemas/', import.meta.url));

const RUN: RunId = RunIdSchema.parse('run_20260807T101500Z_ac1007');
const FRAMING: NodeId = NodeIdSchema.parse('framing');
const T0 = 1_754_380_800_000;
const HOURS = 3_600_000;
const PROVIDER = 'claude';

const RAW_TASK = 'Migrate the design system';

const QUESTION: FramingQuestion = {
  prompt: 'Which packages are in scope? The task names none.',
  options: [
    { id: 'answer', label: 'Answer', effect: 'inject' },
    { id: 'abandon', label: 'Abandon the run', effect: 'reject' },
  ],
  // Well beyond the six hours the third scenario advances, so a row that is
  // still there is a row that has not come due rather than one nobody polled.
  deadline: new Date(T0 + 7 * 24 * HOURS).toISOString(),
};

const ANSWER = 'Only packages/ui and packages/forms. Leave packages/legacy alone.';

function draft(): Record<string, unknown> {
  return {
    schemaId: 'DeFlow.taskspecdraft.v1',
    goal: 'Migrate packages/ui and packages/forms to the new design system.',
    scope: { included: ['packages/ui', 'packages/forms'] },
    nonGoals: ['Leave packages/legacy alone.'],
    constraints: [],
    priorDecisions: [],
    acceptanceCriteria: [
      { id: 'ac-1', statement: 'pnpm typecheck passes.', verifiedBy: ['typecheck'] },
    ],
    knownFailureModes: [
      {
        id: 'fm-1',
        description: 'A legacy import is rewritten by accident.',
        detection: 'git diff touches packages/legacy.',
      },
    ],
  };
}

const present = (value: unknown): StructuredOutput => ({ present: true, value });

const asking: FramingTurn = { question: QUESTION, structuredOutput: { present: false } };
const answering = (): FramingTurn => ({ question: null, structuredOutput: present(draft()) });

interface Scripted extends FramingSession {
  readonly prompts: string[];
}

function session(steerable: boolean, ...turns: readonly FramingTurn[]): Scripted {
  const prompts: string[] = [];
  let at = 0;
  return {
    prompts,
    steerable,
    answer(text: string) {
      prompts.push(text);
      const next = turns[at];
      at += 1;
      if (next === undefined)
        throw new Error('the framing session was asked for an unscripted turn');
      return Promise.resolve(next);
    },
    repair() {
      throw new Error('this suite scripts no repairs');
    },
  };
}

/** An agent whose successive `open()` calls answer with successive turns, so a
 * replay really does start a second session rather than reusing the first. */
function agentOf(
  sessions: readonly Scripted[],
  turns: readonly FramingTurn[],
): FramingAgent & { readonly opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    open(prompt: string) {
      const index = opened.length;
      opened.push(prompt);
      const next = sessions[index];
      const turn = turns[index];
      if (next === undefined || turn === undefined) {
        throw new Error('the framing agent was asked to open an unscripted session');
      }
      return Promise.resolve({ session: next, turn });
    },
  };
}

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
        provenance: { kind: 'text', by: 'ui', submittedAt: T0 },
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

async function harness(tmp: string, agent: FramingAgent) {
  const repoDir = join(tmp, 'repo');
  await makeRepo({ dir: repoDir });
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
  });

  const common = {
    db,
    runId: RUN,
    node: FRAMING,
    attempt: 0,
    epoch: 1,
    provider: PROVIDER,
    capabilityRow: CAPABILITY_ROW,
    packet,
    schemas: loadSchemaDirectory(SCHEMAS_DIR),
    tokenizer: o200kTokenizer(),
    agent,
    readRepo: () => gitRepoState(new Git(repoDir), repoDir),
    captureEvidence: () => HandleSchema.parse(`artifact://${'c'.repeat(64)}`),
  };

  return { db, packet, common };
}

const events = (db: Db) => readRange(db, RUN, 0, 500).events;
const payloadsOf = (db: Db, kind: string) =>
  events(db)
    .filter((event) => event.kind === kind)
    .map((event) => event.payload as Record<string, unknown>);

suite('EPIC-10-S7 — the run suspends on the question and resumes on the answer', () => {
  it('appends human.requested and exactly one human_gate row', async ({ tmp }) => {
    const live = session(true);
    const agent = agentOf([live], [asking]);
    const { db, common } = await harness(tmp, agent);

    const outcome = await runFramingInterview({ ...common, ts: T0 });

    expect(outcome.outcome).toBe('suspended');
    if (outcome.outcome !== 'suspended') return;
    expect(outcome.question.prompt).toBe(QUESTION.prompt);

    const requested = payloadsOf(db, 'human.requested');
    expect(requested).toHaveLength(1);
    expect(requested[0]?.prompt).toBe(QUESTION.prompt);
    expect(requested[0]?.options).toEqual(QUESTION.options);

    expect(readWakes(db, RUN)).toEqual([
      { runId: RUN, nodeId: FRAMING, wakeAt: Date.parse(QUESTION.deadline), reason: 'human_gate' },
    ]);
    // Nothing was sent to the agent while it waits.
    expect(live.prompts).toEqual([]);
    expect(payloadsOf(db, 'run.created')).toEqual([]);
    db.close();
  });

  it('is still suspended, and still one row, after six unanswered hours', async ({ tmp }) => {
    const live = session(true);
    const agent = agentOf([live], [asking]);
    const { db, common } = await harness(tmp, agent);
    const clock = new TestClock(T0);

    await runFramingInterview({ ...common, ts: clock.now() });
    await clock.advance(6 * HOURS);

    // No timeout fired: the ticker's whole per-tick input is this query, and it
    // is empty for every one of those 21,600 ticks.
    expect(dueWakes(db, clock.now())).toEqual([]);
    expect(readWakes(db, RUN)).toHaveLength(1);
    expect(replayAll(db).runs.get(RUN)?.nodes[FRAMING]?.status).toBe('suspended');
    expect(payloadsOf(db, 'node.failed')).toEqual([]);
    db.close();
  });

  it('steers the answer into the same session and records it as a priorDecision', async ({
    tmp,
  }) => {
    const live = session(true, answering());
    const agent = agentOf([live], [asking]);
    const { db, common } = await harness(tmp, agent);

    const suspended = await runFramingInterview({ ...common, ts: T0 });
    expect(suspended.outcome).toBe('suspended');
    if (suspended.outcome !== 'suspended') return;

    const resumed = await answerFramingQuestion({
      ...common,
      ts: T0 + 90_000,
      session: suspended.session,
      question: suspended.question,
      answer: { optionId: 'answer', text: ANSWER },
    });

    expect(resumed.delivery).toBe('steered');
    expect(live.prompts).toEqual([ANSWER]);
    // The clarifying question's wake is consumed in the same transaction as the
    // response. The row that is left is the F1.3 approval gate's: the interview
    // completed, so KAR-10.3's gate opened in the same transaction as
    // `run.created` and the run is now waiting on the operator, not on the agent.
    expect(readWakes(db, RUN).map((row) => row.nodeId)).toEqual([SPEC_GATE_NODE]);

    const responded = payloadsOf(db, 'human.responded');
    expect(responded).toHaveLength(1);
    expect(responded[0]?.text).toBe(ANSWER);

    expect(resumed.outcome).toBe('completed');
    if (resumed.outcome !== 'completed') return;
    // AC8: the answer is in the spec *and* in the ledger, independently.
    expect(resumed.spec.nonGoals.join(' ')).toContain('packages/legacy');
    const operator = resumed.spec.priorDecisions.find((decision) =>
      decision.decision.includes('packages/legacy'),
    );
    expect(operator?.decision).toBe(ANSWER);
    expect(operator?.rationale).toContain(QUESTION.prompt);
    expect(payloadsOf(db, 'run.created')).toHaveLength(1);
    db.close();
  });

  it('replays into a fresh session when the adapter cannot steer, and says so', async ({ tmp }) => {
    const first = session(false);
    const second = session(false);
    const agent = agentOf([first, second], [asking, answering()]);
    const { db, common } = await harness(tmp, agent);

    const suspended = await runFramingInterview({ ...common, ts: T0 });
    expect(suspended.outcome).toBe('suspended');
    if (suspended.outcome !== 'suspended') return;

    const resumed = await answerFramingQuestion({
      ...common,
      ts: T0 + 90_000,
      session: suspended.session,
      question: suspended.question,
      answer: { optionId: 'answer', text: ANSWER },
    });

    // Never reported as delivered when it was in fact a replay.
    expect(resumed.delivery).toBe('replayed');
    expect(first.prompts).toEqual([]);
    expect(agent.opened).toHaveLength(2);
    // The question and the answer are both replayed into the new packet.
    expect(agent.opened[1]).toContain(QUESTION.prompt);
    expect(agent.opened[1]).toContain(ANSWER);

    const progress = payloadsOf(db, 'node.progress');
    expect(progress.map((entry) => entry.phase)).toContain('framing.answer-replayed');
    expect(progress.map((entry) => entry.phase)).not.toContain('framing.answer-steered');

    expect(resumed.outcome).toBe('completed');
    if (resumed.outcome !== 'completed') return;
    expect(resumed.spec.priorDecisions.some((decision) => decision.decision === ANSWER)).toBe(true);
    db.close();
  });
});
