/**
 * KAR-15.6 AC8 — `POST /api/providers/doctor`: the re-probe and the
 * conformance battery, over HTTP.
 *
 * Integration and against a **real binary**, because both halves of the
 * endpoint are claims about the machine rather than about a projection: a
 * re-probe that did not spawn anything would report the row it was given back
 * to itself, and a battery that did not open a connection would report eight
 * assertions nobody ran. The mock agent stands in for an installed adapter —
 * it is a real ACP process, spawned the same way a vendor CLI would be.
 *
 * The stale row is the fixture's whole point: `GET /api/providers` answers out
 * of it, and the doctor's answer has to disagree with it — a different version
 * and a different sha256 — or nothing was re-probed.
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
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { systemClock } from '../../src/clock.ts';
import { clearIntakePorts, setIntakePorts } from '../../src/http/intake-ports.ts';
import { clearLedgerView, openLedgerView, setLedgerView } from '../../src/http/ledger-view.ts';
import { startHttp } from '../../src/http/server.ts';

const fetch = authorizedFetch();

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

const RUN: RunId = RunIdSchema.parse('run_20260810T131500Z_ac1580');
const T0 = 1_754_812_800_000;

/** What the fixture claims the last probe saw. Both fields are wrong on purpose. */
const STALE_VERSION = 'claude-agent-acp 0.0.1-stale';
const STALE_SHA = 'e'.repeat(64);

const CAPS = JSON.stringify({
  protocolVersion: 1,
  agentCapabilities: { loadSession: true },
  authMethods: [],
});

interface DoctorResult {
  readonly assertion: number;
  readonly name: string;
  readonly subject?: string;
  readonly status: 'passed' | 'failed' | 'skipped';
  readonly detail: string;
}

interface DoctorEntry {
  readonly provider: string;
  readonly installed: boolean;
  readonly binaryPath: string | null;
  readonly version: string | null;
  readonly binarySha256: string | null;
  readonly probedAt: number | null;
  readonly capabilities: unknown;
  readonly changed: boolean;
  readonly probe: { readonly status: 'probed' | 'failed' | 'skipped'; readonly detail: string };
  readonly conformance: {
    readonly adapter: string;
    readonly passed: boolean;
    readonly results: readonly DoctorResult[];
  } | null;
}

interface DoctorReport {
  readonly probedAt: number;
  readonly providers: readonly DoctorEntry[];
}

interface Served {
  readonly origin: string;
  readonly db: Db;
  close(): Promise<void>;
}

async function serve(tmp: string): Promise<Served> {
  const repo = join(tmp, 'workspace');
  mkdirSync(join(repo, '.DeFlow'), { recursive: true });

  const db = openLedger(tmp);
  // The row the doctor is asked to re-check: `claude`, recorded against the
  // mock agent's path, with a version and a digest that no longer describe it.
  recordProviderCapabilities(db, {
    provider: 'claude',
    version: STALE_VERSION,
    binarySha256: STALE_SHA,
    binaryPath: MOCK_AGENT_BIN,
    capsJson: CAPS,
    probedAt: T0,
  });

  const draft = (kind: string, payload: unknown): EventDraft =>
    ({ runId: RUN, ts: T0, kind, v: 1, epoch: 1, payload }) as EventDraft;
  appendEvents(db, [
    draft('run.created', {
      spec: {
        schemaId: 'DeFlow.taskspec.v1',
        goal: 'check the installed adapters',
        scope: { included: [] },
        nonGoals: [],
        constraints: [],
        priorDecisions: [],
        acceptanceCriteria: [{ id: 'ac-1', statement: 'the doctor answers' }],
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
  // Real time, because real children are alive for the whole of this spec: a
  // fake clock around a live process is the deadlock docs/14-testing-strategy.md
  // §8 forbids.
  setIntakePorts({
    db,
    epoch: 1,
    clock: systemClock,
    dataDir: tmp,
    randomHex: () => 'abc123',
  });
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
    async close() {
      await started.close();
      clearIntakePorts();
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

const probedEvents = (db: Db): number =>
  (
    db
      .prepare<{ n: number }>("SELECT count(*) AS n FROM event WHERE kind = 'provider.probed'")
      .get() ?? { n: 0 }
  ).n;

suite('POST /api/providers/doctor (AC8)', () => {
  it('re-probes the recorded binary rather than echoing the stored row', async ({ tmp }) => {
    served = await serve(tmp);
    const target = served;
    expect(probedEvents(target.db)).toBe(0);

    const response = await fetch(`${target.origin}/api/providers/doctor`, { method: 'POST' });
    expect(response.status).toBe(200);

    const report = (await response.json()) as DoctorReport;
    const claude = report.providers.find((entry) => entry.provider === 'claude');
    expect(claude?.probe.status).toBe('probed');
    expect(claude?.installed).toBe(true);

    // The two fields that can only be right if a process was spawned and the
    // file was re-read.
    const sha = createHash('sha256').update(readFileSync(MOCK_AGENT_BIN)).digest('hex');
    expect(claude?.binarySha256).toBe(sha);
    expect(claude?.binarySha256).not.toBe(STALE_SHA);
    expect(claude?.version).not.toBe(STALE_VERSION);
    expect(claude?.version).toContain('mock-agent');

    // A probe is a fact about this machine, so it is in the log (F3.4/NF10) —
    // and the capability table now answers with what was just seen.
    expect(probedEvents(target.db)).toBe(1);
    const providers = (await (await fetch(`${target.origin}/api/providers`)).json()) as {
      provider: string;
      version: string | null;
    }[];
    expect(providers.find((entry) => entry.provider === 'claude')?.version).toBe(claude?.version);
  });

  it('runs the conformance battery against the binary it just probed', async ({ tmp }) => {
    served = await serve(tmp);

    const report = (await (
      await fetch(`${served.origin}/api/providers/doctor`, { method: 'POST' })
    ).json()) as DoctorReport;
    const battery = report.providers.find((entry) => entry.provider === 'claude')?.conformance;

    // Assertions 1 and 2 are the handshake and the session — the two an
    // installed, working adapter passes whatever scenario it is driving, and
    // the two that cannot pass unless a connection was actually opened.
    const status = (assertion: number) =>
      battery?.results.filter((result) => result.assertion === assertion).map((r) => r.status);
    expect(status(1)).toEqual(['passed']);
    expect(status(2)).toEqual(['passed']);

    // The battery drives real turns, and a real turn appends `node.started`
    // and `budget.consumed`. None of them belongs in this ledger: they would
    // be spend and calibration samples recorded against a run nobody
    // submitted, which a later run's estimate would then learn from.
    const stray = served.db
      .prepare<{ n: number }>(
        "SELECT count(*) AS n FROM event WHERE kind LIKE 'node.%' OR kind = 'budget.consumed'",
      )
      .get();
    expect(stray?.n).toBe(0);

    // A skip is a result, not an absence: the two cases DeFlow cannot stage
    // against an installed binary — it has no way to make a vendor emit a
    // malformed line or an oversized frame — are reported with the reason
    // that produced them, never omitted.
    for (const assertion of [7, 8]) {
      const results = battery?.results.filter((result) => result.assertion === assertion) ?? [];
      expect(results.length).toBeGreaterThan(0);
      expect(results.every((result) => result.status === 'skipped')).toBe(true);
      expect(results.every((result) => result.detail !== '')).toBe(true);
    }
  });

  it('reports a provider nothing has probed without spawning anything', async ({ tmp }) => {
    served = await serve(tmp);
    const target = served;

    const report = (await (
      await fetch(`${target.origin}/api/providers/doctor`, { method: 'POST' })
    ).json()) as DoctorReport;

    const gemini = report.providers.find((entry) => entry.provider === 'gemini');
    expect(gemini).toMatchObject({
      installed: false,
      binaryPath: null,
      version: null,
      conformance: null,
    });
    expect(gemini?.probe.status).toBe('skipped');
    // "gemini is not installed" is an answer the operator can act on, and it
    // cost no spawn: only the one provider with a recorded binary was probed.
    expect(probedEvents(target.db)).toBe(1);
  });

  it('answers 503 rather than crashing when the daemon has no ports yet', async ({ tmp }) => {
    served = await serve(tmp);
    clearIntakePorts();

    const response = await fetch(`${served.origin}/api/providers/doctor`, { method: 'POST' });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'daemon_starting',
    );
  });
});
