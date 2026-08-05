/**
 * KAR-05.7 AC3, AC4 — the behavioural contract, over all six capability
 * profiles.
 *
 * Six call sites, one per profile, and that is the whole file. That is AC3:
 * five real adapters plus a synthetic one cost six lines rather than six
 * bespoke test files that drift apart within a month. What each of the eight
 * assertions actually means lives in `src/conformance.ts`, and it lives there
 * rather than here so that `DeFlow doctor` (EPIC-18) can run the same battery
 * against a user's installed CLIs.
 *
 * There is no `@live` parameterisation in this file, and its absence is the
 * point of AC4's second half: a real vendor CLI costs real quota against the
 * developer's own subscription and is nondeterministic by construction, so it
 * runs only from `pnpm test:record`, by hand, never in CI.
 *
 * Verifies: EPIC-05-S26 · AC3, AC4 · test plan #3, #4
 */

import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import type { ConformanceCase, ConformancePorts } from '../../src/index.ts';
import {
  liveInGroup,
  NODE_ID,
  openTestLedger,
  PROVIDER,
  RUN_ID,
  type TestLedger,
} from './support/harness.ts';
import {
  CONFORMANCE_PROFILES,
  type ConformanceProfile,
  mockAdapter,
} from './support/mock-adapter.ts';
import { providerContract } from './support/provider-contract.ts';

let dir = '';
let ledger: TestLedger;

beforeAll(async () => {
  dir = await makeTempDir();
  ledger = openTestLedger(dir);
});

afterAll(async () => {
  ledger.close();
  await removeTempDir(dir);
});

const portsFor = async (profile: ConformanceProfile): Promise<ConformancePorts> => ({
  clock: new TestClock(),
  ledger: ledger.sink,
  captureEvidence: ledger.captureEvidence,
  worktree: async (kase: ConformanceCase): Promise<string> => {
    const worktree = join(dir, 'wt', profile, kase);
    await mkdir(worktree, { recursive: true });
    return worktree;
  },
  runId: RUN_ID,
  nodeId: NODE_ID,
  provider: PROVIDER,
  liveInGroup,
});

// AC4 — all six profiles, on every commit. Each is one call site.
for (const profile of CONFORMANCE_PROFILES) {
  providerContract(() => mockAdapter({ profile, ledger, clock: new TestClock(), dataDir: dir })(), {
    label: profile,
    ports: () => portsFor(profile),
  });
}

suite('the parameterisation itself', () => {
  it('covers the six profiles the measured matrix names, in that order', () => {
    // A table that quietly lost a profile still passes every spec above it.
    expect([...CONFORMANCE_PROFILES]).toEqual([
      'claude',
      'codex',
      'opencode',
      'copilot',
      'gemini',
      'mock-full',
    ]);
  });
});
