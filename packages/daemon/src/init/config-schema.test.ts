/**
 * KAR-18.1 AC2 — `.DeFlow/config.yaml` validates against a JSON Schema
 * 2020-12 document generated from `@DeFlow/core`'s `DeFlowConfigSchema`, using
 * the same Ajv2020 `{ strict: true, allErrors: true }` options every other
 * validator in this codebase compiles with, and the document itself declares
 * no provider capability field.
 *
 * Verifies: EPIC-18-S1, EPIC-18-S6 · AC2
 */
import { expect, it, describe as suite } from 'vitest';
import {
  CONFIG_SCHEMA_ID,
  configJsonSchema,
  validateAgainstConfigSchema,
} from './config-schema.ts';

suite('configJsonSchema', () => {
  it('declares the 2020-12 dialect and this schema’s id', () => {
    const doc = configJsonSchema();
    expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(doc.title).toBe(CONFIG_SCHEMA_ID);
  });

  it('names no provider capability field anywhere in the document', () => {
    const doc = configJsonSchema();
    const text = JSON.stringify(doc);
    // AR-5: capability is probed at runtime and persisted, never declared in
    // the committed config. If one of these words appears, something added a
    // capability-shaped field to DeFlowConfigSchema.
    for (const capabilityWord of [
      'canResume',
      'canFork',
      'supportsTerminal',
      'mediatedExecution',
    ]) {
      expect(text).not.toContain(capabilityWord);
    }
  });
});

suite('validateAgainstConfigSchema', () => {
  it('accepts the empty config `init` generates on a clean repository', () => {
    const result = validateAgainstConfigSchema(configJsonSchema(), {});
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a populated, well-typed config', () => {
    const result = validateAgainstConfigSchema(configJsonSchema(), {
      providers: { claude: { pinReinjectTurns: 8 } },
      budget: { run: { costUsd: 25 } },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a value the schema disagrees with, with at least one error', () => {
    const result = validateAgainstConfigSchema(configJsonSchema(), {
      providers: { claude: { pinReinjectTurns: 'lots' } },
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
