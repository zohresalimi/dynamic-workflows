/**
 * KAR-23.11 — a node that produced nothing does not report `completed`.
 *
 * On 2026-08-24, `run_20260824T143505Z_3a7365` took four implementation nodes
 * to `node.completed` over twenty-two minutes. Every branch
 * `DeFlow/run_20260824t143505z_3a7365__*` holds zero commits and an empty diff
 * against main; the completion payloads carry `artifacts: []` beside an
 * `output.text` saying, in the agent's own words, *"I am blocked before any
 * code could land"* and *"I wrote no files"*. Nothing in the ledger, the CLI or
 * the UI noticed. The run looked healthy.
 *
 * Integration rather than unit because the claim is about the **ledger** after
 * a real spawn: a `node.failed` where a `node.completed` used to be, its spend
 * beside it, and no `node.completed` anywhere. The pure predicate has its own
 * suite in `src/scope-audit.test.ts`; what that cannot show is that the two
 * runners really reach it before their completion transaction, on both routes.
 *
 * The auditor here is a real one over the real worktree — it lists what the
 * turn left on disk. Counting *commits* needs `git`, which this package may
 * never spawn (docs/09-workspace-and-safety.md §11.4), so the commit half is
 * supplied as data and proved against real git in
 * `packages/daemon/test/integration/scope-diff.test.ts`.
 *
 * Verifies: KAR-23.11 · MET-1010
 */
import {
  type NodeId,
  NodeIdSchema,
  type ProviderId,
  ProviderIdSchema,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';
import { it, linkFakeAgent, TestClock } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { expect, describe as suite } from 'vitest';
import {
  type AcpNodeRequest,
  runAcpNode,
  runShimNode,
  type ScopeAudit,
  type ShimNodeRequest,
  type ShimPorts,
  shimCapabilityRow,
} from '../../src/index.ts';
import {
  mockAgentBinary,
  openTestLedger,
  readEvidence,
  scenario,
  type TestLedger,
} from './support/harness.ts';

const RUN: RunId = RunIdSchema.parse('run_20260824T143505Z_3a7365');
const NODE: NodeId = NodeIdSchema.parse('api-credit-reads');
const CLAUDE: ProviderId = ProviderIdSchema.parse('claude');
const MOCK: ProviderId = ProviderIdSchema.parse('mock');
const SESSION = '3f2504e0-4f89-41d3-9a0c-0305e82c3303';
const NOW = 1_800_000_000_000;

/** The declared write scope of a node the plan says will change files. */
const WRITE_SCOPE = ['src/**'];

/**
 * A real auditor over a real directory: whatever the turn left on disk is what
 * it changed.
 *
 * `commitsAhead` is supplied rather than measured, because counting commits
 * means spawning `git` and this package never does
 * (docs/09-workspace-and-safety.md §11.4). `warning` is always `null`: every
 * file these scenarios write is inside `src/**`, and out-of-scope detection is
 * KAR-08.7's suite rather than this one's.
 */
const auditor = (worktree: string, commitsAhead = 0): ScopeAudit => {
  return () =>
    Promise.resolve({
      changed: readdirSync(worktree, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(String(entry.parentPath), entry.name).slice(worktree.length + 1)),
      commitsAhead,
      warning: null,
    });
};

/** The kinds the ledger holds, in order. */
const kindsOf = (ledger: TestLedger): string[] =>
  ledger.events().map((event) => event.kind as string);

const failureOf = (ledger: TestLedger): Record<string, unknown> =>
  (
    ledger.events().find((event) => event.kind === 'node.failed')?.payload as {
      failure: Record<string, unknown>;
    }
  ).failure;

// ── the exec-shim route ──────────────────────────────────────────────────────

interface ShimHarness {
  readonly ledger: TestLedger;
  readonly dataDir: string;
  readonly worktree: string;
  run(overrides?: Partial<ShimNodeRequest>, audit?: ScopeAudit): ReturnType<typeof runShimNode>;
}

/** A turn that says something and writes nothing — the incident's own shape. */
const APOLOGY = 'I am blocked before any code could land. I wrote no files.';

const shimScenario = (text: string, writes: readonly { path: string; content: string }[] = []) =>
  JSON.stringify({
    name: 'says-something',
    description: 'One turn that answers, with or without touching the worktree.',
    sessionId: SESSION,
    steps: [{ type: 'message', text }],
    ...(writes.length === 0 ? {} : { writeFiles: writes.map((file) => ({ ...file })) }),
    result: { subtype: 'success', text, totalCostUsd: 0.01 },
  });

async function shimHarness(tmp: string, binary: string, script: string): Promise<ShimHarness> {
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  const worktree = join(tmp, 'wt');
  await mkdir(join(worktree, 'src'), { recursive: true });
  const ledger = openTestLedger(dataDir);

  const request: ShimNodeRequest = {
    runId: RUN,
    nodeId: NODE,
    attempt: 0,
    provider: CLAUDE,
    // `read` rather than `worktree`, and the mismatch with the write scope is
    // deliberate on two counts. Practically, `worktree` needs a sandbox this
    // machine may not have, and admission refuses the node before the runner is
    // reached at all — every shim fixture in this directory runs at `read` for
    // that reason. Substantively, a `read` node carrying a non-empty write scope
    // is *precisely* the case KAR-23.11 refuses to exempt: it is structurally
    // incapable of the work its plan promised, and letting it complete would
    // reopen the defect through a second door.
    permission: 'read',
    worktree,
    prompt: 'implement the credit reads',
    sessionId: SESSION,
    pathScope: WRITE_SCOPE,
    binary: {
      path: binary,
      version: '2.1.220',
      sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
    },
    sandbox: {
      version: '2.1.220',
      platform: 'darwin',
      roots: [join(tmp, 'bin')],
      configDir: join(tmp, 'sandbox'),
    },
    env: {
      ...process.env,
      DeFlow_FAKE_DIALECT: 'claude-stream-json',
      DeFlow_FAKE_SCENARIO: script,
      DeFlow_FAKE_SEED: '42',
      DeFlow_FAKE_NOW: String(NOW),
    },
  };

  const portsWith = (audit: ScopeAudit): ShimPorts => ({
    clock: { now: () => NOW, setTimer: () => ({ cancel: () => {} }) },
    ledger: ledger.sink,
    captureEvidence: ledger.captureEvidence,
    scopeAudit: audit,
    capabilityRow: shimCapabilityRow({
      provider: CLAUDE,
      version: '2.1.220',
      binaryPath: binary,
      binarySha256: request.binary.sha256,
      probedAt: NOW,
    }),
  });

  return {
    ledger,
    dataDir,
    worktree,
    run: (overrides = {}, audit = auditor(worktree)) =>
      runShimNode({ ...request, ...overrides }, portsWith(audit)),
  };
}

suite('the exec-shim route — a write-scoped node that changed nothing', () => {
  it('fails with contract.no-work-product instead of completing', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await shimHarness(tmp, agent.binary, shimScenario(APOLOGY));

    const outcome = await test.run();

    expect(outcome.status).toBe('failed');
    const failure = failureOf(test.ledger);
    expect(failure.reason).toBe('contract.no-work-product');
    expect(failure.class).toBe('permanent');
    expect(String(failure.message)).toContain('src/**');

    // The whole point: not a completion anywhere in the ledger. On 2026-08-24
    // this is where four of them were.
    const kinds = kindsOf(test.ledger);
    expect(kinds, `the ledger was: ${kinds.join(' → ')}`).not.toContain('node.completed');
    expect(kinds).toContain('node.failed');

    // Twenty-two failed minutes are still spend, and it lands in the same
    // transaction the completion path would have used.
    expect(kinds.indexOf('budget.consumed')).toBe(kinds.indexOf('node.failed') - 1);

    // The agent's own account of the turn, kept as a handle rather than parsed.
    // DeFlow measures the worktree; it does not sniff for apologies — and it
    // keeps the text so the human reading the failure sees what the incident's
    // investigator had to go looking for.
    const evidence = (failure.evidence as string[]).map((handle) =>
      Buffer.from(readEvidence(test.dataDir, handle)).toString('utf8'),
    );
    expect(evidence.join('\n')).toContain('I wrote no files');

    test.ledger.close();
  });

  it('completes normally when the same agent writes one file', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await shimHarness(
      tmp,
      agent.binary,
      shimScenario('done', [{ path: 'src/credits.ts', content: 'export const credits = 1;\n' }]),
    );

    const outcome = await test.run();

    expect(outcome.status).toBe('completed');
    expect(kindsOf(test.ledger)).toContain('node.completed');
    test.ledger.close();
  });

  it('completes when the agent committed its own work — a clean worktree is not an empty one', async ({
    tmp,
  }) => {
    // Load-bearing. DeFlow's model is that a node's work sits dirty and is
    // salvage-committed at teardown, so `git status` is normally the whole
    // answer — but an agent that commits its own work leaves a *clean* status.
    // Failing that node would be the worst false positive available.
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await shimHarness(tmp, agent.binary, shimScenario('committed it myself'));

    const outcome = await test.run({}, auditor(test.worktree, 1));

    expect(outcome.status).toBe('completed');
    expect(kindsOf(test.ledger)).not.toContain('node.failed');
    test.ledger.close();
  });

  it('completes a legitimately-empty node: pathScope [] is never even asked', async ({ tmp }) => {
    // A reviewer, a verification agent, a node that only returns a document.
    // No exemption in the rule — the node's own declared contract says it
    // changes nothing, and `auditCompletionScope` returns before the check.
    const agent = await linkFakeAgent(tmp, 'claude');
    const test = await shimHarness(tmp, agent.binary, shimScenario('the diff looks correct'));

    const outcome = await test.run({ pathScope: [] });

    expect(outcome.status).toBe('completed');
    expect(kindsOf(test.ledger)).toContain('node.completed');
    expect(kindsOf(test.ledger)).not.toContain('node.failed');
    test.ledger.close();
  });
});

// ── the ACP route ────────────────────────────────────────────────────────────

suite('the ACP route — the same rule, at the same chokepoint', () => {
  const acpRequest = (worktree: string, over: Partial<AcpNodeRequest> = {}): AcpNodeRequest => ({
    runId: RUN,
    nodeId: NODE,
    attempt: 0,
    provider: MOCK,
    permission: 'worktree',
    worktree,
    binary: mockAgentBinary(),
    argv: ['--seed', '42', '--scenario', scenario('minimal-turn.jsonc')],
    mcpServers: [],
    prompt: 'implement the credit reads',
    pathScope: WRITE_SCOPE,
    ...over,
  });

  it('fails a write-scoped node that left the worktree untouched', async ({ tmp }) => {
    const worktree = join(tmp, 'wt', 'n1');
    await mkdir(worktree, { recursive: true });
    const ledger = openTestLedger(tmp);

    const outcome = await runAcpNode(acpRequest(worktree), {
      clock: new TestClock(),
      ledger: ledger.sink,
      captureEvidence: ledger.captureEvidence,
      scopeAudit: auditor(worktree),
    });

    expect(outcome.status).toBe('failed');
    const kinds = kindsOf(ledger);
    expect(kinds, `the ledger was: ${kinds.join(' → ')}`).not.toContain('node.completed');
    expect(failureOf(ledger).reason).toBe('contract.no-work-product');
    expect(kinds.indexOf('budget.consumed')).toBe(kinds.indexOf('node.failed') - 1);
    ledger.close();
  });

  it('completes the same node once one file exists in its worktree', async ({ tmp }) => {
    const worktree = join(tmp, 'wt', 'n1');
    await mkdir(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'credits.ts'), 'export const credits = 1;\n', 'utf8');
    const ledger = openTestLedger(tmp);

    const outcome = await runAcpNode(acpRequest(worktree), {
      clock: new TestClock(),
      ledger: ledger.sink,
      captureEvidence: ledger.captureEvidence,
      scopeAudit: auditor(worktree),
    });

    expect(outcome.status).toBe('completed');
    expect(kindsOf(ledger)).toContain('node.completed');
    ledger.close();
  });

  it('completes a legitimately-empty node with pathScope []', async ({ tmp }) => {
    const worktree = join(tmp, 'wt', 'n1');
    await mkdir(worktree, { recursive: true });
    const ledger = openTestLedger(tmp);

    const outcome = await runAcpNode(acpRequest(worktree, { pathScope: [] }), {
      clock: new TestClock(),
      ledger: ledger.sink,
      captureEvidence: ledger.captureEvidence,
      scopeAudit: auditor(worktree),
    });

    expect(outcome.status).toBe('completed');
    expect(kindsOf(ledger)).not.toContain('node.failed');
    ledger.close();
  });

  it('completes when the agent committed its own work', async ({ tmp }) => {
    const worktree = join(tmp, 'wt', 'n1');
    await mkdir(worktree, { recursive: true });
    const ledger = openTestLedger(tmp);

    const outcome = await runAcpNode(acpRequest(worktree), {
      clock: new TestClock(),
      ledger: ledger.sink,
      captureEvidence: ledger.captureEvidence,
      scopeAudit: auditor(worktree, 1),
    });

    expect(outcome.status).toBe('completed');
    ledger.close();
  });
});
