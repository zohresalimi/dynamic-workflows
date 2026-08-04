/**
 * KAR-02.8 — the emitter and the drift check, run as the real scripts.
 *
 * Integration rather than unit because the thing under test is a subprocess
 * that writes files: a spec that imported the scripts' functions would prove
 * the diff algorithm and nothing about `pnpm schemas:check` being wired up,
 * runnable, and non-zero on drift — which is the whole of AC2.
 *
 * Verifies: EPIC-02-S24 · AC1, AC2, AC3 · test plan #2, #3
 */
import { execFile } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, describe as suite } from 'vitest';
import { REGISTERED_SCHEMA_IDS } from '../../src/json-schema.ts';

const repoRoot = new URL('../../../../', import.meta.url).pathname;
const committedDir = join(repoRoot, 'schemas');
const EMIT = 'packages/core/scripts/emit-schemas.ts';
const CHECK = 'packages/core/scripts/check-schemas.ts';

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const tmpDirs: string[] = [];

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'DeFlow-schemas-'));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  if (process.env.DeFlow_KEEP_TMP === '1') return;
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const run = (command: string, args: readonly string[]): Promise<Run> =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code:
            error === null ? 0 : ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1),
          stdout,
          stderr,
        });
      },
    );
  });

suite('pnpm schemas:emit (AC1, test plan #2)', () => {
  it('writes one 2020-12 file per registered schemaId, byte-identical to the committed dir', async () => {
    const out = tmp();
    const emitted = await run('node', [EMIT, '--dir', out]);

    expect(emitted.stderr).toBe('');
    expect(emitted.code).toBe(0);

    const written = readdirSync(out).sort();
    expect(written).toEqual([...REGISTERED_SCHEMA_IDS].map((id) => `${id}.json`).sort());

    for (const file of written) {
      const text = readFileSync(join(out, file), 'utf8');
      expect(JSON.parse(text).$schema, file).toBe('https://json-schema.org/draft/2020-12/schema');
      // Content, never mtimes: a check that compares timestamps is green on a
      // fresh clone and green on a stale tree, which is the failure mode this
      // whole story exists to make impossible.
      expect(text, file).toBe(readFileSync(join(committedDir, file), 'utf8'));
    }
  });
});

suite('pnpm schemas:check (AC2, AC3, EPIC-02-S24)', () => {
  it('exits 0 and prints nothing to stderr on a clean tree', async () => {
    // --silent suppresses pnpm's own "$ node …" banner, which it writes to
    // stderr for every script it runs. Without it this asserts on pnpm's
    // output rather than the checker's.
    const checked = await run('pnpm', ['--silent', 'schemas:check']);

    expect(checked.stderr).toBe('');
    expect(checked.code).toBe(0);
  });

  it('exits non-zero, names the schemaId and prints a unified diff when a file is stale', async () => {
    // A Zod schema that gained a required field and was never re-emitted is,
    // from the checker's side, exactly this: a file on disk missing something
    // the generated document has.
    const stale = tmp();
    cpSync(committedDir, stale, { recursive: true });
    const target = join(stale, 'DeFlow.fact.v1.json');
    const document = JSON.parse(readFileSync(target, 'utf8'));
    document.required = document.required.filter((field: string) => field !== 'provenance');
    writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`);

    const checked = await run('node', [CHECK, '--dir', stale]);

    expect(checked.code).not.toBe(0);
    expect(checked.stderr).toContain('DeFlow.fact.v1');
    expect(checked.stderr).toContain('--- ');
    expect(checked.stderr).toContain('+++ ');
    expect(checked.stderr).toMatch(/^\+\s*"provenance"/m);
    expect(checked.stderr).toContain('pnpm schemas:emit');
  });

  it('exits non-zero and names a registered schema that has no file at all', async () => {
    const missing = tmp();
    cpSync(committedDir, missing, { recursive: true });
    rmSync(join(missing, 'DeFlow.verdict.v1.json'));

    const checked = await run('node', [CHECK, '--dir', missing]);

    expect(checked.code).not.toBe(0);
    expect(checked.stderr).toContain('DeFlow.verdict.v1');
  });

  it('exits non-zero on a schema file no registered id claims', async () => {
    const orphaned = tmp();
    cpSync(committedDir, orphaned, { recursive: true });
    writeFileSync(join(orphaned, 'DeFlow.ghost.v1.json'), '{}\n');

    const checked = await run('node', [CHECK, '--dir', orphaned]);

    expect(checked.code).not.toBe(0);
    expect(checked.stderr).toContain('DeFlow.ghost.v1');
  });

  it('re-emitting makes it green again (EPIC-02-S24 scenario 3)', async () => {
    const repaired = tmp();
    cpSync(committedDir, repaired, { recursive: true });
    writeFileSync(join(repaired, 'DeFlow.fact.v1.json'), '{}\n');
    expect((await run('node', [CHECK, '--dir', repaired])).code).not.toBe(0);

    await run('node', [EMIT, '--dir', repaired]);

    expect(await run('node', [CHECK, '--dir', repaired])).toMatchObject({ code: 0, stderr: '' });
  });
});
