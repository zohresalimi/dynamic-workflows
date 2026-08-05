/**
 * KAR-04.1 AC5 — the mock agent is an independent oracle.
 *
 * The guards themselves are exercised against violating fixtures in
 * ./guards.test.ts; this file is the half that points them at the real tree.
 *
 * Verifies: EPIC-04-S21 · AC5
 */
import { expect, it, describe as suite } from 'vitest';
import {
  checkNoDeprecatedAcpPackages,
  checkNoWorkspaceImports,
  describe as render,
} from './support/guards.ts';
import {
  allManifests,
  manifestFor,
  readJson,
  readSources,
  readWorkspaceYaml,
  repoTypeScriptFiles,
  walk,
} from './support/workspace.ts';

const mockAgentSources = readSources(
  ['packages/mock-agent/src', 'packages/mock-agent/bin'].flatMap((dir) =>
    walk(dir, (path) => path.endsWith('.ts')),
  ),
);

suite('EPIC-04-S21 — no workspace imports', () => {
  it('scans every TypeScript file the package ships', () => {
    // A guard that matched nothing would pass for ever. The package has a bin
    // and at least an entry point, so anything less than two files means the
    // scan missed the tree it is supposed to be reading.
    expect(mockAgentSources.length).toBeGreaterThanOrEqual(2);
  });

  it('no file under packages/mock-agent imports a @DeFlow/ package', () => {
    expect(render(checkNoWorkspaceImports(mockAgentSources))).toBe('');
  });

  it('and that is a real result, not an empty scan', () => {
    const mutated = mockAgentSources.map((file) => ({
      ...file,
      text: `${file.text}\nimport { reduce } from '@DeFlow/core';\n`,
    }));
    expect(checkNoWorkspaceImports(mutated)).toHaveLength(mockAgentSources.length);
  });
});

suite('EPIC-04-S21 — exactly one dependency, pinned exactly', () => {
  const manifest = readJson('packages/mock-agent/package.json');

  it('declares @agentclientprotocol/sdk and nothing else', () => {
    expect(Object.keys(manifest.dependencies ?? {})).toEqual(['@agentclientprotocol/sdk']);
  });

  it('takes the version from the catalog, where it is the exact string 1.3.0', () => {
    // The catalog is the one place a version may be written
    // (docs/16-repo-layout.md §5), so "pinned exactly" is a claim about the
    // catalog entry the manifest points at rather than about the manifest.
    expect(manifest.dependencies?.['@agentclientprotocol/sdk']).toBe('catalog:');
    expect(readWorkspaceYaml().catalog?.['@agentclientprotocol/sdk']).toBe('1.3.0');
  });

  it('has no workspace dependency in any block', () => {
    const manifestFile = manifestFor('packages/mock-agent');
    const blocks = [
      manifestFile.json.dependencies,
      manifestFile.json.devDependencies,
      manifestFile.json.optionalDependencies,
      manifestFile.json.peerDependencies,
    ];
    for (const block of blocks) {
      for (const name of Object.keys(block ?? {})) {
        expect(name.startsWith('@DeFlow/'), `${name} is a workspace package`).toBe(false);
      }
    }
  });
});

suite('EPIC-04-S21 — the deprecated packages are unreachable', () => {
  it('nothing in the workspace names @zed-industries/*', () => {
    expect(
      render(checkNoDeprecatedAcpPackages(readSources(repoTypeScriptFiles()), allManifests())),
    ).toBe('');
  });
});
