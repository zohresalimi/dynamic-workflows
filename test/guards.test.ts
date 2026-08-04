/**
 * The guards themselves, exercised against fixtures.
 *
 * A structural guard that has only ever seen a compliant repository is not
 * known to detect anything. Each rule gets a violating input and a clean input.
 *
 * Verifies: EPIC-01-S2, EPIC-01-S3, EPIC-01-S4, EPIC-01-S5, EPIC-01-S8 (unit)
 */
import { describe as suite, expect, it } from 'vitest';
import {
  checkCorePurity,
  checkDaemonIsLeaf,
  checkDependencyValues,
  checkExactCatalogPins,
  checkMockAgentIsIndependent,
  checkNoBareNodePty,
  checkNoCorepack,
  checkNoDeepWorkspaceImports,
  checkNoNodeBuiltinImports,
  describe as render,
  workspaceDependencyEdges,
} from './support/guards.ts';

const NAMES = ['@DeFlow/core', '@DeFlow/daemon', '@DeFlow/mock-agent', 'DeFlow'];

suite('checkDependencyValues', () => {
  it('rejects a literal semver on a third-party dependency', () => {
    const violations = checkDependencyValues(
      [{ path: 'packages/ledger/package.json', json: { dependencies: { 'better-sqlite3': '13.0.2' } } }],
      NAMES,
    );
    expect(violations).toHaveLength(1);
    expect(render(violations)).toContain('better-sqlite3');
    expect(render(violations)).toContain('catalog:');
  });

  it('rejects a literal version on a workspace dependency', () => {
    const violations = checkDependencyValues(
      [{ path: 'packages/daemon/package.json', json: { dependencies: { '@DeFlow/core': '^0.0.0' } } }],
      NAMES,
    );
    expect(violations).toHaveLength(1);
    expect(render(violations)).toContain('workspace:*');
  });

  it('checks devDependencies, optionalDependencies and peerDependencies too', () => {
    const violations = checkDependencyValues(
      [
        {
          path: 'packages/daemon/package.json',
          json: {
            devDependencies: { typescript: '6.0.3' },
            optionalDependencies: { '@lydell/node-pty': '1.2.0-beta.14' },
            peerDependencies: { vite: '8.2.0' },
          },
        },
      ],
      NAMES,
    );
    expect(violations).toHaveLength(3);
  });

  it('accepts catalog: and workspace:* ', () => {
    expect(
      checkDependencyValues(
        [
          {
            path: 'packages/daemon/package.json',
            json: {
              dependencies: { '@DeFlow/core': 'workspace:*', hono: 'catalog:' },
              optionalDependencies: { '@lydell/node-pty': 'catalog:' },
            },
          },
        ],
        NAMES,
      ),
    ).toEqual([]);
  });
});

suite('workspaceDependencyEdges', () => {
  it('lists every consumer/dependency pair whose dependency is a workspace package', () => {
    expect(
      workspaceDependencyEdges(
        [
          {
            path: 'packages/daemon/package.json',
            json: {
              dependencies: { '@DeFlow/core': 'workspace:*', hono: 'catalog:' },
              devDependencies: { '@DeFlow/testkit': 'workspace:*' },
            },
          },
          { path: 'packages/cli/package.json', json: { dependencies: { '@DeFlow/daemon': 'workspace:*' } } },
        ],
        [...NAMES, '@DeFlow/testkit'],
      ),
    ).toEqual([
      { consumerDir: 'packages/daemon', dependency: '@DeFlow/core' },
      { consumerDir: 'packages/daemon', dependency: '@DeFlow/testkit' },
      { consumerDir: 'packages/cli', dependency: '@DeFlow/daemon' },
    ]);
  });

  it('gives the repo root as the consumer directory for the root manifest', () => {
    expect(
      workspaceDependencyEdges(
        [{ path: 'package.json', json: { devDependencies: { '@DeFlow/testkit': 'workspace:*' } } }],
        ['@DeFlow/testkit'],
      ),
    ).toEqual([{ consumerDir: '.', dependency: '@DeFlow/testkit' }]);
  });

  it('ignores third-party dependencies', () => {
    expect(
      workspaceDependencyEdges(
        [{ path: 'packages/core/package.json', json: { dependencies: { zod: 'catalog:' } } }],
        NAMES,
      ),
    ).toEqual([]);
  });
});

suite('checkExactCatalogPins', () => {
  it('rejects a caret on the ACP SDK and on tsdown', () => {
    const violations = checkExactCatalogPins({
      '@agentclientprotocol/sdk': '^1.3.0',
      tsdown: '^0.22.14',
      '@biomejs/biome': '2.5.6',
    });
    expect(violations).toHaveLength(2);
    expect(render(violations)).toContain('changed both npm scope and GitHub org');
  });

  it('reports a missing entry', () => {
    expect(checkExactCatalogPins({})).toHaveLength(3);
  });

  it('accepts the exact pins', () => {
    expect(
      checkExactCatalogPins({
        '@agentclientprotocol/sdk': '1.3.0',
        tsdown: '0.22.14',
        '@biomejs/biome': '2.5.6',
      }),
    ).toEqual([]);
  });
});

suite('checkCorePurity (R1)', () => {
  it('fails naming the added dependency and pointing at the ports rule', () => {
    const violations = checkCorePurity({ dependencies: { zod: 'catalog:', 'better-sqlite3': 'catalog:' } });
    const message = render(violations);
    expect(message).toContain('better-sqlite3');
    expect(message).toContain(
      'time, randomness and ids enter through ports declared in @DeFlow/core and implemented in @DeFlow/daemon or @DeFlow/testkit',
    );
  });

  it('accepts zod alone', () => {
    expect(checkCorePurity({ dependencies: { zod: 'catalog:' } })).toEqual([]);
  });
});

suite('checkNoNodeBuiltinImports (R1)', () => {
  it('catches a node: builtin import and names the line', () => {
    const violations = checkNoNodeBuiltinImports([
      { path: 'packages/core/src/reduce.ts', text: "const a = 1;\nimport { readFile } from 'node:fs';\n" },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.where).toBe('packages/core/src/reduce.ts:2');
  });

  it('leaves a pure file alone', () => {
    expect(
      checkNoNodeBuiltinImports([
        { path: 'packages/core/src/reduce.ts', text: "import { z } from 'zod';\nexport const x = z;\n" },
      ]),
    ).toEqual([]);
  });
});

suite('checkDaemonIsLeaf (R2)', () => {
  it('rejects any package but the cli depending on the daemon', () => {
    const violations = checkDaemonIsLeaf([
      { path: 'packages/adapters/package.json', json: { dependencies: { '@DeFlow/daemon': 'workspace:*' } } },
      { path: 'packages/cli/package.json', json: { dependencies: { '@DeFlow/daemon': 'workspace:*' } } },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.where).toBe('packages/adapters/package.json');
    expect(render(violations)).toContain('keeps the daemon a leaf');
  });
});

suite('checkMockAgentIsIndependent', () => {
  it('quotes the oracle rule when the mock agent depends on core', () => {
    const violations = checkMockAgentIsIndependent(
      { path: 'packages/mock-agent/package.json', json: { dependencies: { '@DeFlow/core': 'workspace:*' } } },
      NAMES,
    );
    expect(render(violations)).toContain(
      'a bug in the domain model could be mirrored on both sides of the wire and cancel itself out',
    );
  });

  it('accepts a mock agent with only third-party dependencies', () => {
    expect(
      checkMockAgentIsIndependent(
        { path: 'packages/mock-agent/package.json', json: { dependencies: { '@agentclientprotocol/sdk': 'catalog:' } } },
        NAMES,
      ),
    ).toEqual([]);
  });
});

suite('checkNoBareNodePty', () => {
  it('catches upstream node-pty and explains the node-gyp fallback', () => {
    const violations = checkNoBareNodePty([
      { path: 'packages/daemon/package.json', json: { dependencies: { 'node-pty': '1.1.0' } } },
    ]);
    expect(violations).toHaveLength(1);
    expect(render(violations)).toContain('node-gyp rebuild');
    expect(render(violations)).toContain('@lydell/node-pty');
  });

  it('accepts @lydell/node-pty', () => {
    expect(
      checkNoBareNodePty([
        { path: 'packages/daemon/package.json', json: { optionalDependencies: { '@lydell/node-pty': 'catalog:' } } },
      ]),
    ).toEqual([]);
  });
});

suite('checkNoDeepWorkspaceImports', () => {
  it('fails naming the file and the specifier, and explains the tarball breakage', () => {
    const violations = checkNoDeepWorkspaceImports(
      [{ path: 'packages/daemon/src/tick.ts', text: "import { reduce } from '@DeFlow/core/src/reduce.ts';\n" }],
      NAMES,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.where).toBe('packages/daemon/src/tick.ts:1');
    const message = render(violations);
    expect(message).toContain('@DeFlow/core/src/reduce.ts');
    expect(message).toContain('does not exist in the tarball');
    expect(message).toContain('publishConfig swaps exports "." to ./dist/index.js');
    expect(message).toContain('turn every internal file into public API');
  });

  it('accepts the package root and relative .ts specifiers', () => {
    expect(
      checkNoDeepWorkspaceImports(
        [
          {
            path: 'packages/daemon/src/tick.ts',
            text: "import { reduce } from '@DeFlow/core';\nimport { applyPatch } from './patch.ts';\n",
          },
        ],
        NAMES,
      ),
    ).toEqual([]);
  });
});

suite('checkNoCorepack', () => {
  it('fails naming the file and line', () => {
    const violations = checkNoCorepack([
      { path: '.github/workflows/ci.yml', text: 'steps:\n  - run: corepack enable\n' },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.where).toBe('.github/workflows/ci.yml:2');
    expect(render(violations)).toContain('removed from Node 25+ distributions');
  });

  it('accepts npm i -g pnpm@11', () => {
    expect(
      checkNoCorepack([{ path: '.github/workflows/ci.yml', text: 'steps:\n  - run: npm i -g pnpm@11\n' }]),
    ).toEqual([]);
  });
});
