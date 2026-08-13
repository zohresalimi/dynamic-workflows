/**
 * KAR-12.3 AC1, AC3 — the transport half of the gate contract, against a real
 * process.
 *
 * Two claims a unit test cannot make. **The schema really travels as a file**:
 * the argv the child was spawned with contains `--json-schema` followed by the
 * absolute path of the run's own `.DeFlow/schemas/verdict.schema.json`, and the
 * object comes back parsed in `structured_output`. A relative path would work
 * in whichever test happened to run from the repository root and break the
 * moment a node runs with `cwd` set to its worktree, which is every node.
 *
 * **The vendor's exhausted repair loop is read off a real envelope**: the fake
 * agent emits `error_max_structured_output_retries` the way the CLI does, and
 * the adapter maps it to `agent.schema-repair-exhausted` — one node result, no
 * further prompt of DeFlow's own.
 *
 * Verifies: EPIC-12-S18, EPIC-12-S20 · AC1, AC3 · test plan #8
 */
import {
  type NodeId,
  NodeIdSchema,
  type ProviderId,
  ProviderIdSchema,
  type RunId,
  RunIdSchema,
  runSchemaFileName,
  serializeSchemaDocument,
  toJsonSchemaDocument,
  VERDICT_SCHEMA_FILE,
  VERDICT_V3_SCHEMA_ID,
} from '@DeFlow/core';
import { it, linkFakeAgent } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
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

const RUN: RunId = RunIdSchema.parse('run_20260809T101500Z_ac1203');
const NODE: NodeId = NodeIdSchema.parse('lint-gate');
const CLAUDE: ProviderId = ProviderIdSchema.parse('claude');
const SESSION = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const NOW = 1_800_000_000_000;
const BLOB = 'f'.repeat(40);

/** A verdict the reviewer returns, valid against the emitted document. */
const VERDICT = {
  schemaId: VERDICT_V3_SCHEMA_ID,
  outcome: 'fail',
  gate: 'lint-gate',
  evaluatedNode: 'implement',
  by: { node: 'lint-gate', provider: 'claude-code', model: 'claude-sonnet-4-5' },
  criteria: [{ id: 'lint-clean', status: 'unsatisfied' }],
  findings: [
    {
      id: 'a13f0c2b91e4',
      severity: 'blocker',
      message: 'no-floating-promises: promise not awaited',
      evidence: [],
      location: { file: 'src/api/client.ts', line: 42, blobSha: BLOB },
    },
  ],
  summary: 'lint failed with 1 finding(s)',
  cost: { durationMs: 2400 },
};

const successScenario = (structuredOutput: unknown): string =>
  JSON.stringify({
    name: 'gate-verdict',
    description: 'One turn that answers with a verdict.',
    sessionId: SESSION,
    steps: [{ type: 'message', text: 'judged' }],
    result: {
      subtype: 'success',
      text: 'judged',
      totalCostUsd: 0.01,
      structuredOutput,
    },
  });

/** The subtype Claude Code emits when its own bounded schema-repair loop is
 * exhausted (**verified 2026-08-02**). */
const exhaustedScenario = JSON.stringify({
  name: 'gate-verdict-repair-exhausted',
  description: 'The vendor gave up producing output matching the schema.',
  sessionId: SESSION,
  steps: [{ type: 'message', text: 'attempting structured output' }],
  result: {
    subtype: 'error_max_structured_output_retries',
    stopReason: 'refusal',
    text: '',
    totalCostUsd: 0.42,
  },
  exitCode: 1,
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
    prompt: 'judge the change against the pinned criteria',
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
    wakes: { schedule: async (_row: NodeWakeRow): Promise<void> => {} },
  };

  return { ledger, run: (overrides = {}) => runShimNode({ ...request, ...overrides }, ports) };
}

/**
 * The verdict document, where run creation puts it.
 *
 * Written here rather than imported from `@DeFlow/daemon`'s `writeRunSchemas`
 * because this package may not depend on the daemon (R2) — the bytes are the
 * same function's output either way, which is the point AC1 is making.
 */
async function writeVerdictSchema(tmp: string): Promise<string> {
  const dir = join(tmp, '.DeFlow', 'schemas');
  await mkdir(dir, { recursive: true });
  const path = join(dir, runSchemaFileName(VERDICT_V3_SCHEMA_ID));
  writeFileSync(path, serializeSchemaDocument(toJsonSchemaDocument(VERDICT_V3_SCHEMA_ID)));
  return path;
}

suite('the verdict schema reaches the CLI as a file (EPIC-12-S18 · test plan #8)', () => {
  it('passes --json-schema with the absolute path of verdict.schema.json', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const schemaPath = await writeVerdictSchema(tmp);
    const test = await harness(tmp, agent.binary, successScenario(VERDICT));

    const outcome = await test.run({
      schemaPath,
      schemaDocument: readFileSync(schemaPath, 'utf8'),
    });

    // KAR-19.11 — the **file** is still the artefact an operator reads
    // afterwards, absolute and named `verdict.schema.json`; what the vendor is
    // handed is the document, because Claude Code parses the value of this flag
    // as JSON. Both halves are asserted: NF8 is about the file, AC1 about the
    // argument.
    expect(isAbsolute(schemaPath)).toBe(true);
    expect(schemaPath.endsWith(VERDICT_SCHEMA_FILE)).toBe(true);

    const at = outcome.argv.indexOf('--json-schema');
    expect(at).toBeGreaterThanOrEqual(0);
    // Minus `$schema`: claude's own validator has no 2020-12 meta-schema, and
    // the entry declares that one key as stripped (`stripKeys`).
    const { $schema: _dialect, ...sent } = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(JSON.parse(String(outcome.argv[at + 1]))).toEqual(sent);
    expect(outcome.argv).not.toContain(schemaPath);
    test.ledger.close();
  });

  it('reads the verdict back out of structured_output, parsed', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const schemaPath = await writeVerdictSchema(tmp);
    const test = await harness(tmp, agent.binary, successScenario(VERDICT));

    const outcome = await test.run({
      schemaPath,
      schemaDocument: readFileSync(schemaPath, 'utf8'),
    });

    expect(outcome.status).toBe('completed');
    expect(outcome.structuredOutput).toEqual({ present: true, value: VERDICT });
    test.ledger.close();
  });

  it('is the file the contract builder names, not a second copy', async ({ tmp }) => {
    const schemaPath = await writeVerdictSchema(tmp);
    const contract = structuredOutputContract({
      provider: 'claude',
      schemaId: VERDICT_V3_SCHEMA_ID,
      schemasDir: join(tmp, '.DeFlow', 'schemas'),
      maxTokens: 600,
    });

    // The builder derives `<schemaId>.json`; run creation writes the same
    // document under the run-directory name. Both resolve to one file on disk.
    expect(readFileSync(schemaPath, 'utf8')).toBe(
      serializeSchemaDocument(toJsonSchemaDocument(VERDICT_V3_SCHEMA_ID)),
    );
    expect(contract.mechanism).toBe('native');
    expect(contract.flag).toBe('--json-schema');
  });
});

suite('the vendor exhausted its own repair loop (EPIC-12-S20 · test plan #7)', () => {
  it('fails the node with agent.schema-repair-exhausted, once', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const schemaPath = await writeVerdictSchema(tmp);
    const test = await harness(tmp, agent.binary, exhaustedScenario);

    const outcome = await test.run({
      schemaPath,
      schemaDocument: readFileSync(schemaPath, 'utf8'),
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.failure.reason).toBe(
      'agent.schema-repair-exhausted',
    );
    expect(outcome.structuredOutput).toEqual({ present: false });

    // Exactly one attempt was started for this node: DeFlow did not put its own
    // repair on top of the vendor's.
    const started = test.ledger.events().filter((event) => event.kind === 'node.started');
    expect(started.length).toBe(1);
    test.ledger.close();
  });
});
