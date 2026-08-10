/**
 * KAR-15.6 AC8 — `GET /api/providers`, `GET /api/config` and `PATCH /api/config`.
 *
 * Integration and file-backed, because both endpoints are about state that
 * lives outside the process: the capability rows a probe left in the ledger,
 * and a real `.DeFlow/config.yaml` on a real disk. A `PATCH` that "succeeded"
 * without the next `GET` reading it back is the failure worth spending a test
 * on, and only a real file shows it.
 *
 * Verifies: KAR-15.6 AC8
 */
import type { RunId } from '@DeFlow/core';
import { RunIdSchema } from '@DeFlow/core';
import {
  appendEvents,
  type Db,
  type EventDraft,
  openLedger,
  recordProviderCapabilities,
} from '@DeFlow/ledger';
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, describe as suite } from 'vitest';
import { clearLedgerView, openLedgerView, setLedgerView } from '../../src/http/ledger-view.ts';
import { startHttp } from '../../src/http/server.ts';

const fetch = authorizedFetch();

const RUN: RunId = RunIdSchema.parse('run_20260810T131500Z_ac1580');
const T0 = 1_754_812_800_000;

const CAPS = JSON.stringify({
  protocolVersion: 1,
  agentCapabilities: { loadSession: true },
  authMethods: [],
});

interface Served {
  readonly origin: string;
  readonly db: Db;
  readonly repo: string;
  close(): Promise<void>;
}

async function serve(tmp: string): Promise<Served> {
  const repo = join(tmp, 'workspace');
  mkdirSync(join(repo, '.DeFlow'), { recursive: true });

  const db = openLedger(tmp);
  recordProviderCapabilities(db, {
    provider: 'claude',
    version: 'claude-agent-acp 0.64.1',
    binarySha256: 'e'.repeat(64),
    binaryPath: '/opt/claude/bin/claude',
    capsJson: CAPS,
    probedAt: T0,
  });

  const draft = (kind: string, payload: unknown): EventDraft =>
    ({ runId: RUN, ts: T0, kind, v: 1, epoch: 1, payload }) as EventDraft;
  appendEvents(db, [
    draft('run.created', {
      spec: {
        schemaId: 'DeFlow.taskspec.v1',
        goal: 'configure the workspace',
        scope: { included: [] },
        nonGoals: [],
        constraints: [],
        priorDecisions: [],
        acceptanceCriteria: [{ id: 'ac-1', statement: 'the config round-trips' }],
        knownFailureModes: [],
        approvedBy: null,
        specHash: `sha256-${'5'.repeat(64)}`,
      },
      cwd: repo,
      repo: { head: 'abcdef1', branch: 'main' },
    }),
  ]);

  const view = openLedgerView(tmp);
  setLedgerView(view);
  const started = await startHttp({
    port: 0,
    hostname: '127.0.0.1',
    dev: false,
    token: TEST_DAEMON_TOKEN,
  });
  const address = started.server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    db,
    repo,
    async close() {
      await started.close();
      clearLedgerView();
      view.close();
      db.close();
    },
  };
}

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

suite('GET /api/providers (AC8)', () => {
  it('reports the probed version and the capability manifest, unmodified', async ({ tmp }) => {
    served = await serve(tmp);

    const providers = (await (await fetch(`${served.origin}/api/providers`)).json()) as {
      provider: string;
      installed: boolean;
      version: string | null;
      capabilities: unknown;
    }[];

    const claude = providers.find((entry) => entry.provider === 'claude');
    expect(claude).toMatchObject({
      installed: true,
      version: 'claude-agent-acp 0.64.1',
      binarySha256: 'e'.repeat(64),
    });
    // The vendor's own `initialize` answer, never paraphrased.
    expect(claude?.capabilities).toEqual(JSON.parse(CAPS));
  });

  it('names a provider nothing has probed rather than omitting it', async ({ tmp }) => {
    served = await serve(tmp);

    const providers = (await (await fetch(`${served.origin}/api/providers`)).json()) as {
      provider: string;
      installed: boolean;
      version: string | null;
    }[];

    // "gemini is not installed" is an answer the operator can act on; an
    // absent row is one they have to infer.
    const unprobed = providers.filter((entry) => !entry.installed);
    expect(unprobed.length).toBeGreaterThan(0);
    expect(unprobed.every((entry) => entry.version === null)).toBe(true);
  });
});

suite('the workspace config (AC8)', () => {
  it('reads an unconfigured workspace as an empty config, not an error', async ({ tmp }) => {
    served = await serve(tmp);

    const response = await fetch(
      `${served.origin}/api/config?cwd=${encodeURIComponent(served.repo)}`,
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as { config: unknown }).toEqual({
      cwd: served.repo,
      config: {},
    });
  });

  it('merges a PATCH, writes YAML, and reads it back', async ({ tmp }) => {
    served = await serve(tmp);
    const target = served;

    const patched = await fetch(
      `${target.origin}/api/config?cwd=${encodeURIComponent(target.repo)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: { inlineThresholdBytes: 4096 } }),
      },
    );
    expect(patched.status).toBe(200);

    // On disk as YAML, because that is the file an operator hand-edits.
    const onDisk = readFileSync(join(target.repo, '.DeFlow', 'config.yaml'), 'utf8');
    expect(onDisk).toContain('inlineThresholdBytes: 4096');

    const read = (await (
      await fetch(`${target.origin}/api/config?cwd=${encodeURIComponent(target.repo)}`)
    ).json()) as { config: { context?: { inlineThresholdBytes?: number } } };
    expect(read.config.context?.inlineThresholdBytes).toBe(4096);
  });

  it('refuses an invalid value and changes nothing on disk', async ({ tmp }) => {
    served = await serve(tmp);
    const target = served;

    const response = await fetch(
      `${target.origin}/api/config?cwd=${encodeURIComponent(target.repo)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // `inlineThresholdBytes` has to be a positive integer, and a run built
        // against a config that quietly fell back would offload nothing.
        body: JSON.stringify({ context: { inlineThresholdBytes: 'nope' } }),
      },
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'schema_violation',
    );
    // §13's highest-severity risk is a setting the operator believes is in
    // force and is not. A refused patch must leave the file exactly as it was.
    const read = (await (
      await fetch(`${target.origin}/api/config?cwd=${encodeURIComponent(target.repo)}`)
    ).json()) as { config: { context?: { inlineThresholdBytes?: number } } };
    expect(read.config.context).toBeUndefined();
  });

  it('refuses a cwd this daemon holds no run for', async ({ tmp }) => {
    served = await serve(tmp);

    for (const cwd of ['', '/etc']) {
      const response = await fetch(`${served.origin}/api/config?cwd=${encodeURIComponent(cwd)}`);
      expect(response.status, cwd).toBe(400);
    }
  });
});
