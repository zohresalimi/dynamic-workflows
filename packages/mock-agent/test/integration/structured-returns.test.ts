/**
 * KAR-19.7 AC1, AC6 — the bundled agent answers a turn that carries a schema,
 * and refuses one it cannot serve rather than approximating it.
 *
 * Integration, and a real subprocess, because the whole claim is about the
 * binary: an in-process call to the generator would prove the generator writes
 * a valid document and nothing at all about whether the flag reaches it, what
 * lands on stdout beside it, or what the exit code is. The document is
 * validated **in the test** rather than by the binary — `@DeFlow/mock-agent`
 * ships with exactly one dependency (docs/07-provider-adapter-layer.md §13),
 * so ajv cannot come along — which is why AC1's guarantee is a test-time
 * property of a generator written to be obviously correct.
 *
 * **This file does not verify EPIC-19-S44**, though it claimed to until the gate
 * read it. S44 is the acceptance case — `deflow run --file spec.md` on a machine
 * with no vendor CLI, asserted against the on-disk ledger — and nothing here
 * runs the command or opens a ledger. What it settles is the capability S44
 * *depends on*: that the binary honours the flag its registry entry declares.
 * S44's own clauses live in `e2e/mock-only-run.test.ts`.
 *
 * Verifies: EPIC-19-S45, EPIC-19-S48 · AC1, AC6 · test plan #1, #6
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { expect, it, describe as suite } from 'vitest';
import {
  BUNDLED_PROVIDER_ID,
  MOCK_STRUCTURED_OUTPUT_FLAG,
  PLAN_SCHEMA_ID,
  SERVABLE_SCHEMA_IDS,
} from '../../src/structured.ts';
import { spawnMockAgent } from '../support/harness.ts';

/** The repository's own emitted documents — the bytes `deflow init` copies. */
const SCHEMAS_DIR = fileURLToPath(new URL('../../../../schemas/', import.meta.url));

const schemaFile = (schemaId: string): string => join(SCHEMAS_DIR, `${schemaId}.json`);

// `strict: false` for the same reason the ACP schema suite sets it: the emitted
// documents carry formats ajv has no opinion about, and every one of them would
// otherwise be an exception rather than a validation answer.
const ajv = new Ajv2020.default({ allErrors: true, strict: false, logger: false });

function validate(schemaId: string, document: unknown): string[] {
  const schema = JSON.parse(readFileSync(schemaFile(schemaId), 'utf8')) as object;
  const compiled = ajv.compile(schema);
  return compiled(document)
    ? []
    : (compiled.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

/**
 * One structured turn, as a caller on the exec path runs it: the flag, the
 * schema file, the prompt, and nothing on stdin.
 */
async function serve(
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const agent = spawnMockAgent(args);
  const exit = await agent.finish();
  return { code: exit.code, stdout: agent.stdout().toString('utf8'), stderr: agent.stderr() };
}

const turnFor = (
  schemaId: string,
  extra: readonly string[] = [],
): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> =>
  serve([MOCK_STRUCTURED_OUTPUT_FLAG, schemaFile(schemaId), '--prompt', 'Do the task.', ...extra]);

suite('EPIC-19-S45 — every schema the live chain needs', () => {
  it.each([...SERVABLE_SCHEMA_IDS])('serves %s as one valid document', async (schemaId) => {
    const turn = await turnFor(schemaId);

    expect(turn.stderr).toBe('');
    expect(turn.code).toBe(0);
    // "Exactly one document and nothing else": the bytes on the return channel
    // are the document, with no banner, no trailing prose and no second object.
    const document: unknown = JSON.parse(turn.stdout);
    expect(turn.stdout).toBe(JSON.stringify(document));
    expect(validate(schemaId, document)).toEqual([]);
  });

  it('serves a default plan big enough to be a plan', async () => {
    const turn = await turnFor(PLAN_SCHEMA_ID);
    const plan = JSON.parse(turn.stdout) as { nodes: readonly unknown[] };

    // KAR-19.5 AC2 asserts a compiled plan has at least two nodes, and a
    // one-node default would make that clause unreachable against the only
    // agent the smoke test has.
    expect(plan.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it('routes its own nodes onto itself, so the plan can pass validation at all', async () => {
    const turn = await turnFor(PLAN_SCHEMA_ID);
    const plan = JSON.parse(turn.stdout) as {
      nodes: readonly { type: string; provider?: { prefer: readonly string[] } }[];
    };

    // KAR-19.3 found this the hard way: `prefer: []` is not "no preference", it
    // is a preference nothing satisfies, and `validatePlanVersion` refuses it
    // with `PROVIDER_NOT_PROBED` for every agent node — so the plan the bundled
    // agent proposes could never be compiled, and the epic's own Definition of
    // Done was unreachable. Naming *itself* is not the routing hazard AC8 is
    // about: this binary ships in the same tarball as DeFlow, and it is
    // definitionally on the machine that just used it to plan.
    for (const node of plan.nodes) {
      if (node.type !== 'agent') continue;
      expect(node.provider?.prefer).toEqual([BUNDLED_PROVIDER_ID]);
    }
  });

  it('names no vendor in the plan it proposes', async () => {
    const turn = await turnFor(PLAN_SCHEMA_ID);

    // A default plan that preferred a vendor would route every smoke run onto
    // a CLI the machine may not have — the routing hazard AC8 is about,
    // arriving through the document rather than through the registry.
    for (const vendor of ['claude', 'codex', 'gemini', 'copilot', 'opencode']) {
      expect(turn.stdout).not.toContain(vendor);
    }
  });
});

suite('EPIC-19-S48 — a schema it cannot serve is refused, never approximated', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'DeFlow-mock-schema-'));

  function refusal(stderr: string): void {
    // Listing what it *can* serve is what turns "the smoke test failed" into a
    // one-line diagnosis.
    for (const schemaId of SERVABLE_SCHEMA_IDS) expect(stderr).toContain(schemaId);
  }

  it('refuses an unknown schema id', async () => {
    const path = join(scratch, 'DeFlow.notaschema.v1.json');
    writeFileSync(path, JSON.stringify({ title: 'DeFlow.notaschema.v1', type: 'object' }));

    const turn = await serve([MOCK_STRUCTURED_OUTPUT_FLAG, path, '--prompt', 'x']);

    expect(turn.code).not.toBe(0);
    expect(turn.stdout).toBe('');
    expect(turn.stderr).toContain('DeFlow.notaschema.v1');
    refusal(turn.stderr);
  });

  it('refuses a schema file that is not there', async () => {
    const path = join(scratch, 'DeFlow.taskspecdraft.v1.json');

    const turn = await serve([MOCK_STRUCTURED_OUTPUT_FLAG, path, '--prompt', 'x']);

    expect(turn.code).not.toBe(0);
    expect(turn.stdout).toBe('');
    expect(turn.stderr).toContain(path);
    refusal(turn.stderr);
  });

  it('refuses an unreadable schema file', async () => {
    const path = join(scratch, 'unreadable.DeFlow.taskspecdraft.v1.json');
    writeFileSync(path, '{}');
    chmodSync(path, 0o000);

    const turn = await serve([MOCK_STRUCTURED_OUTPUT_FLAG, path, '--prompt', 'x']);

    expect(turn.code).not.toBe(0);
    expect(turn.stdout).toBe('');
    expect(turn.stderr).toContain(path);
    refusal(turn.stderr);
  });

  it('refuses a schema the repository has but the agent has no generator for', async () => {
    const turn = await serve([
      MOCK_STRUCTURED_OUTPUT_FLAG,
      schemaFile('DeFlow.humandecision.v1'),
      '--prompt',
      'x',
    ]);

    expect(turn.code).not.toBe(0);
    // An empty object validates against a permissive schema, so a caller that
    // received one would have no way to tell a served turn from an unserved
    // one. Zero bytes is the clause with teeth.
    expect(turn.stdout).toBe('');
    expect(turn.stderr).toContain('DeFlow.humandecision.v1');
    refusal(turn.stderr);
  });
});
