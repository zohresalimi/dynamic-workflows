/**
 * KAR-05.7 AC4 — the same battery, against a **real installed CLI**, behind an
 * `@live` tag CI never selects.
 *
 * The tag is in the suite's name, and the gate is `DeFlow_LIVE=1` plus a path
 * to a binary. Both are required and neither is set anywhere in
 * `.github/workflows/`, which `test/conformance-suite.test.ts` asserts rather
 * than trusts. Nothing here runs on a commit: a real vendor CLI costs real
 * quota against the developer's own subscription, needs credentials CI does
 * not have, and answers differently on different days — a suite that ran it
 * automatically would be red for reasons nobody could act on, which is how a
 * suite stops being read.
 *
 * `deflow doctor` (EPIC-18, KAR-18.4) is the natural home for this against the
 * versions a *user* has installed. Until it exists, this is how a maintainer
 * asks the question by hand:
 *
 *   DeFlow_LIVE=1 DeFlow_LIVE_BIN=/opt/homebrew/bin/claude-agent-acp \
 *     pnpm vitest run --project integration -t '@live'
 *
 * Verifies: EPIC-05-S26 (scenario 3) · AC4
 */

import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConformanceAdapter, ConformanceCase, ConformancePorts } from '../../src/index.ts';
import {
  liveInGroup,
  NODE_ID,
  openTestLedger,
  PROVIDER,
  RUN_ID,
  type TestLedger,
} from './support/harness.ts';
import { providerContract } from './support/provider-contract.ts';

/** Both, deliberately: a tag alone is one stray `-t` away from spending quota. */
const LIVE_BIN = process.env.DeFlow_LIVE_BIN;
const ENABLED = process.env.DeFlow_LIVE === '1' && LIVE_BIN !== undefined;

let dir = '';
let ledger: TestLedger;

describe.runIf(ENABLED)('@live', () => {
  beforeAll(async () => {
    dir = await makeTempDir();
    ledger = openTestLedger(dir);
  });

  afterAll(async () => {
    ledger.close();
    await removeTempDir(dir);
  });

  const ports = async (): Promise<ConformancePorts> => ({
    clock: new TestClock(),
    ledger: ledger.sink,
    captureEvidence: ledger.captureEvidence,
    worktree: async (kase: ConformanceCase): Promise<string> => {
      const worktree = join(dir, 'wt', kase);
      await mkdir(worktree, { recursive: true });
      return worktree;
    },
    runId: RUN_ID,
    nodeId: NODE_ID,
    provider: PROVIDER,
    liveInGroup,
  });

  providerContract(
    (): ConformanceAdapter => {
      const path = LIVE_BIN as string;
      return {
        name: `live:${path}`,
        // Nothing has been probed for a binary named on the command line, so
        // every capability-dependent assertion skips *with that reason* rather
        // than guessing from the vendor's name — which is the rule this whole
        // package is built on.
        capabilityRow: null,
        stage(kase: ConformanceCase) {
          // A real CLI cannot be told to emit a malformed line or a 10 MB
          // frame on demand, and pretending otherwise would report a pass for
          // an assertion that never ran. Those two are the mock's job.
          if (kase === 'malformed-line' || kase === 'oversized-frame') {
            return {
              kind: 'unavailable' as const,
              reason: `stimulus-unavailable: a real CLI cannot be asked to produce ${kase}`,
            };
          }
          return {
            kind: 'target' as const,
            binary: {
              path,
              version: 'live',
              sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
            },
          };
        },
      };
    },
    { label: `installed CLI (${LIVE_BIN ?? 'unset'})`, ports, timeoutMs: 600_000 },
  );
});

describe('the @live gate itself', () => {
  it('is off unless DeFlow_LIVE=1 and DeFlow_LIVE_BIN are both set', () => {
    // The one spec in this file that runs on a commit, and it asserts the
    // absence of the thing that would spend money.
    expect(ENABLED).toBe(process.env.DeFlow_LIVE === '1' && LIVE_BIN !== undefined);
    if (process.env.CI !== undefined) expect(ENABLED).toBe(false);
  });
});
