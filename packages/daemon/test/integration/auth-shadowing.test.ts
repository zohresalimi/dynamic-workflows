/**
 * KAR-08.8 — auth-shadowing detection, proved at the real spawn boundary and
 * the real ledger (EPIC-08-S31, EPIC-08-S32).
 *
 * `buildChildEnv()`'s allowlist (KAR-08.4) already drops `ANTHROPIC_API_KEY`
 * by omission — it is simply not on the allowlist. What this suite proves is
 * the loud half: `resolveProviderAuth()` decides whether the child actually
 * receives the variable (never, unless the node explicitly selected the
 * api_key path) and what gets appended to the ledger, and both halves are
 * checked against what the **child process itself** printed and what
 * `readRange` actually returns — never against an in-memory value alone, the
 * same discipline `../env-scrubbing.test.ts` uses for KAR-08.4.
 *
 * Verifies: EPIC-08-S31, EPIC-08-S32 · KAR-08.8 AC1, AC2 (test plan #1, #2)
 */
import type { EventRecord, EventSeq } from '@DeFlow/core';
import { ProviderIdSchema } from '@DeFlow/core';
import { appendEvents, openLedger, readEpoch, readRange } from '@DeFlow/ledger';
import { makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  buildChildEnv,
  createRunTmpdir,
  createTerminalService,
  resolveLoginShellPath,
  resolveProviderAuth,
} from '../../src/index.ts';

const RUN_ID = 'run_20260807T000000Z_ab12c3';
const NODE = 'n1';
const CLAUDE = ProviderIdSchema.parse('claude');

/** A real key shape, so a value-scan assertion means something — never a
 * value that would work against a real provider. */
const ANTHROPIC_KEY = 'sk-ant-fixture-do-not-use';

let dir = '';
let worktree = '';
let loginPath = '';

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', NODE);
  await mkdir(worktree, { recursive: true });
  loginPath = await resolveLoginShellPath();
});

afterEach(async () => {
  await removeTempDir(dir);
});

/** Prints `process.env` as JSON, exactly the fixture `../env-scrubbing.test.ts`
 * uses for the same reason: a real subprocess, an absolute path, and its own
 * environment is the thing under test. */
async function printChildEnv(
  childEnv: Readonly<Record<string, string>>,
): Promise<Record<string, string>> {
  const service = createTerminalService({ root: worktree, childEnv });
  const id = await service.create({
    command: process.execPath,
    args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
  });
  await service.waitForExit(id);
  const printed = service.output(id).output;
  return JSON.parse(printed) as Record<string, string>;
}

suite('EPIC-08-S31 — subscription auth: stripped, and the strip is recorded', () => {
  it('the child never receives ANTHROPIC_API_KEY, and the value never reaches the ledger', async () => {
    const base = { ...process.env, ANTHROPIC_API_KEY: ANTHROPIC_KEY };
    const resolved = resolveProviderAuth({
      node: NODE,
      attempt: 0,
      provider: CLAUDE,
      mode: 'subscription',
      base,
    });

    const tmp = await createRunTmpdir(dir);
    const { env } = buildChildEnv({ base, loginPath, tmpdir: tmp, declared: resolved.passthrough });
    const received = await printChildEnv(env);
    expect(received).not.toHaveProperty('ANTHROPIC_API_KEY');

    const db = openLedger(dir);
    try {
      const epoch = readEpoch(db);
      const records: EventRecord[] = [
        {
          kind: 'provider.auth_mode',
          v: 1,
          ts: 0,
          nodeId: NODE,
          attempt: 0,
          payload: resolved.authModeEvent,
        },
        ...resolved.shadowStrippedEvents.map(
          (payload): EventRecord => ({
            kind: 'provider.auth_shadow_stripped',
            v: 1,
            ts: 0,
            nodeId: NODE,
            attempt: 0,
            payload,
          }),
        ),
      ];
      appendEvents(
        db,
        records.map((record) => ({
          runId: RUN_ID,
          ts: record.ts,
          kind: record.kind,
          v: record.v,
          epoch,
          nodeId: record.nodeId,
          attempt: record.attempt,
          payload: record.payload,
        })),
      );

      const page = readRange(db, RUN_ID, 0, 10);
      const stripped = page.events.find((e) => e.kind === 'provider.auth_shadow_stripped');
      expect(stripped?.payload).toEqual({
        node: NODE,
        attempt: 0,
        provider: CLAUDE,
        variable: 'ANTHROPIC_API_KEY',
      });

      const authMode = page.events.find((e) => e.kind === 'provider.auth_mode');
      expect(authMode?.payload).toEqual({
        node: NODE,
        attempt: 0,
        provider: CLAUDE,
        mode: 'subscription',
      });

      // "the event carries no value" (EPIC-08-S31) — the strongest form: not
      // merely absent from the payload shape, absent from the raw bytes.
      const wholeLedgerAsText = JSON.stringify(page.events);
      expect(wholeLedgerAsText).not.toContain(ANTHROPIC_KEY);
    } finally {
      db.close();
    }
  });

  it('a shadowing variable the base env never carried strips nothing and reports nothing', async () => {
    const base = { ...process.env };
    delete base.ANTHROPIC_API_KEY;
    const resolved = resolveProviderAuth({
      node: NODE,
      attempt: 0,
      provider: CLAUDE,
      mode: 'subscription',
      base,
    });
    expect(resolved.shadowStrippedEvents).toEqual([]);
  });
});

suite('EPIC-08-S32 — the explicit api_key path is recorded too', () => {
  it('the child DOES receive the key, and no auth_shadow_stripped event is emitted', async () => {
    const base = { ...process.env, ANTHROPIC_API_KEY: ANTHROPIC_KEY };
    const resolved = resolveProviderAuth({
      node: NODE,
      attempt: 0,
      provider: CLAUDE,
      mode: 'api_key',
      base,
    });
    expect(resolved.shadowStrippedEvents).toEqual([]);

    const tmp = await createRunTmpdir(dir);
    const { env } = buildChildEnv({ base, loginPath, tmpdir: tmp, declared: resolved.passthrough });
    const received = await printChildEnv(env);
    expect(received.ANTHROPIC_API_KEY).toBe(ANTHROPIC_KEY);
  });

  it('the run manifest records provider.auth_mode "api_key" in the ledger', async () => {
    const base = { ...process.env, ANTHROPIC_API_KEY: ANTHROPIC_KEY };
    const resolved = resolveProviderAuth({
      node: NODE,
      attempt: 0,
      provider: CLAUDE,
      mode: 'api_key',
      base,
    });

    const db = openLedger(dir);
    try {
      const epoch = readEpoch(db);
      const seq = appendEvents(db, [
        {
          runId: RUN_ID,
          ts: 0,
          kind: 'provider.auth_mode',
          v: 1,
          epoch,
          nodeId: NODE,
          attempt: 0,
          payload: resolved.authModeEvent,
        },
      ])[0] as EventSeq;
      expect(seq).toBeGreaterThan(0);

      const page = readRange(db, RUN_ID, 0, 10);
      const authMode = page.events.find((e) => e.kind === 'provider.auth_mode');
      expect(authMode?.payload).toEqual({
        node: NODE,
        attempt: 0,
        provider: CLAUDE,
        mode: 'api_key',
      });
      expect(page.events.some((e) => e.kind === 'provider.auth_shadow_stripped')).toBe(false);
    } finally {
      db.close();
    }
  });
});
