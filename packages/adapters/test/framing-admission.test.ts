/**
 * KAR-10.2 AC3 — the framing node is admitted onto an adapter that can take a
 * schema at the boundary, or it is not scheduled at all.
 *
 * *"Do not accept a prose plan… a regex over prose is how the planner layer
 * starts breaking on every CLI update"* ([06 §8]) — and the same argument
 * applies harder to the spec, because the spec is what everything downstream is
 * judged against. So there is no prose fallback here: an adapter that cannot
 * enforce the document is refused with `adapter.capability-missing`, which is a
 * routing decision the planner can act on rather than a parse DeFlow can get
 * wrong.
 *
 * Under `test/` and not `src/` for the same reason `admission.test.ts` is: it
 * names vendors, and `no-capability-table.test.ts` keeps those out of `src/`.
 *
 * Verifies: EPIC-10-S10 · AC3
 */
import { NodeIdSchema, ProviderIdSchema, TASKSPEC_DRAFT_SCHEMA_ID } from '@DeFlow/core';
import { CAPABILITY_PROFILES } from '@DeFlow/mock-agent';
import { expect, it, describe as suite } from 'vitest';
import type { CapabilityRow } from '../src/index.ts';
import { admitFraming, framingSchemaContract } from '../src/index.ts';

const NODE = NodeIdSchema.parse('frame');

function rowFor(provider: string): CapabilityRow {
  return {
    provider: ProviderIdSchema.parse(provider),
    version: '1.0.0',
    binarySha256: 'a'.repeat(64),
    binaryPath: '/opt/DeFlow/bin/agent',
    capsJson: JSON.stringify({
      protocolVersion: 1,
      agentCapabilities: CAPABILITY_PROFILES['mock-full'],
      authMethods: [],
    }),
    probedAt: 1_754_313_093_000,
  };
}

suite('EPIC-10-S10 — the schema goes to the adapter that can take it', () => {
  it('admits claude, whose schema rides on --json-schema', () => {
    expect(admitFraming({ node: NODE, provider: 'claude' }, rowFor('claude'))).toBeNull();

    const contract = framingSchemaContract({
      provider: 'claude',
      schemasDir: '/run/.DeFlow/schemas',
    });
    expect(contract.mechanism).toBe('native');
    expect(contract.flag).toBe('--json-schema');
    expect(contract.schemaPath).toBe(`/run/.DeFlow/schemas/${TASKSPEC_DRAFT_SCHEMA_ID}.json`);
    // Native means the vendor enforces it; nothing is asked of the prompt.
    expect(contract.promptInjection).toBeNull();
  });

  it('admits codex, whose schema rides on --output-schema <FILE>', () => {
    expect(admitFraming({ node: NODE, provider: 'codex' }, rowFor('codex'))).toBeNull();
    expect(
      framingSchemaContract({ provider: 'codex', schemasDir: '/run/.DeFlow/schemas' }).flag,
    ).toBe('--output-schema');
  });

  it('refuses a probed adapter that has no way to take a schema', () => {
    const refusal = admitFraming({ node: NODE, provider: 'gemini' }, rowFor('gemini'));
    expect(refusal).not.toBeNull();
    expect(refusal?.deflowFailure.reason).toBe('adapter.capability-missing');
    expect(refusal?.deflowFailure.class).toBe('permanent');
    expect(refusal?.message).toContain('gemini');
    expect(refusal?.message).toMatch(/prose/);
  });

  it('refuses an unprobed adapter: capabilities are read from the row, never a constant', () => {
    const refusal = admitFraming({ node: NODE, provider: 'claude' }, null);
    expect(refusal).not.toBeNull();
    expect(refusal?.deflowFailure.reason).toBe('adapter.capability-missing');
    expect(refusal?.deflowFailure.detail).toMatchObject({ node: 'frame', provider: 'claude' });
  });

  it('refuses a provider DeFlow has never heard of rather than assuming a flag', () => {
    const refusal = admitFraming({ node: NODE, provider: 'acme-cli' }, rowFor('acme-cli'));
    expect(refusal?.deflowFailure.reason).toBe('adapter.capability-missing');
  });

  it('budgets the framed document at 4000 tokens on the prompt-only arm too', () => {
    // Nothing is scheduled onto a prompt-only adapter (above), but the contract
    // is still computable — and if it were ever rendered, the budget it states
    // must be the one the node is actually held to.
    expect(
      framingSchemaContract({ provider: 'gemini', schemasDir: '/run/.DeFlow/schemas' })
        .promptInjection,
    ).toContain('4000');
  });
});
