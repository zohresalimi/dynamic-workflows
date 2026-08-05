/**
 * Conformance assertion 7 — a line that is not JSON at all.
 *
 * Found by the battery itself: before this spec existed, DeFlow read
 * `DeFlow-mock-agent --malformed-line` and reported a **completed** turn. The
 * SDK's line reader drops a line it cannot parse and carries on, which is a
 * reasonable thing for a transport library to do and the wrong thing for
 * DeFlow — `adapter.malformed-output` and `adapter.protocol-error` are separate
 * reasons with different `class` values and therefore different scheduler
 * decisions (docs/04-domain-model.md §8), and a silently-dropped frame is
 * neither. It is a node that appears to have succeeded while part of its
 * transcript was thrown away, which is the one failure mode a durable ledger
 * cannot survive: the missing frame is missing from the replay too.
 *
 * So the check is in the transport, beside the frame guard and for the same
 * reason: that is the last place where a complete line is still bytes.
 *
 * Verifies: EPIC-05-S26 (assertion 7) · KAR-05.7 AC3
 */

import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { runAcpNode } from '../../src/index.ts';
import {
  liveInGroup,
  mockAgentBinary,
  NODE_ID,
  openTestLedger,
  PROVIDER,
  RUN_ID,
  readEvidence,
  scenario,
  type TestLedger,
} from './support/harness.ts';

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

const run = (argv: readonly string[]) =>
  runAcpNode(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      provider: PROVIDER,
      permission: 'worktree',
      worktree,
      binary: mockAgentBinary(),
      argv,
      mcpServers: [],
      prompt: 'hello',
    },
    { clock: new TestClock(), ledger: ledger.sink, captureEvidence: ledger.captureEvidence },
  );

suite('a malformed line ends the node instead of disappearing', () => {
  it('fails with adapter.malformed-output rather than completing', async () => {
    const outcome = await run(['--seed', '42', '--malformed-line']);

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.reason).toBe('adapter.malformed-output');
    // Permanent: the same build of the same binary writes the same bytes on
    // the next attempt, so a retry is a second three-hour wait for the same
    // answer.
    expect(outcome.failure.class).toBe('permanent');
  });

  it('keeps the offending bytes as evidence, so the report is readable', async () => {
    const outcome = await run(['--seed', '42', '--malformed-line']);
    if (outcome.status !== 'failed') throw new Error('expected a failure');

    const evidence = outcome.failure.evidence
      .map((handle) => Buffer.from(readEvidence(dir, handle)).toString('utf8'))
      .join('\n');
    // The mock's malformed line is an unbalanced brace: valid-looking enough
    // that a reader believes it has a frame until JSON.parse says otherwise.
    expect(evidence).toContain('{');
  });

  it('tears the session down and leaves nothing running', async () => {
    const outcome = await run(['--seed', '42', '--malformed-line']);
    expect(outcome.exit).not.toBeNull();
    expect(liveInGroup(outcome.pgid)).toEqual([]);
    // The daemon is still here, which is the "no crash" half of the assertion.
    expect(ledger.events().map((event) => event.kind)).toContain('node.failed');
  });

  it('leaves a well-formed turn alone — the check is on the bytes, not on the agent', async () => {
    const outcome = await run(['--seed', '42', '--scenario', scenario('minimal-turn.jsonc')]);
    expect(outcome.status).toBe('completed');
  });

  it('does not fire on a frame that is valid JSON but fails schema validation', async () => {
    // `adapter.malformed-output` is "not JSON at all"; a frame the ACP schema
    // rejects is a different reason with a different class, and conflating the
    // two would make the scheduler's decision wrong for one of them.
    const outcome = await run(['--seed', '42', '--invalid-frame']);
    if (outcome.status === 'failed') {
      expect(outcome.failure.reason).not.toBe('adapter.malformed-output');
    }
  });
});
