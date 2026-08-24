/**
 * KAR-23.10 — a client method DeFlow advertised and did not wire is a node
 * failure, not a read-only agent.
 *
 * On `run_20260824T143505Z_3a7365` four implementation nodes ran twenty-two
 * minutes and wrote zero files. The agent said why, in its own output:
 *
 *     Tool permission request failed: Error: "Method not found":
 *     session/request_permission
 *
 * `CLIENT_CAPABILITIES` advertises `fs.readTextFile`, `fs.writeTextFile` and
 * `terminal: true` on every `initialize`, and ACP requires
 * `session/request_permission` of every client — so DeFlow told each agent it
 * could serve seven methods and, with no `handlers` wired, served none. A
 * `-32601` is indistinguishable from *"this client genuinely cannot do that"*,
 * so the agent degraded to read-only and spent the node saying so. Every node
 * **completed**. Green nodes that wrote nothing.
 *
 * So the gap is closed where it can be seen: the agent still gets a real error
 * for its request, and the **turn ends, named**. `internal` because it is
 * DeFlow's bug and not the agent's, `permanent` because no retry against the
 * same build can help and the attempt budget must not be spent proving it.
 *
 * Deliberately a lazy guard — it fires when the method is called, not before
 * the spawn — because `runAcpNode` has legitimate callers that wire no handlers
 * and never need any: the conformance assertions and the capability probe. A
 * pre-spawn refusal would break those; this costs them nothing.
 *
 * Verifies: KAR-23.10
 */

import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { runAcpNode } from '../../src/index.ts';
import {
  MOCK_AGENT_BIN,
  mockAgentBinary,
  NODE_ID,
  openTestLedger,
  PROVIDER,
  RUN_ID,
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

/**
 * An agent whose first act is the thing DeFlow said it could do.
 *
 * `onError` is present and says so, because that is the incident's own shape:
 * the agent has a branch for "the client refused", it takes it, and the turn
 * ends green. Without the branch the test would pass for the wrong reason.
 */
async function scenarioCalling(method: string, params: Record<string, unknown>): Promise<string> {
  const path = join(dir, `${method.replaceAll('/', '-')}.json`);
  await writeFile(
    path,
    JSON.stringify({
      name: 'unimplemented-client-method',
      steps: [
        {
          type: 'clientCall',
          method,
          params,
          onError: { steps: [{ type: 'message', text: 'the client cannot do that' }] },
        },
        { type: 'message', text: 'carried on read-only' },
      ],
      stopReason: 'end_turn',
    }),
  );
  return path;
}

function dispatch(
  scenarioPath: string,
  handlers?: Record<string, (params: never) => unknown>,
): ReturnType<typeof runAcpNode> {
  return runAcpNode(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      provider: PROVIDER,
      permission: 'worktree',
      worktree,
      binary: mockAgentBinary(),
      argv: ['--seed', '42', '--scenario', scenarioPath],
      env: { PATH: process.env.PATH ?? '' },
      mcpServers: [],
      prompt: 'go',
    },
    {
      clock: new TestClock(),
      ledger: ledger.sink,
      captureEvidence: ledger.captureEvidence,
      ...(handlers === undefined ? {} : { handlers }),
    },
  );
}

suite('KAR-23.10 — an advertised client method with nothing behind it fails the node', () => {
  it('names the method, fails permanently, and does not let the turn end green', async () => {
    const outcome = await dispatch(
      await scenarioCalling('fs/write_text_file', {
        path: join(worktree, 'src', 'session.ts'),
        content: 'export const cookie = "sid=1; Secure";\n',
      }),
    );

    // The whole twenty-two minutes, in one assertion: on `master` this is
    // `completed`, and a completed node that wrote nothing looks exactly like a
    // node that had nothing to write.
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.reason).toBe('internal');
    expect(outcome.failure.class).toBe('permanent');
    expect(outcome.failure.message).toContain('fs/write_text_file');

    const kinds = ledger.events().map((event) => event.kind);
    expect(kinds).toContain('node.failed');
    expect(kinds).not.toContain('node.completed');
  });

  it('does the same for session/request_permission, which ACP requires of every client', async () => {
    const scenarioPath = join(dir, 'ask.json');
    await writeFile(
      scenarioPath,
      JSON.stringify({
        name: 'ask',
        steps: [
          {
            type: 'permission',
            title: 'may I edit',
            toolKind: 'edit',
            path: join(worktree, 'src', 'session.ts'),
            options: [
              { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
            ],
            onAllowed: { steps: [{ type: 'message', text: 'allowed' }] },
            onRejected: { steps: [{ type: 'message', text: 'rejected' }] },
            onCancelled: { steps: [{ type: 'message', text: 'cancelled' }] },
          },
        ],
        stopReason: 'end_turn',
      }),
    );

    const outcome = await dispatch(scenarioPath);

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    // Not merely "the turn ended badly" — on `master` an unanswered
    // `session/request_permission` already unwinds, as `adapter.protocol-error`
    // carrying the agent's own `-32601` text, which reads as *the agent* broke
    // the protocol. It did not: DeFlow advertised a method and did not wire it.
    expect(outcome.failure.reason).toBe('internal');
    expect(outcome.failure.class).toBe('permanent');
    expect(outcome.failure.message).toContain('session/request_permission');
    expect(outcome.failure.message).toContain('advertised');
  });

  it('fires only on the gap: a wired method completes exactly as it did before', async () => {
    const written: string[] = [];
    const outcome = await dispatch(
      await scenarioCalling('fs/write_text_file', {
        path: join(worktree, 'src', 'session.ts'),
        content: 'ok\n',
      }),
      {
        'fs/write_text_file': (params: never) => {
          written.push((params as { path: string }).path);
          return {};
        },
        'session/request_permission': () => ({ outcome: { outcome: 'cancelled' } }),
        'fs/read_text_file': () => ({ content: '' }),
        'terminal/create': () => ({ terminalId: 't1' }),
        'terminal/output': () => ({ output: '', truncated: false, exitStatus: null }),
        'terminal/wait_for_exit': () => ({ exitCode: 0, signal: null }),
        'terminal/kill': () => ({}),
        'terminal/release': () => ({}),
      },
    );

    expect(outcome.status).toBe('completed');
    expect(written).toEqual([join(worktree, 'src', 'session.ts')]);
  });
});
