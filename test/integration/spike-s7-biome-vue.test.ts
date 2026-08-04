/**
 * KAR-00.6 — what `biome check --write` actually does to real Vue SFCs, run
 * for real, before it is ever wired into a `stage_fixed: true` pre-commit
 * hook (KAR-01.6). Nothing here is mocked: the real `biome` and `oxlint`
 * binaries in node_modules/.bin, a real `git init` in a real `fs.mkdtemp`
 * directory with GIT_CONFIG_GLOBAL/SYSTEM pointed at /dev/null, and the
 * fixtures shared with the `spike/s7-biome-vue` scratch branch.
 *
 * The arithmetic over the resulting `git diff --stat` output, and the note's
 * own claims, are checked in test/spike-s7-biome-vue-diff.test.ts.
 *
 * Verifies: EPIC-00-S20 · AC1, AC2, AC5; test plan #1, #3, #4.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { isBounded, parseDiffStatSummary } from '../../spikes/s7-biome-vue/src/diff-stat.ts';
import {
  COMPLEX_GENERICS_VUE,
  LONG_ATTRS_VUE,
  UNUSED_COMPONENT_VUE,
  UNUSED_VARIABLE_TS,
} from '../../spikes/s7-biome-vue/src/fixtures.ts';
import { readJson, repoRoot } from '../support/workspace.ts';

/**
 * The two adversarial fixtures deliberately maximise how misformatted the
 * `<script setup>` half is, so the diff --stat total this spike measures
 * (33 insertions / 19 deletions, 52 lines) is close to a worst case rather
 * than a typical one; a normal commit touches far less. 80 leaves headroom
 * for that number moving slightly with a Biome patch release without
 * silently accepting an unbounded rewrite.
 */
const MAX_CHANGED_LINES = 80;

const BIOME = join(repoRoot, 'node_modules/.bin/biome');
const OXLINT = join(repoRoot, 'node_modules/.bin/oxlint');
const OXLINT_CONFIG = join(repoRoot, '.oxlintrc.json');
const PRODUCTION_BIOME_CONFIG = join(repoRoot, 'biome.json');

/** The hermetic git environment every git fixture in this repo uses. */
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'DeFlow Test',
  GIT_AUTHOR_EMAIL: 'test@deflow.invalid',
  GIT_COMMITTER_NAME: 'DeFlow Test',
  GIT_COMMITTER_EMAIL: 'test@deflow.invalid',
} as const;

interface Run {
  readonly code: number;
  readonly output: string;
}

function run(bin: string, args: readonly string[], cwd: string): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { cwd, env: { ...process.env, ...GIT_ENV }, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code:
            error === null ? 0 : ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1),
          output: `${stdout}\n${stderr}`,
        });
      },
    );
  });
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'DeFlow-spike-s7-biome-vue-'));
});

afterEach(() => {
  if (process.env.DeFlow_KEEP_TMP !== '1') rmSync(dir, { recursive: true, force: true });
});

/** Real `git init` + an initial commit of the two SFC fixtures, in `dir`. */
async function seedGitRepo(): Promise<void> {
  writeFileSync(join(dir, 'complex-generics.vue'), COMPLEX_GENERICS_VUE);
  writeFileSync(join(dir, 'long-attrs.vue'), LONG_ATTRS_VUE);
  await run('git', ['init', '-q'], dir);
  await run('git', ['add', '-A'], dir);
  await run('git', ['commit', '-q', '-m', 'before: real misformatted Vue SFCs'], dir);
}

suite(
  'with the html block absent, the template markup is a real no-op — the script block is not (AC1, test plan #1)',
  () => {
    // AC1 as written by the epic assumed the whole .vue file is untouched
    // without the opt-in. Measured on Biome 2.5.6: it is not. The `html`
    // block gates only the markup formatter; the embedded <script> block is
    // still handed to Biome's ordinary TS formatter regardless of the flag,
    // so a .vue file with any misformatted TypeScript in it is never a true
    // no-op. What the flag actually gates — confirmed below — is whether the
    // <template> markup itself is touched. The decision note records this
    // correction; it is the spike's own most load-bearing finding.
    it('exits 0 and does not change the <template> markup', async () => {
      await seedGitRepo();
      const config = readJson('biome.json') as Record<string, unknown>;
      delete config.html;
      const configPath = join(dir, 'biome-no-html.json');
      writeFileSync(configPath, JSON.stringify(config, null, 2));
      const templateBefore = extractTemplate(readFileSync(join(dir, 'long-attrs.vue'), 'utf8'));

      const result = await run(BIOME, ['check', '--write', '--config-path', configPath, dir], dir);
      expect(result.code).toBe(0);

      const templateAfter = extractTemplate(readFileSync(join(dir, 'long-attrs.vue'), 'utf8'));
      expect(templateAfter).toBe(templateBefore);
    });

    it('still rewrites the <script> block, so the .vue file is listed as changed', async () => {
      await seedGitRepo();
      const config = readJson('biome.json') as Record<string, unknown>;
      delete config.html;
      const configPath = join(dir, 'biome-no-html.json');
      writeFileSync(configPath, JSON.stringify(config, null, 2));

      await run(BIOME, ['check', '--write', '--config-path', configPath, dir], dir);

      const nameOnly = await run('git', ['diff', '--name-only', '--', '*.vue'], dir);
      expect(nameOnly.output.trim().split('\n').sort()).toEqual([
        'complex-generics.vue',
        'long-attrs.vue',
      ]);
    });
  },
);

/** The exact bytes between (and including) the `<template>`/`</template>` tags. */
function extractTemplate(source: string): string {
  const start = source.indexOf('<template>');
  const end = source.indexOf('</template>') + '</template>'.length;
  return source.slice(start, end);
}

suite(
  'with the html block present, the same command produces a diff (AC2, mechanical half)',
  () => {
    it('rewrites both SFCs and the change is bounded', async () => {
      await seedGitRepo();

      const result = await run(
        BIOME,
        ['check', '--write', '--config-path', PRODUCTION_BIOME_CONFIG, dir],
        dir,
      );
      expect(result.code).toBe(0);

      const nameOnly = await run('git', ['diff', '--name-only', '--', '*.vue'], dir);
      expect(nameOnly.output.trim().split('\n').sort()).toEqual([
        'complex-generics.vue',
        'long-attrs.vue',
      ]);

      const stat = await run('git', ['diff', '--stat', '--', '*.vue'], dir);
      const total = parseDiffStatSummary(stat.output);
      expect(total.filesChanged).toBe(2);
      expect(isBounded(total, MAX_CHANGED_LINES)).toBe(true);
    });

    it('preserves the generic type parameters instead of mangling them (AC3)', async () => {
      await seedGitRepo();
      await run(BIOME, ['check', '--write', '--config-path', PRODUCTION_BIOME_CONFIG, dir], dir);

      const after = readFileSync(join(dir, 'complex-generics.vue'), 'utf8');
      expect(after).toContain(
        'interface GraphNode<TPayload extends Record<string, unknown> = Record<string, unknown>>',
      );
      expect(after).toContain('function collect<TPayload, TResult>(');
      expect(after).toContain("status: 'pending' | 'running' | 'done'");
    });

    it('wraps the long attribute list onto multiple lines instead of one unreadable line (AC3)', async () => {
      await seedGitRepo();
      await run(BIOME, ['check', '--write', '--config-path', PRODUCTION_BIOME_CONFIG, dir], dir);

      const after = readFileSync(join(dir, 'long-attrs.vue'), 'utf8');
      const buttonOpenTag = after.slice(after.indexOf('<button'), after.indexOf('>Submit'));
      expect(buttonOpenTag.split('\n').length).toBeGreaterThan(1);
      expect(buttonOpenTag).toContain('type="button"');
      expect(buttonOpenTag).toContain(':disabled="disabled"');
    });
  },
);

suite('the ownership split, confirmed by running both over one file (AC5, test plan #3)', () => {
  it('the production config (linter disabled) leaves oxlint the only reporter', async () => {
    writeFileSync(join(dir, 'unused.ts'), UNUSED_VARIABLE_TS);

    const biomeResult = await run(
      BIOME,
      ['lint', '--config-path', PRODUCTION_BIOME_CONFIG, join(dir, 'unused.ts')],
      dir,
    );
    expect(biomeResult.output).not.toContain('noUnusedVariables');
  });

  it("turning Biome's linter back on reproduces the exact duplicate the split prevents", async () => {
    writeFileSync(join(dir, 'unused.ts'), UNUSED_VARIABLE_TS);
    const linterOnConfig = join(dir, 'biome-linter-enabled.json');
    writeFileSync(
      linterOnConfig,
      JSON.stringify({ linter: { enabled: true, rules: { recommended: true } } }),
    );

    const [biomeResult, oxlintResult] = await Promise.all([
      run(BIOME, ['lint', '--config-path', linterOnConfig, join(dir, 'unused.ts')], dir),
      run(OXLINT, ['-c', OXLINT_CONFIG, join(dir, 'unused.ts')], dir),
    ]);

    // Same binding, same line, flagged under each tool's own rule name — the
    // literal duplicate "linter.enabled: false" in the production config
    // exists to prevent.
    expect(biomeResult.output).toContain('noUnusedVariables');
    expect(oxlintResult.output).toContain('no-unused-vars');
    expect(oxlintResult.code).not.toBe(0);
  });
});

suite('oxlint sees only the <script> block of an SFC (AC5, test plan #4)', () => {
  it('reports nothing for a component registered but never used in the template', async () => {
    const file = join(dir, 'unused-component.vue');
    writeFileSync(file, UNUSED_COMPONENT_VUE);

    const result = await run(OXLINT, ['-c', OXLINT_CONFIG, file], dir);

    expect(result.code).toBe(0);
    expect(result.output).not.toContain('no-unused-vars');
    expect(result.output).not.toContain('UnusedWidget');
  });
});
