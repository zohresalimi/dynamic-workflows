/**
 * The scaffold itself: workspace globs, the catalog, the root manifest, the
 * runtime-version files and every package's exports/publishConfig pair.
 *
 * Verifies: EPIC-01-S2 (unit half), AC1, AC2, AC5, AC6, AC10 (declaration half)
 */
import { describe as suite, expect, it } from 'vitest';
import { checkExactCatalogPins, describe as render } from './support/guards.ts';
import { exists, packageDirs, readJson, readText, readWorkspaceYaml } from './support/workspace.ts';

/** docs/16-repo-layout.md §5 — the catalog, verbatim. */
const EXPECTED_CATALOG: Readonly<Record<string, string>> = {
  typescript: '6.0.3',
  zod: '4.4.3',
  vitest: '4.1.10',
  vite: '8.2.0',
  '@types/node': '^24.0.0',
  hono: '4.12.33',
  '@hono/node-server': '2.0.12',
  'better-sqlite3': '13.0.2',
  '@agentclientprotocol/sdk': '1.3.0',
  '@modelcontextprotocol/sdk': '1.30.0',
  execa: '10.0.1',
  pino: '10.3.1',
  '@biomejs/biome': '2.5.6',
  oxlint: '1.76.0',
  tsdown: '0.22.14',
};

/** docs/16-repo-layout.md §1 — directory to package name. */
const EXPECTED_PACKAGES: Readonly<Record<string, string>> = {
  'packages/core': '@DeFlow/core',
  'packages/ledger': '@DeFlow/ledger',
  'packages/adapters': '@DeFlow/adapters',
  'packages/daemon': '@DeFlow/daemon',
  'packages/cli': 'DeFlow',
  'packages/web': '@DeFlow/web',
  'packages/testkit': '@DeFlow/testkit',
  'packages/mock-agent': '@DeFlow/mock-agent',
  e2e: '@DeFlow/e2e',
};

/** The published package is packages/cli; e2e ships no library entry point. */
const LIBRARY_DIRS = Object.keys(EXPECTED_PACKAGES).filter(
  (dir) => dir !== 'packages/cli' && dir !== 'e2e',
);

suite('pnpm-workspace.yaml', () => {
  it('lists packages/* and e2e', () => {
    expect(readWorkspaceYaml().packages).toEqual(['packages/*', 'e2e']);
  });

  it('carries a catalog holding every shared version', () => {
    const catalog = readWorkspaceYaml().catalog ?? {};
    for (const [name, version] of Object.entries(EXPECTED_CATALOG)) {
      expect(catalog[name], `catalog entry for ${name}`).toBe(version);
    }
  });

  it('pins the ACP SDK, tsdown and Biome exact, without a range operator', () => {
    const violations = checkExactCatalogPins(readWorkspaceYaml().catalog ?? {});
    expect(render(violations)).toBe('');
  });

  it('forbids every dependency build, so no install can reach node-gyp', () => {
    // pnpm 11 asks for an explicit decision per package that ships a binding.gyp.
    // better-sqlite3@13.0.2 has gypfile:false and no install script, and ships
    // prebuilds/ — the answer is permanently "no", and saying so in the manifest
    // means a future dependency cannot start compiling without a visible diff.
    const allowBuilds = (readWorkspaceYaml() as { allowBuilds?: Record<string, unknown> })
      .allowBuilds;
    expect(allowBuilds).toBeDefined();
    for (const [name, allowed] of Object.entries(allowBuilds ?? {})) {
      expect(allowed, `allowBuilds["${name}"] must be false — NF6 forbids compilation`).toBe(false);
    }
  });
});

suite('root package.json', () => {
  const root = readJson('package.json');

  it('asserts the pnpm version through packageManager', () => {
    expect(root.packageManager).toBe('pnpm@11.18.0');
  });

  it('requires Node 24 or newer and does not list Node 22', () => {
    expect(root.engines?.node).toBe('>=24');
    expect(JSON.stringify(root.engines)).not.toContain('22');
  });

  it('is private and ESM-only', () => {
    expect(root.private).toBe(true);
    expect(root.type).toBe('module');
  });
});

suite('runtime version files', () => {
  it('.node-version names the Node major', () => {
    expect(readText('.node-version').trim()).toBe('24');
  });

  it('.tool-versions names Node and pnpm for asdf/mise', () => {
    const toolVersions = readText('.tool-versions');
    expect(toolVersions).toMatch(/^nodejs 24$/m);
    expect(toolVersions).toMatch(/^pnpm 11\.18\.0$/m);
  });
});

suite('package layout', () => {
  it('has exactly the nine packages of the layout', () => {
    expect(packageDirs()).toEqual(Object.keys(EXPECTED_PACKAGES).sort());
  });

  it.each(Object.entries(EXPECTED_PACKAGES))('%s is named %s', (dir, name) => {
    expect(readJson(`${dir}/package.json`).name).toBe(name);
  });

  it.each(Object.keys(EXPECTED_PACKAGES).filter((dir) => dir !== 'packages/cli'))(
    '%s is private, so packages/cli stays the only published package',
    (dir) => {
      expect(readJson(`${dir}/package.json`).private).toBe(true);
    },
  );

  it('packages/cli is the one package that is publishable', () => {
    expect(readJson('packages/cli/package.json').private).toBeUndefined();
  });

  it.each(Object.keys(EXPECTED_PACKAGES))('%s is ESM-only', (dir) => {
    expect(readJson(`${dir}/package.json`).type).toBe('module');
  });

  it.each(LIBRARY_DIRS)('%s exposes "." and nothing else, resolved to live source', (dir) => {
    expect(readJson(`${dir}/package.json`).exports).toEqual({ '.': './src/index.ts' });
    expect(exists(`${dir}/src/index.ts`)).toBe(true);
  });

  it.each(LIBRARY_DIRS)('%s swaps "." to built JavaScript at pack time', (dir) => {
    expect(readJson(`${dir}/package.json`).publishConfig?.exports).toEqual({
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
    });
  });
});
