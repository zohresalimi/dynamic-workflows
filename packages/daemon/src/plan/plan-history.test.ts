/**
 * KAR-11.5 AC4, AC5 — the two pure pieces of the diff endpoint's contract
 * (docs/06-planning-and-replanning.md §5, docs/11-api-and-realtime.md §7.4):
 *
 *   - `unionLayoutKey` is a cache key, never coordinates — a string of the
 *     exact shape `<runId>:union:v<from>-v<to>`, so a client can cache the
 *     layout it computes once and the server never ships x/y values.
 *   - `joinPlanTransition` carries `reason` from the proposal to the response
 *     without touching it — no template, no re-casing, no truncation — because
 *     the whole of AC5 is that the string on the wire is the string on the
 *     `plan.patched` event, byte for byte, including whatever punctuation a
 *     human or a scheduler put in it.
 *
 * Pure, so this is unit level: the DB reads that produce the two arguments are
 * `../../test/integration/plan-diff-endpoint.test.ts`'s job, over a real
 * ledger.
 *
 * Verifies: EPIC-11-S27 · AC4, AC5 · test plan #4
 */
import { describe, expect, it } from 'vitest';
import { joinPlanTransition, unionLayoutKey } from './plan-history.ts';

describe('unionLayoutKey — a cache key, never coordinates', () => {
  it('is <runId>:union:v<from>-v<to>', () => {
    expect(unionLayoutKey('run_20260809T090000Z_ac1105', 3, 4)).toBe(
      'run_20260809T090000Z_ac1105:union:v3-v4',
    );
  });

  it('is meaningful for a non-adjacent pair too', () => {
    expect(unionLayoutKey('run_20260809T090000Z_ac1105', 1, 4)).toBe(
      'run_20260809T090000Z_ac1105:union:v1-v4',
    );
  });
});

describe('joinPlanTransition — the reason travels byte-identical, and nothing else is invented', () => {
  it('carries patchId, reason and the decision outcome straight through', () => {
    const joined = joinPlanTransition(
      { patchId: 'patch-3a91f0', decision: { decision: 'auto' } },
      { patch: { reason: 'Anthropic rate limit hit; re-routing to Codex' } },
    );

    expect(joined).toEqual({
      patchId: 'patch-3a91f0',
      reason: 'Anthropic rate limit hit; re-routing to Codex',
      decision: 'auto',
    });
  });

  it('round-trips a reason carrying a newline and a double quote unchanged', () => {
    // AC5's own example: "the plan.patched reason contains a newline and a
    // double quote" and "nothing truncated, summarised or re-cased it". A
    // naive implementation that interpolated the reason into a hand-built
    // string (rather than passing the value through) would corrupt exactly
    // this input.
    const reason = 'node "implement" moved because claude was rate-limited\nretrying on codex';
    const joined = joinPlanTransition(
      { patchId: 'patch-1', decision: { decision: 'auto' } },
      { patch: { reason } },
    );

    expect(joined?.reason).toBe(reason);
  });

  it('returns null when there is no patch behind the version — v1’s initial compile', () => {
    expect(joinPlanTransition(null, null)).toBeNull();
  });

  it('returns null when the patched event names a proposal this run never logged', () => {
    // Defensive: a `plan.patched` whose `plan.patch.proposed` counterpart is
    // unreadable (a schema this build no longer parses) must not fabricate a
    // reason rather than surface an honest absence.
    expect(
      joinPlanTransition({ patchId: 'patch-1', decision: { decision: 'auto' } }, null),
    ).toBeNull();
  });
});
