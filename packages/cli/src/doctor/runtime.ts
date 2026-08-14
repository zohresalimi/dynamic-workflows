/**
 * KAR-18.4, category 1 — Runtime (docs/03-local-development.md §8).
 *
 * Node's version, pnpm's, and the two directories DeFlow writes to: the global
 * state dir (`$XDG_DATA_HOME/DeFlow` or `~/.DeFlow`) and the repo-local
 * `.DeFlow/`. Both are tested **by writing** — see `./paths.ts` — because a
 * directory that exists and refuses a write is the case `existsSync` waves
 * through, and it is the common one.
 *
 * This is one of only two categories that can produce a `fail` from a fact
 * about the machine rather than a bug (the other is git). That is deliberate
 * and it is what makes the exit code worth branching on: `5` means *DeFlow
 * cannot run here*, not *something is imperfect here*.
 *
 * Verifies: EPIC-18-S26, EPIC-18-S33 · AC1, AC8
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { probeWritable, resolveOnPath } from './paths.ts';
import type { DoctorCheck } from './report.ts';

const run = promisify(execFile);

/** docs/02-tech-stack.md: Node 24 is the floor — erasable syntax, native
 * TypeScript loading and `node --run` are all 24-and-later. */
export const MIN_NODE_MAJOR = 24;

export interface RuntimeInput {
  /** `process.versions.node`, or a fixture. */
  readonly nodeVersion: string;
  /** `PATH`, already split into directories. */
  readonly roots: readonly string[];
  /** The resolved global state directory (absolute). */
  readonly dataDir: string;
  /** The repo-local `.DeFlow/` (absolute). */
  readonly workspaceDir: string;
}

function nodeCheck(version: string): DoctorCheck {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (Number.isNaN(major)) {
    return {
      id: 'runtime.node',
      status: 'fail',
      detail: `could not read a major version out of "${version}"; DeFlow needs Node >= ${MIN_NODE_MAJOR}`,
      action: `install Node ${MIN_NODE_MAJOR} or later, then run 'deflow doctor' again`,
    };
  }
  return major >= MIN_NODE_MAJOR
    ? {
        id: 'runtime.node',
        status: 'ok',
        detail: `Node ${version} meets the >= ${MIN_NODE_MAJOR} floor`,
        data: { version, major },
      }
    : {
        id: 'runtime.node',
        status: 'fail',
        detail:
          `Node ${version} is below the ${MIN_NODE_MAJOR} floor: DeFlow ships erasable-syntax ` +
          'TypeScript that earlier runtimes cannot load at all. Upgrade Node and run doctor again.',
        action:
          `install Node ${MIN_NODE_MAJOR} or later (nvm: 'nvm install ${MIN_NODE_MAJOR}'), then ` +
          "run 'deflow doctor' again",
        data: { version, major },
      };
}

/**
 * pnpm's version, from the binary on the operator's own `PATH`.
 *
 * A `warn` rather than a `fail` when it is absent, because pnpm is the
 * *development* workflow's package manager (docs/03 §2): an installed
 * `npx deflow` tarball runs without it, and reporting a fail here would make
 * `doctor` red on the machines it was written to reassure.
 */
async function pnpmCheck(roots: readonly string[]): Promise<DoctorCheck> {
  const binary = resolveOnPath(roots, 'pnpm');
  if (binary === null) {
    return {
      id: 'runtime.pnpm',
      status: 'warn',
      detail:
        "pnpm is not on PATH. It is the development workflow's package manager; an installed " +
        'DeFlow runs without it, but "pnpm build", "pnpm test" and the recording refresh do not.',
      action: 'npm install -g pnpm',
    };
  }

  try {
    const { stdout } = await run(binary, ['--version'], { timeout: 10_000 });
    const version = stdout.trim();
    return {
      id: 'runtime.pnpm',
      status: 'ok',
      detail: `pnpm ${version} at ${binary}`,
      data: { version, binary },
    };
  } catch (error) {
    return {
      id: 'runtime.pnpm',
      status: 'warn',
      detail: `${binary} would not report a version: ${
        error instanceof Error ? error.message : String(error)
      }`,
      action: `run '${binary} --version' yourself — doctor could not`,
    };
  }
}

/** AC8 — the absolute path and the errno, always, in both directions. */
function writableCheck(
  id: string,
  label: string,
  dir: string,
  hint: string,
  action: string,
): DoctorCheck {
  const probe = probeWritable(dir);

  if (probe.writable) {
    return { id, status: 'ok', detail: `${label} is writable: ${dir}`, data: { path: dir } };
  }
  return {
    id,
    status: 'fail',
    detail: `${label} at ${dir} is not writable (${probe.errno ?? 'UNKNOWN'}): ${
      probe.message ?? 'the write was refused'
    }. ${hint}`,
    action,
    data: { path: dir, errno: probe.errno },
  };
}

export async function runtimeChecks(input: RuntimeInput): Promise<readonly DoctorCheck[]> {
  return [
    nodeCheck(input.nodeVersion),
    await pnpmCheck(input.roots),
    writableCheck(
      'runtime.state-dir',
      'the global state directory',
      input.dataDir,
      'The ledger, the blob store and the daemon lease all live here — set XDG_DATA_HOME or ' +
        'DeFlow_DATA_DIR to a writable location, or fix the permissions on this one.',
      `chmod u+w ${input.dataDir}, or set DeFlow_DATA_DIR to a directory you can write to`,
    ),
    existsSync(input.workspaceDir)
      ? writableCheck(
          'runtime.workspace-dir',
          'the repo-local .DeFlow/ directory',
          input.workspaceDir,
          'Fix the permissions on it, or run DeFlow from a checkout you can write to.',
          `chmod u+w ${input.workspaceDir}`,
        )
      : {
          // Not created here on purpose: making `.DeFlow/` is `deflow init`'s
          // job (KAR-18.1), and a health check that quietly initialises the
          // workspace would answer a question the operator did not ask.
          id: 'runtime.workspace-dir',
          status: 'warn',
          detail:
            `no .DeFlow/ directory at ${input.workspaceDir} — this repository has not been ` +
            'initialised yet. Run "deflow init" from its root.',
          action: "run 'deflow init' from the root of this repository",
          data: { path: input.workspaceDir },
        },
  ];
}
