/**
 * KAR-07.5 — what a fan-out will cost on disk, before it is authorized
 * (docs/09-workspace-and-safety.md §5.3; EPIC-07-S22).
 *
 * ```
 * N × (tracked working-tree size)  +  N × node_modules   (≈ 0 under pnpm)
 * ```
 *
 * **There is no `.git` term, and its absence is verified rather than
 * forgotten**: a 300 KB `.git` served a 24 KB worktree with no object
 * duplication, because worktrees share the object store. Adding a per-worktree
 * `.git` term would overstate an 8-node fan-out on a large repository by
 * gigabytes, and a figure that is visibly wrong is a figure users learn to
 * dismiss.
 *
 * The point of rendering it at all is behavioural, not informational: a user
 * told "this plan will use 14 GB" migrates to pnpm on their own, which is the
 * outcome §5.1 wants and cannot get by recommending it.
 *
 * Units are binary — 1 MB = 1024 KB, `du -h`'s convention — which is what
 * makes §5.3's worked example render as "approximately 7.2 GB".
 *
 * Verifies: EPIC-07-S22
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { detectPackageManager, type PackageManager } from './package-manager.ts';
import { splitNul } from './worktree-include.ts';

export interface DiskEstimateTerm {
  readonly label: string;
  readonly perNodeBytes: number;
  readonly totalBytes: number;
}

export interface DiskEstimate {
  readonly nodes: number;
  /** Whether the manager shares a content-addressable store, collapsing the
   * `node_modules` term to ~0. pnpm does; npm and yarn each pay a full copy. */
  readonly sharesStore: boolean;
  readonly terms: readonly DiskEstimateTerm[];
  readonly totalBytes: number;
}

export interface DiskEstimateInput {
  /** How many worktrees the plan fans out to. */
  readonly nodes: number;
  /** The size of the tracked working tree, in bytes. */
  readonly trackedBytes: number;
  /** The main checkout's `node_modules`, in bytes. Absent means none yet. */
  readonly nodeModulesBytes?: number;
  readonly manager: PackageManager | null;
}

/** pnpm's `node_modules` is hardlinks and symlinks into one store, so the
 * second and third worktrees cost essentially nothing (§5.1). */
const SHARES_STORE: ReadonlySet<PackageManager> = new Set<PackageManager>(['pnpm']);

export function estimateFanOutDisk(input: DiskEstimateInput): DiskEstimate {
  if (!Number.isInteger(input.nodes) || input.nodes < 1) {
    throw new RangeError(
      `a fan-out estimate needs at least one node, got ${String(input.nodes)} — a zero or ` +
        'negative count would render a figure that is not about any plan.',
    );
  }

  const sharesStore = input.manager !== null && SHARES_STORE.has(input.manager);
  const nodeModulesPerNode = sharesStore ? 0 : (input.nodeModulesBytes ?? 0);

  const terms: DiskEstimateTerm[] = [
    {
      label: 'tracked working tree',
      perNodeBytes: input.trackedBytes,
      totalBytes: input.nodes * input.trackedBytes,
    },
    {
      label: 'node_modules',
      perNodeBytes: nodeModulesPerNode,
      totalBytes: input.nodes * nodeModulesPerNode,
    },
  ];

  return {
    nodes: input.nodes,
    sharesStore,
    terms,
    totalBytes: terms.reduce((sum, term) => sum + term.totalBytes, 0),
  };
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * `du -h`'s shape: binary divisors, and one fractional digit only below 10,
 * where it is still a tenth of the reading rather than noise. "7.2 GB" and
 * "960 MB" are the two figures §5.3 names.
 */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const label = UNITS[unit];
  if (unit === 0) return `${Math.round(value)} ${label}`;
  return `${value >= 10 ? String(Math.round(value)) : value.toFixed(1)} ${label}`;
}

/** The plan-approval line, with the breakdown §5.3 asks for. */
export function renderDiskEstimate(estimate: DiskEstimate): string {
  const breakdown = estimate.terms
    .map((term) => `${term.label} ${formatBytes(term.perNodeBytes)}`)
    .join(' + ');
  const store = estimate.sharesStore
    ? ' The node_modules term is approximately zero because this project uses pnpm, whose ' +
      'content-addressable store is shared across worktrees.'
    : '';
  return (
    `About ${formatBytes(estimate.totalBytes)} across ${estimate.nodes} worktrees — ` +
    `${estimate.nodes} × (${breakdown}).${store}`
  );
}

// ── measuring a real repository ──────────────────────────────────────────────

/** The one git call this module makes. Same shape the Workspace Manager
 * injects, so the recorded-argv seam is the same seam. */
interface MeasuringGit {
  run(
    args: readonly string[],
    opts?: { readonly cwd?: string },
  ): Promise<{ readonly exitCode: number; readonly stdout: string }>;
}

export interface MeasuredRepo {
  /** The sum of every tracked file's size — the term multiplied by N. */
  readonly trackedBytes: number;
  /** The main checkout's `node_modules`, or 0 when there is none yet. */
  readonly nodeModulesBytes: number;
  readonly manager: PackageManager | null;
}

/** Apparent size, recursively. Symlinks are not followed: a link is bytes of
 * path, and following one out of the tree would double-count a store. */
async function treeBytes(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await treeBytes(path);
    else if (entry.isFile()) total += (await stat(path).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/**
 * What a fan-out from this repository would actually cost, measured.
 *
 * The tracked term comes from `git ls-files -z` rather than from walking the
 * working tree, because the working tree also holds every gitignored build
 * artifact — and a worktree is a checkout of the *tracked* files only. Walking
 * it instead would report a `dist/` and a `.next/` that no worktree is going
 * to receive.
 */
export async function measureRepoDisk(git: MeasuringGit, repoRoot: string): Promise<MeasuredRepo> {
  const listed = await git.run(['ls-files', '-z'], { cwd: repoRoot });
  const tracked = listed.exitCode === 0 ? splitNul(listed.stdout) : [];

  let trackedBytes = 0;
  for (const path of tracked) {
    trackedBytes += (await stat(join(repoRoot, path)).catch(() => ({ size: 0 }))).size;
  }

  const present = await readdir(repoRoot).catch((): string[] => []);
  return {
    trackedBytes,
    nodeModulesBytes: present.includes('node_modules')
      ? await treeBytes(join(repoRoot, 'node_modules'))
      : 0,
    manager: detectPackageManager(present)?.manager ?? null,
  };
}
