/**
 * KAR-09.9 AC2 — the schema really reaches the process, and the parsed object
 * really comes back in `structured_output`.
 *
 * A unit test can prove the argv builder emits `--json-schema`. Only a spawn
 * proves that a turn run **without** it comes back with no `structured_output`
 * at all — which is the whole reason the field is read as a tagged
 * `{ present }` rather than as `?? {}`. The fake reproduces the vendor here:
 * no schema flag, no structured output. So a regression that dropped the flag
 * does not quietly produce an empty object that validates against a permissive
 * schema; it produces the contract failure §9.1 asks for.
 *
 * The scenario is written inline rather than as a file: what varies between
 * these cases is one field of the result envelope, and a near-duplicate
 * scenario file per case is how a fixture directory stops being readable.
 *
 * Verifies: EPIC-09-S46 (first scenario), EPIC-09-S50 · AC2 · test plan #3, #4
 */
import {
  type NodeId,
  NodeIdSchema,
  type ProviderId,
  ProviderIdSchema,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';
import { it, linkFakeAgent } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import {
  type NodeWakeRow,
  runShimNode,
  type ShimNodeRequest,
  type ShimPorts,
  shimCapabilityRow,
  structuredOutputContract,
} from '../../src/index.ts';
import { openTestLedger, type TestLedger } from './support/harness.ts';

const RUN: RunId = RunIdSchema.parse('run_20260806T101500Z_ac0509');
const NODE: NodeId = NodeIdSchema.parse('n1');
const CLAUDE: ProviderId = ProviderIdSchema.parse('claude');
const SESSION = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const NOW = 1_800_000_000_000;

/** What the node is contracted to return, and what the fake will send back. */
const FINDING = {
  id: 'f-1',
  severity: 'major',
  message: 'the session cookie is set without the Secure attribute',
  evidence: [],
};

const scenario = (structuredOutput: unknown): string =>
  JSON.stringify({
    name: 'structured-return',
    description: 'One turn that answers with a schema-shaped object.',
    sessionId: SESSION,
    steps: [{ type: 'message', text: 'done' }],
    result: {
      subtype: 'success',
      text: 'done',
      totalCostUsd: 0.01,
      ...(structuredOutput === undefined ? {} : { structuredOutput }),
    },
  });

interface Harness {
  readonly ledger: TestLedger;
  run(overrides?: Partial<ShimNodeRequest>): ReturnType<typeof runShimNode>;
}

async function harness(tmp: string, binary: string, script: string): Promise<Harness> {
  const dataDir = join(tmp, 'data');
  await mkdir(dataDir, { recursive: true });
  const worktree = join(tmp, 'wt');
  await mkdir(worktree, { recursive: true });
  const ledger = openTestLedger(dataDir);

  const request: ShimNodeRequest = {
    runId: RUN,
    nodeId: NODE,
    attempt: 0,
    provider: CLAUDE,
    permission: 'read',
    worktree,
    prompt: 'find the issue',
    sessionId: SESSION,
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

  const ports: ShimPorts = {
    clock: { now: () => NOW, setTimer: () => ({ cancel: () => {} }) },
    ledger: ledger.sink,
    captureEvidence: ledger.captureEvidence,
    capabilityRow: shimCapabilityRow({
      provider: CLAUDE,
      version: '2.1.220',
      binaryPath: binary,
      binarySha256: request.binary.sha256,
      probedAt: NOW,
    }),
    wakes: {
      schedule: async (_row: NodeWakeRow): Promise<void> => {},
    },
  };

  return { ledger, run: (overrides = {}) => runShimNode({ ...request, ...overrides }, ports) };
}

/** The emitted document, where `deflow init` would have put it. */
function writeSchema(tmp: string): string {
  const dir = join(tmp, '.DeFlow', 'schemas');
  const contract = structuredOutputContract({
    provider: 'claude',
    schemaId: 'DeFlow.finding.v1',
    schemasDir: dir,
    maxTokens: 1500,
  });
  writeFileSync(
    contract.schemaPath,
    readFileSync(new URL('../../../../schemas/DeFlow.finding.v1.json', import.meta.url), 'utf8'),
  );
  return contract.schemaPath;
}

suite('the schema reaches the CLI on its own flag (test plan #3)', () => {
  it('passes --json-schema and reads the parsed object back out', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    await mkdir(join(tmp, '.DeFlow', 'schemas'), { recursive: true });
    const schemaPath = writeSchema(tmp);
    const test = await harness(tmp, agent.binary, scenario(FINDING));

    // KAR-19.11 — the file is still written where `deflow init` puts it, and
    // what rides on `--json-schema` is the **document**: Claude Code 2.1.220
    // parses the value as JSON and exited 1 on the path on 2026-08-13.
    const schemaDocument = readFileSync(schemaPath, 'utf8');
    const outcome = await test.run({ schemaPath, schemaDocument });

    expect(outcome.status).toBe('completed');
    const at = outcome.argv.indexOf('--json-schema');
    expect(at).toBeGreaterThanOrEqual(0);
    // Minus `$schema`: claude's own validator has no 2020-12 meta-schema, and
    // the entry declares that one key as stripped (`stripKeys`).
    const { $schema: _dialect, ...sent } = JSON.parse(schemaDocument) as Record<string, unknown>;
    expect(JSON.parse(String(outcome.argv[at + 1]))).toEqual(sent);
    expect(outcome.argv).not.toContain(schemaPath);
    expect(outcome.structuredOutput).toEqual({ present: true, value: FINDING });
    test.ledger.close();
  });

  it('reports an absent structured_output as absent, never as {}', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    // No `schemaPath`: the flag never goes on the argv, so the fake — like the
    // real CLI — emits no `structured_output` at all.
    const test = await harness(tmp, agent.binary, scenario(FINDING));

    const outcome = await test.run();

    expect(outcome.status).toBe('completed');
    expect(outcome.argv).not.toContain('--json-schema');
    expect(outcome.structuredOutput).toEqual({ present: false });
    test.ledger.close();
  });
});
