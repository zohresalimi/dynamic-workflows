/**
 * KAR-10.5 — the half of reconnaissance that is I/O: what DeFlow reads off the
 * worktree for itself (docs/06-planning-and-replanning.md §2.1).
 *
 * Everything here is an **observation**, never a claim. The manifest bytes, the
 * script keys really in them, the files really under the areas the spec named,
 * the gate definitions really in `.DeFlow/gates/`. `deriveReconFacts` in
 * `@DeFlow/core` measures the agent's claims against these, and that join is
 * what `confidence` means — so the value of this module is precisely that it
 * asks the filesystem rather than the model.
 *
 * **Nothing here writes.** Not a normalised YAML file, not a cached index, not
 * a `.DeFlow/` scratch entry: the recon node runs at `read`, and a survey that
 * modified the tree it surveyed would make the next node's diff a lie
 * (EPIC-10-S27's third scenario).
 *
 * **No absolute path leaves this module.** Every path in the observation and in
 * the survey document is repo-relative, because the survey is written to the CAS
 * and referenced from a fact — and a fact carrying somebody's home directory is
 * a machine-local detail in a durable ledger that outlives the machine. It is
 * also what `HandleSchema`'s `file://` arm refuses outright (§1).
 *
 * Verifies: EPIC-10-S24, EPIC-10-S27 · AC3, AC4
 */
import type {
  GateObservation,
  ManifestKind,
  ManifestObservation,
  RepoObservation,
} from '@DeFlow/core';
import { MANIFEST_KINDS } from '@DeFlow/core';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';

/** Where a repository's own gate definitions live (F7.6, catalogued here and
 * executed in EPIC-12). */
export const GATES_DIR = join('.DeFlow', 'gates');

/**
 * Directories a survey never descends into.
 *
 * `node_modules` and `.git` because they are somebody else's bytes and counting
 * them would make every `blastRadiusFiles` estimate meaningless; `.DeFlow`
 * because it is DeFlow's own state, and a worktree of a repository DeFlow is
 * running in would otherwise count its own worktrees.
 */
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.DeFlow']);

export interface SurveyOptions {
  /** Absolute path of the worktree being surveyed. Never leaves this module. */
  readonly root: string;
  /** The areas the spec named, repo-relative, globs allowed. */
  readonly scopePaths: readonly string[];
}

/**
 * The full survey, as the bytes that go to the CAS (AC6).
 *
 * The file listing lives here and **not** on the `scope/touched-paths` fact:
 * a 200-file listing does not belong in a context packet, and the answer to a
 * body that does not fit is a handle, never a truncated array.
 */
export interface RepoSurveyDocument {
  readonly observation: RepoObservation;
  /** Every file under the scope paths, repo-relative and sorted. */
  readonly files: readonly string[];
}

/** The literal directory prefix of a glob: `packages/ui/src/**` → `packages/ui/src`. */
function literalPrefix(pattern: string): string {
  const parts = pattern.split('/');
  const literal: string[] = [];
  for (const part of parts) {
    if (/[*?[\]]/.test(part)) break;
    literal.push(part);
  }
  return literal.join('/');
}

/** Repo-relative, POSIX-separated, so a Windows survey reads like every other. */
const toRepoRelative = (root: string, absolute: string): string =>
  relative(root, absolute).split(sep).join('/');

async function walkFiles(root: string, directory: string, into: Set<string>): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    // A scope path the spec named and the repository does not have is a real
    // answer — the count is zero — not an error that stops the survey.
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      await walkFiles(root, join(directory, entry.name), into);
    } else if (entry.isFile()) {
      into.add(toRepoRelative(root, join(directory, entry.name)));
    }
  }
}

/** `scripts` as a string map, ignoring any member that is not a string — a
 * manifest is somebody else's file and may hold anything. */
function scriptsOf(manifest: unknown): Record<string, string> {
  if (typeof manifest !== 'object' || manifest === null) return {};
  const scripts = (manifest as { scripts?: unknown }).scripts;
  if (typeof scripts !== 'object' || scripts === null) return {};
  return Object.fromEntries(
    Object.entries(scripts as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

async function readManifest(root: string): Promise<ManifestObservation | null> {
  for (const kind of MANIFEST_KINDS) {
    let text: string;
    try {
      text = await readFile(join(root, kind), 'utf8');
    } catch {
      continue;
    }

    if (kind !== 'package.json') {
      // Recognised, and read — but its script table is not JSON, so nothing is
      // claimed about it here. A `cargo test` claim will land `speculative`,
      // which is the honest answer until somebody teaches this a TOML parser.
      return { path: kind, kind: kind as ManifestKind, text, scripts: {} };
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      // A manifest DeFlow cannot parse is still a manifest it read: the file
      // exists, so this is not the AC8 "no manifest at all" case.
      parsed = null;
    }
    const packageManager = (parsed as { packageManager?: unknown } | null)?.packageManager;
    return {
      path: kind,
      kind,
      text,
      scripts: scriptsOf(parsed),
      ...(typeof packageManager === 'string' ? { packageManager } : {}),
    };
  }
  return null;
}

/** The `id:` a gate definition declares, or its filename — never invented. */
function gateIdOf(text: string, file: string): string {
  let parsed: unknown = null;
  try {
    parsed = parseYaml(text);
  } catch {
    parsed = null;
  }
  const declared = (parsed as { id?: unknown } | null)?.id;
  if (typeof declared === 'string' && declared.length > 0) return declared;
  return file.replace(/\.(ya?ml)$/, '');
}

async function readGates(root: string): Promise<readonly GateObservation[]> {
  const directory = join(root, GATES_DIR);
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const gates: GateObservation[] = [];
  for (const file of entries.filter((entry) => /\.ya?ml$/.test(entry)).toSorted()) {
    const text = await readFile(join(directory, file), 'utf8');
    gates.push({
      id: gateIdOf(text, file),
      path: `${GATES_DIR.split(sep).join('/')}/${file}`,
      lines: text.split('\n').length,
    });
  }
  return gates;
}

/**
 * AC3, AC4 — the survey: the manifest, the counted path set and the gates
 * already in the repository.
 *
 * Total: a directory that is not there, a manifest that will not parse and a
 * gate file with no `id` are all answers rather than throws, because a recon
 * node that failed on an absent directory would fail on exactly the
 * repositories the planner most needs a discovery step for.
 */
export async function surveyRepository(options: SurveyOptions): Promise<RepoSurveyDocument> {
  const { root } = options;

  const files = new Set<string>();
  for (const pattern of options.scopePaths) {
    const prefix = literalPrefix(pattern);
    if (prefix === '' || prefix.startsWith('..') || prefix.startsWith('/')) continue;
    const absolute = join(root, prefix);
    let entry: Awaited<ReturnType<typeof stat>>;
    try {
      entry = await stat(absolute);
    } catch {
      continue;
    }
    if (entry.isDirectory()) await walkFiles(root, absolute, files);
    else if (entry.isFile()) files.add(toRepoRelative(root, absolute));
  }

  const sorted = [...files].toSorted();
  const observation: RepoObservation = {
    manifest: await readManifest(root),
    scope: { paths: [...options.scopePaths], fileCount: sorted.length },
    gates: await readGates(root),
  };

  return { observation, files: sorted };
}
