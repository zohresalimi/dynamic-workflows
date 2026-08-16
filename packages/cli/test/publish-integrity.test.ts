/**
 * KAR-20.5 — what gets published is what was tested.
 *
 * `deflowai@0.1.0` is on the registry and cannot be installed from it: its
 * manifest says `"better-sqlite3": "catalog:"`, pnpm's workspace-catalog
 * protocol, which `pnpm pack` resolves to `13.0.2` and `npm publish` does not
 * understand at all. npm refuses the package with `EUNSUPPORTEDPROTOCOL`.
 *
 * Every install spec in this repository installs a **pnpm-packed** tarball, in
 * which the protocol is already resolved, so the artefact npm actually
 * publishes has never been exercised by anything. What is here is the half of
 * the fix that can be decided by reading files; the half that has to produce an
 * artefact — pack, read the manifest out of the tarball, and watch the gate go
 * red against a staged one — lives next door in
 * `test/integration/publish-artefact.test.ts`.
 *
 * Verifies: EPIC-20-S41 (the reading half) · EPIC-20-S43 · EPIC-20-S44 ·
 * EPIC-20-S45 · EPIC-20-S46 · AC1, AC2, AC4, AC5, AC6
 */
import { execFileSync } from 'node:child_process';
import { expect, it, describe as suite } from 'vitest';
import {
  checkWorkspaceFilters,
  describe as render,
  writtenFilters,
} from '../../../test/support/guards.ts';
import { parseCommands } from '../../../test/support/readme.ts';
import {
  docFiles,
  exists,
  filterCommandFiles,
  readJson,
  readSources,
  readText,
  repoRoot,
  workspaceNames,
} from '../../../test/support/workspace.ts';
import {
  describeUnresolved,
  PUBLISHED_DEPENDENCY_BLOCKS,
  RELEASE_STEPS,
  UNRESOLVED_PROTOCOLS,
  unresolvedSpecifiers,
} from '../scripts/release.ts';
import {
  BROKEN_RELEASES,
  PACKAGE_NAME,
  REGISTRY_INSTALL_VERIFIED_BY,
  REGISTRY_INSTALL_WORKS,
} from '../src/command-name.ts';

const cli = readJson('packages/cli/package.json');
const root = readJson('package.json');

/** A fenced line that sends this package to the registry by some other route. */
const PUBLISHES = /\b(?:npm|pnpm)\s+publish\b/;

suite('the artefact that would be published (AC2, EPIC-20-S41)', () => {
  it('reports every protocol only the workspace can resolve, in every published block', () => {
    // One fixture covering all four protocols and all three blocks, because
    // `catalog:` was merely the one that fired. `workspace:*` reaches the
    // registry as a 404 on a private package; `link:` and `file:` as a path
    // that exists on the publisher's machine and nowhere else.
    const found = unresolvedSpecifiers({
      dependencies: { 'better-sqlite3': 'catalog:', '@DeFlow/core': 'workspace:*' },
      optionalDependencies: { '@lydell/node-pty': 'link:../pty' },
      peerDependencies: { hono: 'file:../hono' },
    });

    expect(found.map((entry) => `${entry.block}.${entry.name}=${entry.value}`)).toEqual([
      'dependencies.better-sqlite3=catalog:',
      'dependencies.@DeFlow/core=workspace:*',
      'optionalDependencies.@lydell/node-pty=link:../pty',
      'peerDependencies.hono=file:../hono',
    ]);
    expect([...PUBLISHED_DEPENDENCY_BLOCKS]).toEqual([
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
    ]);
    expect([...UNRESOLVED_PROTOCOLS]).toEqual(['catalog:', 'workspace:', 'link:', 'file:']);
  });

  it('ignores devDependencies, which nobody installing the package resolves', () => {
    // `@DeFlow/*` are `workspace:*` devDependencies of the published package and
    // must stay that way. A check that read every block would demand the
    // impossible and would then be turned off.
    expect(
      unresolvedSpecifiers({
        devDependencies: { '@DeFlow/core': 'workspace:*', publint: 'catalog:' },
      }),
    ).toEqual([]);
  });

  it('passes a manifest whose published blocks are all real versions', () => {
    expect(
      unresolvedSpecifiers({
        dependencies: { 'better-sqlite3': '13.0.2' },
        optionalDependencies: { '@lydell/node-pty': '1.2.0-beta.14' },
      }),
    ).toEqual([]);
  });

  it('reports the workspace manifest, which is the 0.1.0 manifest byte for byte', () => {
    // `catalog:` in `packages/cli/package.json` is *correct* — one place holds
    // the version — so this is not a defect in the file. It is the reason the
    // real check has to run against the packed artefact rather than this one,
    // and asserting it here is what stops somebody "fixing" the check by
    // pointing it at the file that reads clean.
    expect(unresolvedSpecifiers(cli).map((entry) => `${entry.name}=${entry.value}`)).toEqual([
      'better-sqlite3=catalog:',
      '@lydell/node-pty=catalog:',
    ]);
  });

  it('says what npm will do about it, rather than "expected [] to equal []"', () => {
    const message = describeUnresolved(unresolvedSpecifiers(cli));

    expect(message).toContain('better-sqlite3');
    expect(message).toContain('catalog:');
    expect(message).toContain('dependencies');
    expect(message).toContain('EUNSUPPORTEDPROTOCOL');
    expect(message).toContain('pnpm pack');
    expect(message).toContain('npm publish');
  });
});

suite('one scripted way to publish (AC1, EPIC-20-S43)', () => {
  it('is a script, and the root package.json is where you find it', () => {
    expect(root.scripts?.release).toBe('node packages/cli/scripts/release.ts');
  });

  it('checks, then packs, then verifies what it packed, then publishes it', () => {
    // The order is the whole criterion: `pack:check` after a publish lints
    // bytes nobody can un-ship, and a publish that does not go through the
    // tarball it verified is publishing something else. The steps are data the
    // runner iterates, not four calls in a row that a reader has to trust.
    expect(RELEASE_STEPS.map((step) => step.id)).toEqual([
      'pack:check',
      'pack',
      'verify',
      'publish',
    ]);
  });

  it('runs no other way to publish in any block a reader would copy', () => {
    // Before this story the documented release was `npm version patch && pnpm
    // publish`, written out in four places, executable in none — and the
    // release that happened used `npm publish` from the package directory,
    // which is a fifth.
    //
    // Fenced blocks rather than whole files, and the distinction is the point
    // of the criterion rather than a softening of it: "one documented *way* to
    // publish" is about what a reader runs. §10's release section has to name
    // `npm publish` in prose — it is the command that broke 0.1.0 and the
    // reason the script exists — and a rule that forbade saying so would force
    // the documentation to stop explaining itself, which is how this defect
    // survived in the first place.
    //
    // `docs/delivery/` is excluded for the same reason: the epics record what
    // was done, including the command that did it.
    const reader = [
      { path: 'README.md', text: readText('README.md') },
      ...readSources(docFiles().filter((path) => !path.startsWith('docs/delivery/'))),
    ];
    const offenders = reader.flatMap(({ path, text }) =>
      parseCommands(text)
        .filter(({ command }) => PUBLISHES.test(command))
        .map(({ command, line }) => `${path}:${String(line)} ${command}`),
    );

    expect(offenders).toEqual([]);
    expect(readText('docs/03-local-development.md')).toContain('pnpm release');
  });

  it('would report a fenced publish command, so the check above is not vacuous', () => {
    const commands = (text: string): string[] =>
      parseCommands(text)
        .filter(({ command }) => PUBLISHES.test(command))
        .map(({ command }) => command);

    expect(commands('```bash\ncd packages/cli && npm publish\n```\n')).toEqual([
      'cd packages/cli && npm publish',
    ]);
    expect(commands('Not `npm publish`, which is what broke 0.1.0.\n')).toEqual([]);
  });

  it('refuses to reship a version the registry already has as broken', () => {
    // AC5's repository half. Deprecating 0.1.0 and publishing its replacement
    // need an npm OTP nobody automates here, so what the tree can guarantee is
    // that `pnpm release` from this tree is not another 0.1.0.
    expect(BROKEN_RELEASES).toContain('0.1.0');
    expect(BROKEN_RELEASES).not.toContain(cli.version);
  });
});

suite('a filter that names no package is not a passing step (AC4, EPIC-20-S44)', () => {
  const names = workspaceNames();

  it('has something to scan', () => {
    // A guard whose input silently became empty is a guard that passes forever.
    const files = filterCommandFiles();
    expect(files.length).toBeGreaterThan(200);
    expect(writtenFilters(readSources(files)).length).toBeGreaterThan(5);
  });

  it('every filter written down in this repository selects a package', () => {
    expect(render(checkWorkspaceFilters(readSources(filterCommandFiles()), names))).toBe('');
  });

  it('reports a filter naming a package the workspace does not have', () => {
    // The guard's own red, and the exact line this story found:
    // `pnpm --filter deflow exec publint` in verify-install, where the package
    // is `deflowai`.
    const message = render(
      checkWorkspaceFilters(
        [
          {
            path: 'packages/cli/scripts/verify-install/lib.ts',
            text: "run('pnpm', ['--filter', 'deflow', 'exec', 'publint'], repoRoot)",
          },
        ],
        ['deflowai', '@DeFlow/web'],
      ),
    );

    expect(message).toContain('packages/cli/scripts/verify-install/lib.ts');
    expect(message).toContain('deflow');
    expect(message).toContain('exits 0');
    expect(message).toContain('deflowai');
  });

  it('reads a filter out of either spelling', () => {
    expect(
      writtenFilters([
        { path: 'a', text: 'pnpm --filter @DeFlow/web build' },
        { path: 'b', text: 'pnpm --filter=deflowai exec publint' },
        { path: 'c', text: "['--filter', 'deflowai', 'exec', 'attw']" },
      ]).map((entry) => entry.name),
    ).toEqual(['@DeFlow/web', 'deflowai', 'deflowai']);
  });

  it('does not invent a name where none was written down', () => {
    // A filter assembled at runtime cannot be checked from here, so the guard
    // is about *written* filters and says so rather than pretending otherwise.
    expect(
      writtenFilters([
        { path: 'a', text: 'pnpm --filter ${filter} exec ${binary}' },
        { path: 'b', text: 'const match = /^\\s*pnpm\\s+(?:--filter\\s+(\\S+)\\s+)?exec/' },
        // An identifier is a reference to the one place the name lives, which
        // is the shape this guard exists to encourage. Reading it as a literal
        // would report `PACKAGE_NAME` as a missing package — the fix failing
        // its own guard.
        { path: 'c.ts', text: "run('pnpm', ['--filter', PACKAGE_NAME, 'exec', 'publint'])" },
      ]),
    ).toEqual([]);
  });
});

suite('verify-install runs the checks it claims to run (AC4, EPIC-20-S45)', () => {
  const lib = readText('packages/cli/scripts/verify-install/lib.ts');

  it('selects the package by the name it is published under', () => {
    expect(lib).toContain('PACKAGE_NAME');
    expect(PACKAGE_NAME).toBe(cli.name);
  });

  it('does not spell the name out a second time', () => {
    // The copy that was wrong. One identifier is the fix; no second copy is
    // what stops it being the fix again the next time the name moves.
    expect(writtenFilters([{ path: 'lib.ts', text: lib }])).toEqual([]);
  });
});

suite('the registry install is unverified, and this says so (AC6, EPIC-20-S46)', () => {
  it('records the gap where a reader of the test will see it', () => {
    const gap =
      'AC6, unmet on purpose and recorded here: nothing in this suite installs ' +
      `${PACKAGE_NAME} from the npm registry. Publishing needs an OTP nobody automates here and ` +
      'the registry is a shared mutable resource, so every install spec packs a local tarball ' +
      'instead — which is the substitution that let 0.1.0 ship. REGISTRY_INSTALL_VERIFIED_BY is ' +
      'the list of specs that close it, and it is empty while REGISTRY_INSTALL_WORKS is false.';

    if (REGISTRY_INSTALL_WORKS) {
      expect(REGISTRY_INSTALL_VERIFIED_BY.length, gap).toBeGreaterThan(0);
      for (const path of REGISTRY_INSTALL_VERIFIED_BY) {
        expect([path, exists(path)]).toEqual([path, true]);
      }
      return;
    }
    expect(REGISTRY_INSTALL_VERIFIED_BY, gap).toEqual([]);
  });

  it('is a list of real spec files whenever it is not empty', () => {
    // Hung off KAR-20.4's own flag rather than a new one, so the day somebody
    // flips it the suite asks for the check that flip implies instead of going
    // green on the strength of a local tarball.
    const source = readText('packages/cli/src/command-name.ts');
    expect(source).toContain('REGISTRY_INSTALL_VERIFIED_BY');
    expect(source).toContain('REGISTRY_INSTALL_WORKS');
  });
});

suite('the release script is reachable as the repository ships it', () => {
  it('runs from a clean checkout with --help and says what it does', () => {
    const help = execFileSync(process.execPath, ['packages/cli/scripts/release.ts', '--help'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(help).toContain('pnpm release');
    expect(help).toContain('--dry-run');
    expect(help).toContain('--verify');
  });
});
