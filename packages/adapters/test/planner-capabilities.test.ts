/**
 * KAR-11.1 AC2, AC8 — the planner's third input, and the effort it plans at.
 *
 * 06 §2.2's finding is the whole of this file: *"a hardcoded capability matrix
 * will be wrong within a month"*, and the 2026-08-02 probe already contradicts
 * the vendor docs in two places. So the list handed to the planner is built
 * from probed rows, one entry per row, and the assertions below are the ones
 * that fail the moment somebody caches it in a constant: delete a row and the
 * provider is gone.
 *
 * The `strongestEffort` half is the other side of that coin, and it splits
 * differently on purpose. *Whether* an adapter can resume is probed; *which
 * flag it takes a reasoning effort on* cannot be — no ACP `initialize` response
 * mentions one — so the ladder comes from `provider-registry.ts`, the one file
 * allowed to know how a vendor is invoked, and it is selected by the provider
 * the probed row names.
 *
 * Verifies: EPIC-11-S1 (third scenario), EPIC-11-S2 (second and third
 * scenarios) · AC2, AC8
 */
import { expect, it, describe as suite } from 'vitest';
import type { CapabilityRow } from '../src/capabilities.ts';
import { plannerCapabilityList } from '../src/planner-capabilities.ts';
import { PLANNER_EFFORTS, strongestEffort } from '../src/planner-effort.ts';

const row = (provider: string, caps: unknown, version = '1.0.0'): CapabilityRow =>
  ({
    provider,
    version,
    binarySha256: 'a'.repeat(64),
    binaryPath: `/opt/bin/${provider}`,
    capsJson: JSON.stringify(caps),
    probedAt: 1_754_380_800_000,
  }) as CapabilityRow;

/** The 2026-08-02 shapes, in the three answers that must not collapse. */
const CLAUDE = row(
  'claude',
  { agentCapabilities: { loadSession: true, sessionCapabilities: { resume: true } } },
  '2.1.220',
);
/** Gemini returned no `sessionCapabilities` key whatsoever. */
const GEMINI = row('gemini', { agentCapabilities: { loadSession: false } }, '0.53.1');
/** Codex returned the literal boolean `false` for `mcpCapabilities.acp`. */
const CODEX = row(
  'codex',
  { agentCapabilities: { mcpCapabilities: { acp: false }, sessionCapabilities: { resume: true } } },
  '0.146.0',
);

suite('AC2 — the capability list is one entry per probed row', () => {
  it('names every probed provider and its version', () => {
    const list = plannerCapabilityList([CLAUDE, GEMINI, CODEX], 12);

    expect(list.map((entry) => `${entry.provider} ${entry.version}`)).toEqual([
      'claude 2.1.220',
      'gemini 0.53.1',
      'codex 0.146.0',
    ]);
  });

  it('loses a provider when its row is deleted — nothing is cached', () => {
    const before = plannerCapabilityList([CLAUDE, GEMINI], 12);
    const after = plannerCapabilityList([CLAUDE], 12);

    expect(before.map((entry) => entry.provider)).toContain('gemini');
    expect(after.map((entry) => entry.provider)).not.toContain('gemini');
  });

  it('is empty for an empty table, rather than falling back to a default fleet', () => {
    expect(plannerCapabilityList([], 12)).toEqual([]);
  });
});

suite('the three answers 06 §2.2 says must not collapse', () => {
  const answersOf = (entry: { answers: readonly { key: string; reason: string }[] }) =>
    Object.fromEntries(entry.answers.map((answer) => [answer.key, answer.reason]));

  it('reports an absent key as absent, not as denied', () => {
    const [gemini] = plannerCapabilityList([GEMINI], 12);
    if (gemini === undefined) throw new Error('unreachable');
    expect(answersOf(gemini).resume).toBe('capability-absent');
    expect(gemini.answers.find((answer) => answer.key === 'resume')?.supported).toBeUndefined();
  });

  it('reports an explicit false as denied, not as absent', () => {
    const [codex] = plannerCapabilityList([CODEX], 12);
    if (codex === undefined) throw new Error('unreachable');
    expect(answersOf(codex).mcpAcp).toBe('capability-denied');
    expect(codex.answers.find((answer) => answer.key === 'mcpAcp')?.supported).toBe(false);
  });

  it('reports a grant as granted', () => {
    const [claude] = plannerCapabilityList([CLAUDE], 12);
    if (claude === undefined) throw new Error('unreachable');
    expect(answersOf(claude).resume).toBe('capability-granted');
  });

  it('answers every question the router can ask, for every row', () => {
    const [claude] = plannerCapabilityList([CLAUDE], 12);
    const [gemini] = plannerCapabilityList([GEMINI], 12);
    expect(claude?.answers.length).toBeGreaterThan(0);
    expect(gemini?.answers.map((answer) => answer.key)).toEqual(
      claude?.answers.map((answer) => answer.key),
    );
  });
});

suite('the two fields that are invocation knowledge, not probe answers', () => {
  it('reads the structured-output mechanism off the vendor registry', () => {
    const [claude] = plannerCapabilityList([CLAUDE], 12);
    expect(claude?.structuredOutput).toBe('native');
  });

  it('calls an unregistered vendor prompt-only rather than assuming a flag', () => {
    const [unknown] = plannerCapabilityList([row('never-seen-this', {})], 12);
    expect(unknown?.structuredOutput).toBe('prompt-only');
  });

  it('carries the probe event so the segment can be clicked through', () => {
    const [claude] = plannerCapabilityList([CLAUDE], 99);
    expect(claude?.sourceEvent).toBe(99);
  });
});

suite('AC8 — the strongest reasoning effort the adapter exposes', () => {
  it('resolves Claude Code to the top of its own ladder', () => {
    expect(strongestEffort('claude')).toEqual({ flag: '--effort', effort: 'max' });
  });

  it('answers null for a vendor with no such control, rather than inventing one', () => {
    expect(strongestEffort('codex')).toBeNull();
  });

  it('answers null for a vendor nobody has registered', () => {
    expect(strongestEffort('never-seen-this')).toBeNull();
  });

  it('orders the ladder weakest to strongest, as the CLI documents it', () => {
    expect([...PLANNER_EFFORTS]).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('puts the resolved effort on the list entry the planner reads', () => {
    const [claude] = plannerCapabilityList([CLAUDE], 12);
    const [gemini] = plannerCapabilityList([GEMINI], 12);
    expect(claude?.strongestEffort).toBe('max');
    expect(gemini?.strongestEffort).toBeNull();
  });
});
