/**
 * KAR-10.1 AC4 — a `{ kind: 'file' }` path is resolved against `cwd` and
 * refused if it escapes after `realpath`. Real tmpdir, real symlink — the same
 * discipline `fs-mediation.test.ts` applies to the fs boundary this mirrors.
 *
 * Verifies: KAR-10.1 AC4 · EPIC-10-S4 (symlink scenario)
 */
import { it } from '@DeFlow/testkit';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { resolveWithinRepo } from '../../src/intake/resolve-path.ts';

suite('resolveWithinRepo — inside the repo', () => {
  it('resolves a relative path against cwd', async ({ tmp }) => {
    const root = await realpath(tmp);
    await mkdir(join(root, 'docs'), { recursive: true });
    await writeFile(join(root, 'docs', 'spec.md'), '# spec\n');

    const result = await resolveWithinRepo(root, 'docs/spec.md');
    expect(result).toEqual({ outcome: 'inside', path: join(root, 'docs', 'spec.md') });
  });

  it('resolves an absolute path that is inside cwd', async ({ tmp }) => {
    const root = await realpath(tmp);
    await writeFile(join(root, 'a.md'), 'x');

    const result = await resolveWithinRepo(root, join(root, 'a.md'));
    expect(result).toEqual({ outcome: 'inside', path: join(root, 'a.md') });
  });

  it('resolves a not-yet-existing path (the deepest ancestor is still checked)', async ({
    tmp,
  }) => {
    const root = await realpath(tmp);
    const result = await resolveWithinRepo(root, 'does-not-exist.md');
    expect(result).toEqual({ outcome: 'inside', path: join(root, 'does-not-exist.md') });
  });
});

suite('resolveWithinRepo — escapes the repo (AC4, EPIC-10-S4)', () => {
  it('refuses a `../../../etc/passwd`-style traversal', async ({ tmp }) => {
    const root = await realpath(tmp);
    const result = await resolveWithinRepo(root, '../../../etc/passwd');
    expect(result).toEqual({ outcome: 'outside', route: 'traversal' });
  });

  it('refuses an absolute path outside cwd', async ({ tmp }) => {
    const root = await realpath(tmp);
    const result = await resolveWithinRepo(root, '/etc/passwd');
    expect(result).toEqual({ outcome: 'outside', route: 'absolute' });
  });

  it('refuses the empty string without guessing', async ({ tmp }) => {
    const root = await realpath(tmp);
    const result = await resolveWithinRepo(root, '');
    expect(result).toEqual({ outcome: 'outside', route: 'invalid' });
  });

  it('refuses a symlink inside the repo that resolves outside it, after realpath', async ({
    tmp,
  }) => {
    const root = await realpath(tmp);
    const outside = join(root, '..', 'outside-target');
    await writeFile(outside, 'not part of the repo\n');
    await symlink(outside, join(root, 'outside.md'));

    const result = await resolveWithinRepo(root, 'outside.md');
    expect(result).toEqual({ outcome: 'outside', route: 'symlink' });
  });
});
