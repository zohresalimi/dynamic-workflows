/**
 * KAR-19.7 — the structured-output path: a turn that carries a schema, answered
 * with one document that validates against it.
 *
 * ## Why this exists at all
 *
 * Every schema-bearing turn in DeFlow — framing, recon, the planner — is
 * admitted only onto an adapter whose registry entry declares a
 * `structuredOutputFlag` (`admitFraming`, KAR-10.2 AC3). Until this module
 * existed, the only entries that declared one were two vendor **exec-shim**
 * paths, and the bundled agent spoke ACP only. So on a machine with no vendor
 * CLI nothing could get past framing, and *"`DeFlow run` works end to end with
 * only the bundled mock agent"* was not a claim anybody could test.
 *
 * **The guard was not the thing to change.** A special case for the test double
 * inside `admitFraming` is exactly what makes the production branch exercised by
 * nothing anyone runs. So the change is here: the binary genuinely takes a
 * schema and genuinely returns a document that validates against it, and the
 * registry says `native` because that is true.
 *
 * ## Four rules the generators keep
 *
 * **The document is a function of `(schemaId, seed)` and nothing else.** Not the
 * prompt, not the cwd, not a directory listing, and above all not the run's own
 * context: a mock whose output depends on what the caller wanted is a second
 * planner wearing a fixture's clothes, and KAR-19.3 AC7's
 * one-implementation-per-step guard is the rule it would be evading. The prompt
 * is accepted on argv because a real invocation carries one — and it is
 * deliberately *not* read into the document, because a framing packet contains
 * the run's own absolute worktree path, and a plan carrying somebody's `TMPDIR`
 * is a smoke test whose two runs never agree.
 *
 * **No time, no randomness, no filesystem order.** Ids and time-like fields come
 * from `./ids.ts` and `./clock.ts`, the same seeded sources every other frame
 * this binary writes comes from. `Date.now()` and `crypto.randomUUID()` do not
 * appear.
 *
 * **A schema it cannot serve is refused, never approximated.** There is no
 * nearest-match, no empty object and no prose fallback. An empty object
 * validates against a permissive schema, and a caller that received one would
 * have no way to tell a served turn from an unserved one — this epic's own
 * failure mode, reproduced inside the test double.
 *
 * **Validation happens in the tests, not here.** `@DeFlow/mock-agent` ships with
 * exactly one dependency (docs/07-provider-adapter-layer.md §13), so ajv cannot
 * come along. The guarantee that these documents validate is a test-time
 * property of generators written to be obviously correct, which is why each one
 * is a flat literal rather than a builder.
 */
import type { Clock } from './clock.ts';
import { createSyntheticClock } from './clock.ts';
import type { IdFactory } from './ids.ts';
import { createIdFactory } from './ids.ts';
import { mulberry32 } from './random.ts';

/**
 * The flag a schema file rides in on.
 *
 * **This constant is the registry entry too.** `provider-registry.ts` imports
 * it for `PROVIDER_SPECS.mock.shim.structuredOutputFlag` rather than repeating
 * the string, so a rename here cannot leave the registry declaring a capability
 * the binary does not have — which would be a lie `admitFraming` then trusts.
 */
export const MOCK_STRUCTURED_OUTPUT_FLAG = '--return-schema';

/** The turn's prompt. Only meaningful alongside the flag above. */
export const MOCK_PROMPT_FLAG = '--prompt';

export const DRAFT_SCHEMA_ID = 'DeFlow.taskspecdraft.v1';
export const RECON_SURVEY_SCHEMA_ID = 'DeFlow.reconsurvey.v1';
export const RECON_FACT_SCHEMA_ID = 'DeFlow.reconfact.v1';
export const PLAN_SCHEMA_ID = 'DeFlow.plangraph.v1';

/** Everything one generator is allowed to see. */
export interface GeneratorInput {
  readonly ids: IdFactory;
  readonly clock: Clock;
  /** The seeded stream, for the digest-shaped fields DeFlow overwrites. */
  readonly hex: (length: number) => string;
}

type Generator = (input: GeneratorInput) => unknown;

/** `sha256-<64 hex>`, seeded — a placeholder the caller recomputes and replaces. */
const digest = (input: GeneratorInput): string => `sha256-${input.hex(64)}`;

/**
 * The two criteria every draft carries, and the two the default plan's gate
 * covers. One list, because a plan whose gate names a criterion the spec does
 * not have is a plan that fails validation for a reason nobody scripted.
 */
const CRITERIA = ['ac-1', 'ac-2'] as const;

const taskSpecDraft: Generator = () => ({
  schemaId: DRAFT_SCHEMA_ID,
  goal: 'Carry out the submitted task in this repository, and leave it green.',
  scope: { included: ['.'] },
  nonGoals: ['Anything the submitted task did not ask for.'],
  constraints: ['Change nothing outside the declared scope.'],
  priorDecisions: [],
  acceptanceCriteria: [
    {
      id: CRITERIA[0],
      statement: 'The change the task describes is present in the repository.',
      verifiedBy: ['review'],
    },
    {
      id: CRITERIA[1],
      statement: "The repository's own checks pass after the change.",
      verifiedBy: ['typecheck'],
    },
  ],
  knownFailureModes: [
    {
      id: 'fm-1',
      description: 'The change is made somewhere the declared scope does not cover.',
      detection: 'A file outside the scope appears in the diff.',
    },
  ],
});

const reconSurvey: Generator = () => ({
  schemaId: RECON_SURVEY_SCHEMA_ID,
  toolchain: { language: 'typescript', packageManager: 'pnpm' },
  commands: { test: 'pnpm test', build: 'pnpm build', typecheck: 'pnpm typecheck' },
  notes: 'Reported by the bundled agent; every claim here is a claim, not a measurement.',
});

/**
 * One fact in the `reconfact` vocabulary — the `toolchain` variant, whose
 * `manifest` field is what makes the claim checkable against something DeFlow
 * read for itself (F2.2).
 */
const reconFact: Generator = () => ({
  reconKind: 'toolchain',
  language: 'typescript',
  manifest: 'package.json',
  packageManager: 'pnpm',
});

/**
 * `run_YYYYMMDDTHHMMSSZ_<6 hex>` — the envelope id shape. The caller overwrites
 * it with the real run's, and the pattern is honoured anyway so the document
 * validates on its own.
 */
function runId(input: GeneratorInput): string {
  const at = new Date(input.clock.now()).toISOString();
  const stamp = `${at.slice(0, 10).replaceAll('-', '')}T${at.slice(11, 19).replaceAll(':', '')}Z`;
  return `run_${stamp}_${input.hex(6)}`;
}

const agentNode = (
  id: string,
  title: string,
  brief: string,
  deps: readonly string[],
): Record<string, unknown> => ({
  id,
  title,
  type: 'agent',
  deps: [...deps],
  lifecycle: 'active',
  reads: [{ kind: 'spec', section: 'goal' }],
  writes: [],
  permission: 'worktree',
  pathScopes: { write: ['**'] },
  returns: { schemaId: 'DeFlow.finding.v1', maxTokens: 1500 },
  brief,
  // Empty on purpose. A default plan that named a vendor here would route
  // every run onto a CLI the machine may not have — AC8's routing hazard,
  // arriving through the document instead of through the registry.
  provider: { prefer: [], requires: ['structuredOutput'] },
  resume: 'always-replay',
});

/**
 * The default plan: two agent nodes and the gate that checks them.
 *
 * Two rather than one because KAR-19.5 AC2 asserts a compiled plan has at least
 * two nodes, and a one-node default would make that clause unreachable against
 * the only agent the smoke test has.
 */
const planGraph: Generator = (input) => ({
  schemaId: PLAN_SCHEMA_ID,
  runId: runId(input),
  version: 1,
  planHash: digest(input),
  parent: null,
  taskSpecHash: digest(input),
  createdBy: 'planner',
  createdAt: new Date(input.clock.now()).toISOString(),
  nodes: [
    agentNode('implement', 'Make the change the task describes', 'Make the change, carefully.', []),
    agentNode('verify', 'Check the change against the criteria', 'Re-read the change.', [
      'implement',
    ]),
    {
      id: 'review',
      title: 'Check the acceptance criteria',
      type: 'gate',
      deps: ['verify'],
      lifecycle: 'active',
      reads: [{ kind: 'spec', section: 'criteria' }],
      writes: [],
      permission: 'read',
      pathScopes: { write: [] },
      returns: { schemaId: 'DeFlow.verdict.v2', maxTokens: 1500 },
      gate: { kind: 'deterministic', gateId: 'typecheck' },
      criteria: [...CRITERIA],
      independence: { notSessionOf: ['implement', 'verify'], preferDifferentProvider: false },
    },
  ],
  edges: [
    { from: 'implement', to: 'verify', kind: 'control' },
    { from: 'verify', to: 'review', kind: 'control' },
  ],
});

/**
 * Every schema this binary can answer for, by id.
 *
 * A closed record rather than a lookup that falls back to "something
 * schema-shaped": the ids in here are the ids the refusal prints, and a
 * generator that could be added by accident is a document nobody wrote.
 */
export const SCHEMA_GENERATORS: Readonly<Record<string, Generator>> = {
  [DRAFT_SCHEMA_ID]: taskSpecDraft,
  [RECON_SURVEY_SCHEMA_ID]: reconSurvey,
  [RECON_FACT_SCHEMA_ID]: reconFact,
  [PLAN_SCHEMA_ID]: planGraph,
};

/** The ids a refusal lists, in a fixed order so the message is stable. */
export const SERVABLE_SCHEMA_IDS: readonly string[] = Object.keys(SCHEMA_GENERATORS).toSorted();

/** True for an id this binary has a generator behind. */
export function canServe(schemaId: string): boolean {
  return Object.hasOwn(SCHEMA_GENERATORS, schemaId);
}

/**
 * The document for `schemaId` at `seed`, or `null` for an id with no generator.
 *
 * The answer is wrapped rather than returned bare, because a bare `unknown`
 * collapses `unknown | null` into `unknown` and a caller could no longer tell
 * "I have no generator for this" from "the generator produced null". `null`
 * rather than a throw for the same reason: "cannot serve this" is an answer the
 * caller turns into a refusal that lists what it *can* serve, and an exception
 * would arrive at the same place carrying less.
 */
export function serveSchema(schemaId: string, seed: number): { readonly document: unknown } | null {
  const generate = SCHEMA_GENERATORS[schemaId];
  if (generate === undefined) return null;

  const draw = mulberry32(seed);
  const hex = (length: number): string => {
    let out = '';
    while (out.length < length) {
      out += Math.floor(draw() * 0x1_00_00_00_00)
        .toString(16)
        .padStart(8, '0');
    }
    return out.slice(0, length);
  };

  return {
    document: generate({ ids: createIdFactory(seed), clock: createSyntheticClock(seed), hex }),
  };
}

/**
 * The schema id a file names, read from the document itself.
 *
 * `title` first because every schema this repository emits carries the id there
 * verbatim; `$id`'s last path segment second, for a schema written by hand
 * against the same convention. A file that answers neither is refused by name
 * rather than guessed at from its path — a guess is how a caller ends up served
 * the wrong document under the right filename.
 */
export function schemaIdOf(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (typeof record.title === 'string' && record.title !== '') return record.title;

  const id = record.$id;
  if (typeof id !== 'string') return null;
  const last = id.split('/').at(-1) ?? '';
  return last.endsWith('.json') ? last.slice(0, -'.json'.length) : last === '' ? null : last;
}

/**
 * The id a *path* names, for the two cases where the file cannot be read at
 * all.
 *
 * The refusal still has to name what it was asked for — "cannot read
 * /…/DeFlow.plangraph.v1.json" with no id in it makes the reader open the
 * caller to find out which turn died.
 */
export function schemaIdFromPath(path: string): string | null {
  const base = path.split('/').at(-1) ?? '';
  if (!base.endsWith('.json')) return null;
  const id = base.slice(0, -'.json'.length);
  return id === '' ? null : id;
}

/**
 * How a scenario overrides the return (AC7), so the caller's own refusal paths
 * are reachable with no vendor CLI installed.
 *
 * The unscripted default is always valid: making a turn fail takes a scenario
 * file rather than the absence of one. If an absent file produced an invalid
 * return, every spec that forgot one would exercise the repair loop and nobody
 * would notice the happy path had stopped being covered.
 */
export type ScriptedReturn =
  /** Parseable JSON that fails validation — the schema-repair loop's case. */
  | { readonly kind: 'invalid' }
  /** A prefix of the document, so the parse itself fails. */
  | { readonly kind: 'truncated' }
  /** Emitted verbatim: a valid but unsatisfiable plan is written here. */
  | { readonly kind: 'document'; readonly document: unknown };

/**
 * The bytes for one turn: the document, or what the script asked for instead.
 *
 * No trailing newline. The return channel carries exactly one document and
 * nothing else, and a caller that has to strip a line terminator before parsing
 * is a caller written to tolerate a prefix — which is the parser that silently
 * accepts a truncated return.
 */
export function renderReturn(
  schemaId: string,
  seed: number,
  scripted: ScriptedReturn | null,
): string | null {
  if (scripted?.kind === 'document') return JSON.stringify(scripted.document);
  if (scripted?.kind === 'invalid') return JSON.stringify({ schemaId });

  const served = serveSchema(schemaId, seed);
  if (served === null) return null;

  const text = JSON.stringify(served.document);
  // Cut inside the JSON rather than at a random byte: a truncated object is
  // what a killed vendor leaves behind, and the half that matters is that it
  // is unparseable rather than that it is short.
  return scripted?.kind === 'truncated' ? text.slice(0, Math.max(1, text.length - 12)) : text;
}
