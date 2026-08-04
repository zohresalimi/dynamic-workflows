/**
 * KAR-01.5 — the lint and format pipeline exercised for real: a real oxlint
 * binary catching a real floating promise, a real biome binary rewriting a
 * real misformatted .vue file, and the ownership-split consequence — turn
 * Biome's linter back on and it duplicates oxlint's diagnostic — demonstrated
 * once mechanically rather than trusted.
 *
 * These shell out to the real binaries in node_modules/.bin against the
 * repo's real biome.json / .oxlintrc.json, over disposable fixtures in a
 * temp directory: the config's own shape is asserted separately, statically,
 * in test/lint-format-pipeline.test.ts.
 *
 * Verifies: EPIC-01-S20 (the lint half), EPIC-01-S22 (scenarios 2 and 4) ·
 * AC2, AC5, AC6; test plan #2, #3, #4
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { repoRoot } from '../support/workspace.ts';

const OXLINT = join(repoRoot, 'node_modules/.bin/oxlint');
const BIOME = join(repoRoot, 'node_modules/.bin/biome');
const BIOME_CONFIG = join(repoRoot, 'biome.json');
const OXLINT_CONFIG = join(repoRoot, '.oxlintrc.json');

const A_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
  },
});

interface Run {
  readonly code: number;
  readonly output: string;
}

function run(bin: string, args: readonly string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile(bin, args, { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        code: error === null ? 0 : ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1),
        output: `${stdout}\n${stderr}`,
      });
    });
  });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'deflow-lint-pipeline-'));
});

afterEach(() => {
  if (process.env.DeFlow_KEEP_TMP !== '1') rmSync(dir, { recursive: true, force: true });
});

suite('oxlint --type-aware catches the bug the pipeline exists for (AC2, test plan #2)', () => {
  it('fires typescript/no-floating-promises on an unawaited async call', async () => {
    writeFileSync(join(dir, 'tsconfig.json'), A_TSCONFIG);
    const file = join(dir, 'floating.ts');
    writeFileSync(
      file,
      'async function doWork(): Promise<void> {\n' +
        '  return;\n' +
        '}\n\n' +
        'export function run(): void {\n' +
        '  doWork();\n' +
        '}\n',
    );

    const result = await run(OXLINT, ['--type-aware', '-c', OXLINT_CONFIG, file]);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('typescript(no-floating-promises)');
  });

  it('does not fire when the same call is awaited', async () => {
    writeFileSync(join(dir, 'tsconfig.json'), A_TSCONFIG);
    const file = join(dir, 'awaited.ts');
    writeFileSync(
      file,
      'async function doWork(): Promise<void> {\n' +
        '  await Promise.resolve();\n' +
        '}\n\n' +
        'export async function run(): Promise<void> {\n' +
        '  await doWork();\n' +
        '}\n',
    );

    const result = await run(OXLINT, ['--type-aware', '-c', OXLINT_CONFIG, file]);

    expect(result.output).not.toContain('no-floating-promises');
    expect(result.code).toBe(0);
  });
});

suite('the .vue opt-in is doing real work (AC6, test plan #3)', () => {
  it('biome check --write rewrites a deliberately misformatted SFC, template included', async () => {
    const file = join(dir, 'messy.vue');
    const before =
      '<template>\n' +
      '    <div            class="a"   >\n' +
      '        {{ msg }}\n' +
      '    </div>\n' +
      '</template>\n\n' +
      '<script setup lang="ts">\n' +
      "const   msg    =   'hi'\n" +
      '</script>\n';
    writeFileSync(file, before);

    const result = await run(BIOME, ['check', '--write', '--config-path', BIOME_CONFIG, file]);

    expect(result.code).toBe(0);
    const after = readFileSync(file, 'utf8');
    expect(after).not.toBe(before);
    // Both halves changed: the opt-in reaches the template, not merely the
    // embedded <script> block that some formatting can reach without it.
    expect(after).toContain('<div class="a">');
    expect(after).toContain("const msg = 'hi';");
  });
});

suite('linter.enabled: false is load-bearing (AC5, EPIC-01-S22 scenario 4, test plan #4)', () => {
  const dupeSource = 'function example(): number {\n  const unused = 1;\n  return 2;\n}\n';

  it('the production config finds nothing to lint, so no duplicate is even possible', async () => {
    const file = join(dir, 'dupe.ts');
    writeFileSync(file, dupeSource);

    const result = await run(BIOME, ['lint', '--config-path', BIOME_CONFIG, file]);

    expect(result.output).not.toContain('lint/correctness');
  });

  it('enabling it alongside oxlint reproduces the exact duplicate the config prevents', async () => {
    const file = join(dir, 'dupe.ts');
    writeFileSync(file, dupeSource);
    const linterOnConfig = join(dir, 'biome-linter-enabled.json');
    writeFileSync(
      linterOnConfig,
      JSON.stringify({ linter: { enabled: true, rules: { recommended: true } } }),
    );

    const [biomeResult, oxlintResult] = await Promise.all([
      run(BIOME, ['lint', '--config-path', linterOnConfig, file]),
      run(OXLINT, ['-c', OXLINT_CONFIG, file]),
    ]);

    // The same unused binding, on the same lines, flagged under each tool's
    // own rule name — the exact duplicate "linter.enabled: false" prevents.
    expect(biomeResult.output).toContain('noUnusedVariables');
    expect(biomeResult.code).toBe(0);
    expect(oxlintResult.output).toContain('no-unused-vars');
    expect(oxlintResult.code).not.toBe(0);
  });
});
