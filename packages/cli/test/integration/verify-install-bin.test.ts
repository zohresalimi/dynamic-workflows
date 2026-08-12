/**
 * KAR-18.6 — EPIC-18-S44: the bin must be executable and self-describing.
 *
 * `packages/cli/test/integration/build.test.ts` (KAR-18.5) already proves the
 * *healthy* case against the real build: byte 0 is `#` and the mode carries
 * the `0o111` bits. What is new here is the defect half of the scenario
 * outline — a built `dist/bin.mjs` missing its shebang, or one that lost its
 * exec bit — and the two things that follow from it: `checkBinExecutable`
 * names the defect the way the verifier reports it, and the OS itself refuses
 * to run the file directly, which is what `npx <tarball> --version` actually
 * hits (a shell-level exec failure, not a DeFlow error) — the failure this
 * story's notes call "a syntax error from the shell, which reads like a
 * corrupt download rather than a packaging bug".
 *
 * Verifies: EPIC-18-S44 · test plan row (shebang/exec bit outline)
 */
import { makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { checkBinExecutable } from '../../scripts/verify-install/lib.ts';

const HEALTHY = '#!/usr/bin/env node\nprocess.stdout.write("0.1.0\\n");\n';

let tmp = '';

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  await removeTempDir(tmp);
});

function write(name: string, content: string, mode: number): string {
  const path = join(tmp, name);
  writeFileSync(path, content);
  chmodSync(path, mode);
  return path;
}

suite('the bin must be executable and self-describing (EPIC-18-S44)', () => {
  it('no "#!/usr/bin/env node": checkBinExecutable reports the shebang is missing', () => {
    const path = write('bin.mjs', 'process.stdout.write("0.1.0\\n");\n', 0o755);

    expect(checkBinExecutable(path)).toEqual([`shebang missing from ${path}`]);

    // And the OS agrees: with no shebang, exec(2) cannot interpret the file at
    // all — ENOEXEC, not a DeFlow error — exactly the "syntax error from the
    // shell" this story's notes describe.
    const ran = spawnSync(path, ['--version']);
    expect(ran.error?.code).toBe('ENOEXEC');
  });

  it('mode without 0o111: checkBinExecutable reports the file is not executable', () => {
    const path = write('bin.mjs', HEALTHY, 0o644);

    expect(checkBinExecutable(path)).toEqual([`${path} is not executable`]);

    const ran = spawnSync(path, ['--version']);
    expect(ran.error?.code).toBe('EACCES');
  });

  it('both defects at once are both named', () => {
    const path = write('bin.mjs', 'process.stdout.write("0.1.0\\n");\n', 0o644);

    expect(checkBinExecutable(path)).toEqual([
      `shebang missing from ${path}`,
      `${path} is not executable`,
    ]);
  });

  it('the healthy case: byte 0 is "#", the mode includes 0o111, and it runs', () => {
    const path = write('bin.mjs', HEALTHY, 0o755);

    expect(checkBinExecutable(path)).toEqual([]);

    const ran = spawnSync(path, ['--version'], { encoding: 'utf8' });
    expect(ran.status).toBe(0);
    expect(ran.stdout.trim()).toBe('0.1.0');
  });
});
