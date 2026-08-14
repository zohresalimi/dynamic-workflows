/**
 * KAR-19.7 AC4 — the returned document is a function of (schema, prompt, seed)
 * and of nothing else.
 *
 * F3.7 calls the mock provider *"deterministic, free"* and NF9 puts
 * nondeterminism outside the adapter boundary. A returned document carrying a
 * wall-clock timestamp, an unseeded id or a directory-listing order would flake
 * every downstream snapshot in the repository at roughly the rate that trains a
 * person to re-run the suite rather than read the failure.
 *
 * The changed-`TZ` clause is not decoration: a date rendered through the host
 * locale is the realistic version of this bug, and it passes on the author's
 * machine indefinitely.
 *
 * Verifies: EPIC-19-S47 · AC4 · test plan #4
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { MOCK_STRUCTURED_OUTPUT_FLAG, SERVABLE_SCHEMA_IDS } from '../../src/structured.ts';
import { MOCK_AGENT_BIN, spawnMockAgent } from '../support/harness.ts';

const SCHEMAS_DIR = fileURLToPath(new URL('../../../../schemas/', import.meta.url));
const schemaFile = (schemaId: string): string => join(SCHEMAS_DIR, `${schemaId}.json`);

/** What `crypto.randomUUID()` emits. Its absence is half the assertion. */
const UUID_V4 = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;

interface Machine {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
}

async function serve(schemaId: string, seed: string, machine: Machine = {}): Promise<string> {
  const agent = spawnMockAgent(
    [MOCK_STRUCTURED_OUTPUT_FLAG, schemaFile(schemaId), '--prompt', 'Do the task.', '--seed', seed],
    {
      bin: MOCK_AGENT_BIN,
      ...(machine.env === undefined ? {} : { env: machine.env }),
      ...(machine.cwd === undefined ? {} : { cwd: machine.cwd }),
    },
  );
  const exit = await agent.finish();
  expect(exit.code).toBe(0);
  return agent.stdout().toString('utf8');
}

const SCHEMA_ID = 'DeFlow.plangraph.v1';

suite('EPIC-19-S47 — the same inputs give the same bytes', () => {
  it('produces one document across twenty fresh spawns', async () => {
    const documents: string[] = [];
    for (let at = 0; at < 20; at += 1) documents.push(await serve(SCHEMA_ID, '7'));

    expect(new Set(documents).size).toBe(1);
    expect(documents[0]).not.toMatch(UUID_V4);
  });

  it('is unmoved by cwd, TMPDIR, TZ and locale', async () => {
    const baseline = await serve(SCHEMA_ID, '7');
    const elsewhere = mkdtempSync(join(tmpdir(), 'DeFlow-mock-elsewhere-'));

    const moved = await serve(SCHEMA_ID, '7', {
      cwd: elsewhere,
      env: {
        ...process.env,
        TMPDIR: elsewhere,
        TZ: 'Pacific/Kiritimati',
        LANG: 'fr_FR.UTF-8',
        LC_ALL: 'fr_FR.UTF-8',
      },
    });

    expect(moved).toBe(baseline);
  });

  it('moves with the seed, so the seed is provably what fixes it', async () => {
    // The negative half: identical bytes at two different seeds would mean the
    // document is a constant, and "deterministic" would be true for a reason
    // that proves nothing about where its ids came from.
    expect(await serve(SCHEMA_ID, '7')).not.toBe(await serve(SCHEMA_ID, '8'));
  });

  it.each([...SERVABLE_SCHEMA_IDS])('holds for %s too', async (schemaId) => {
    expect(await serve(schemaId, '3')).toBe(await serve(schemaId, '3'));
  });
});
