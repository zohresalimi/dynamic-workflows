/**
 * KAR-02.8 AC7 — the linter, not just a guard test, refuses I/O in
 * `packages/core/src/**`.
 *
 * `packages/core/test/purity.test.ts` already greps for `node:` imports, and
 * that is a test you have to be running to learn anything from. AC7 asks for
 * the rule to fail *the build*, in the editor and in the `check` job, at the
 * moment the import is typed — which means a real linter rule over the real
 * config. So this spec writes a violating file at the path the rule scopes to
 * and runs oxlint over it.
 *
 * The emitter is the reason the rule is worth having: it needs `node:fs`, and
 * the obvious place to put it is next to the schemas it emits. It lives in
 * `packages/core/scripts/` instead, outside the published surface.
 *
 * Verifies: KAR-02.8 AC7
 */
import { execFile } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it, describe as suite } from 'vitest';
import { readText, repoRoot } from '../support/workspace.ts';

const probe = join(repoRoot, 'packages/core/src/__io-probe.ts');
const probeRelative = 'packages/core/src/__io-probe.ts';

afterEach(() => {
  rmSync(probe, { force: true });
});

interface Run {
  readonly code: number;
  readonly output: string;
}

const lint = (target: string): Promise<Run> =>
  new Promise((resolve) => {
    execFile(
      'node_modules/.bin/oxlint',
      [target],
      { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code:
            error === null ? 0 : ((error as NodeJS.ErrnoException & { code?: number }).code ?? 1),
          output: `${stdout}${stderr}`,
        });
      },
    );
  });

suite('oxlint refuses I/O imports under packages/core/src', () => {
  it('fails on node:fs', async () => {
    writeFileSync(
      probe,
      "import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n",
    );

    const result = await lint(probeRelative);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('node:fs');
  });

  it('fails on node:path', async () => {
    writeFileSync(probe, "import { join } from 'node:path';\nexport const x = join;\n");

    const result = await lint(probeRelative);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('node:path');
  });

  it('fails on a driver package', async () => {
    writeFileSync(probe, "import Database from 'better-sqlite3';\nexport const x = Database;\n");

    const result = await lint(probeRelative);

    expect(result.code).not.toBe(0);
    expect(result.output).toContain('better-sqlite3');
  });

  it('allows zod, which is the one dependency core has', async () => {
    writeFileSync(probe, "import { z } from 'zod';\nexport const x = z.string();\n");

    expect((await lint(probeRelative)).code).toBe(0);
  });

  it('does not fire on packages/core/scripts, where the emitter lives', async () => {
    // The emitter imports node:fs on purpose. If the rule were repo-wide it
    // would either fail the build or be turned off, and either outcome loses
    // the guarantee.
    expect(readText('packages/core/scripts/schemas-io.ts')).toContain("from 'node:fs'");

    const result = await lint('packages/core/scripts/schemas-io.ts');

    expect(result.code, result.output).toBe(0);
  });

  it('does not fire on another package, which is allowed to do I/O', async () => {
    const result = await lint('packages/daemon/src/schema-store.ts');

    expect(result.code, result.output).toBe(0);
  });
});
