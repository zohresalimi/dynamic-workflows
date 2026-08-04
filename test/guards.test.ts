/**
 * The guards themselves, exercised against fixtures.
 *
 * A structural guard that has only ever seen a compliant repository is not
 * known to detect anything. Each rule gets a violating input and a clean input.
 *
 * Verifies: EPIC-01-S2, EPIC-01-S3, EPIC-01-S4, EPIC-01-S5, EPIC-01-S6, EPIC-01-S7,
 * EPIC-01-S8 (unit)
 */
import { expect, it, describe as suite } from 'vitest';
import {
  checkBiomeOwnershipSplit,
  checkCorePurity,
  checkDaemonIsLeaf,
  checkDependencyValues,
  checkDevLoopScripts,
  checkExactCatalogPins,
  checkGitInvocationsAreHermetic,
  checkLintFormatScripts,
  checkMockAgentIsIndependent,
  checkNoBareNodePty,
  checkNoCorepack,
  checkNoDeepWorkspaceImports,
  checkNoFakeTimers,
  checkNoInMemoryDatabases,
  checkNoNodeBuiltinImports,
  checkNoPathsAlias,
  checkNoTransformTypesFlag,
  checkNoUnsupportedGitLibrary,
  checkNoViteProxy,
  checkNoVitestWorkspace,
  checkOxlintConfig,
  checkPinoPrettyIsNotARuntimeTransport,
  checkRelativeImportsHaveTsExtension,
  checkViteImportIsDynamic,
  REQUIRED_OXLINT_PLUGINS,
  REQUIRED_TYPE_AWARE_RULES,
  describe as render,
  VITE_PROXY_CONSEQUENCES,
  workspaceDependencyEdges,
} from './support/guards.ts';

const NAMES = ['@DeFlow/core', '@DeFlow/daemon', '@DeFlow/mock-agent', 'DeFlow'];

suite('checkDependencyValues', () => {
  it('rejects a literal semver on a third-party dependency', () => {
    const violations = checkDependencyValues(
      [
        {
          path: 'packages/ledger/package.json',
          json: { dependencies: { 'better-sqlite3': '13.0.2' } },
        },
      ],
      NAMES,
    );
    expect(violations).toHaveLength(1);
    expect(render(violations)).toContain('better-sqlite3');
    expect(render(violations)).toContain('catalog:');
  });

  it('rejects a literal version on a workspace dependency', () => {
    const violations = checkDependencyValues(
      [
        {
          path: 'packages/daemon/package.json',
          json: { dependencies: { '@DeFlow/core': '^0.0.0' } },
        },
      ],
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
          {
            path: 'packages/cli/package.json',
            json: { dependencies: { '@DeFlow/daemon': 'workspace:*' } },
          },
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
    const violations = checkCorePurity({
      dependencies: { zod: 'catalog:', 'better-sqlite3': 'catalog:' },
    });
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
      {
        path: 'packages/core/src/reduce.ts',
        text: "const a = 1;\nimport { readFile } from 'node:fs';\n",
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.where).toBe('packages/core/src/reduce.ts:2');
  });

  it('leaves a pure file alone', () => {
    expect(
      checkNoNodeBuiltinImports([
        {
          path: 'packages/core/src/reduce.ts',
          text: "import { z } from 'zod';\nexport const x = z;\n",
        },
      ]),
    ).toEqual([]);
  });
});

suite('checkDaemonIsLeaf (R2)', () => {
  it('rejects any package but the cli depending on the daemon', () => {
    const violations = checkDaemonIsLeaf([
      {
        path: 'packages/adapters/package.json',
        json: { dependencies: { '@DeFlow/daemon': 'workspace:*' } },
      },
      {
        path: 'packages/cli/package.json',
        json: { dependencies: { '@DeFlow/daemon': 'workspace:*' } },
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.where).toBe('packages/adapters/package.json');
    expect(render(violations)).toContain('keeps the daemon a leaf');
  });
});

suite('checkMockAgentIsIndependent', () => {
  it('quotes the oracle rule when the mock agent depends on core', () => {
    const violations = checkMockAgentIsIndependent(
      {
        path: 'packages/mock-agent/package.json',
        json: { dependencies: { '@DeFlow/core': 'workspace:*' } },
      },
      NAMES,
    );
    expect(render(violations)).toContain(
      'a bug in the domain model could be mirrored on both sides of the wire and cancel itself out',
    );
  });

  it('accepts a mock agent with only third-party dependencies', () => {
    expect(
      checkMockAgentIsIndependent(
        {
          path: 'packages/mock-agent/package.json',
          json: { dependencies: { '@agentclientprotocol/sdk': 'catalog:' } },
        },
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
        {
          path: 'packages/daemon/package.json',
          json: { optionalDependencies: { '@lydell/node-pty': 'catalog:' } },
        },
      ]),
    ).toEqual([]);
  });
});

suite('checkNoDeepWorkspaceImports', () => {
  it('fails naming the file and the specifier, and explains the tarball breakage', () => {
    const violations = checkNoDeepWorkspaceImports(
      [
        {
          path: 'packages/daemon/src/tick.ts',
          text: "import { reduce } from '@DeFlow/core/src/reduce.ts';\n",
        },
      ],
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
      checkNoCorepack([
        { path: '.github/workflows/ci.yml', text: 'steps:\n  - run: npm i -g pnpm@11\n' },
      ]),
    ).toEqual([]);
  });
});

suite('checkNoPathsAlias (AC6)', () => {
  it('fails naming the tsconfig and citing the TypeScript issue', () => {
    const violations = checkNoPathsAlias([
      {
        path: 'tsconfig.base.json',
        json: { compilerOptions: { paths: { '@/*': ['./src/*'] } } },
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.where).toBe('tsconfig.base.json');
    const message = render(violations);
    expect(message).toContain('microsoft/TypeScript#61991');
    expect(message).toContain('module-not-found');
  });

  it('accepts a tsconfig with no paths key', () => {
    expect(
      checkNoPathsAlias([
        { path: 'packages/core/tsconfig.json', json: { compilerOptions: {} } },
        { path: 'tsconfig.base.json', json: {} },
      ]),
    ).toEqual([]);
  });
});

suite('checkRelativeImportsHaveTsExtension (AC8)', () => {
  it('catches an extensionless relative import and names the line', () => {
    const violations = checkRelativeImportsHaveTsExtension([
      { path: 'packages/daemon/src/tick.ts', text: "import { applyPatch } from './patch';\n" },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.where).toBe('packages/daemon/src/tick.ts:1');
    expect(render(violations)).toContain('nodenext');
  });

  it('accepts a relative import that already ends in .ts, and ignores bare specifiers', () => {
    expect(
      checkRelativeImportsHaveTsExtension([
        {
          path: 'packages/daemon/src/tick.ts',
          text: "import { applyPatch } from './patch.ts';\nimport { z } from 'zod';\n",
        },
      ]),
    ).toEqual([]);
  });
});

suite('checkNoTransformTypesFlag (EPIC-01-S7 scenario 3)', () => {
  it('fails naming the file and line, and records that Node 26 removed the flag', () => {
    const violations = checkNoTransformTypesFlag([
      {
        path: 'package.json',
        text: '"dev": "node --experimental-transform-types packages/daemon/src/main.ts"\n',
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.where).toBe('package.json:1');
    expect(render(violations)).toContain('removed in Node 26.0.0');
  });

  it('accepts a script with no such flag', () => {
    expect(
      checkNoTransformTypesFlag([
        { path: 'package.json', text: '"dev": "node --watch main.ts"\n' },
      ]),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- *
 * KAR-01.3 — the one-command dev loop
 * -------------------------------------------------------------------------- */

suite('checkNoViteProxy (EPIC-01-S13)', () => {
  it('fires on a proxy key in a Vite config, naming the file', () => {
    const violations = checkNoViteProxy([
      {
        path: 'packages/web/vite.config.ts',
        text: "export default { server: { proxy: { '/api': 'http://localhost:7778' } } };\n",
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.where).toBe('packages/web/vite.config.ts:1');
  });

  it('fires on the string "server.proxy" in source', () => {
    const violations = checkNoViteProxy([
      { path: 'packages/daemon/src/http/server.ts', text: 'config.server.proxy = {};\n' },
    ]);
    expect(violations).toHaveLength(1);
  });

  it.each(VITE_PROXY_CONSEQUENCES)(
    'restates the consequence "%s" and why it is fatal here',
    (mode, why) => {
      const message = render(
        checkNoViteProxy([
          { path: 'packages/web/vite.config.ts', text: 'server: { proxy: {} }\n' },
        ]),
      );
      expect(message).toContain(mode);
      expect(message).toContain(why);
    },
  );

  it('leaves a proxy-free Vite config alone', () => {
    expect(
      checkNoViteProxy([
        {
          path: 'packages/web/vite.config.ts',
          text: "import vue from '@vitejs/plugin-vue';\nexport default { plugins: [vue()] };\n",
        },
      ]),
    ).toEqual([]);
  });
});

suite('checkViteImportIsDynamic (AC8)', () => {
  it('rejects a static import of vite in daemon source', () => {
    const violations = checkViteImportIsDynamic([
      {
        path: 'packages/daemon/src/http/server.ts',
        text: "import { createServer } from 'vite';\n",
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(render(violations)).toContain('published bundle');
  });

  it('rejects a dynamic import that is not behind the DeFlow_DEV branch', () => {
    const violations = checkViteImportIsDynamic([
      {
        path: 'packages/daemon/src/http/server.ts',
        text: "const { createServer } = await import('vite');\n",
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(render(violations)).toContain('DeFlow_DEV');
  });

  it('accepts a dynamic import inside the dev branch', () => {
    expect(
      checkViteImportIsDynamic([
        {
          path: 'packages/daemon/src/http/server.ts',
          text:
            "if (process.env.DeFlow_DEV === '1') {\n" +
            "  const { createServer } = await import('vite');\n" +
            '}\n',
        },
      ]),
    ).toEqual([]);
  });
});

suite('checkPinoPrettyIsNotARuntimeTransport (AC5)', () => {
  it('fires when pino-pretty is named in runtime source', () => {
    const violations = checkPinoPrettyIsNotARuntimeTransport([
      {
        path: 'packages/daemon/src/logging.ts',
        text: "const log = pino({ transport: { target: 'pino-pretty' } });\n",
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(render(violations)).toContain('worker thread');
  });

  it('accepts a logger with no transport', () => {
    expect(
      checkPinoPrettyIsNotARuntimeTransport([
        { path: 'packages/daemon/src/logging.ts', text: 'const log = pino({ level });\n' },
      ]),
    ).toEqual([]);
  });
});

suite('checkDevLoopScripts (EPIC-01-S9 scenario 2)', () => {
  const good = {
    dev: 'DeFlow_DEV=1 node --watch --watch-path=packages/daemon --watch-path=packages/core packages/daemon/src/main.ts',
    'dev:pretty': 'pnpm dev | pino-pretty',
  };

  it('accepts the node --watch loop that excludes packages/web', () => {
    expect(checkDevLoopScripts({ scripts: good })).toEqual([]);
  });

  it('rejects a state-preserving reloader', () => {
    const violations = checkDevLoopScripts({
      scripts: { ...good, dev: 'DeFlow_DEV=1 nodemon --watch-path=packages/daemon main.ts' },
    });
    expect(render(violations)).toContain('the restart is the test');
  });

  it('rejects watching packages, because that covers packages/web', () => {
    const violations = checkDevLoopScripts({
      scripts: { ...good, dev: 'DeFlow_DEV=1 node --watch --watch-path=packages main.ts' },
    });
    expect(render(violations)).toContain('restart *and* an HMR');
  });

  it('rejects a relative --env-file path, which turns the loop into a restart storm', () => {
    const violations = checkDevLoopScripts({
      scripts: {
        ...good,
        dev: `${good.dev} --env-file-if-exists=.env`,
      },
    });
    expect(render(violations)).toContain('restarts the daemon about twice a second');
  });

  it('requires dev:pretty to pipe rather than configure a transport', () => {
    const violations = checkDevLoopScripts({
      scripts: { dev: good.dev, 'dev:pretty': 'DeFlow_LOG_PRETTY=1 pnpm dev' },
    });
    expect(render(violations)).toContain('dev:pretty');
  });

  it('requires DeFlow_DEV=1, or Vite is never mounted', () => {
    const violations = checkDevLoopScripts({
      scripts: { ...good, dev: 'node --watch --watch-path=packages/daemon main.ts' },
    });
    expect(render(violations)).toContain('DeFlow_DEV=1');
  });
});

/**
 * The KAR-01.4 guards. Every fixture below that must be *detected* is assembled
 * from fragments at runtime, because these guards are pointed at the whole
 * TypeScript tree in ./testing-hygiene.test.ts — a literal `defineWorkspace(`
 * written here would make this file its own first violation.
 */
const DEFINE_WORKSPACE = `define${'Workspace'}`;
const USE_FAKE_TIMERS = `vi.useFake${'Timers'}`;
const IN_MEMORY_DSN = `:mem${'ory'}:`;

suite('checkNoVitestWorkspace (EPIC-01-S18)', () => {
  it('rejects a file named vitest.workspace.ts', () => {
    const violations = checkNoVitestWorkspace([
      { path: 'vitest.workspace.ts', text: 'export default [];\n' },
    ]);
    expect(render(violations)).toContain('REMOVED in Vitest 4');
  });

  it('rejects the removed builder wherever it is called', () => {
    const violations = checkNoVitestWorkspace([
      { path: 'vitest.config.ts', text: `export default ${DEFINE_WORKSPACE}(['a', 'b']);\n` },
    ]);
    expect(render(violations)).toContain('pre-3.2');
  });

  it('rejects it as an import even before it is called', () => {
    const violations = checkNoVitestWorkspace([
      { path: 'vitest.config.ts', text: `import { ${DEFINE_WORKSPACE} } from 'vitest/config';\n` },
    ]);
    expect(violations).toHaveLength(1);
  });

  it('accepts the supported shape', () => {
    expect(
      checkNoVitestWorkspace([
        {
          path: 'vitest.config.ts',
          text: 'export default defineConfig({ test: { projects: [] } });\n',
        },
      ]),
    ).toEqual([]);
  });
});

suite('checkNoFakeTimers (AC9, EPIC-01-S16)', () => {
  it('rejects a fake-timer call in a file that is not allowlisted', () => {
    const violations = checkNoFakeTimers(
      [{ path: 'packages/daemon/test/integration/retry.test.ts', text: `${USE_FAKE_TIMERS}();\n` }],
      [],
    );
    expect(render(violations)).toContain('child process');
  });

  it('rejects an allowlisted file that fakes everything', () => {
    const path = 'packages/core/src/backoff.test.ts';
    const violations = checkNoFakeTimers([{ path, text: `${USE_FAKE_TIMERS}();\n` }], [path]);
    expect(render(violations)).toContain('toFake');
  });

  it('accepts an allowlisted file that scopes toFake', () => {
    const path = 'packages/core/src/backoff.test.ts';
    const text = `${USE_FAKE_TIMERS}({ toFake: ['setTimeout', 'setInterval', 'Date'] });\n`;
    expect(checkNoFakeTimers([{ path, text }], [path])).toEqual([]);
  });

  it('accepts a file that takes time through the Clock port instead', () => {
    expect(
      checkNoFakeTimers(
        [{ path: 'packages/core/src/backoff.test.ts', text: 'const clock = new TestClock();\n' }],
        [],
      ),
    ).toEqual([]);
  });
});

suite('checkNoInMemoryDatabases (AC10, EPIC-01-S19)', () => {
  it('rejects an in-memory database under an integration directory', () => {
    const violations = checkNoInMemoryDatabases([
      {
        path: 'packages/ledger/test/integration/resume.test.ts',
        text: `const db = new Database('${IN_MEMORY_DSN}');\n`,
      },
    ]);
    expect(render(violations)).toContain('reopened');
  });

  it('permits it in a pure projection unit test', () => {
    expect(
      checkNoInMemoryDatabases([
        {
          path: 'packages/ledger/src/reduce.test.ts',
          text: `const db = new Database('${IN_MEMORY_DSN}');\n`,
        },
      ]),
    ).toEqual([]);
  });

  it('accepts a file-backed integration test', () => {
    expect(
      checkNoInMemoryDatabases([
        {
          path: 'packages/ledger/test/integration/resume.test.ts',
          text: "const db = new Database(join(tmp, 'ledger.db'));\n",
        },
      ]),
    ).toEqual([]);
  });
});

suite('checkGitInvocationsAreHermetic (AC5, EPIC-01-S15)', () => {
  it('rejects a new invocation that omits the isolated environment', () => {
    const violations = checkGitInvocationsAreHermetic([
      {
        path: 'packages/testkit/src/repo.ts',
        text: "await execa('git', ['init', '-b', 'main'], { cwd: dir });\n",
      },
    ]);
    expect(render(violations)).toContain('GIT_ENV');
  });

  it('rejects an invocation that passes an environment that is not the hermetic one', () => {
    const violations = checkGitInvocationsAreHermetic([
      {
        path: 'packages/testkit/src/repo.ts',
        text: "await execa('git', ['status'], { cwd: dir, env: process.env });\n",
      },
    ]);
    expect(violations).toHaveLength(1);
  });

  it('accepts an invocation that passes GIT_ENV', () => {
    expect(
      checkGitInvocationsAreHermetic([
        {
          path: 'packages/testkit/src/git.ts',
          text: "await execa('git', args, { cwd: dir, env: { ...GIT_ENV }, reject: false });\n",
        },
      ]),
    ).toEqual([]);
  });

  it('catches a raw spawn as well as execa', () => {
    const violations = checkGitInvocationsAreHermetic([
      { path: 'packages/testkit/src/repo.ts', text: "spawnSync('git', ['log']);\n" },
    ]);
    expect(violations).toHaveLength(1);
  });

  it('ignores a file with no git invocation at all', () => {
    expect(
      checkGitInvocationsAreHermetic([
        { path: 'packages/testkit/src/clock.ts', text: 'export class TestClock {}\n' },
      ]),
    ).toEqual([]);
  });
});

suite('checkNoUnsupportedGitLibrary (EPIC-01-S15 scenario 4)', () => {
  it.each(['isomorphic-git', 'simple-git'])('rejects %s', (name) => {
    const violations = checkNoUnsupportedGitLibrary([
      { path: 'packages/testkit/package.json', json: { dependencies: { [name]: 'catalog:' } } },
    ]);
    expect(render(violations)).toContain('worktree');
  });

  it('accepts a manifest that shells out to the real binary', () => {
    expect(
      checkNoUnsupportedGitLibrary([
        { path: 'packages/testkit/package.json', json: { dependencies: { execa: 'catalog:' } } },
      ]),
    ).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- *
 * KAR-01.5 — the lint and format pipeline
 * -------------------------------------------------------------------------- */

suite('checkBiomeOwnershipSplit (AC1, EPIC-01-S22 scenario 1)', () => {
  const compliant = {
    linter: { enabled: false },
    html: { experimentalFullSupportEnabled: true, formatter: { enabled: true } },
  };

  it('accepts the compliant shape', () => {
    expect(checkBiomeOwnershipSplit(compliant)).toEqual([]);
  });

  it('fires when the linter is left enabled, naming the fight it causes', () => {
    const violations = checkBiomeOwnershipSplit({ ...compliant, linter: { enabled: true } });
    expect(render(violations)).toContain('fight each other');
  });

  it('fires when the html block is missing entirely (the silent no-op, EPIC-01-S22 scenario 3)', () => {
    const violations = checkBiomeOwnershipSplit({ linter: { enabled: false } });
    expect(render(violations)).toContain('silently no-ops on every .vue file');
  });

  it('fires when experimentalFullSupportEnabled is false', () => {
    const violations = checkBiomeOwnershipSplit({
      ...compliant,
      html: { experimentalFullSupportEnabled: false, formatter: { enabled: true } },
    });
    expect(violations).toHaveLength(1);
  });

  it('fires when html.formatter.enabled is false', () => {
    const violations = checkBiomeOwnershipSplit({
      ...compliant,
      html: { experimentalFullSupportEnabled: true, formatter: { enabled: false } },
    });
    expect(render(violations)).toContain('formatter never');
  });
});

suite('checkOxlintConfig (AC2, EPIC-01-S20 background)', () => {
  const compliant = {
    plugins: [...REQUIRED_OXLINT_PLUGINS],
    categories: { correctness: 'error', suspicious: 'warn' },
    rules: Object.fromEntries(REQUIRED_TYPE_AWARE_RULES.map((rule) => [rule, 'error'])),
  };

  it('accepts the compliant shape', () => {
    expect(checkOxlintConfig(compliant)).toEqual([]);
  });

  it('names each missing plugin', () => {
    const violations = checkOxlintConfig({ ...compliant, plugins: ['typescript'] });
    expect(violations).toHaveLength(3);
    expect(render(violations)).toContain('unicorn');
    expect(render(violations)).toContain('promise');
    expect(render(violations)).toContain('import');
  });

  it('rejects correctness set to anything but error', () => {
    const violations = checkOxlintConfig({
      ...compliant,
      categories: { correctness: 'warn', suspicious: 'warn' },
    });
    expect(render(violations)).toContain('categories.correctness');
  });

  it('rejects suspicious set to anything but warn', () => {
    const violations = checkOxlintConfig({
      ...compliant,
      categories: { correctness: 'error', suspicious: 'error' },
    });
    expect(render(violations)).toContain('categories.suspicious');
  });

  it.each(REQUIRED_TYPE_AWARE_RULES)('fails naming "%s" when it is downgraded to warn', (rule) => {
    const violations = checkOxlintConfig({
      ...compliant,
      rules: { ...compliant.rules, [rule]: 'warn' },
    });
    expect(render(violations)).toContain(rule);
  });

  it('fails naming a rule that is missing outright', () => {
    const { 'typescript/no-floating-promises': _dropped, ...rest } = compliant.rules;
    const violations = checkOxlintConfig({ ...compliant, rules: rest });
    expect(render(violations)).toContain('typescript/no-floating-promises');
  });
});

suite('checkLintFormatScripts (AC3, AC4)', () => {
  it('accepts the documented shape', () => {
    expect(
      checkLintFormatScripts({
        scripts: { lint: 'oxlint --type-aware && biome check .', format: 'biome check --write .' },
      }),
    ).toEqual([]);
  });

  it('rejects a lint script missing --type-aware', () => {
    const violations = checkLintFormatScripts({
      scripts: { lint: 'oxlint && biome check .', format: 'biome check --write .' },
    });
    expect(render(violations)).toContain('--type-aware');
  });

  it('rejects a lint script that writes instead of checking', () => {
    const violations = checkLintFormatScripts({
      scripts: {
        lint: 'oxlint --type-aware && biome check --write .',
        format: 'biome check --write .',
      },
    });
    expect(render(violations)).toContain('checking, not writing');
  });

  it('rejects a format script that only checks', () => {
    const violations = checkLintFormatScripts({
      scripts: { lint: 'oxlint --type-aware && biome check .', format: 'biome check .' },
    });
    expect(render(violations)).toContain('scripts.format');
  });

  it('rejects missing scripts entirely, naming both the missing type-aware run and the missing check', () => {
    const violations = checkLintFormatScripts({});
    expect(violations).toHaveLength(3);
    expect(render(violations)).toContain('scripts.format');
  });
});
