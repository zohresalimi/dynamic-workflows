/**
 * KAR-07.5 — what provisioning a worktree's environment will do, as data
 * (docs/09-workspace-and-safety.md §5.1, §5.2).
 *
 * The plan exists so that §5.1's hard rule can be *asserted* rather than
 * merely followed:
 *
 * > **Never symlink a shared `node_modules` across worktrees.** Two agents
 * > running installs concurrently against one shared tree corrupts it, and it
 * > defeats the isolation the worktree exists to provide. The one safe symlink
 * > target is the *store*, which pnpm already does correctly.
 *
 * A grep for `symlink(` would not catch the failure this guards, because the
 * failure does not arrive as a rogue call — it arrives as a plausible
 * optimisation ("the third worktree could just link the second's tree"). So
 * the step union *can* express a symlink, `assertNoSharedNodeModules` refuses
 * the one target that must never appear, and the provisioner runs that guard
 * before executing a single step. The unit table in ./provision-plan.test.ts
 * asserts it over the plan for three worktrees.
 *
 * Order is part of the plan. Copies first, because `.worktreeinclude` files
 * are `.env`-shaped and a setup command frequently reads them; the reflink
 * clone next, so the install has a warm tree to reconcile against where the
 * filesystem supports cloning (§5.2); the install last.
 *
 * Verifies: EPIC-07-S20 · AC6
 */
import { sep } from 'node:path';

/** Copy one `.worktreeinclude` file, preserving its mode (AC2). */
export interface CopyStep {
  readonly kind: 'copy';
  /** Repo-relative, and the same on both ends — carried so the
   * `workspace.included_file` event names it without re-deriving it by string
   * surgery on two absolute paths. */
  readonly path: string;
  readonly from: string;
  readonly to: string;
  /** The source's mode, which the copy must not widen. */
  readonly mode: number;
}

/**
 * The §5.2 fast path: a copy-on-write clone of an existing tree, planned only
 * once a probe has cloned a one-byte file in the target directory for real.
 * Still a *copy* — each worktree ends up with its own directory.
 */
export interface CloneStep {
  readonly kind: 'clone';
  readonly from: string;
  readonly to: string;
}

/**
 * A symlink. Nothing in DeFlow plans one today; the variant exists so the
 * guard below has something to refuse, and so a future store-directory link
 * has a shape to be written in that is checked rather than free-hand.
 */
export interface SymlinkStep {
  readonly kind: 'symlink';
  readonly from: string;
  readonly to: string;
}

/** The install, or `workspace.setup`. Run in the worktree. */
export interface RunStep {
  readonly kind: 'run';
  readonly command: string;
  readonly cwd: string;
}

export type ProvisionStep = CopyStep | CloneStep | SymlinkStep | RunStep;

export type ProvisionPlan = readonly ProvisionStep[];

export interface IncludedFile {
  /** Repo-relative. */
  readonly path: string;
  readonly mode: number;
}

export interface PlanInput {
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly includes: readonly IncludedFile[];
  /** `workspace.setup`, or the lockfile's install command, or `null`. */
  readonly setupCommand: string | null;
  /** Whether the §5.2 probe actually cloned a byte in the target directory. */
  readonly reflinkSupported: boolean;
  /** Whether the main checkout has a `node_modules` worth cloning. */
  readonly hasSourceNodeModules: boolean;
}

/**
 * A symlink that would have shared one `node_modules` between worktrees.
 *
 * Thrown, not logged: this is the one condition in the whole provisioning
 * path where continuing produces silent corruption rather than a visible
 * failure, and a corrupted `node_modules` shared by four agents is diagnosed
 * days later as four unrelated flaky nodes.
 */
export class SharedNodeModulesRefused extends Error {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    super(
      `The provisioning plan would have symlinked "${to}" to "${from}", which shares one ` +
        'node_modules across worktrees. Two agents installing concurrently against a shared tree ' +
        'corrupt it, and a shared tree defeats the isolation the worktree exists to provide ' +
        '(docs/09-workspace-and-safety.md §5.1). The one safe shared target is the package ' +
        "manager's own content-addressable store, which pnpm manages itself.",
    );
    this.name = 'SharedNodeModulesRefused';
    this.from = from;
    this.to = to;
  }
}

const NODE_MODULES = 'node_modules';

/** Does this path name a `node_modules` directory, or something inside one?
 * Segment-wise, so `my_node_modules_backup` is not a false positive and
 * `./node_modules` and `node_modules/` are not false negatives. */
function touchesNodeModules(path: string): boolean {
  return path
    .split(/[\\/]/)
    .filter((segment) => segment !== '' && segment !== '.')
    .includes(NODE_MODULES);
}

/** §5.1's hard rule, run before any step executes. */
export function assertNoSharedNodeModules(plan: ProvisionPlan): void {
  for (const step of plan) {
    if (step.kind !== 'symlink') continue;
    if (touchesNodeModules(step.from) || touchesNodeModules(step.to)) {
      throw new SharedNodeModulesRefused(step.from, step.to);
    }
  }
}

const join = (...parts: readonly string[]): string => parts.join(sep);

export function planWorktreeProvision(input: PlanInput): ProvisionPlan {
  const steps: ProvisionStep[] = input.includes.map((file) => ({
    kind: 'copy',
    path: file.path,
    from: join(input.repoRoot, file.path),
    to: join(input.worktreePath, file.path),
    mode: file.mode,
  }));

  if (input.reflinkSupported && input.hasSourceNodeModules) {
    steps.push({
      kind: 'clone',
      from: join(input.repoRoot, NODE_MODULES),
      to: join(input.worktreePath, NODE_MODULES),
    });
  }

  if (input.setupCommand !== null) {
    steps.push({ kind: 'run', command: input.setupCommand, cwd: input.worktreePath });
  }

  return steps;
}
