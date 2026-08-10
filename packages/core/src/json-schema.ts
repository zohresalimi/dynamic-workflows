/**
 * KAR-02.8 — the registry of `(schemaId, zodSchema)` pairs and the pure
 * conversion to JSON Schema 2020-12 (docs/04-domain-model.md §0).
 *
 * Zod is the single source of truth. The files under `schemas/` — copied into
 * a run directory as `.DeFlow/schemas/` — are generated from it by
 * `packages/core/scripts/emit-schemas.ts` and proven to match it in CI by
 * `packages/core/scripts/check-schemas.ts`. NF8 is satisfied without a second
 * hand-maintained artefact, and the day the two disagree is a red build rather
 * than a vendor CLI rejecting a document at 3am.
 *
 * Everything here is pure: this module converts and serialises, it never
 * touches a filesystem (R1). The scripts own the I/O and live outside the
 * published surface.
 *
 * Three conversion decisions are load-bearing:
 *
 *   1. **`io: 'input'`.** Every branded id in this package is
 *      `z.string().regex(…).transform(v => v as NodeId)` — a pipe whose output
 *      side is a transform, and `z.toJSONSchema` throws
 *      "Transforms cannot be represented in JSON Schema" on the output side of
 *      one. The input side is the string with its format regex, which is
 *      exactly what a validator on the wire needs: the brand is a compile-time
 *      fiction with no runtime representation to emit.
 *   2. **Records get their required keys expanded.**
 *      `z.record(SegmentKindSchema, …)` emits `required: [all nine kinds]` with
 *      the value schema under `additionalProperties` and no `properties` at
 *      all. Ajv's `strictRequired` — which `strict: true` turns on — refuses a
 *      `required` naming a property the schema never describes, so AC3 fails
 *      on the raw output. `expandRequiredRecordKeys` writes the missing
 *      `properties` entries, which is the same constraint stated in the form
 *      the validator accepts.
 *   3. **Standalone documents.** Sub-schemas are inlined into `$defs` of the
 *      same file and never `$ref` a sibling path, because a vendor CLI handed
 *      `--json-schema DeFlow.finding.v1.json` resolves nothing (EPIC-02-S25,
 *      EPIC-02-S26).
 *
 * Verifies: EPIC-02-S25 · AC1, AC3
 */
import { z } from 'zod';
import { CONTEXTPACKET_SCHEMA_ID, ContextPacketSchema } from './context-packet.ts';
import { FACT_SCHEMA_ID, FactSchema } from './fact.ts';
import { TASKSPEC_DRAFT_SCHEMA_ID, TaskSpecDraftSchema } from './framing.ts';
import { HUMAN_DECISION_SCHEMA_ID, HumanDecisionSchema } from './human-gate.ts';
import { PLANGRAPH_SCHEMA_ID, PlanGraphSchema } from './plan-graph.ts';
import { PLANPATCH_SCHEMA_ID, PlanPatchSchema } from './plan-patch.ts';
import {
  RECON_FACT_SCHEMA_ID,
  RECON_SURVEY_SCHEMA_ID,
  ReconFactValueSchema,
  ReconSurveySchema,
} from './recon.ts';
import { TASKSPEC_SCHEMA_ID, TaskSpecSchema } from './task-spec.ts';
import {
  FINDING_SCHEMA_ID,
  FINDING_V2_SCHEMA_ID,
  FindingSchema,
  FindingV2Schema,
  VERDICT_SCHEMA_ID,
  VERDICT_V2_SCHEMA_ID,
  VERDICT_V3_SCHEMA_ID,
  VERDICT_V4_SCHEMA_ID,
  VerdictSchema,
  VerdictV2Schema,
  VerdictV3Schema,
  VerdictV4Schema,
} from './verdict.ts';

/**
 * The dialect, spelled once. 2020-12 is not arbitrary: it is what MCP tool
 * `inputSchema` defaults to, so the MCP host and the F6.9 handoff contracts
 * speak one dialect and one validator (**Verified 2026-08-02**).
 */
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/**
 * The `$id` prefix. It is a URL because JSON Schema says `$id` is a URI, not
 * because anything dereferences it — the documents are standalone.
 */
export const SCHEMA_ID_BASE = 'https://deflow.dev/schemas/';

/**
 * Ajv options every consumer of an emitted schema must use, exported from the
 * pure package so `packages/core/scripts/check-schemas.ts` (which proves the
 * files compile) and `@DeFlow/daemon`'s validator (which runs them) cannot
 * drift apart. Stated as data, so core imports no validator.
 *
 * `allErrors` is not a debugging nicety: an agent handed one error at a time
 * takes N turns to fix N problems, and each turn costs quota.
 */
export const AJV_2020_OPTIONS = { strict: true, allErrors: true } as const;

/** A JSON Schema document. Deliberately opaque — nothing here inspects it. */
export type JsonSchemaDocument = Readonly<Record<string, unknown>>;

export interface SchemaRegistration {
  readonly schemaId: string;
  /** One line, for the emitted `description`. */
  readonly summary: string;
  readonly schema: z.ZodType;
}

/**
 * Every document DeFlow ships at v1, sorted by id so the emitter's output
 * order is a property of this table and not of module evaluation.
 *
 * Adding a row is how a new document ships. **Editing the `schema` of a row
 * whose id is already committed under `schemas/` is not** — `schemaId`
 * versioning is append-only, so a shape change publishes `.v2` and leaves
 * `.v1` exactly as it was (AC6, `schemas/CHANGELOG.md`).
 */
export const SCHEMA_REGISTRY: readonly SchemaRegistration[] = [
  {
    schemaId: CONTEXTPACKET_SCHEMA_ID,
    summary: 'The addressable, typed context a node actually received (F6.1, F6.2).',
    schema: ContextPacketSchema,
  },
  {
    schemaId: FACT_SCHEMA_ID,
    summary: 'A blackboard fact envelope: key, kind, provenance and the value schema id (F5.1).',
    schema: FactSchema,
  },
  {
    schemaId: FINDING_SCHEMA_ID,
    summary: 'A structured gate finding, attachable to a diff line (F7.7).',
    schema: FindingSchema,
  },
  {
    schemaId: FINDING_V2_SCHEMA_ID,
    summary:
      'A structured gate finding whose line is anchored to the blob it was read from, so a ' +
      'later revision cannot silently redraw it against the wrong line (F7.7).',
    schema: FindingV2Schema,
  },
  {
    schemaId: HUMAN_DECISION_SCHEMA_ID,
    summary:
      'What a `human` node returns when the operator chose rather than supplied: the option ' +
      'they picked, what it does, and the words they attached to it (F8.1).',
    schema: HumanDecisionSchema,
  },
  {
    schemaId: PLANGRAPH_SCHEMA_ID,
    summary: 'A whole plan: the seven node types, their edges, budgets and declared reads (F2.1).',
    schema: PlanGraphSchema,
  },
  {
    schemaId: PLANPATCH_SCHEMA_ID,
    summary: 'A proposed plan evolution: the five ops, its blast radius and its rationale (F2.3).',
    schema: PlanPatchSchema,
  },
  {
    schemaId: RECON_FACT_SCHEMA_ID,
    summary:
      'The value of a reconnaissance fact: a toolchain, a command and whether the manifest ' +
      'really declares it, a counted path set, the gates already in the repo, or a stated ' +
      'detection failure (F2.2).',
    schema: ReconFactValueSchema,
  },
  {
    schemaId: RECON_SURVEY_SCHEMA_ID,
    summary:
      'What a recon session claims about the repository: language, package manager and the ' +
      'commands it believes exist — claims only, measured against what DeFlow read (F2.2).',
    schema: ReconSurveySchema,
  },
  {
    schemaId: TASKSPEC_DRAFT_SCHEMA_ID,
    summary:
      'The document the framing interview returns: the eight authored fields, the F7.4 ' +
      'criteria contract, and no digest the agent could not honestly compute (F1.2).',
    schema: TaskSpecDraftSchema,
  },
  {
    schemaId: TASKSPEC_SCHEMA_ID,
    summary: 'The approved intent a run is measured against (F1.1).',
    schema: TaskSpecSchema,
  },
  {
    schemaId: VERDICT_SCHEMA_ID,
    summary: 'A gate verdict: outcome, per-criterion status and structured findings (F7.4).',
    schema: VerdictSchema,
  },
  {
    schemaId: VERDICT_V2_SCHEMA_ID,
    summary:
      'A gate verdict, naming the specHash it was judged against so a mid-run spec edit voids ' +
      'it rather than silently keeping it green (F1.5, F7.4).',
    schema: VerdictV2Schema,
  },
  {
    schemaId: VERDICT_V3_SCHEMA_ID,
    summary:
      'The gate contract: outcome, per-criterion status, blob-anchored findings and what the ' +
      'verdict cost — the one shape a deterministic gate and an adversarial reviewer both ' +
      'return (F7.3, F6.9, F7.7).',
    schema: VerdictV3Schema,
  },
  {
    schemaId: VERDICT_V4_SCHEMA_ID,
    summary:
      'The sealed gate verdict: everything v3 carries, plus what DeFlow gave up to produce it — ' +
      "a review routed onto the producer's own provider under the single-provider fallback is " +
      'marked weakened rather than passed off as an ordinary one (F7.2, NF7).',
    schema: VerdictV4Schema,
  },
];

/**
 * KAR-12.3 AC1 — the run-directory name of the gate contract.
 *
 * `.DeFlow/schemas/verdict.schema.json` is what docs/10-verification-gates.md
 * §4 names and what a vendor CLI is handed on `--json-schema` /
 * `--output-schema`. The file is the emitted `DeFlow.verdict.v3` document and
 * nothing else: renaming it in the run directory is how the contract acquires
 * a stable path across versions without a second copy of the document existing
 * anywhere. `title` still carries the `schemaId`, so the daemon's store
 * addresses one compiled validator under both names.
 */
export const VERDICT_SCHEMA_FILE = 'verdict.schema.json';

/**
 * The few documents a run directory knows by a name other than
 * `<schemaId>.json`. One entry today; a map rather than an `if` so the next one
 * is a row instead of a branch.
 *
 * **`verdict.schema.json` stays the `.v3` document, and `.v4` is deliberately
 * not it.** `.v4` adds `weakened`, which is DeFlow's own record of how the
 * reviewer was routed (KAR-12.2 AC7) — not something the reviewer observed.
 * Handing a model a contract with that field in it invites it to state that its
 * own review was not weakened, which is the one claim in the document only the
 * scheduler is in a position to make. So the vendor returns a `.v3`-shaped
 * verdict, the sealer stamps the marker, and the sealed document is a `.v4`.
 */
export const RUN_SCHEMA_FILENAMES: Readonly<Record<string, string>> = {
  [VERDICT_V3_SCHEMA_ID]: VERDICT_SCHEMA_FILE,
};

/** The name this document takes inside a run's `.DeFlow/schemas/`. */
export function runSchemaFileName(schemaId: string): string {
  return RUN_SCHEMA_FILENAMES[schemaId] ?? schemaFileName(schemaId);
}

export const REGISTERED_SCHEMA_IDS: readonly string[] = SCHEMA_REGISTRY.map(
  (registration) => registration.schemaId,
);

/** Thrown by `toJsonSchemaDocument`; also the shape AC5's rejection names. */
export class UnknownSchemaId extends Error {
  readonly schemaId: string;

  constructor(schemaId: string) {
    super(
      `no schema is registered for "${schemaId}" — the registry is ` +
        `SCHEMA_REGISTRY in packages/core/src/json-schema.ts, and it ships ` +
        `${REGISTERED_SCHEMA_IDS.join(', ')}`,
    );
    this.name = 'UnknownSchemaId';
    this.schemaId = schemaId;
  }
}

export function schemaRegistrationOf(schemaId: string): SchemaRegistration {
  const registration = SCHEMA_REGISTRY.find((entry) => entry.schemaId === schemaId);
  if (registration === undefined) throw new UnknownSchemaId(schemaId);
  return registration;
}

/** `<schemaId>.json` — the on-disk name, in one place. */
export function schemaFileName(schemaId: string): string {
  return `${schemaId}.json`;
}

/**
 * Ajv `strictRequired` refuses a `required` entry with no matching
 * `properties` entry, which is exactly what Zod emits for a record keyed by a
 * literal union. Writing the value schema in under `properties` says the same
 * thing in a form the validator accepts. Recursive, because records nest.
 */
function expandRequiredRecordKeys(node: unknown): unknown {
  if (Array.isArray(node)) return node.map((child) => expandRequiredRecordKeys(child));
  if (node === null || typeof node !== 'object') return node;

  const expanded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) expanded[key] = expandRequiredRecordKeys(value);

  const required = expanded.required;
  const additional = expanded.additionalProperties;
  if (Array.isArray(required) && typeof additional === 'object' && additional !== null) {
    const properties: Record<string, unknown> = { ...(expanded.properties as object | undefined) };
    for (const key of required) {
      if (typeof key === 'string' && !(key in properties)) properties[key] = additional;
    }
    expanded.properties = properties;
  }
  return expanded;
}

/**
 * The registered schema as a standalone 2020-12 document. Pure and
 * deterministic: the same registry produces the same bytes on every machine,
 * which is what makes the drift check a content comparison (AC2).
 */
export function toJsonSchemaDocument(schemaId: string): JsonSchemaDocument {
  const registration = schemaRegistrationOf(schemaId);
  const converted = z.toJSONSchema(registration.schema, {
    target: 'draft-2020-12',
    // See decision 1 in the module comment: the output side of a branded id is
    // a transform, and transforms have no JSON Schema representation.
    io: 'input',
  });
  const body = expandRequiredRecordKeys(converted) as Record<string, unknown>;
  const { $schema: _dialect, ...rest } = body;

  return {
    $schema: JSON_SCHEMA_DIALECT,
    $id: `${SCHEMA_ID_BASE}${schemaFileName(schemaId)}`,
    title: schemaId,
    description: registration.summary,
    ...rest,
  };
}

/** Every registered document, in registry order. */
export function toJsonSchemaDocuments(): readonly (readonly [string, JsonSchemaDocument])[] {
  return SCHEMA_REGISTRY.map((registration) => [
    registration.schemaId,
    toJsonSchemaDocument(registration.schemaId),
  ]);
}

/**
 * The one serialisation the emitter writes and the checker compares. Two
 * spaces and a trailing newline so the files are diffable and so a text editor
 * does not create a spurious diff the first time someone opens one.
 */
export function serializeSchemaDocument(document: JsonSchemaDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
