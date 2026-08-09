/**
 * KAR-12.3 AC10 — every recorded verdict validates against the schema on disk.
 *
 * The check reads `.DeFlow/schemas/verdict.schema.json` *from the filesystem*
 * rather than importing the Zod type, and that is the entire point: a Zod edit
 * that changes the wire shape without shipping a new document fails here,
 * rather than in the next run against a vendor CLI that rejects the payload at
 * three in the morning. Together with `pnpm schemas:check` — which proves the
 * committed documents still match the Zod source — the pair closes the loop in
 * both directions.
 *
 * The corpus is `fixtures/runs/gate-failure-repair.events.json`: a gate failing
 * with two findings, a repair attempt that fixes one and introduces another, an
 * adversarial reviewer that can only answer one of its two criteria, and a
 * final pass. It is the shape KAR-12.5's repair loop will be measured against,
 * and it exists here first so the contract is fixed before the loop is written.
 *
 * Verifies: EPIC-12-S19, EPIC-12-S22 · AC5, AC7, AC8, AC10 · test plan #10
 */
import { EVENT_CURRENT_VERSIONS, VERDICT_V3_SCHEMA_ID } from '@DeFlow/core';
import { findingDelta } from '@DeFlow/gates';
import { it } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { expect, describe as suite } from 'vitest';
import { writeRunSchemas } from '../../src/run-schemas.ts';
import { loadSchemaDirectory } from '../../src/schema-store.ts';

interface FixtureEvent {
  readonly seq: number;
  readonly kind: string;
  readonly v: number;
  readonly attempt: number;
  readonly payload: {
    readonly gate: string;
    readonly verdict: {
      readonly criteria: readonly { readonly id: string; readonly status: string }[];
      readonly findings: readonly { readonly id: string }[];
      readonly cost?: { readonly durationMs: number };
    };
  };
}

const events = JSON.parse(
  readFileSync(
    new URL('../../../../fixtures/runs/gate-failure-repair.events.json', import.meta.url),
    'utf8',
  ),
) as readonly FixtureEvent[];

const gateEvents = events.filter((event) => event.kind === 'gate.evaluated');

suite('the gate-failure-repair fixture (test plan #10)', () => {
  it('is a run with gates in it', () => {
    expect(gateEvents.length).toBeGreaterThanOrEqual(4);
  });

  it('records its payloads at the version this build writes', () => {
    // Not cosmetic: a `gate.evaluated` bump with no corresponding fixture is a
    // corpus that stops describing what the daemon now writes.
    for (const event of gateEvents) {
      expect(event.v).toBe(EVENT_CURRENT_VERSIONS['gate.evaluated']);
    }
  });

  it('validates every verdict against the document in the run directory (AC10)', ({ tmp }) => {
    const store = loadSchemaDirectory(writeRunSchemas(tmp));

    for (const event of gateEvents) {
      const issues = store.validate(VERDICT_V3_SCHEMA_ID, event.payload.verdict);
      expect(issues, `seq ${event.seq}: ${JSON.stringify(issues)}`).toEqual([]);
    }
  });

  it('validates them under the name a vendor CLI is handed, too', ({ tmp }) => {
    const store = loadSchemaDirectory(writeRunSchemas(tmp));

    for (const event of gateEvents) {
      expect(store.validate('verdict.schema', event.payload.verdict)).toEqual([]);
    }
  });

  it('records a cost on every verdict, and never a fabricated token count (AC8)', () => {
    for (const event of gateEvents) {
      expect(event.payload.verdict.cost?.durationMs).toBeGreaterThan(0);
    }

    const deterministic = gateEvents.filter((event) => event.payload.gate === 'lint-gate');
    for (const event of deterministic) {
      // A gate that ran a process accounts for no tokens: blank, not zero.
      expect(Object.keys(event.payload.verdict.cost ?? {})).toEqual(['durationMs']);
    }
  });

  it('carries a criterion no gate could answer as unverifiable (AC7)', () => {
    const statuses = gateEvents.flatMap((event) => event.payload.verdict.criteria);
    expect(statuses.some((criterion) => criterion.status === 'unverifiable')).toBe(true);
  });

  it('shows the repair attempt fixing one finding and introducing another (AC5)', () => {
    const first = gateEvents[0]?.payload.verdict.findings.map((finding) => finding.id) ?? [];
    const second = gateEvents[1]?.payload.verdict.findings.map((finding) => finding.id) ?? [];

    expect(findingDelta(first, second)).toEqual({
      fixed: ['a13f0c2b91e4'],
      remaining: ['55c1e0a94b72'],
      introduced: ['9c02f1a4b7d3'],
    });
  });
});
