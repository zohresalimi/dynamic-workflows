/**
 * KAR-09.7 AC5 — which seed a provider's estimate correction starts from.
 *
 * The seeds are keyed by *model family* (`anthropic`, `openai`, `default`)
 * rather than by provider id, because the bias being corrected is the
 * tokenizer's, and the tokenizer belongs to the model rather than to the CLI
 * driving it. Which family a provider's models belong to cannot be probed —
 * you have to know that this CLI drives Anthropic models before you can ask it
 * anything — so it lives in the one file allowed to name vendors, beside the
 * argv it takes.
 *
 * A provider whose family nobody has stated gets `default`, and that is the
 * right answer: 1.05 is a deliberately small correction, and it is replaced by
 * measurement after five nodes.
 *
 * Verifies: EPIC-09-S39 · KAR-09.7 AC5
 */
import { ProviderIdSchema, seedFactor } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { PROVIDER_SPECS, providerFamily } from '../src/index.ts';

suite('every registered provider states a model family', () => {
  it('states one for each of the verified adapters', () => {
    for (const spec of Object.values(PROVIDER_SPECS)) {
      expect(typeof spec.family, `${spec.id} has no family`).toBe('string');
      expect(spec.family.length).toBeGreaterThan(0);
    }
  });

  it('maps the two families whose seeds are stated, and nothing else', () => {
    expect(providerFamily(ProviderIdSchema.parse('claude'))).toBe('anthropic');
    expect(providerFamily(ProviderIdSchema.parse('codex'))).toBe('openai');
    // Everything else is honestly "we have not measured this one".
    for (const id of ['gemini', 'copilot', 'opencode']) {
      expect(seedFactor(providerFamily(ProviderIdSchema.parse(id)))).toBe(1.05);
    }
  });

  it('answers default for a provider that is not registered at all', () => {
    expect(providerFamily(ProviderIdSchema.parse('not-a-provider'))).toBe('default');
    expect(seedFactor(providerFamily(ProviderIdSchema.parse('not-a-provider')))).toBe(1.05);
  });
});
