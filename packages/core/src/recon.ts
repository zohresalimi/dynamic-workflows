/**
 * KAR-10.5 — repository reconnaissance, as the decisions that turn a survey
 * into typed facts (docs/06-planning-and-replanning.md §2.1).
 *
 * The planner's second input is *"language and toolchain detection, the scripts
 * in `package.json`, test/lint/build commands **that actually exist**, directory
 * shape, the size of the areas the spec names, and any `.DeFlow/gates/`
 * definitions already present in the repo"*. The italicised part is the whole
 * value: a plan whose gate node runs `pnpm test:unit` in a repository with no
 * such script fails at node 27 of 40.
 *
 * So this module is built around one asymmetry. **The agent claims; the daemon
 * observes.** `ReconSurvey` is what the recon session returned — a claim, and
 * nothing more. `RepoObservation` is what DeFlow read off the worktree for
 * itself: the manifest bytes, the script keys in them, the path set it walked
 * and counted, the gate files it found. `deriveReconFacts` is the join, and
 * `confidence` is what the join produces:
 *
 *   * `verified` — the script key is really in the manifest, and the fact
 *     carries the `file://<path>#L<n>-L<n>` range it was read from (AC2, AC5).
 *   * `speculative` — the model named a command the manifest does not declare.
 *     Recorded, because it may still be right, with **no** evidence handle:
 *     an evidence handle it did not come from is the lie this whole design
 *     exists to prevent (EPIC-10-S25).
 *   * `asserted` — detection genuinely failed. No manifest, or no such script,
 *     and the fact says so. The planner is then expected to plan a discovery
 *     step; a fabricated default would be the failure mode dynamic planning is
 *     supposed to make unnecessary (AC8).
 *
 * **The model's guess is dropped, not downgraded, when there is no manifest at
 * all.** A `speculative` command in a repository DeFlow could not identify has
 * nothing behind it and everything in front of it — it is the first string a
 * plan reaches for — so the no-manifest arm records only that detection failed.
 * That is the one place this module discards information on purpose.
 *
 * Nothing here reads a file. The daemon's `surveyRepository` does the I/O and
 * hands the bytes over, which is what keeps `@DeFlow/core` I/O-free (R1) and
 * these rules testable without a repository.
 *
 * Verifies: EPIC-10-S24, EPIC-10-S25, EPIC-10-S27 · AC2, AC3, AC4, AC5, AC8
 */
import { z } from 'zod';
import type { Confidence, FactKind } from './fact.ts';
import { RETURN_BUDGET_DEFAULTS } from './handoff.ts';
import { type Handle, HandleSchema, SchemaIdSchema } from './ids.ts';
import type { NodeReturns, PermissionLevel } from './plan-graph.ts';

/** AC1 — a recon node reads the repository and writes nothing. */
export const RECON_PERMISSION: PermissionLevel = 'read';

/**
 * AC6 — 4,000, the `agent.recon` row of docs/08-context-and-memory.md §9.3,
 * read from the shared table rather than restated. A survey that does not fit
 * is offloaded to a handle; it is never truncated.
 */
export const RECON_RETURN_MAX_TOKENS = RETURN_BUDGET_DEFAULTS['agent.recon'];

/** The document a recon session returns. */
export const RECON_SURVEY_SCHEMA_ID = 'DeFlow.reconsurvey.v1' as const;

/** The `schemaId` of every fact this module derives — the *value* schema, not
 * the `DeFlow.fact.v1` envelope it travels in. */
export const RECON_FACT_SCHEMA_ID = 'DeFlow.reconfact.v1' as const;

/** The recon node's `returns` contract (AC6). */
export function reconReturns(): NodeReturns {
  return {
    schemaId: SchemaIdSchema.parse(RECON_SURVEY_SCHEMA_ID),
    maxTokens: RECON_RETURN_MAX_TOKENS,
  };
}

/* -------------------------------------------------------------------------- *
 * What the agent claims
 * -------------------------------------------------------------------------- */

/** The four command roles a plan schedules a node for. */
export const RECON_COMMAND_ROLES = ['test', 'build', 'lint', 'typecheck'] as const;

export type ReconCommandRole = (typeof RECON_COMMAND_ROLES)[number];

const CommandClaimsSchema = z.strictObject({
  test: z.string().min(1).optional(),
  build: z.string().min(1).optional(),
  lint: z.string().min(1).optional(),
  typecheck: z.string().min(1).optional(),
});

/**
 * `DeFlow.reconsurvey.v1` — deliberately small.
 *
 * It carries claims and nothing that DeFlow can establish for itself: no file
 * count, no gate list, no path set. Those are observations, and a return that
 * carried them would be inviting the model to restate numbers the daemon
 * already knows — which is how a survey ends up disagreeing with the repository
 * it surveyed.
 */
export const ReconSurveySchema = z.strictObject({
  schemaId: z.literal(RECON_SURVEY_SCHEMA_ID),
  toolchain: z.strictObject({
    language: z.string().min(1),
    packageManager: z.string().min(1).optional(),
    frameworks: z.array(z.string().min(1)).optional(),
  }),
  commands: CommandClaimsSchema,
  /** Free prose for the operator and the node inspector. Never parsed. */
  notes: z.string().optional(),
});

export type ReconSurvey = z.infer<typeof ReconSurveySchema>;

/* -------------------------------------------------------------------------- *
 * What the daemon observed
 * -------------------------------------------------------------------------- */

/** The manifests DeFlow recognises. A repository with none of them is the AC8
 * case, not a repository DeFlow guesses about. */
export const MANIFEST_KINDS = ['package.json', 'Cargo.toml', 'pyproject.toml'] as const;

export type ManifestKind = (typeof MANIFEST_KINDS)[number];

/**
 * The language family a manifest's *existence* proves, which is all a file read
 * proves. `package.json` does not distinguish JavaScript from TypeScript, so
 * both are in its family and the claim decides which word the fact uses.
 */
const MANIFEST_LANGUAGES: Record<ManifestKind, readonly [string, ...string[]]> = {
  'package.json': ['javascript', 'typescript'],
  'Cargo.toml': ['rust'],
  'pyproject.toml': ['python'],
};

export interface ManifestObservation {
  /** Repo-relative, so the `file://` handle it produces never carries a home
   * directory (docs/04-domain-model.md §1). */
  readonly path: string;
  readonly kind: ManifestKind;
  /** The bytes, verbatim — the evidence line ranges are computed from them. */
  readonly text: string;
  /** Script key to script body. Empty for a manifest with no script table. */
  readonly scripts: Readonly<Record<string, string>>;
  /** `package.json`'s own `packageManager` field, where it declares one. */
  readonly packageManager?: string;
}

export interface ScopeObservation {
  /** The areas the spec named, as they were given. */
  readonly paths: readonly string[];
  /** Files under those areas, counted by walking them — F5.2's write
   * serialisation input and the patch policy's `blastRadiusFiles` estimate. */
  readonly fileCount: number;
}

export interface GateObservation {
  readonly id: string;
  /** Repo-relative path of the definition, e.g. `.DeFlow/gates/typecheck.yaml`. */
  readonly path: string;
  /** Lines in the file, so the evidence handle addresses the whole definition. */
  readonly lines: number;
}

export interface RepoObservation {
  readonly manifest: ManifestObservation | null;
  readonly scope: ScopeObservation;
  readonly gates: readonly GateObservation[];
}

/* -------------------------------------------------------------------------- *
 * The join
 * -------------------------------------------------------------------------- */

/** A fact ready for the blackboard, minus the envelope only the ledger can
 * fill: the id, and the provenance the writing node stamps on it. */
export interface ReconFactCandidate {
  readonly key: string;
  readonly kind: FactKind;
  readonly schemaId: string;
  readonly value: unknown;
  readonly confidence: Confidence;
  readonly fromEvidence: readonly Handle[];
}

export interface DeriveReconFactsInput {
  /** The session's return, or `null` when it produced nothing usable. */
  readonly survey: ReconSurvey | null;
  readonly observation: RepoObservation;
  /**
   * The full survey in the CAS (AC6). Every fact that was derived from the
   * daemon's own walk rather than from a file range points here, which is what
   * makes the node inspector's provenance table clickable for them too.
   */
  readonly surveyHandle: Handle;
}

/** `file://<repo-relative path>#L<n>-L<m>` (docs/04-domain-model.md §1). */
export function fileEvidenceHandle(path: string, start: number, end: number): Handle {
  return HandleSchema.parse(`file://${path}#L${start}-L${end}`);
}

const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);

/**
 * The manifest script key a claimed command would run, or `null` when the
 * command is not a script invocation at all.
 *
 * `cargo test` and `vitest run` answer `null` rather than `'test'`/`'run'`: they
 * are real commands that simply are not backed by a `package.json` script, and
 * pretending otherwise would make the verification check answer "not declared"
 * for the wrong reason.
 */
export function scriptKeyOf(command: string): string | null {
  const tokens = command
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  const [runner, ...rest] = tokens;
  if (runner === undefined || !PACKAGE_MANAGERS.has(runner)) return null;
  const key = rest[0] === 'run' ? rest[1] : rest[0];
  if (key === undefined || key.startsWith('-')) return null;
  return key;
}

const escapeForRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The 1-based line the `scripts` table declares `key` on, or `null`.
 *
 * Located in the *text* rather than derived from the parsed object because the
 * evidence handle has to address bytes a human can open — a parsed object has
 * no lines — and because the search is scoped to the `scripts` block, so a
 * `"test"` key under `devDependencies` cannot masquerade as a script.
 */
export function jsonScriptLineRange(
  text: string,
  key: string,
): { readonly start: number; readonly end: number } | null {
  const scriptsAt = text.indexOf('"scripts"');
  if (scriptsAt === -1) return null;

  const openAt = text.indexOf('{', scriptsAt);
  if (openAt === -1) return null;

  let depth = 0;
  let closeAt = -1;
  for (let at = openAt; at < text.length; at += 1) {
    if (text[at] === '{') depth += 1;
    else if (text[at] === '}') {
      depth -= 1;
      if (depth === 0) {
        closeAt = at;
        break;
      }
    }
  }
  if (closeAt === -1) return null;

  const block = text.slice(openAt, closeAt);
  const declaration = new RegExp(`"${escapeForRegExp(key)}"\\s*:`).exec(block);
  if (declaration === null) return null;

  const before = text.slice(0, openAt + declaration.index);
  const line = before.split('\n').length;
  return { start: line, end: line };
}

/** The whole file, as one evidence range. */
function wholeFileEvidence(observation: ManifestObservation): Handle {
  return fileEvidenceHandle(observation.path, 1, observation.text.split('\n').length);
}

const kindOfKey = (key: string): FactKind => (key.startsWith('scope/') ? 'scope' : 'finding');

function candidate(
  key: string,
  value: unknown,
  confidence: Confidence,
  fromEvidence: readonly Handle[],
): ReconFactCandidate {
  return {
    key,
    kind: kindOfKey(key),
    schemaId: RECON_FACT_SCHEMA_ID,
    value,
    confidence,
    fromEvidence,
  };
}

/** AC8 — "detection failed", as a fact rather than as an absence. An absent
 * fact is indistinguishable from a recon node that never ran. */
function detectionFailed(
  key: string,
  what: string,
  detail: string,
  surveyHandle: Handle,
): ReconFactCandidate {
  return candidate(
    key,
    { reconKind: 'detection-failed', what, detail, survey: surveyHandle },
    'asserted',
    [surveyHandle],
  );
}

function toolchainFact(
  survey: ReconSurvey | null,
  manifest: ManifestObservation,
): ReconFactCandidate {
  const family = MANIFEST_LANGUAGES[manifest.kind];
  const claimed = survey?.toolchain.language.toLowerCase();
  // A claim the manifest's own family does not contain is still worth
  // recording, and it is not worth trusting: `speculative` is exactly that
  // distinction. No claim at all is not a disagreement — the manifest alone
  // establishes the family, which is what `verified` means here.
  const consistent = claimed === undefined || family.includes(claimed);
  const language = claimed !== undefined && family.includes(claimed) ? claimed : family[0];
  const value = {
    reconKind: 'toolchain',
    language,
    manifest: manifest.path,
    ...(manifest.packageManager === undefined ? {} : { packageManager: manifest.packageManager }),
    ...(consistent ? {} : { claimedLanguage: claimed }),
  };
  return candidate('finding/toolchain', value, consistent ? 'verified' : 'speculative', [
    wholeFileEvidence(manifest),
  ]);
}

function commandFact(
  role: Extract<ReconCommandRole, 'test' | 'build'>,
  claim: string | undefined,
  manifest: ManifestObservation,
  surveyHandle: Handle,
): ReconFactCandidate {
  const key = `finding/${role}-command`;

  if (claim !== undefined) {
    const scriptKey = scriptKeyOf(claim);
    const script = scriptKey === null ? undefined : manifest.scripts[scriptKey];
    const range = scriptKey === null ? null : jsonScriptLineRange(manifest.text, scriptKey);
    if (script !== undefined && range !== null) {
      return candidate(key, { reconKind: 'command', role, command: claim, script }, 'verified', [
        fileEvidenceHandle(manifest.path, range.start, range.end),
      ]);
    }
    // AC2 — the claim is kept, the trust is not, and it carries no evidence
    // handle because there is nothing it was read from.
    return candidate(
      key,
      { reconKind: 'command', role, command: claim, script: null },
      'speculative',
      [],
    );
  }

  const declared = manifest.scripts[role];
  const range = jsonScriptLineRange(manifest.text, role);
  if (declared !== undefined && range !== null) {
    return candidate(
      key,
      { reconKind: 'command', role, command: declared, script: declared },
      'verified',
      [fileEvidenceHandle(manifest.path, range.start, range.end)],
    );
  }

  return detectionFailed(
    key,
    `${role}-command`,
    `${manifest.path} declares no "${role}" script and the survey claimed no ${role} command`,
    surveyHandle,
  );
}

/**
 * The join: claims measured against observations, as fact candidates in a
 * stable order (toolchain, test, build, scope, gates).
 *
 * Pure and total. It never throws, because every arm — including "the session
 * returned nothing" — has a fact that states what happened.
 */
export function deriveReconFacts(input: DeriveReconFactsInput): readonly ReconFactCandidate[] {
  const { survey, observation, surveyHandle } = input;
  const facts: ReconFactCandidate[] = [];
  const { manifest } = observation;

  if (manifest === null) {
    // The model's commands are dropped rather than downgraded — see the module
    // note. A guess in a repository DeFlow could not identify is the first
    // string a plan would reach for.
    const detail =
      `no ${MANIFEST_KINDS.join(', ')} was found in the surveyed tree, so nothing about the ` +
      'toolchain could be established by reading a file';
    facts.push(detectionFailed('finding/toolchain', 'toolchain', detail, surveyHandle));
    facts.push(
      detectionFailed(
        'finding/test-command',
        'test-command',
        `${detail}; plan a discovery step rather than assuming a test command`,
        surveyHandle,
      ),
    );
    facts.push(
      detectionFailed(
        'finding/build-command',
        'build-command',
        `${detail}; plan a discovery step rather than assuming a build command`,
        surveyHandle,
      ),
    );
  } else {
    facts.push(toolchainFact(survey, manifest));
    facts.push(commandFact('test', survey?.commands.test, manifest, surveyHandle));
    facts.push(commandFact('build', survey?.commands.build, manifest, surveyHandle));
  }

  facts.push(
    candidate(
      'scope/touched-paths',
      {
        reconKind: 'scope',
        paths: [...observation.scope.paths],
        fileCount: observation.scope.fileCount,
        survey: surveyHandle,
      },
      'verified',
      [surveyHandle],
    ),
  );

  if (observation.gates.length > 0) {
    facts.push(
      candidate(
        'finding/repo-gates',
        {
          reconKind: 'gates',
          gates: observation.gates.map((gate) => ({ id: gate.id, path: gate.path })),
        },
        'verified',
        observation.gates.map((gate) => fileEvidenceHandle(gate.path, 1, gate.lines)),
      ),
    );
  }

  return facts;
}

/* -------------------------------------------------------------------------- *
 * The fact value schema
 * -------------------------------------------------------------------------- */

/**
 * `DeFlow.reconfact.v1` — the value of every fact `deriveReconFacts` produces.
 *
 * One document with a `reconKind` discriminator rather than five: the arms are
 * written and read together, they version together, and a criteria-coverage
 * check that wants the gate list should not have to know which of five ids to
 * ask the schema registry for.
 */
export const ReconFactValueSchema = z.discriminatedUnion('reconKind', [
  z.strictObject({
    reconKind: z.literal('toolchain'),
    language: z.string().min(1),
    manifest: z.string().min(1),
    packageManager: z.string().min(1).optional(),
    claimedLanguage: z.string().min(1).optional(),
  }),
  z.strictObject({
    reconKind: z.literal('command'),
    role: z.enum(RECON_COMMAND_ROLES),
    command: z.string().min(1),
    /** The manifest's script body when the key really is declared, `null` when
     * the command is the model's claim and nothing more. */
    script: z.string().min(1).nullable(),
  }),
  z.strictObject({
    reconKind: z.literal('scope'),
    paths: z.array(z.string()),
    fileCount: z.number().int().nonnegative(),
    survey: HandleSchema,
  }),
  z.strictObject({
    reconKind: z.literal('gates'),
    gates: z.array(z.strictObject({ id: z.string().min(1), path: z.string().min(1) })),
  }),
  z.strictObject({
    reconKind: z.literal('detection-failed'),
    what: z.string().min(1),
    detail: z.string().min(1),
    survey: HandleSchema,
  }),
]);

export type ReconFactValue = z.infer<typeof ReconFactValueSchema>;
