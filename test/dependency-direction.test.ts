/**
 * R1 and R2 applied to the real workspace, plus the catalog/workspace protocol
 * discipline that keeps nine packages from drifting.
 *
 * Verifies: EPIC-01-S2 (scenario 2), EPIC-01-S5 (unit)
 */
import { expect, it, describe as suite } from 'vitest';
import {
  checkDaemonIsLeaf,
  checkDependencyValues,
  checkMockAgentIsIndependent,
  checkNoBareNodePty,
  describe as render,
} from './support/guards.ts';
import { allManifests, manifestFor, workspaceNames } from './support/workspace.ts';

suite('dependency values', () => {
  it('uses workspace:* for workspace packages and catalog: for everything else', () => {
    expect(render(checkDependencyValues(allManifests(), workspaceNames()))).toBe('');
  });
});

suite('R2 — the daemon stays a leaf', () => {
  it('only packages/cli depends on @DeFlow/daemon', () => {
    expect(render(checkDaemonIsLeaf(allManifests()))).toBe('');
  });
});

suite('the mock agent is an independent oracle', () => {
  it('@DeFlow/mock-agent has zero workspace dependencies', () => {
    expect(
      render(checkMockAgentIsIndependent(manifestFor('packages/mock-agent'), workspaceNames())),
    ).toBe('');
  });
});

suite('native dependencies never invoke node-gyp', () => {
  it('no package depends on the bare node-pty', () => {
    expect(render(checkNoBareNodePty(allManifests()))).toBe('');
  });

  it('@lydell/node-pty is optional, so an unsupported platform degrades instead of failing', () => {
    const daemon = manifestFor('packages/daemon');
    expect(daemon.json.optionalDependencies?.['@lydell/node-pty']).toBe('catalog:');
    expect(daemon.json.dependencies?.['@lydell/node-pty']).toBeUndefined();
  });
});
