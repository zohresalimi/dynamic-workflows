/**
 * KAR-14.4 AC1 — EPIC-14-S28: the ACP path normalises a rate limit to the same
 * `provider.rate_limited { provider, resetsAt?, raw }` the shim path produces.
 *
 * The shim half of AC1 has a verified vendor frame behind it. This half does
 * not: ACP assigns no rate-limit code, and whether any adapter surfaces quota
 * state at all is **Unverified** (roadmap A0-3's sibling question). So the
 * signal here is a JSON-RPC error code the *caller* declared, exactly as
 * `rateLimitExitCodes` works on the shim, and the assertions below are as much
 * about what DeFlow refuses to infer as about what it parses:
 *
 *   - an undeclared error is not promoted to a quota;
 *   - a code ACP has already taken cannot be declared at all, and the refusal
 *     lands before a process exists;
 *   - `resetsAt` comes from the vendor's own payload or is absent. Never
 *     invented, and `raw` keeps the payload verbatim either way.
 *
 * A real child process over a real pipe, a real file-backed ledger, no mocks.
 *
 * Verifies: EPIC-14-S28 · AC1, AC9
 */
import {
  describeRateLimit,
  type NodeId,
  ProviderIdSchema,
  type RunId,
  rateLimitOf,
} from '@DeFlow/core';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import type { AcpNodeOutcome, NodeWakeRow } from '../../src/index.ts';
import { runAcpNode } from '../../src/index.ts';
import { NODE_ID, openTestLedger, PROVIDER, RUN_ID, type TestLedger } from './support/harness.ts';

const AGENT = fileURLToPath(new URL('./support/rate-limited-agent.ts', import.meta.url));

/**
 * Inside JSON-RPC's implementation-defined server range and not a code ACP has
 * taken. It is the fixture's datum, not a table `@DeFlow/adapters` ships — no
 * adapter has been observed to answer with it, which is the point of AC1's
 * degradation note.
 */
const DECLARED = -32_042;
/** Epoch **seconds**, as the one verified vendor spelling puts it on the wire. */
const RESETS_AT_SECONDS = 1_800_014_400;
const RESETS_AT_MS = RESETS_AT_SECONDS * 1000;

let dir = '';
let worktree = '';
let ledger: TestLedger;

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', 'n1');
  await mkdir(worktree, { recursive: true });
  ledger = openTestLedger(dir);
});

afterEach(async () => {
  ledger.close();
  await removeTempDir(dir);
});

interface Run {
  readonly outcome: AcpNodeOutcome;
  readonly wakes: readonly NodeWakeRow[];
  /** Every method the agent was asked for, or `null` when it never ran. */
  readonly methods: readonly string[] | null;
}

async function runAgainst(options: {
  readonly agentArgv: readonly string[];
  readonly declare: readonly number[];
  readonly tag: string;
}): Promise<Run> {
  const methodLog = join(dir, `methods-${options.tag}.log`);
  const wakes: NodeWakeRow[] = [];
  const outcome = await runAcpNode(
    {
      runId: RUN_ID as RunId,
      nodeId: NODE_ID as NodeId,
      attempt: 0,
      provider: PROVIDER,
      permission: 'read',
      worktree,
      // Run through the current Node binary, so the fixture needs no execute
      // bit to be a real child process.
      binary: { path: process.execPath, version: process.version, sha256: 'a'.repeat(64) },
      argv: [AGENT, ...options.agentArgv],
      env: { ...process.env, DeFlow_RATE_LIMIT_LOG: methodLog },
      mcpServers: [],
      prompt: 'hello',
      rateLimitErrorCodes: options.declare,
    },
    {
      clock: new TestClock(),
      ledger: ledger.sink,
      captureEvidence: ledger.captureEvidence,
      wakes: {
        schedule: async (row) => {
          wakes.push(row);
        },
      },
    },
  );
  return {
    outcome,
    wakes,
    methods: existsSync(methodLog)
      ? readFileSync(methodLog, 'utf8').split('\n').filter(Boolean)
      : null,
  };
}

suite('a declared rate-limit error carrying the vendor’s own reset (AC1)', () => {
  it('normalises to provider.rate_limited and suspends at that exact instant', async () => {
    const { outcome, wakes } = await runAgainst({
      agentArgv: ['--code', `${DECLARED}`, '--resets-at', `${RESETS_AT_SECONDS}`],
      declare: [DECLARED],
      tag: 'reset',
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;

    // AC9: transient, and assigned where the failure was constructed.
    expect(outcome.failure.reason).toBe('provider.rate-limited');
    expect(outcome.failure.class).toBe('transient');
    // The one reader the scheduler uses, identical on both paths.
    expect(rateLimitOf(outcome.failure)).toEqual({
      provider: PROVIDER,
      resetsAt: RESETS_AT_MS,
      raw: {
        code: DECLARED,
        message: 'usage limit reached for this account',
        data: { status: 'rejected', resetsAt: RESETS_AT_SECONDS },
      },
    });

    const events = ledger.events();
    const kinds = events.map((event) => event.kind);
    // Cause before effect: a reader walking the timeline meets the limit
    // before the failure it caused. The session opened and the prompt went
    // out, so the turn really reached the vendor before it was refused.
    //
    // Two `node.started`, since KAR-12.2: the first is written after the
    // handshake and before a session exists, the second the instant
    // `session/new` answers, carrying the resolved session id. The ledger is
    // append-only, so a late-arriving field is a second event rather than an
    // edit to the first — which is also what makes independence checkable from
    // two payloads after the fact.
    expect(kinds).toEqual([
      'node.scheduled',
      'node.started',
      'node.started',
      'node.progress',
      'provider.rate_limited',
      'node.failed',
    ]);
    const limited = events.find((event) => event.kind === 'provider.rate_limited')?.payload;
    expect(limited).toEqual({
      provider: PROVIDER,
      resetsAt: RESETS_AT_MS,
      // Verbatim, so a later build re-parses the vendor's payload off the
      // ledger without a re-run.
      raw: {
        code: DECLARED,
        message: 'usage limit reached for this account',
        data: { status: 'rejected', resetsAt: RESETS_AT_SECONDS },
      },
    });

    // AC2: a row at the vendor's own instant, under the quota reason — never a
    // timer, because 2^31−1 ms is a ceiling a row does not have.
    expect(wakes).toEqual([
      { runId: RUN_ID, nodeId: NODE_ID, wakeAt: RESETS_AT_MS, reason: 'quota' },
    ]);
    // And the child is not left behind.
    expect(outcome.exit).not.toBeNull();
  });

  it('finds the reset where the one verified vendor spelling nests it', async () => {
    const { outcome, wakes } = await runAgainst({
      agentArgv: ['--code', `${DECLARED}`, '--resets-at', `${RESETS_AT_SECONDS}`, '--nest'],
      declare: [DECLARED],
      tag: 'nested',
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(rateLimitOf(outcome.failure)?.resetsAt).toBe(RESETS_AT_MS);
    expect(wakes.map((row) => row.wakeAt)).toEqual([RESETS_AT_MS]);
  });
});

suite('a declared rate limit with no reset (AC1, AC6)', () => {
  it('records the limit, invents no instant, and writes no wake row', async () => {
    const { outcome, wakes } = await runAgainst({
      agentArgv: ['--code', `${DECLARED}`],
      declare: [DECLARED],
      tag: 'blind',
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;

    expect(outcome.failure.class).toBe('transient');
    const limit = rateLimitOf(outcome.failure);
    expect(limit?.resetsAt).toBeNull();
    expect(describeRateLimit(limit as never)).toBe('rate limited, reset time unknown');

    const limited = ledger.events().find((event) => event.kind === 'provider.rate_limited');
    expect(limited?.payload).not.toHaveProperty('resetsAt');
    expect(limited?.payload.raw).toMatchObject({ data: { retryAfter: 'unknown' } });

    // No row, because there is no instant to write one at: the retry ladder's
    // full jitter is what schedules the next attempt.
    expect(wakes).toEqual([]);
  });
});

suite('everything that is not a declared rate limit (AC9)', () => {
  it('leaves an undeclared error exactly what it was', async () => {
    const { outcome } = await runAgainst({
      agentArgv: ['--code', '-32043', '--resets-at', `${RESETS_AT_SECONDS}`],
      declare: [DECLARED],
      tag: 'undeclared',
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.reason).not.toBe('provider.rate-limited');
    expect(rateLimitOf(outcome.failure)).toBeNull();
    expect(ledger.events().map((event) => event.kind)).not.toContain('provider.rate_limited');
  });

  it('reads nothing when the caller declared no codes — the shipped default', async () => {
    const { outcome } = await runAgainst({
      agentArgv: ['--code', `${DECLARED}`, '--resets-at', `${RESETS_AT_SECONDS}`],
      declare: [],
      tag: 'none-declared',
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(rateLimitOf(outcome.failure)).toBeNull();
    expect(ledger.events().map((event) => event.kind)).not.toContain('provider.rate_limited');
  });
});

suite('a code ACP has already assigned (AC9)', () => {
  it('is refused before a process exists, rather than masking an auth refusal', async () => {
    const { outcome, methods, wakes } = await runAgainst({
      // -32000 is ACP's `authRequired`. Reading it as a quota would retry a
      // permanent refusal until the attempt budget ran out.
      agentArgv: ['--code', '-32000'],
      declare: [-32_000],
      tag: 'assigned',
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.class).toBe('permanent');
    expect(outcome.failure.message).toContain('-32000');
    expect(rateLimitOf(outcome.failure)).toBeNull();

    // The whole claim of "before the spawn": the agent never ran.
    expect(methods).toBeNull();
    expect(outcome.exit).toBeNull();
    expect(wakes).toEqual([]);
    expect(ledger.events().map((event) => event.kind)).toEqual(['node.scheduled', 'node.failed']);
  });
});
