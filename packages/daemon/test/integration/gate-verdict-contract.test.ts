/**
 * KAR-12.3 — the gate contract enforced at the boundary: against the real Ajv
 * 2020-12 validator compiled from the run's own `.DeFlow/schemas/`, the real
 * Tier-2 tokenizer and a real ledger file.
 *
 * Integration rather than unit for the usual reason: every claim is about
 * something durable or something real. *How many* `handoff.oversize` rows the
 * run has, that the payload stored on the failing arm is byte-identical to what
 * the agent sent, that six malformed verdicts are refused by Ajv rather than by
 * a hand-written check that happens to agree with Ajv on the cases somebody
 * thought of, and that a vendor that exhausted its own repair loop is not
 * repaired again.
 *
 * The transport half — the schema reaching the process on `--json-schema`, the
 * `error_max_structured_output_retries` subtype coming back off a real
 * envelope — is `packages/adapters/test/integration/gate-verdict-argv.test.ts`,
 * where a real process really is spawned.
 *
 * Verifies: EPIC-12-S19, EPIC-12-S20, EPIC-12-S21 · AC2, AC3, AC4 ·
 * test plan #6, #7
 */
import type { Db, NodeId, StructuredOutput } from '@DeFlow/core';
import { canonicalJson, VERDICT_V3_SCHEMA_ID } from '@DeFlow/core';
import { GATE_RETURN_BUDGET, gateVerdictContract } from '@DeFlow/gates';
import { openLedger, readRange } from '@DeFlow/ledger';
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import { enforceHandoff, type HandoffSession } from '../../src/handoff/enforce.ts';
import { writeRunSchemas } from '../../src/run-schemas.ts';
import { loadSchemaDirectory } from '../../src/schema-store.ts';
import { o200kTokenizer } from '../../src/tokens/tokenizer.ts';
import { IMPLEMENT, RETRY_RUN, seedRetryRun, T0 } from './support/retry-run.ts';

const BLOB = 'f'.repeat(40);
const CONTRACT = gateVerdictContract();

/**
 * A verdict with `count` findings, so a return can be put on either side of the
 * 600-token budget by construction.
 *
 * Measured with the Tier-2 tokenizer, one finding of this shape is about 52
 * tokens — and roughly a third of that is the 40-character `blobSha`. That is
 * worth knowing rather than hiding behind a round number: anchoring findings is
 * not free, and it is why 600 rather than the 300 a gate gets by default.
 */
function verdict(count: number, message = 'promise not awaited'): unknown {
  return {
    schemaId: VERDICT_V3_SCHEMA_ID,
    outcome: count === 0 ? 'pass' : 'fail',
    gate: 'lint',
    evaluatedNode: 'implement',
    by: { node: 'lint-gate', provider: 'claude-code', model: 'claude-sonnet-4-5' },
    criteria: [{ id: 'lint-clean', status: count === 0 ? 'satisfied' : 'unsatisfied' }],
    findings: Array.from({ length: count }, (_unused, index) => ({
      id: `f${String(index).padStart(11, '0')}`,
      severity: 'blocker',
      message: `no-floating-promises: ${message}`,
      evidence: [],
      location: { file: `src/api/c${index}.ts`, line: 42, blobSha: BLOB },
    })),
    summary: count === 0 ? 'lint passed' : `lint failed with ${count} finding(s)`,
    cost: { durationMs: 2400 },
  };
}

const present = (value: unknown): StructuredOutput => ({ present: true, value });

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

const oversizeEvents = (db: Db) =>
  readRange(db, RETRY_RUN, 0, 500)
    .events.filter((event) => event.kind === 'handoff.oversize')
    .map((event) => event.payload as Record<string, unknown>);

function enforce(
  tmp: string,
  db: Db,
  structuredOutput: StructuredOutput,
  session: HandoffSession,
  options: { readonly vendorRepairExhausted?: boolean } = {},
) {
  return enforceHandoff({
    db,
    runId: RETRY_RUN,
    node: IMPLEMENT as NodeId,
    nodeType: 'gate',
    attempt: 0,
    epoch: 1,
    ts: T0,
    contract: CONTRACT,
    structuredOutput,
    // The run's own directory, written the way run creation writes it — so
    // what validates here is the file a vendor CLI would have been handed.
    schemas: loadSchemaDirectory(writeRunSchemas(tmp)),
    tokenizer: o200kTokenizer(),
    session,
    ...options,
  });
}

suite('a gate return inside the 600-token budget (EPIC-12-S21, second scenario)', () => {
  it('is accepted with no re-prompt and no handoff.oversize', async ({ tmp }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);
    const session = scriptedSession();
    // Nine anchored findings measure ~548 tokens: findings-heavy, and inside
    // the headroom the 600 budget exists to provide.
    const heavy = verdict(9);

    const result = await enforce(tmp, db, present(heavy), session);

    expect(result.outcome).toBe('accepted');
    expect(result.tokens.estimated).toBeLessThan(GATE_RETURN_BUDGET);
    expect(session.prompts).toEqual([]);
    expect(oversizeEvents(db)).toEqual([]);
    db.close();
  });
});

suite('an oversize verdict (EPIC-12-S21, first scenario · test plan #6)', () => {
  it('emits handoff.oversize, re-prompts exactly once, then fails whole', async ({ tmp }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);
    // ~1,000 tokens against a 600 budget, then ~750 after the compression
    // re-prompt: still over, so the node fails whole rather than being cut.
    const big = verdict(18);
    const stillBig = verdict(13);
    const session = scriptedSession(present(stillBig));

    const result = await enforce(tmp, db, present(big), session);

    const events = oversizeEvents(db);
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ budget: GATE_RETURN_BUDGET, repairAttempted: false });
    expect(Number(events[0]?.actual)).toBeGreaterThan(GATE_RETURN_BUDGET);
    expect(events[1]).toMatchObject({ budget: GATE_RETURN_BUDGET, repairAttempted: true });

    expect(session.prompts.length).toBe(1);
    expect(session.prompts[0]).toContain(String(GATE_RETURN_BUDGET));
    expect(result.repairs).toBe(1);
    expect(result.outcome).toBe('failed');
    expect(result.failure?.deflowFailure.reason).toBe('contract.handoff-oversize');
    db.close();
  });

  it('stores the payload byte-identically: nothing is truncated on any arm', async ({ tmp }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);
    const stillBig = verdict(13);
    const session = scriptedSession(present(stillBig));

    const result = await enforce(tmp, db, present(verdict(18)), session);

    expect(canonicalJson(result.returned)).toBe(canonicalJson(stillBig));
    expect((result.returned as { findings: unknown[] }).findings.length).toBe(13);
    db.close();
  });
});

suite('six malformed verdicts (EPIC-12-S19 · test plan #4)', () => {
  const prose = 'The code looks fine to me, though the guard could be tidier.';

  const cases: readonly (readonly [string, unknown, string])[] = [
    ['a prose paragraph', prose, ''],
    ['{ outcome: "ok" }', { outcome: 'ok' }, '/outcome'],
    [
      'findings as an array of strings',
      { ...(verdict(0) as object), findings: ['the guard is wrong'] },
      '/findings/0',
    ],
    [
      'a Finding with severity "critical"',
      {
        ...(verdict(1) as object),
        findings: [
          {
            id: 'f00000000000',
            severity: 'critical',
            message: 'unsupported severity',
            evidence: [],
            location: { file: 'a.ts', line: 1, blobSha: BLOB },
          },
        ],
      },
      '/findings/0/severity',
    ],
    [
      'a Finding with a range but no blobSha',
      {
        ...(verdict(1) as object),
        findings: [
          {
            id: 'f00000000000',
            severity: 'blocker',
            message: 'unanchored',
            evidence: [],
            location: { file: 'a.ts', line: 1 },
          },
        ],
      },
      '/findings/0/location/blobSha',
    ],
    [
      'a verdict missing the criteria array',
      (() => {
        const { criteria: _dropped, ...rest } = verdict(0) as Record<string, unknown>;
        return rest;
      })(),
      '/criteria',
    ],
  ];

  for (const [name, payload, pointer] of cases) {
    it(`${name} fails the node with contract.schema-invalid`, async ({ tmp }) => {
      const db = openLedger(tmp);
      seedRetryRun(db);
      // The single repair is already spent, so this is the failing arm rather
      // than the repair arm — what is under test is the refusal, not the loop.
      const result = await enforceHandoff({
        db,
        runId: RETRY_RUN,
        node: IMPLEMENT as NodeId,
        nodeType: 'gate',
        attempt: 0,
        epoch: 1,
        ts: T0,
        contract: CONTRACT,
        structuredOutput: present(payload),
        schemas: loadSchemaDirectory(writeRunSchemas(tmp)),
        tokenizer: o200kTokenizer(),
        session: scriptedSession(present(payload)),
      });

      expect(result.outcome).toBe('failed');
      expect(result.failure?.deflowFailure.reason).toBe('contract.schema-invalid');
      if (pointer !== '') {
        expect(result.issues.map((issue) => issue.pointer)).toContain(pointer);
      }
      db.close();
    });
  }

  it('carries every Ajv error, not only the first (AC2)', async ({ tmp }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);
    const wrongInFourPlaces = {
      ...(verdict(1) as object),
      outcome: 'ok',
      criteria: [{ id: 'lint-clean', status: 'probably' }],
      findings: [
        {
          id: 'f00000000000',
          severity: 'critical',
          message: 'wrong in several ways at once',
          evidence: [],
          location: { file: 'a.ts', line: 1 },
        },
      ],
    };

    const result = await enforceHandoff({
      db,
      runId: RETRY_RUN,
      node: IMPLEMENT as NodeId,
      nodeType: 'gate',
      attempt: 0,
      epoch: 1,
      ts: T0,
      contract: CONTRACT,
      structuredOutput: present(wrongInFourPlaces),
      schemas: loadSchemaDirectory(writeRunSchemas(tmp)),
      tokenizer: o200kTokenizer(),
      session: scriptedSession(present(wrongInFourPlaces)),
    });

    const pointers = result.issues.map((issue) => issue.pointer);
    expect(pointers).toContain('/outcome');
    expect(pointers).toContain('/criteria/0/status');
    expect(pointers).toContain('/findings/0/severity');
    expect(pointers).toContain('/findings/0/location/blobSha');
    // The failure message is what the node inspector shows, and it shows all of
    // them: one round trip per error is how a repair loop becomes four.
    expect(result.failure?.message).toContain('/outcome');
    expect(result.failure?.message).toContain('/findings/0/severity');
    db.close();
  });
});

suite('the vendor already exhausted its own repair loop (EPIC-12-S20 · test plan #7)', () => {
  it('fails with agent.schema-repair-exhausted and repairs nothing further', async ({ tmp }) => {
    const db = openLedger(tmp);
    seedRetryRun(db);
    const session = scriptedSession();

    const result = await enforce(tmp, db, { present: false }, session, {
      vendorRepairExhausted: true,
    });

    expect(result.outcome).toBe('failed');
    expect(result.failure?.deflowFailure.reason).toBe('agent.schema-repair-exhausted');
    expect(result.failure?.deflowFailure.class).toBe('permanent');
    expect(result.repairs).toBe(0);
    expect(session.prompts).toEqual([]);
    expect(oversizeEvents(db)).toEqual([]);
    db.close();
  });
});
