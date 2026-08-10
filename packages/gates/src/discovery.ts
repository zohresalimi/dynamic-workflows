/**
 * KAR-12.6 — discovering gate definitions from `.DeFlow/gates/*.{yaml,yml}`
 * and from repo reconnaissance, and hashing them into the run manifest
 * (docs/10-verification-gates.md §2).
 *
 * Three things live here, and the order they appear in this file is the
 * order they act:
 *
 * **Discovery goes through the same door as everything else.** A `GateSource`
 * — a path and the file's raw bytes — is the one shape both a custom
 * `.DeFlow/gates/typecheck.yaml` and a built-in derived from
 * `package.json#scripts.typecheck` produce, and `loadGateSource` hands both
 * to KAR-12.1's `loadGateDefinition` unchanged. One parser, one validator,
 * one hash mechanism, exactly as the epic asks — a bad file, custom or
 * built-in, refuses the whole run rather than being silently skipped (AC2).
 *
 * **The hash is over bytes, never over the parsed object.** A parsed-object
 * hash normalises away comments, key order and whitespace — a reviewer's
 * "temporarily loosen this" comment edit would be invisible, which defeats
 * the entire anti-drift point of the manifest (AC1, AC3).
 *
 * **Divergence is a comparison, not an action.** `checkGateDivergence` only
 * says whether the bytes still match; `sealDivergedVerdict` is what a caller
 * seals when they do not. Neither one runs a gate — the caller that finds
 * `diverged: true` is the one deciding not to, which is what makes "does not
 * run against the new definition and does not run against the cached one
 * either" (S37) true by construction rather than by a flag somewhere.
 */
import type { CriterionId, GateId, NodeId, VerdictV3 } from '@DeFlow/core';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type GateDefinition, type LoadGateOptions, loadGateDefinition } from './definition.ts';
import type { GateParser } from './parsers.ts';
import { sealVerdict } from './verdict-of.ts';

/** `{ id, path, sha256 }` — exactly what `gates.loaded` carries per entry
 * (`DeFlow.core`'s `GatesLoadedSchema`). */
export interface GateManifestEntry {
  readonly id: string;
  readonly path: string;
  readonly sha256: string;
}

/** A manifest entry, plus the definition it was parsed into. */
export interface DiscoveredGate extends GateManifestEntry {
  readonly definition: GateDefinition;
}

/** One file's raw bytes, before it is parsed — real or synthesised. */
export interface GateSource {
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** `sha256sum` on the bytes, hex — what `gates.loaded.gates[].sha256` carries. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Parses and hashes one source through KAR-12.1's loader.
 *
 * Throws `GateLoadError`, naming the file, for anything the schema or the
 * purity/`cwd` rules refuse (AC2) — a caller discovering several files calls
 * this once per source and lets the first bad one stop the whole run.
 */
export function loadGateSource(source: GateSource, options: LoadGateOptions = {}): DiscoveredGate {
  const text = Buffer.from(source.bytes).toString('utf8');
  const definition = loadGateDefinition(source.path, text, options);
  return {
    id: definition.id,
    path: source.path,
    sha256: sha256Hex(source.bytes),
    definition,
  };
}

const GATE_FILE_PATTERN = /\.ya?ml$/;

/**
 * Every `*.yaml`/`*.yml` file directly under a `.DeFlow/gates/` directory, as
 * unparsed sources.
 *
 * A missing directory is a legal answer — zero custom gates — not an error:
 * a repository that has not written one yet is the common case, and failing
 * on it would refuse every run in a fresh checkout. Sorted, so two runs over
 * the same directory discover gates in the same order.
 */
export async function readGatesDirectory(gatesDir: string): Promise<readonly GateSource[]> {
  let entries: string[];
  try {
    entries = await readdir(gatesDir);
  } catch {
    return [];
  }

  const files = entries.filter((entry) => GATE_FILE_PATTERN.test(entry)).toSorted();
  const sources: GateSource[] = [];
  for (const file of files) {
    const path = join(gatesDir, file);
    sources.push({ path, bytes: await readFile(path) });
  }
  return sources;
}

/**
 * §2 — DeFlow's built-in gates, one per well-known `package.json` script a
 * repository actually declares.
 *
 * A short, named list rather than "every script in the file": an arbitrary
 * script is not a gate DeFlow can put a parser on with any honesty, and the
 * three named here are the ones §1's deterministic tier and this workspace's
 * own `package.json` agree on. `findings.parser: 'none'` for `lint` and
 * `test` is the honest choice until a later story teaches a built-in gate the
 * pinned lint/test runner's own JSON shape — the exit code is real evidence
 * on its own (§2's escape hatch), and a guessed parser would be worse than
 * none.
 */
export const BUILTIN_GATE_SCRIPTS: readonly {
  readonly script: string;
  readonly title: string;
  readonly parser: GateParser;
}[] = [
  { script: 'typecheck', title: 'TypeScript project check', parser: 'tsc' },
  { script: 'lint', title: 'Lint', parser: 'none' },
  { script: 'test', title: 'Unit tests', parser: 'none' },
];

function builtinGateYaml(script: string, title: string, parser: GateParser): string {
  return [
    `id: ${script}`,
    'kind: deterministic',
    `title: ${title}`,
    `run: pnpm run ${script}`,
    'cwd: worktree',
    'timeout: 300s',
    'effect: pure',
    'permission: worktree',
    'expect:',
    '  exitCode: 0',
    'findings:',
    `  parser: ${parser}`,
    'satisfies: []',
    '',
  ].join('\n');
}

/**
 * The built-in gates this repository's `package.json` scripts actually
 * support, as sources — synthesised YAML, not a file on disk.
 *
 * `path` names the recon source (`package.json#scripts.<name>`) rather than
 * a file, because there is none: a reader of `gates.loaded` who wants to know
 * why the `typecheck` gate exists is pointed at exactly the script it was
 * derived from (AC1).
 */
export function builtinGateSources(
  scripts: Readonly<Record<string, string>>,
): readonly GateSource[] {
  return BUILTIN_GATE_SCRIPTS.filter(({ script }) => typeof scripts[script] === 'string').map(
    ({ script, title, parser }) => ({
      path: `package.json#scripts.${script}`,
      bytes: Buffer.from(builtinGateYaml(script, title, parser), 'utf8'),
    }),
  );
}

export interface DiscoverGatesInput {
  /** Where a repository's own `.DeFlow/gates/*.{yaml,yml}` live. */
  readonly gatesDir: string;
  /** `package.json`'s `scripts` table, for deriving the built-ins. Absent
   * means no built-ins — a caller with no manifest to read passes nothing. */
  readonly scripts?: Readonly<Record<string, string>>;
  readonly options?: LoadGateOptions;
}

/**
 * AC1 — every gate this run will schedule: the built-ins first, then the
 * repository's own, each discovered, parsed, validated and hashed through the
 * one door.
 *
 * Rejects on the first bad file (AC2) — `Promise.all`/`.map` would collect
 * every result and let a caller reach into the successes, and the whole
 * point is that one bad file refuses the *run*, not the gate it names.
 */
export async function discoverGateDefinitions(
  input: DiscoverGatesInput,
): Promise<readonly DiscoveredGate[]> {
  const sources = [
    ...builtinGateSources(input.scripts ?? {}),
    ...(await readGatesDirectory(input.gatesDir)),
  ];
  return sources.map((source) => loadGateSource(source, input.options ?? {}));
}

// ── divergence (S37) ────────────────────────────────────────────────────────

/** The `needs-human` reason a diverged gate's verdict carries. */
export const GATE_DEFINITION_DIVERGED = 'gate-definition-diverged';

export interface DivergenceCheck {
  readonly diverged: boolean;
  readonly manifestSha256: string;
  readonly currentSha256: string;
}

/**
 * Whether a gate file still matches what `gates.loaded` recorded for it.
 *
 * Pure: the caller reads the current bytes however is appropriate for the
 * entry (a real file for a custom gate; a re-synthesised built-in source for
 * one of those), and this only compares the two hashes.
 */
export function checkGateDivergence(
  entry: GateManifestEntry,
  currentBytes: Uint8Array,
): DivergenceCheck {
  const currentSha256 = sha256Hex(currentBytes);
  return { diverged: currentSha256 !== entry.sha256, manifestSha256: entry.sha256, currentSha256 };
}

/**
 * The disk-reading convenience for a custom gate, whose `path` is a real
 * repo-relative file. A built-in's `path` names a recon source rather than a
 * file and has no on-disk counterpart to reread this way.
 */
export async function checkGateDivergenceOnDisk(
  entry: GateManifestEntry,
  repoRoot: string,
): Promise<DivergenceCheck> {
  const bytes = await readFile(join(repoRoot, entry.path));
  return checkGateDivergence(entry, bytes);
}

export interface SealDivergedVerdict {
  readonly gate: GateId;
  /** The gate's own node. */
  readonly node: NodeId;
  /** Whose work would have been judged. */
  readonly evaluatedNode: NodeId;
  readonly specHash: string;
  readonly criteria: readonly CriterionId[];
  readonly manifestSha256: string;
  readonly currentSha256: string;
  readonly durationMs: number;
}

/**
 * S37 — the verdict a caller seals instead of running the gate: `needs-human`,
 * naming `gate-definition-diverged` and both hashes, with no findings and no
 * evidence, because nothing ran.
 */
export function sealDivergedVerdict(input: SealDivergedVerdict): VerdictV3 {
  return sealVerdict({
    gate: input.gate,
    node: input.node,
    evaluatedNode: input.evaluatedNode,
    outcome: 'needs-human',
    specHash: input.specHash,
    criteria: input.criteria,
    findings: [],
    evidence: [],
    summary:
      `${input.gate} gate definition diverged from the run manifest ` +
      `(${GATE_DEFINITION_DIVERGED}): manifest ${input.manifestSha256}, disk ${input.currentSha256}`,
    durationMs: input.durationMs,
  });
}
