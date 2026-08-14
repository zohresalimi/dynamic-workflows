/**
 * KAR-19.7 AC2 — the registry declares the capability, and the declaration is
 * true.
 *
 * The point of this file is that it does not compare two string literals. A
 * test asserting `PROVIDER_SPECS.mock.shim.structuredOutputFlag === '--x'`
 * would go green on a registry that lies, which is the exact failure the story
 * exists to prevent: `providerStructuredOutput` reporting `native` is what
 * lets `admitFraming` schedule a framing turn here, and it has to be true
 * because the binary honours the flag rather than because a constant says so.
 *
 * So the entry's **own** flag is put on the **real** binary's argv, and the
 * document that comes back is the evidence.
 *
 * Verifies: EPIC-19-S46 · AC2 · test plan #2
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import {
  providerSpec,
  providerStructuredOutput,
  structuredOutputContract,
} from '../../src/index.ts';
import { MOCK_AGENT_BIN } from './support/harness.ts';

const SCHEMAS_DIR = fileURLToPath(new URL('../../../../schemas/', import.meta.url));
const DRAFT_SCHEMA_ID = 'DeFlow.taskspecdraft.v1';

const MOCK = 'mock';

function run(argv: readonly string[]): Promise<{ code: number | null; stdout: string }> {
  const child = spawn(MOCK_AGENT_BIN, [...argv], { stdio: ['pipe', 'pipe', 'pipe'] });
  const out: Buffer[] = [];
  child.stdout.on('data', (bytes: Buffer) => out.push(bytes));
  child.stdin.end();
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      resolve({ code, stdout: Buffer.concat(out).toString('utf8') });
    });
  });
}

suite('EPIC-19-S46 — the registry entry earns its answer', () => {
  it('reports native structured output for the bundled agent', () => {
    const manifest = providerStructuredOutput(MOCK);

    expect(manifest.structuredOutput).toBe('native');
    expect(manifest.flag).toBe(providerSpec(MOCK)?.shim.structuredOutputFlag);
  });

  it('honours the entry’s own flag when the real binary is spawned with it', async () => {
    const spec = providerSpec(MOCK);
    if (spec === undefined) throw new Error('PROVIDER_SPECS has no "mock" entry');

    // The argv the registry itself builds for a schema-bearing turn — not one
    // this test assembles, so a builder that dropped the schema would fail
    // here rather than pass by construction.
    const argv = spec.shim.argv({
      resolved: { provider: spec.id, path: MOCK_AGENT_BIN },
      worktree: process.cwd(),
      prompt: 'Frame this task.',
      sessionId: 'mock-session-1',
      permission: 'read',
      schemaPath: join(SCHEMAS_DIR, `${DRAFT_SCHEMA_ID}.json`),
    });

    expect(argv).toContain(spec.shim.structuredOutputFlag);

    const turn = await run(argv);

    expect(turn.code).toBe(0);
    const document = JSON.parse(turn.stdout) as { schemaId?: string };
    expect(document.schemaId).toBe(DRAFT_SCHEMA_ID);
  });

  it('routes the framing contract natively rather than into the prompt', () => {
    const contract = structuredOutputContract({
      provider: MOCK,
      schemaId: DRAFT_SCHEMA_ID,
      schemasDir: SCHEMAS_DIR,
      maxTokens: 4000,
    });

    expect(contract.mechanism).toBe('native');
    expect(contract.promptInjection).toBeNull();
  });
});
