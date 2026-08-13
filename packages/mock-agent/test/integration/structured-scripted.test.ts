/**
 * KAR-19.7 AC5, AC7 — the failure returns are scriptable, and the structured
 * path is entered only when a schema is supplied.
 *
 * The refusal paths are the half of the chain that is hardest to reach and
 * easiest to leave untested, and until this story reaching them at all needed
 * an installed vendor CLI persuaded to misbehave. The trap the shape has to
 * avoid is the opposite one: if an absent scenario file produced an invalid
 * return, every test that forgot one would exercise the repair loop and nobody
 * would notice the happy path had stopped being covered.
 *
 * Verifies: EPIC-19-S49, EPIC-19-S50 · AC5, AC7 · test plan #5, #7
 */
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { parseScenario } from '../../src/scenario.ts';
import { MOCK_STRUCTURED_OUTPUT_FLAG } from '../../src/structured.ts';
import { connectClient, SCENARIO_DIR, spawnMockAgent } from '../support/harness.ts';

const SCHEMAS_DIR = fileURLToPath(new URL('../../../../schemas/', import.meta.url));
const DRAFT = join(SCHEMAS_DIR, 'DeFlow.taskspecdraft.v1.json');

const scratch = (): string => mkdtempSync(join(tmpdir(), 'DeFlow-mock-scripted-'));

function scenarioFile(body: Record<string, unknown>): string {
  const path = join(scratch(), 'scenario.jsonc');
  writeFileSync(path, JSON.stringify({ name: 'scripted-return', steps: [], ...body }));
  return path;
}

async function serve(
  args: readonly string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const agent = spawnMockAgent(args);
  const exit = await agent.finish();
  return { code: exit.code, stdout: agent.stdout().toString('utf8'), stderr: agent.stderr() };
}

const structured = (
  scenario: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  serve([MOCK_STRUCTURED_OUTPUT_FLAG, DRAFT, '--prompt', 'Do the task.', '--scenario', scenario]);

suite('EPIC-19-S49 — the caller-refusal paths need no vendor CLI', () => {
  it('scripts a document that fails validation', async () => {
    const turn = await structured(scenarioFile({ returns: { kind: 'invalid' } }));

    expect(turn.code).toBe(0);
    const document = JSON.parse(turn.stdout) as Record<string, unknown>;
    // Parseable JSON, and wrong — which is the case the schema-repair loop is
    // for. A truncated return is a different failure and has its own script.
    expect(document.schemaId).toBe('DeFlow.taskspecdraft.v1');
    expect(document.goal).toBeUndefined();
  });

  it('scripts a truncated document', async () => {
    const turn = await structured(scenarioFile({ returns: { kind: 'truncated' } }));

    expect(turn.code).toBe(0);
    expect(turn.stdout.length).toBeGreaterThan(0);
    expect(() => JSON.parse(turn.stdout)).toThrow();
  });

  it('scripts a document verbatim, so a valid-but-unsatisfiable return is reachable', async () => {
    const unsatisfiable = { schemaId: 'DeFlow.taskspecdraft.v1', goal: 'unreachable' };
    const turn = await structured(
      scenarioFile({ returns: { kind: 'document', document: unsatisfiable } }),
    );

    expect(turn.code).toBe(0);
    expect(JSON.parse(turn.stdout)).toEqual(unsatisfiable);
  });

  it('returns a valid document when no scenario scripts one', async () => {
    const turn = await serve([MOCK_STRUCTURED_OUTPUT_FLAG, DRAFT, '--prompt', 'Do the task.']);

    expect(turn.code).toBe(0);
    const document = JSON.parse(turn.stdout) as Record<string, unknown>;
    expect(document.schemaId).toBe('DeFlow.taskspecdraft.v1');
    expect(document.goal).toEqual(expect.any(String));
  });
});

suite('EPIC-19-S50 — a turn with no schema flag is the turn it always was', () => {
  async function acpTurn(args: readonly string[]): Promise<Buffer> {
    const agent = spawnMockAgent(args);
    const { connection } = connectClient(agent);
    await connection.agent.request('initialize', { protocolVersion: 1 });
    const session = await connection.agent.request('session/new', {
      cwd: process.cwd(),
      mcpServers: [],
    });
    await connection.agent.request('session/prompt', {
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    const exit = await agent.finish();
    expect(exit.code).toBe(0);
    return agent.stdout();
  }

  it('ignores a scripted return entirely when no schema was supplied', async () => {
    const withReturn = scenarioFile({
      returns: { kind: 'invalid' },
      steps: [{ type: 'message', text: 'scripted' }],
    });
    const without = scenarioFile({ steps: [{ type: 'message', text: 'scripted' }] });

    // Byte-identical: the structured path is gated on the flag's presence, so
    // a `returns` block is invisible to every turn that carries no schema —
    // which is what keeps this story's cost proportional to what it adds
    // rather than re-recording every fixture EPIC-04 owns.
    expect(
      Buffer.compare(
        await acpTurn(['--scenario', withReturn]),
        await acpTurn(['--scenario', without]),
      ),
    ).toBe(0);
  });

  it('refuses a prompt with no schema to answer, rather than silently dropping it', async () => {
    const turn = await serve(['--prompt', 'Do the task.']);

    expect(turn.code).not.toBe(0);
    expect(turn.stderr).toContain(MOCK_STRUCTURED_OUTPUT_FLAG);
  });

  it('leaves every shipped scenario exactly as EPIC-04 wrote it', () => {
    const files = readdirSync(SCENARIO_DIR).filter((name) => name.endsWith('.jsonc'));
    expect(files.length).toBeGreaterThan(0);

    for (const name of files) {
      const parsed = parseScenario(readFileSync(join(SCENARIO_DIR, name), 'utf8'), name);
      expect(parsed.ok, `${name} no longer parses`).toBe(true);
      // Not one of them scripts a return, so not one of them means anything
      // different than it did before this story — which is the half of "every
      // shipped scenario produces byte-identical output" that a test written
      // *after* the change can honestly state.
      if (parsed.ok) expect(parsed.scenario.returns, name).toBeNull();
    }
  });
});
