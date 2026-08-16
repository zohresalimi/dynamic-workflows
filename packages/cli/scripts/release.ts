#!/usr/bin/env node
/**
 * `pnpm release` — the one way this package goes to npm (KAR-20.5 AC1).
 *
 * It is a script rather than a paragraph because a paragraph is what we had.
 * [16 §2](../../../docs/16-repo-layout.md) and
 * [ADR-0009](../../../docs/adr/0009-pnpm-workspaces-single-published-package.md)
 * both said the release was `npm version patch && pnpm publish`, and on
 * 2026-08-15 the release that happened was `npm publish` from
 * `packages/cli`. The difference is not stylistic:
 *
 *   * `pnpm pack` rewrites pnpm's workspace protocols — `catalog:`,
 *     `workspace:` — into the versions `pnpm-workspace.yaml` pins. The packed
 *     manifest says `"better-sqlite3": "13.0.2"`.
 *   * `npm publish` has never heard of `catalog:`. It uploads the field
 *     verbatim, and every subsequent `npm install` of the package dies with
 *     `EUNSUPPORTEDPROTOCOL — Unsupported URL Type "catalog:"`.
 *
 * `deflowai@0.1.0` is that package, live and uninstallable, published by a
 * green suite — because every install spec in this repository installs a
 * *pnpm-packed* tarball, in which the protocol is already resolved.
 *
 * So the order below is the whole point, and it is data (`RELEASE_STEPS`) that
 * the runner iterates rather than four calls a reader has to trust:
 *
 *   1. `pack:check`  — build, then publint and attw, *before* anything leaves
 *      the machine. After a publish they lint bytes nobody can un-ship.
 *   2. `pack`        — with pnpm, which is what resolves the protocol.
 *   3. `verify`      — open that tarball and read its manifest. Not the
 *      workspace's manifest, which correctly says `catalog:`.
 *   4. `publish`     — `npm publish <that tarball>`. The bytes that were
 *      checked are the bytes that go up; there is no second packing step in
 *      which they could differ.
 *
 * Usage:
 *
 *   pnpm release                 # the whole thing (npm will ask for the OTP)
 *   pnpm release --dry-run       # steps 1-3, then print the tarball and stop
 *   pnpm release --verify <tgz>  # step 3 alone, against a tarball you have
 *   pnpm release --otp 123456    # pass a one-time password straight through
 *
 * Deprecating a bad release is deliberately **not** here. It is a one-off
 * against the registry with no artefact to check (`npm deprecate
 * deflowai@0.1.0 "<why> — use <version>"`), and wrapping it would suggest this
 * script is the place to think about it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const cliDir = fileURLToPath(new URL('..', import.meta.url));
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The dependency blocks a consumer of the published package actually resolves.
 *
 * `devDependencies` is deliberately absent: `@DeFlow/*` are `workspace:*`
 * devDependencies of `packages/cli` and must stay that way, and npm never
 * installs them for anybody who installs this package. A check that read every
 * block would demand the impossible and would then be switched off.
 */
export const PUBLISHED_DEPENDENCY_BLOCKS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
] as const;

export type PublishedDependencyBlock = (typeof PUBLISHED_DEPENDENCY_BLOCKS)[number];

/**
 * Specifier protocols that mean something inside this workspace and nothing on
 * the registry.
 *
 * Four rather than the one that fired. `catalog:` is 0.1.0's actual defect;
 * `workspace:` would reach a user as a 404 on a private package; `link:` and
 * `file:` as a path that exists on the publisher's machine and nowhere else.
 * They are one mistake — a specifier only this checkout can resolve — and there
 * is no reason to wait for the other three to happen before checking for them.
 */
export const UNRESOLVED_PROTOCOLS = ['catalog:', 'workspace:', 'link:', 'file:'] as const;

export interface UnresolvedSpecifier {
  readonly block: PublishedDependencyBlock;
  readonly name: string;
  readonly value: string;
}

interface DependencyBlocks {
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

/** Every published-block specifier npm could not resolve, in manifest order. */
export function unresolvedSpecifiers(manifest: DependencyBlocks): UnresolvedSpecifier[] {
  const found: UnresolvedSpecifier[] = [];
  for (const block of PUBLISHED_DEPENDENCY_BLOCKS) {
    for (const [name, value] of Object.entries(manifest[block] ?? {})) {
      if (UNRESOLVED_PROTOCOLS.some((protocol) => value.startsWith(protocol))) {
        found.push({ block, name, value });
      }
    }
  }
  return found;
}

/** What npm will do about them, rather than "expected [] to equal []". */
export function describeUnresolved(found: readonly UnresolvedSpecifier[]): string {
  if (found.length === 0) return '';
  return [
    'this artefact carries dependency specifiers only a pnpm workspace can resolve:',
    ...found.map((entry) => `  ${entry.block}["${entry.name}"] = "${entry.value}"`),
    '',
    'npm refuses such a package outright — `npm error code EUNSUPPORTEDPROTOCOL` — so it installs',
    'for nobody, which is what happened to deflowai@0.1.0 on 2026-08-15. `pnpm pack` rewrites these',
    'into the versions pnpm-workspace.yaml pins; `npm publish` from the package directory does not,',
    'because it has never heard of them. Publish the pnpm-packed tarball, which is what',
    '`pnpm release` does.',
  ].join('\n');
}

/** The `package.json` inside a packed tarball — the manifest npm would serve. */
export function readPackedManifest(tgz: string): DependencyBlocks & Record<string, unknown> {
  if (!existsSync(tgz)) throw new Error(`no such tarball: ${tgz}`);
  const text = execFileSync('tar', ['xzfO', tgz, 'package/package.json'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(text) as DependencyBlocks & Record<string, unknown>;
}

export interface ReleaseContext {
  /** Where the packed tarball ends up; set by the `pack` step. */
  tgz?: string;
  readonly destDir: string;
  readonly dryRun: boolean;
  readonly otp?: string | undefined;
  readonly log: (line: string) => void;
}

function must(label: string, command: string, args: readonly string[], cwd: string): void {
  const child = spawnSync(command, [...args], { cwd, stdio: 'inherit' });
  if (child.status !== 0) {
    throw new Error(`${label} exited ${String(child.status)}`);
  }
}

export interface ReleaseStep {
  readonly id: string;
  readonly what: string;
  readonly run: (context: ReleaseContext) => void;
}

/**
 * The release, in the one order that works, as data.
 *
 * `main` iterates this array; there is no second place the order is written
 * down, so `packages/cli/test/publish-integrity.test.ts` asserting on it is
 * asserting on what runs.
 */
export const RELEASE_STEPS: readonly ReleaseStep[] = [
  {
    id: 'pack:check',
    what: 'build, publint and attw — before anything leaves the machine',
    run: (context) => {
      context.log('→ pnpm pack:check');
      must('pnpm pack:check', 'pnpm', ['pack:check'], repoRoot);
    },
  },
  {
    id: 'pack',
    what: 'pnpm pack, which resolves catalog: and workspace: into real versions',
    run: (context) => {
      context.log('→ pnpm pack');
      const packed = execFileSync(
        'pnpm',
        ['pack', '--pack-destination', context.destDir, '--json'],
        { cwd: cliDir, encoding: 'utf8' },
      );
      const entry = JSON.parse(packed) as { filename?: string };
      if (typeof entry.filename !== 'string') {
        throw new Error(`pnpm pack --json returned no filename:\n${packed}`);
      }
      context.tgz = entry.filename;
      context.log(`  packed ${entry.filename}`);
    },
  },
  {
    id: 'verify',
    what: 'read the manifest out of that tarball, not out of the workspace',
    run: (context) => {
      if (context.tgz === undefined) throw new Error('nothing was packed to verify');
      verifyTarball(context.tgz, context.log);
    },
  },
  {
    id: 'publish',
    what: 'npm publish <that tarball> — the bytes that were checked',
    run: (context) => {
      if (context.tgz === undefined) throw new Error('nothing was packed to publish');
      if (context.dryRun) {
        context.log(`→ --dry-run: not publishing. The tarball is at ${context.tgz}`);
        return;
      }
      context.log('→ npm publish');
      must(
        'npm publish',
        'npm',
        [
          'publish',
          context.tgz,
          '--access',
          'public',
          ...(context.otp ? ['--otp', context.otp] : []),
        ],
        repoRoot,
      );
    },
  },
];

/** Step 3 on its own. Throws with `describeUnresolved`'s message if it fails. */
export function verifyTarball(tgz: string, log: (line: string) => void = () => {}): void {
  const manifest = readPackedManifest(tgz);
  const found = unresolvedSpecifiers(manifest);
  if (found.length > 0) {
    throw new Error(`${tgz}: ${describeUnresolved(found)}`);
  }
  log(`✓ ${tgz}: no unresolved dependency specifier in the published blocks`);
}

const USAGE = `pnpm release — the one way deflowai goes to npm.

  pnpm release                 build, check, pack with pnpm, verify the packed
                               manifest, then npm publish that tarball
  pnpm release --dry-run       everything except the publish; prints the tarball
  pnpm release --verify <tgz>  verify a tarball you already have, and stop
  pnpm release --otp <code>    pass a one-time password through to npm

Publishing any other way — npm publish from packages/cli, in particular — sends
pnpm's catalog: protocol to the registry unresolved and produces a package npm
refuses to install. That is deflowai@0.1.0.`;

export function main(argv: readonly string[]): number {
  const log = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  if (argv.includes('--help') || argv.includes('-h')) {
    log(USAGE);
    return 0;
  }

  const verifyAt = argv.indexOf('--verify');
  if (verifyAt !== -1) {
    const tgz = argv.at(verifyAt + 1);
    if (tgz === undefined || tgz.startsWith('--')) {
      process.stderr.write('--verify needs a tarball path\n');
      return 2;
    }
    try {
      verifyTarball(tgz, log);
      return 0;
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  const otpAt = argv.indexOf('--otp');
  const context: ReleaseContext = {
    destDir: mkdtempSync(join(tmpdir(), 'DeFlow-release-')),
    dryRun: argv.includes('--dry-run'),
    otp: otpAt === -1 ? undefined : argv.at(otpAt + 1),
    log,
  };

  for (const step of RELEASE_STEPS) {
    try {
      step.run(context);
    } catch (error) {
      process.stderr.write(
        `release step "${step.id}" (${step.what}) failed:\n` +
          `${error instanceof Error ? error.message : String(error)}\n`,
      );
      return 1;
    }
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
