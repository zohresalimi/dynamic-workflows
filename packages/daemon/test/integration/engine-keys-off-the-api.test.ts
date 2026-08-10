/**
 * KAR-15.5 test plan #8 — the effect journal is not client-reachable
 * (docs/11-api-and-realtime.md §11, last paragraph).
 *
 * *"The engine's own `(runId, nodeId, attempt)` idempotency keys are **not**
 * exposed on the API … conflating the two would let a client reach into the
 * effect journal, which is precisely the invariant that makes crash recovery
 * sound."*
 *
 * The scenario names three things, and this spec asserts all three:
 *
 * 1. **The emitted schemas carry no engine key.** Every document in a run's
 *    `.DeFlow/schemas/` is walked, at every depth, for a property under any of
 *    the engine key's names. The walker is checked against a positive control
 *    first, so a green row cannot mean "the walk found nothing because it looks
 *    at nothing".
 * 2. **No endpoint accepts one as input.** `POST /api/runs`' body schema is
 *    strict, so an `ikey` field is a `400` rather than a field quietly ignored;
 *    and the control endpoints, whose bodies are read by hand, never carry one
 *    into the ledger.
 * 3. **The API-level key is a distinct concept with a distinct name.** It
 *    travels as an `Idempotency-Key` *header*, and it is journalled under an
 *    `intake:` namespace that `ikey()` cannot produce for any input — so a
 *    client sending an engine-shaped value still cannot address an engine row.
 *
 * Integration rather than unit because claim 1 is about **files on disk**: the
 * scenario says "the JSON Schemas emitted to `.DeFlow/schemas/`", and reading
 * the in-memory documents instead would pass even if the writer dropped one.
 *
 * Verifies: EPIC-15-S38 · AC8
 */
import { ikey, parseIkey } from '@DeFlow/core';
import { INTAKE_IKEY_PREFIX, intakeIkey } from '@DeFlow/ledger';
import { authorizedFetch, it, makeRepo, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { type Booted, boot } from '../../src/boot.ts';
import { runSchemasDir, writeRunSchemas } from '../../src/run-schemas.ts';

const fetch = authorizedFetch();

/**
 * The names an engine idempotency key could travel under, and the shape of the
 * value itself.
 *
 * Names *and* value, because a schema could leak the concept either way: a
 * property called `ikey`, or a `const`/`example` carrying
 * `run_.../node/0/0` under some innocuous name.
 */
const ENGINE_KEY_NAMES = ['ikey', 'idempotencyKey', 'idempotency_key', 'effectKey'];
const ENGINE_KEY_SHAPE = /^run_\d{8}T\d{6}Z_[0-9a-f]{6}\/[a-z0-9][a-z0-9-]*\/\d+\/\d+$/;

/** Every place `value` mentions an engine key, as a dotted path. Empty is clean. */
function engineKeyMentions(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') {
    return ENGINE_KEY_SHAPE.test(value) ? [`${path} = ${value}`] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => engineKeyMentions(item, `${path}[${index}]`));
  }
  if (value === null || typeof value !== 'object') return [];

  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (ENGINE_KEY_NAMES.includes(key)) found.push(`${path}.${key}`);
    found.push(...engineKeyMentions(child, `${path}.${key}`));
  }
  return found;
}

async function bootAt(dataDir: string): Promise<{ booted: Booted; origin: string }> {
  const booted = await boot({ dataDir, port: 0, dev: false, token: TEST_DAEMON_TOKEN });
  const address = booted.http.server.address() as AddressInfo;
  return { booted, origin: `http://127.0.0.1:${address.port}` };
}

suite('EPIC-15-S38 — the emitted schemas (AC8)', () => {
  it('finds an engine key when one is there, so a clean sweep means something', () => {
    // The positive control. Without it, every assertion below would pass
    // against a walker that returned `[]` unconditionally.
    expect(engineKeyMentions({ properties: { ikey: { type: 'string' } } })).toEqual([
      '$.properties.ikey',
    ]);
    expect(
      engineKeyMentions({ examples: [{ handle: 'run_20260810T101500Z_aa0001/impl-auth/0/0' }] }),
    ).toHaveLength(1);
  });

  it('carries no engine idempotency key in any document a run publishes', ({ tmp }) => {
    const dir = writeRunSchemas(tmp);
    expect(dir).toBe(runSchemasDir(tmp));

    const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const document: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      expect({ file, mentions: engineKeyMentions(document) }).toEqual({ file, mentions: [] });
    }
  });
});

suite('EPIC-15-S38 — no endpoint accepts one as input (AC8)', () => {
  it('refuses an ikey field on POST /api/runs rather than ignoring it', async ({ tmp }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const { booted, origin } = await bootAt(`${tmp}/data`);
    try {
      const response = await fetch(`${origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: { kind: 'text', text: 'ship it' },
          cwd: repo.dir,
          permission: 'worktree',
          ikey: 'run_20260810T101500Z_aa0001/impl-auth/0/0',
        }),
      });

      // Refused, not tolerated: a field quietly dropped is a field somebody
      // will assume works.
      expect(response.status).toBe(400);
      expect(booted.db.prepare<{ n: number }>('SELECT count(*) AS n FROM effect').get()?.n).toBe(0);
    } finally {
      await booted.shutdown();
    }
  });

  it('never lets a response body carry one, on success or on refusal', async ({ tmp }) => {
    const repo = await makeRepo({ dir: `${tmp}/repo` });
    const { booted, origin } = await bootAt(`${tmp}/data`);
    try {
      const created = await fetch(`${origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': 'k1' },
        body: JSON.stringify({
          input: { kind: 'text', text: 'ship it' },
          cwd: repo.dir,
          permission: 'worktree',
        }),
      });
      const body = (await created.json()) as { runId: string };
      expect(engineKeyMentions(body)).toEqual([]);

      // A refusal too: the control endpoints answer an unapproved run with
      // `422 spec_not_approved`, and its envelope must be as bare as the 201.
      const refused = await fetch(`${origin}/api/runs/${body.runId}/pause`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(refused.status).toBe(422);
      expect(engineKeyMentions(await refused.json())).toEqual([]);
    } finally {
      await booted.shutdown();
    }
  });
});

suite('EPIC-15-S38 — a distinct concept with a distinct name (AC8)', () => {
  it('journals an engine-shaped header value where no engine key can reach', () => {
    const engineShaped = ikey('run_20260810T101500Z_aa0001' as never, 'impl-auth' as never, 0, 0);
    // The value the client sent *is* a well-formed engine key…
    expect(() => parseIkey(engineShaped)).not.toThrow();
    // …and what the journal stores for it is not, and can never collide with
    // the row that triple's effects use.
    expect(intakeIkey(engineShaped)).toBe(`${INTAKE_IKEY_PREFIX}${engineShaped}`);
    expect(() => parseIkey(intakeIkey(engineShaped))).toThrow();
  });
});
