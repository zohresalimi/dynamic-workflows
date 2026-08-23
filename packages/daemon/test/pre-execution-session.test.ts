/**
 * KAR-19.13 AC1, AC2, AC7 / EPIC-19-S84 (the outline), EPIC-19-S85 (the offline
 * recomputation) — the vendor session a re-advanced pre-execution turn opens.
 *
 * The arithmetic below is the diagnosis rather than colour. On 2026-08-16 run
 * `run_20260816T194933Z_839b9b` died inside `compilePlanV1` with
 *
 * ```
 * Session ID 5f2b8935-25e5-5c1c-83c6-a97d1b151f08 is already in use
 * ```
 *
 * and that value is exactly `vendorSessionId({ runId, nodeId: 'planner',
 * attempt: 0 })`. The planner turn asked the vendor for its **first** session
 * twice, because `live-chain.ts` pinned `PRE_EXECUTION_ATTEMPT = 0`. So the
 * unit under test is the derivation's *tuple*: one id per turn already
 * recorded, still derived rather than minted.
 *
 * The ledger half — that the count comes from the ledger and not from a number
 * in a process — is `test/integration/pre-execution-session.test.ts`, because a
 * daemon restart is a second process and nothing smaller can show one.
 *
 * Verifies: EPIC-19-S84, EPIC-19-S85 · KAR-19.13 AC1, AC2, AC7
 */
import { type SessionIdSpec, vendorSessionId } from '@DeFlow/adapters';
import { RunIdSchema } from '@DeFlow/core';
import { readFileSync } from 'node:fs';
import { expect, it, describe as suite } from 'vitest';
import {
  PRE_EXECUTION_NODES,
  preExecutionSessionId,
} from '../src/pipeline/pre-execution-session.ts';

/** The run from the 2026-08-16 log, verbatim — the id an operator greps for. */
const RUN = RunIdSchema.parse('run_20260816T194933Z_839b9b');

/** The id the vendor refused, and the reason it could be refused at all. */
const THE_SPENT_ID = '5f2b8935-25e5-5c1c-83c6-a97d1b151f08';

/** A vendor whose `--session-id` creates and never attaches — Claude Code's,
 * as the registry declares it. Written as a value rather than read from
 * `PROVIDER_SPECS` so this file asserts the *rule* and `test/session-id-registry`
 * asserts the table. */
const CREATE_ONLY: SessionIdSpec = {
  flag: '--session-id',
  form: 'uuid',
  reuse: 'create-only',
  reuseProvenance: { how: 'executed', on: '2026-08-16', note: 'refused an id it had created' },
};

const MAY_ATTACH: SessionIdSpec = {
  ...CREATE_ONLY,
  reuse: 'may-attach',
  reuseProvenance: { how: 'help', on: '2026-08-16' },
};

const TURNS = ['framing', 'recon', 'planner'] as const;

suite('KAR-19.13 AC1 — the turn already recorded is in the tuple', () => {
  it('does not hand the planner the id the vendor spent on 2026-08-16', () => {
    const first = preExecutionSessionId({
      runId: RUN,
      nodeId: PRE_EXECUTION_NODES.planner,
      turnsRecorded: 0,
      sessionId: CREATE_ONLY,
    });
    const second = preExecutionSessionId({
      runId: RUN,
      nodeId: PRE_EXECUTION_NODES.planner,
      turnsRecorded: 1,
      sessionId: CREATE_ONLY,
    });

    expect(first).toBe(THE_SPENT_ID);
    expect(second).not.toBe(THE_SPENT_ID);
  });

  it.each(TURNS)(
    'derives a distinct id per recorded turn for the %s turn, not just the one that failed',
    (turn) => {
      const nodeId = PRE_EXECUTION_NODES[turn];
      const ids = [0, 1, 3].map((turnsRecorded) =>
        preExecutionSessionId({ runId: RUN, nodeId, turnsRecorded, sessionId: CREATE_ONLY }),
      );

      expect(new Set(ids).size).toBe(3);
      for (const [index, turnsRecorded] of [0, 1, 3].entries()) {
        expect(ids[index]).toBe(vendorSessionId({ runId: RUN, nodeId, attempt: turnsRecorded }));
      }
    },
  );
});

suite('KAR-19.13 AC7 — the create-only fact is read, not the vendor’s name', () => {
  it('keeps the turn in the tuple only because the flag can only create', () => {
    const key = { runId: RUN, nodeId: PRE_EXECUTION_NODES.framing, turnsRecorded: 2 } as const;

    // A flag that may legitimately be presented twice is the one case where
    // re-presenting the first turn's id is a continuation rather than a
    // collision — and it is a declaration in `PROVIDER_SPECS`, never a name.
    expect(preExecutionSessionId({ ...key, sessionId: MAY_ATTACH })).toBe(
      preExecutionSessionId({ ...key, turnsRecorded: 0, sessionId: MAY_ATTACH }),
    );
    expect(preExecutionSessionId({ ...key, sessionId: CREATE_ONLY })).not.toBe(
      preExecutionSessionId({ ...key, turnsRecorded: 0, sessionId: CREATE_ONLY }),
    );
  });

  it('treats an entry that declares nothing as one that cannot be re-presented', () => {
    const key = { runId: RUN, nodeId: PRE_EXECUTION_NODES.recon } as const;

    // The safe direction: an undeclared flag gets a fresh session per turn,
    // which costs a transcript handle and never wedges a run.
    expect(preExecutionSessionId({ ...key, turnsRecorded: 1 })).not.toBe(
      preExecutionSessionId({ ...key, turnsRecorded: 0 }),
    );
  });
});

suite('KAR-19.13 AC2 — derived, never minted', () => {
  const source = readFileSync(
    new URL('../src/pipeline/pre-execution-session.ts', import.meta.url),
    'utf8',
  );
  /** Comments removed: the prose above quotes the value that broke. */
  const code = source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  it.each([
    'randomUUID',
    'Math.random',
    'Date.now',
    'new Date',
    'process.env',
    'getRandomValues',
    'let ',
  ])('reads no %s', (forbidden) => {
    // `let` as well as the random sources: a module-level counter is the other
    // way to satisfy AC1 and fail AC2, and it is the one a daemon restart
    // resets to the value that collides.
    expect(code).not.toContain(forbidden);
  });

  it('names no vendor, so the next vendor is answered by the table', () => {
    expect(code.toLowerCase()).not.toMatch(/claude|gemini|codex|copilot/);
  });
});
