/**
 * KAR-02.5 — `Fact`, `Provenance` and the blackboard vocabulary
 * (docs/04-domain-model.md §5).
 *
 * This answers PRD open question §15.2: a small fixed core of six kinds
 * (`finding`, `decision`, `artifact`, `scope`, `risk`, `verdict`) plus one
 * schema-validated free-form namespace (`ext`). The fixed core gives the
 * memory graph and the node inspector's provenance table something
 * renderable and diffable; `ext:` stops the vocabulary becoming a
 * straitjacket the first time an unanticipated task archetype appears.
 *
 * The key grammar is enforced at the schema boundary, not left to
 * convention: `<kind>/<slug>` for the six core kinds, `ext:<namespace>/<key>`
 * for the free space, and kind and key prefix must agree — a `finding` fact
 * cannot carry a `decision/…` key and vice versa.
 *
 * A `Fact`'s `value` is `unknown` at the type level. Validating it against
 * `schemaId` is Ajv's job at acceptance time (KAR-02.8) — this package
 * cannot depend on anything I/O-capable (R1), and a schema *registry* is a
 * lookup that needs the filesystem. This module only owns the shape.
 *
 * Two invariants from §5 that matter more than they look:
 *
 *   1. §5.1 — the blackboard is a projection, never a store. `fact.written`
 *      / `fact.read` / `fact.invalidated` events are the truth; the `fact`
 *      table is a materialised view rebuildable from the ledger at any time.
 *      This module enforces its half of that rule structurally: it exports
 *      constructors and validators only, never a mutator. Corrections are a
 *      new `Fact` whose `supersedes` points at the old one — the old one is
 *      never touched.
 *   2. §5.2 — the taint rule ("every consumer whose `fact.read` is at a seq
 *      earlier than the invalidation") is a numeric comparison over
 *      `EventSeq`, never a timestamp one. `provenance.at` is display-only;
 *      `provenance.atEvent` is the only ordering key this module exposes,
 *      because the wall clock is not monotonic — laptop sleep and NTP
 *      correction both move `Date.now()` backwards
 *      (docs/05-durable-execution.md §9.6).
 *
 * Verifies: EPIC-02-S14 (kind/key grammar), EPIC-02-S16 · AC1–AC7
 */
import { z } from 'zod';
import {
  EventSeqSchema,
  FactIdSchema,
  HandleSchema,
  NodeIdSchema,
  ProviderIdSchema,
  SchemaIdSchema,
} from './ids.ts';

/**
 * The id of the `Fact` **envelope** document — what `schemas/DeFlow.fact.v1.json`
 * describes (KAR-02.8). Not to be confused with `Fact.schemaId`, which names
 * the schema of the fact's *value*.
 */
export const FACT_SCHEMA_ID = 'DeFlow.fact.v1' as const;

/** The whole enumerated vocabulary: six fixed kinds plus the free-form
 * `ext` escape hatch. Nothing outside this list is a legal `Fact.kind`. */
export const FACT_KINDS = [
  'finding',
  'decision',
  'artifact',
  'scope',
  'risk',
  'verdict',
  'ext',
] as const;

export type FactKind = (typeof FACT_KINDS)[number];

export const FactKindSchema: z.ZodType<FactKind> = z.enum(FACT_KINDS);

export const CONFIDENCE_LEVELS = ['asserted', 'verified', 'speculative'] as const;

export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export const ConfidenceSchema: z.ZodType<Confidence> = z.enum(CONFIDENCE_LEVELS);

export const ProvenanceSchema = z.strictObject({
  byNode: NodeIdSchema,
  byProvider: ProviderIdSchema,
  /** As reported by the adapter, verbatim — not normalised or looked up. */
  byModel: z.string().min(1),
  fromEvidence: z.array(HandleSchema),
  /** The ordering key. See `compareFactsByEventOrder` below. */
  atEvent: EventSeqSchema,
  /**
   * ISO 8601, display-only. Never compared: the wall clock is not
   * monotonic, so ordering on this field is a bug waiting for a laptop to
   * sleep through a daylight-saving transition. `atEvent` is authoritative.
   */
  at: z.iso.datetime(),
  confidence: ConfidenceSchema,
});

export type Provenance = z.infer<typeof ProvenanceSchema>;

/** `<kind>/<slug>`: lowercase, starting alphanumeric, kebab-case body. */
const CORE_KEY_SLUG = /^[a-z][a-z0-9-]*$/;

/** `ext:<namespace>/<key>`, both segments the same slug shape. */
const EXT_KEY_PATTERN = /^ext:[a-z][a-z0-9-]*\/[a-z][a-z0-9-]*$/;

/** AC1–AC3: kind and key prefix must agree. Exported so callers that build a
 * key programmatically (rather than through `FactSchema.parse`) can check it
 * before round-tripping through Zod. */
export function keyMatchesKind(kind: FactKind, key: string): boolean {
  if (kind === 'ext') return EXT_KEY_PATTERN.test(key);
  const prefix = `${kind}/`;
  return key.startsWith(prefix) && CORE_KEY_SLUG.test(key.slice(prefix.length));
}

export const FactSchema = z
  .strictObject({
    id: FactIdSchema,
    /** 'finding/auth-uses-jwt' for core kinds; 'ext:migration/…' for the free
     * space. Cross-checked against `kind` below. */
    key: z.string().min(1),
    kind: FactKindSchema,
    /** Resolves to `.DeFlow/schemas/<schemaId>.json`. */
    schemaId: SchemaIdSchema,
    /** Validated against `schemaId` by Ajv at acceptance (KAR-02.8), not
     * here — this module has no schema registry to validate against. */
    value: z.unknown(),
    provenance: ProvenanceSchema,
    /** A different `Fact`, never this one (AC5). */
    supersedes: FactIdSchema.optional(),
    /** The event that invalidated this fact — the taint rule's input, and an
     * `EventSeq` so the comparison downstream is numeric (AC6). */
    invalidatedBy: EventSeqSchema.optional(),
  })
  .superRefine((candidate, ctx) => {
    if (!keyMatchesKind(candidate.kind, candidate.key)) {
      ctx.addIssue({
        code: 'custom',
        path: ['key'],
        message:
          `key "${candidate.key}" does not match kind "${candidate.kind}": core kinds ` +
          `require "<kind>/<slug>", "ext" requires "ext:<namespace>/<key>"`,
      });
    }
    if (candidate.supersedes !== undefined && candidate.supersedes === candidate.id) {
      ctx.addIssue({
        code: 'custom',
        path: ['supersedes'],
        message: 'a fact cannot supersede itself',
      });
    }
  });

export type Fact = z.infer<typeof FactSchema>;

/**
 * The only ordering this module exports: by `provenance.atEvent`, never by
 * `provenance.at` (AC4, §5.2). Suitable for `Array.prototype.sort`.
 */
export function compareFactsByEventOrder(a: Fact, b: Fact): number {
  return a.provenance.atEvent - b.provenance.atEvent;
}
