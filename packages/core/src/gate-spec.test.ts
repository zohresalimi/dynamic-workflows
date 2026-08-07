/**
 * KAR-09.4 AC8 / §4.3 — a gate's criteria come from the ledger, and from
 * nothing else.
 *
 * The rule follows from Security-Recall Divergence: prohibitions rot while the
 * commission-type audit signals stay healthy, so "the gates are passing" is not
 * evidence that the spec was honoured — and a gate that asked the agent what the
 * spec said would be reading the very thing that decayed.
 *
 * Verifies: EPIC-09-S25 · AC8
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { EVENT_SCHEMAS, type EventKind } from './event-payloads.ts';
import { type Event, parseEvent } from './events.ts';
import { GateSpecUnavailable, gateSpecFromLedger } from './gate-spec.ts';
import { specHash } from './hash.ts';

const RUN_ID = 'run_20260806T090000Z_5c1d2e';

const fixture: Record<string, unknown> = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../test/fixtures/specs/vue3-migration.json', import.meta.url)),
    'utf8',
  ),
);

/** The fixture spec with a *real* `specHash`, since the identity is the whole
 * mechanism: a gate selects by it. */
async function spec(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const draft = { ...structuredClone(fixture), ...overrides };
  draft.approvedBy = { at: '2026-08-06T09:00:00Z', via: 'ui' };
  return { ...draft, specHash: await specHash(draft) };
}

interface Row {
  readonly kind: EventKind;
  readonly payload: unknown;
}

function ledger(rows: readonly Row[]): Event[] {
  return rows.map((row, index) => {
    const result = parseEvent({
      seq: index + 1,
      runId: RUN_ID,
      ts: 1_754_470_000_000,
      kind: row.kind,
      v: EVENT_SCHEMAS[row.kind].v,
      epoch: 1,
      payload: row.payload,
    });
    if (result.status !== 'ok') {
      throw new Error(`fixture for ${row.kind} is not an event: ${JSON.stringify(result)}`);
    }
    return result.event;
  });
}

const created = (value: Record<string, unknown>): Row => ({
  kind: 'run.created',
  payload: { spec: value, cwd: '/tmp/repo', repo: { head: 'e83c516', branch: 'main' } },
});

const approved = (hash: string): Row => ({
  kind: 'run.spec.approved',
  payload: { specHash: hash, by: 'ui' },
});

suite('a gate resolves its criteria from the ledger (EPIC-09-S25)', () => {
  it('returns the approved spec, its hash and its criterion ids', async () => {
    const value = await spec();
    const resolved = await gateSpecFromLedger(
      ledger([created(value), approved(value.specHash as string)]),
    );

    expect(resolved.specHash).toBe(value.specHash);
    expect(resolved.criteria.map((criterion) => criterion.id)).toEqual(
      (value.acceptanceCriteria as { id: string }[]).map((criterion) => criterion.id),
    );
  });

  it('does not consult anything the agent was told — the ledger is the only input', async () => {
    const value = await spec();
    const events = ledger([created(value), approved(value.specHash as string)]);

    // The gate is handed the events and nothing else. There is no context
    // packet, no prompt and no transcript in the argument list, which is the
    // property F1.5 asks for expressed as a type rather than as a convention.
    const resolved = await gateSpecFromLedger(events);

    expect(resolved.spec.goal).toBe(value.goal);
  });

  it('refuses a run whose spec was never approved rather than judging a draft', async () => {
    const value = await spec();

    await expect(gateSpecFromLedger(ledger([created(value)]))).rejects.toThrow(GateSpecUnavailable);
  });

  it('refuses a ledger with no spec at all', async () => {
    await expect(
      gateSpecFromLedger(ledger([approved(`sha256-${'0'.repeat(64)}`)])),
    ).rejects.toThrow(GateSpecUnavailable);
  });

  it('refuses when the approved hash is not the hash of the spec on record', async () => {
    const value = await spec();

    await expect(
      gateSpecFromLedger(ledger([created(value), approved(`sha256-${'a'.repeat(64)}`)])),
    ).rejects.toThrow(/specHash/);
  });
});

suite('editing the spec changes the identity gates evaluate against', () => {
  it('one word of the goal is a different specHash', async () => {
    const before = await spec();
    const after = await spec({ goal: `${String(fixture.goal)} carefully` });

    expect(after.specHash).not.toBe(before.specHash);
  });

  it('re-approving the same bytes does not', async () => {
    const value = await spec();
    const reapproved = await spec({ approvedBy: { at: '2026-08-07T09:00:00Z', via: 'cli' } });

    expect(reapproved.specHash).toBe(value.specHash);
  });
});
