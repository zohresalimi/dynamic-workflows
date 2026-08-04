/**
 * KAR-02.8 — the acceptance gate every fact passes before it can be written
 * (docs/04-domain-model.md §5, EPIC-02-S14, EPIC-02-S15).
 *
 * Three checks, in this order, because each one's error is only meaningful
 * once the previous one has passed:
 *
 *   1. **Shape.** `FactSchema` — including the rule that kind and key prefix
 *      agree. A key that lies about its kind poisons every projection keyed
 *      on `kind`, and it is cheap to refuse here.
 *   2. **Registration.** `schemaId` must be a document the registry has. This
 *      is what makes the `ext:` namespace safe: DeFlow applies no constraint on
 *      what an `ext` fact *means*, and would be an untyped bag without the
 *      requirement that its schema be registered first (PRD §15.2).
 *   3. **Value.** The value validated against that document, reporting *all*
 *      errors — an agent handed one error at a time takes N turns to fix N
 *      problems, and each turn costs quota.
 *
 * The registry is a **port**. This package cannot read `.DeFlow/schemas/` (R1),
 * and it should not want to: the lookup is I/O, the decision is not.
 * `@DeFlow/daemon` implements it over Ajv2020 and the emitted files.
 *
 * Verifies: EPIC-02-S14, EPIC-02-S15 · AC4, AC5
 */
import { type Fact, FactSchema } from './fact.ts';

/** One validation failure, addressed by JSON Pointer (RFC 6901). */
export interface SchemaIssue {
  /** `/segments/2/tokens/estimated` — Ajv's `instancePath` verbatim. */
  readonly pointer: string;
  readonly message: string;
}

/**
 * The lookup `acceptFact` needs and cannot perform: "is this document
 * registered, and does this value satisfy it".
 */
export interface FactSchemaRegistry {
  /** Where the registry read its documents, named in the rejection message. */
  readonly location: string;
  has(schemaId: string): boolean;
  /** Every violation, not the first (AC4). Empty means valid. */
  validate(schemaId: string, value: unknown): readonly SchemaIssue[];
}

export type AcceptFactError =
  | {
      readonly kind: 'malformed-fact';
      readonly message: string;
      readonly issues: readonly SchemaIssue[];
    }
  | {
      readonly kind: 'unknown-schema-id';
      readonly message: string;
      readonly schemaId: string;
      readonly issues: readonly SchemaIssue[];
    }
  | {
      readonly kind: 'schema-invalid';
      readonly message: string;
      readonly schemaId: string;
      readonly issues: readonly SchemaIssue[];
    };

export type AcceptFactResult =
  | { readonly ok: true; readonly fact: Fact }
  | { readonly ok: false; readonly error: AcceptFactError };

/** Zod's `path` (`['provenance', 'atEvent']`) as a JSON Pointer. */
function toPointer(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '';
  return path
    .map((segment) => `/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`)
    .join('');
}

/**
 * A value never throws here. Acceptance is a decision the caller has to
 * record either way — `fact.written` on success, and a typed refusal the node
 * inspector can render on failure — and an exception is the one shape that
 * cannot be put in the ledger (docs/04-domain-model.md §8).
 */
export function acceptFact(candidate: unknown, registry: FactSchemaRegistry): AcceptFactResult {
  const parsed = FactSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      pointer: toPointer(issue.path),
      message: issue.message,
    }));
    return {
      ok: false,
      error: {
        kind: 'malformed-fact',
        message: `fact does not satisfy FactSchema: ${issues
          .map((issue) => `${issue.pointer || '/'} ${issue.message}`)
          .join('; ')}`,
        issues,
      },
    };
  }

  const fact = parsed.data;
  const schemaId = fact.schemaId as unknown as string;

  if (!registry.has(schemaId)) {
    return {
      ok: false,
      error: {
        kind: 'unknown-schema-id',
        message:
          `fact "${fact.key}" names schemaId "${schemaId}", which is not present in ` +
          `${registry.location} — register the document there before writing the fact`,
        schemaId,
        issues: [],
      },
    };
  }

  const issues = registry.validate(schemaId, fact.value);
  if (issues.length > 0) {
    return {
      ok: false,
      error: {
        kind: 'schema-invalid',
        message:
          `fact "${fact.key}" does not satisfy "${schemaId}": ` +
          issues.map((issue) => `${issue.pointer || '/'} ${issue.message}`).join('; '),
        schemaId,
        issues,
      },
    };
  }

  return { ok: true, fact };
}
