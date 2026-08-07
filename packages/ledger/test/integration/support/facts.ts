/**
 * Fixtures for the blackboard specs (KAR-09.8).
 *
 * Two things live here and nothing else: a `Fact` builder that produces a
 * document `FactSchema` actually accepts — every field of `Provenance` is
 * required, and a spec that hand-rolled one per case would be testing its own
 * typos — and a `FactSchemaRegistry` double standing in for
 * `.DeFlow/schemas/`. The double is a fake, not a mock: it answers `has` and
 * `validate` from a plain table, so a spec says which schemas are registered
 * and which values are legal by *data* rather than by arranging calls.
 */
import type { FactKind, FactSchemaRegistry, NodeId, SchemaIssue } from '@DeFlow/core';
import { createHash } from 'node:crypto';

/**
 * `fact_` plus 26 lowercase-alnum characters, as `FactIdSchema` demands.
 *
 * Digested rather than slugified: a spec that writes `finding/f1` and
 * `finding/f10` needs two ids, and any padding scheme gives them one.
 */
export function factId(slug: string): string {
  return `fact_${createHash('sha256').update(slug).digest('hex').slice(0, 26)}`;
}

export interface FactOverrides {
  readonly id?: string;
  readonly key?: string;
  readonly kind?: FactKind;
  readonly schemaId?: string;
  readonly value?: unknown;
  readonly byNode?: string;
  readonly atEvent?: number;
  readonly at?: string;
  readonly confidence?: 'asserted' | 'verified' | 'speculative';
  readonly supersedes?: string;
}

/** One structurally valid `finding` fact, overridable field by field. */
export function fact(overrides: FactOverrides = {}): Record<string, unknown> {
  const key = overrides.key ?? 'finding/auth-uses-jwt';
  const built: Record<string, unknown> = {
    id: overrides.id ?? factId(key),
    key,
    kind: overrides.kind ?? (key.startsWith('ext:') ? 'ext' : key.slice(0, key.indexOf('/'))),
    schemaId: overrides.schemaId ?? 'DeFlow.finding.v1',
    value: overrides.value ?? { claim: 'auth uses jwt' },
    provenance: {
      byNode: overrides.byNode ?? 'recon',
      byProvider: 'claude-code',
      byModel: 'claude-sonnet-4-6-20260514',
      fromEvidence: [`artifact://${'b'.repeat(64)}`],
      atEvent: overrides.atEvent ?? 7,
      at: overrides.at ?? '2026-08-07T09:00:00.000Z',
      confidence: overrides.confidence ?? 'asserted',
    },
  };
  if (overrides.supersedes !== undefined) built.supersedes = overrides.supersedes;
  return built;
}

export const nodeId = (id: string): NodeId => id as NodeId;

export interface FakeRegistryOptions {
  /** Every `schemaId` the directory holds. */
  readonly registered: readonly string[];
  /** Values this registry refuses, by `schemaId`. Everything else validates. */
  readonly rejects?: (schemaId: string, value: unknown) => readonly SchemaIssue[];
}

/** A `FactSchemaRegistry` over a literal table — no Ajv, no filesystem. */
export function fakeRegistry(options: FakeRegistryOptions): FactSchemaRegistry {
  const registered = new Set(options.registered);
  return {
    location: '/tmp/project/.DeFlow/schemas',
    has: (schemaId) => registered.has(schemaId),
    validate: (schemaId, value) => options.rejects?.(schemaId, value) ?? [],
  };
}
