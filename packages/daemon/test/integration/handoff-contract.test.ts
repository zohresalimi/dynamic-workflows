/**
 * KAR-09.9 — the bounded repair loop, end to end, against a real ledger file,
 * the real Ajv2020 validator over the repository's emitted schemas, and the
 * real Tier-2 tokenizer.
 *
 * Integration rather than unit because every claim here is about something
 * durable or something real: *how many* `handoff.oversize` rows a run has, that
 * the second one says the repair was spent, that a failed handoff leaves the
 * `fact` table untouched, and that a return which does not satisfy
 * `DeFlow.finding.v1` is refused by Ajv rather than by a hand-written check
 * that agrees with Ajv on the cases somebody thought of.
 *
 * The "session" is a port with a scripted queue — the repair is one further
 * turn on a live session, and what this file is testing is the *loop*, not the
 * transport. The transport half (the schema reaching the process on
 * `--json-schema`, `structured_output` coming back) is
 * `packages/adapters/test/integration/structured-output.test.ts`, where a real
 * process really is spawned.
 *
 * Verifies: EPIC-09-S46, EPIC-09-S47, EPIC-09-S48, EPIC-09-S49 · AC4, AC5,
 * AC6, AC7, AC8, AC9 · test plan #5, #6, #7, #9
 */
import type { Db, NodeId, StructuredOutput } from '@DeFlow/core';
import { handoffOversizeRates } from '@DeFlow/core';
import { openLedger, readFacts, readRange } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { enforceHandoff, type HandoffSession } from '../../src/handoff/enforce.ts';
import { loadSchemaDirectory } from '../../src/schema-store.ts';
import { o200kTokenizer } from '../../src/tokens/tokenizer.ts';
import { IMPLEMENT, RETRY_RUN, seedRetryRun, T0 } from './support/retry-run.ts';

/** The repository's own emitted documents — the same bytes `deflow init`
 * copies into a run's `.DeFlow/schemas/`. */
const SCHEMAS_DIR = fileURLToPath(new URL('../../../../schemas/', import.meta.url));

const CONTRACT = { schemaId: 'DeFlow.finding.v1' as never, maxTokens: 1500 };

/** A `DeFlow.finding.v1` whose `message` is `words` repetitions long, so a
 * return can be put on either side of a budget by construction. */
function finding(words: number): Record<string, unknown> {
  return {
    id: 'f-1',
    severity: 'major',
    message: `the session cookie is set without the Secure attribute. ${'detail '.repeat(words)}`,
    evidence: [],
  };
}

const present = (value: unknown): StructuredOutput => ({ present: true, value });

/** A session that hands back the scripted returns in order, and records how
 * many times it was asked. */
function scriptedSession(...returns: readonly StructuredOutput[]): HandoffSession & {
  readonly prompts: string[];
} {
  const prompts: string[] = [];
  let at = 0;
  return {
    prompts,
    repair(prompt: string) {
      prompts.push(prompt);
      const next = returns[at];
      at += 1;
      if (next === undefined) throw new Error('the session was asked for an unscripted repair');
      return Promise.resolve(next);
    },
  };
}

const events = (db: Db) => readRange(db, RETRY_RUN, 0, 500).events;
const oversizeEvents = (db: Db) =>
  events(db)
    .filter((event) => event.kind === 'handoff.oversize')
    .map((event) => event.payload as Record<string, unknown>);

function enforce(
  db: Db,
  structuredOutput: StructuredOutput,
  session: HandoffSession,
  contract = CONTRACT,
) {
  return enforceHandoff({
    db,
    runId: RETRY_RUN,
    node: IMPLEMENT as NodeId,
    nodeType: 'agent',
    attempt: 0,
    epoch: 1,
    ts: T0,
    contract,
    structuredOutput,
    schemas: loadSchemaDirectory(SCHEMAS_DIR),
    tokenizer: o200kTokenizer(),
    session,
  });
}

suite('a native structured return inside budget (EPIC-09-S46)', () => {
  it('is accepted, measured with the Tier-2 tokenizer, and appends no event', async ({ tmp }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);
    const session = scriptedSession();

    const result = await enforce(db, present(finding(2)), session);

    expect(result.outcome).toBe('accepted');
    expect(result.returned).toEqual(finding(2));
    expect(result.tokens.method).toBe('gpt-tokenizer/o200k_base');
    expect(result.tokens.estimated).toBeGreaterThan(0);
    expect(result.tokens.estimated).toBeLessThan(CONTRACT.maxTokens);
    expect(oversizeEvents(db)).toEqual([]);
    expect(session.prompts).toEqual([]);
    db.close();
  });
});

suite('one repair, then it fits (EPIC-09-S47 · test plan #5)', () => {
  it('appends handoff.oversize with repairAttempted false, repairs once, accepts', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);
    const session = scriptedSession(present(finding(2)));
    const budget = { ...CONTRACT, maxTokens: 200 };

    const result = await enforce(db, present(finding(400)), session, budget);

    expect(result.outcome).toBe('accepted');
    expect(result.repairs).toBe(1);
    expect(session.prompts).toHaveLength(1);
    expect(session.prompts[0]).toContain('200');

    const oversize = oversizeEvents(db);
    expect(oversize).toHaveLength(1);
    expect(oversize[0]).toMatchObject({
      node: IMPLEMENT,
      attempt: 0,
      budget: 200,
      repairAttempted: false,
    });
    expect(oversize[0]?.actual as number).toBeGreaterThan(200);
    db.close();
  });

  it('does not count the repair as a node retry attempt', async ({ tmp }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);

    await enforce(db, present(finding(400)), scriptedSession(present(finding(2))), {
      ...CONTRACT,
      maxTokens: 200,
    });

    expect(events(db).map((event) => event.kind)).not.toContain('node.retry.scheduled');
    expect(events(db).filter((event) => event.kind === 'node.started')).toHaveLength(7);
    db.close();
  });
});

suite('still oversize after the repair (EPIC-09-S48 · test plan #6)', () => {
  it('appends a second event saying the repair was spent, and fails the node', async ({ tmp }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);
    const session = scriptedSession(present(finding(300)));

    const result = await enforce(db, present(finding(400)), session, {
      ...CONTRACT,
      maxTokens: 200,
    });

    expect(result.outcome).toBe('failed');
    expect(result.failure?.deflowFailure.reason).toBe('contract.handoff-oversize');

    const oversize = oversizeEvents(db);
    expect(oversize).toHaveLength(2);
    expect(oversize.map((payload) => payload.repairAttempted)).toEqual([false, true]);
    db.close();
  });

  it('carries the FULL repaired return, not a prefix', async ({ tmp }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);
    const repaired = finding(300);

    const result = await enforce(db, present(finding(400)), scriptedSession(present(repaired)), {
      ...CONTRACT,
      maxTokens: 200,
    });

    expect(result.returned).toEqual(repaired);
    db.close();
  });

  it('sends no second repair prompt under any circumstances', async ({ tmp }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);
    // One scripted return, and the session throws if asked twice.
    const session = scriptedSession(present(finding(300)));

    await enforce(db, present(finding(400)), session, { ...CONTRACT, maxTokens: 200 });

    expect(session.prompts).toHaveLength(1);
    db.close();
  });

  it('writes no fact, so nothing invalid reaches the blackboard (test plan #9)', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);

    await enforce(db, present(finding(400)), scriptedSession(present(finding(300))), {
      ...CONTRACT,
      maxTokens: 200,
    });

    expect(readFacts(db, RETRY_RUN)).toEqual([]);
    db.close();
  });
});

suite('a schema-invalid return (AC8 · test plan #9)', () => {
  it('is repaired once and then fails, with every Ajv violation reported', async ({ tmp }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);
    // Missing `severity` and `evidence`, and `id` is the wrong type: three
    // violations, which `allErrors: true` is what makes visible at once.
    const broken = { id: 7, message: 'something' };

    const result = await enforce(db, present(broken), scriptedSession(present(broken)));

    expect(result.outcome).toBe('failed');
    expect(result.failure?.deflowFailure.reason).toBe('contract.schema-invalid');
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
    expect(result.repairs).toBe(1);
    expect(readFacts(db, RETRY_RUN)).toEqual([]);
    // A schema failure is not an oversize failure, and the ledger says so by
    // having nothing to say about the size.
    expect(oversizeEvents(db)).toEqual([]);
    db.close();
  });

  it('accepts the repaired return when the repair fixed it', async ({ tmp }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);

    const result = await enforce(
      db,
      present({ id: 7, message: 'something' }),
      scriptedSession(present(finding(2))),
    );

    expect(result.outcome).toBe('accepted');
    expect(result.returned).toEqual(finding(2));
    db.close();
  });
});

suite('the vendor’s exhausted repair loop is not retried on top of (EPIC-09-S49)', () => {
  it('fails with agent.schema-repair-exhausted and asks for zero DeFlow repairs', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);
    const session = scriptedSession();

    const result = await enforceHandoff({
      db,
      runId: RETRY_RUN,
      node: IMPLEMENT as NodeId,
      nodeType: 'agent',
      attempt: 0,
      epoch: 1,
      ts: T0,
      contract: CONTRACT,
      // What the adapter mapped `error_max_structured_output_retries` to.
      vendorRepairExhausted: true,
      structuredOutput: { present: false },
      schemas: loadSchemaDirectory(SCHEMAS_DIR),
      tokenizer: o200kTokenizer(),
      session,
    });

    expect(result.outcome).toBe('failed');
    expect(result.failure?.deflowFailure.reason).toBe('agent.schema-repair-exhausted');
    expect(result.repairs).toBe(0);
    expect(session.prompts).toEqual([]);
    expect(oversizeEvents(db)).toEqual([]);
    // Exactly one attempt for that node in the ledger — the seed's own
    // `node.started`, and nothing this path added.
    expect(
      events(db).filter(
        (event) => event.kind === 'node.started' && event.nodeId === (IMPLEMENT as string),
      ),
    ).toHaveLength(1);
    db.close();
  });

  it('is a different reason from DeFlow’s own oversize failure', async ({ tmp }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);

    const ours = await enforce(db, present(finding(400)), scriptedSession(present(finding(300))), {
      ...CONTRACT,
      maxTokens: 200,
    });

    expect(ours.failure?.deflowFailure.reason).toBe('contract.handoff-oversize');
    expect(ours.failure?.deflowFailure.reason).not.toBe('agent.schema-repair-exhausted');
    db.close();
  });
});

suite('the oversize rate per node type is measurable afterwards (AC9)', () => {
  it('emits one sample per handoff, so the rate has a denominator', async ({ tmp }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);
    const budget = { ...CONTRACT, maxTokens: 200 };

    const fits = await enforce(db, present(finding(2)), scriptedSession(), budget);
    const over = await enforce(
      db,
      present(finding(400)),
      scriptedSession(present(finding(300))),
      budget,
    );

    expect(fits.sample).toEqual({ nodeType: 'agent', oversize: false });
    expect(over.sample).toEqual({ nodeType: 'agent', oversize: true });
    // Two handoffs, one of them oversize — a numerator read off the events
    // alone would have said 100%.
    expect(handoffOversizeRates([fits.sample, over.sample])).toEqual([
      { nodeType: 'agent', handoffs: 2, oversize: 1, rate: 0.5 },
    ]);
    db.close();
  });
});

suite('an absent structured_output on a successful turn', () => {
  it('is a contract failure with a clear message, never an empty object', async ({ tmp }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);
    const session = scriptedSession({ present: false });

    const result = await enforce(db, { present: false }, session);

    expect(result.outcome).toBe('failed');
    expect(result.failure?.deflowFailure.reason).toBe('contract.schema-invalid');
    expect(result.failure?.message).toContain('structured_output');
    expect(result.returned).toBeUndefined();
    expect(readFacts(db, RETRY_RUN)).toEqual([]);
    db.close();
  });
});
