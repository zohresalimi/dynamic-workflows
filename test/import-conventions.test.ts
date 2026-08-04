/**
 * The breakages that are invisible in development, and the one that is
 * invisible until someone upgrades Node.
 *
 * Verifies: EPIC-01-S8 (deep-import half), EPIC-01-S4 (scenario 2 and the
 * troubleshooting entry from scenario 1)
 */
import { describe as suite, expect, it } from 'vitest';
import { checkNoCorepack, checkNoDeepWorkspaceImports, describe as render } from './support/guards.ts';
import {
  allWorkspaceSources,
  exists,
  readSources,
  readText,
  walk,
  workspaceNames,
} from './support/workspace.ts';

suite('cross-package imports use the package root', () => {
  it('no source file deep-imports a workspace package', () => {
    expect(render(checkNoDeepWorkspaceImports(allWorkspaceSources(), workspaceNames()))).toBe('');
  });
});

suite('corepack is never used', () => {
  const targets = [
    ...walk('.github/workflows', (path) => path.endsWith('.yml') || path.endsWith('.yaml')),
    ...(exists('docs/CONTRIBUTING.md') ? ['docs/CONTRIBUTING.md'] : []),
  ];

  it('no workflow or setup document runs "corepack enable"', () => {
    expect(render(checkNoCorepack(readSources(targets)))).toBe('');
  });

  it('the troubleshooting table names the exact symptom', () => {
    expect(readText('docs/03-local-development.md')).toContain('corepack: command not found');
  });
});
