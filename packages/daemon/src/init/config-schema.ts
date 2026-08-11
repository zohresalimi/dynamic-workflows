/**
 * KAR-18.1 AC2 — the JSON Schema 2020-12 document `.DeFlow/config.yaml`
 * validates against, generated from `@DeFlow/core`'s `DeFlowConfigSchema`
 * with the same conversion EPIC-02 KAR-02.8 uses for every other DeFlow
 * document (`z.toJSONSchema`, `target: 'draft-2020-12'`, `io: 'input'`), and
 * compiled with the same Ajv2020 options every other validator in this
 * codebase uses (`AJV_2020_OPTIONS`, from `@DeFlow/core`).
 *
 * A local conversion rather than a new row in `@DeFlow/core`'s
 * `SCHEMA_REGISTRY`: that registry is the set of documents a `Fact` can carry
 * or a vendor CLI can be handed on `--json-schema` (docs/04-domain-model.md
 * §0), and `.DeFlow/config.yaml` is neither — it is DeFlow's own settings
 * file, read once per run by `loadWorkspaceConfig`, never handed to an agent.
 * Keeping its schema here keeps the one new document this story needs out of
 * EPIC-02's committed `schemas/` fixture and its drift check.
 *
 * `DeFlowConfigSchema` is `z.looseObject` throughout (KAR-09.4's own
 * docstring: the file is the operator's, so unknown top-level keys are
 * carried through rather than rejected) — and it declares no capability
 * field for any provider, only selection and policy (AR-5), so the emitted
 * document inherits that shape for free.
 */
import { AJV_2020_OPTIONS, DeFlowConfigSchema, JSON_SCHEMA_DIALECT } from '@DeFlow/core';
import Ajv2020Module, { type ErrorObject } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';
import { z } from 'zod';

// ajv and ajv-formats are CommonJS with a `default` export; Node's ESM
// interop hands that over as `.default` under some resolutions and as the
// module itself under others (the same interop `schema-store.ts` handles).
type Interop<T> = T & { default?: T };
const Ajv2020 = (Ajv2020Module as Interop<typeof Ajv2020Module>).default ?? Ajv2020Module;
const addFormats =
  (addFormatsModule as Interop<typeof addFormatsModule>).default ?? addFormatsModule;

/** Not a member of `@DeFlow/core`'s `SCHEMA_REGISTRY` — see the module
 * comment — but versioned the same way in case a shape change ever needs a
 * `.v2` of its own. */
export const CONFIG_SCHEMA_ID = 'DeFlow.config.v1';

/** The name this document takes inside `.DeFlow/schemas/`. */
export const CONFIG_SCHEMA_FILE = 'config.schema.json';

/** A standalone 2020-12 document, deterministic across machines. */
export function configJsonSchema(): Record<string, unknown> {
  const converted = z.toJSONSchema(DeFlowConfigSchema, {
    target: 'draft-2020-12',
    // Every branded id elsewhere in the domain model needs 'input' because a
    // transform has no output-side JSON Schema representation; DeFlowConfig
    // carries none, but the same option keeps this conversion consistent with
    // every other one in the codebase rather than a second convention.
    io: 'input',
  }) as Record<string, unknown>;
  const { $schema: _dialect, ...rest } = converted;

  return {
    $schema: JSON_SCHEMA_DIALECT,
    $id: `https://deflow.dev/schemas/${CONFIG_SCHEMA_FILE}`,
    title: CONFIG_SCHEMA_ID,
    description:
      'The committed half of .DeFlow/config.yaml: provider selection and policy, never a ' +
      'capability claim (AR-5).',
    ...rest,
  };
}

export interface ConfigValidation {
  readonly valid: boolean;
  readonly errors: readonly ErrorObject[];
}

/** Validates `value` — parsed YAML, not the raw text — against `schemaDocument`. */
export function validateAgainstConfigSchema(
  schemaDocument: Record<string, unknown>,
  value: unknown,
): ConfigValidation {
  const ajv = new Ajv2020(AJV_2020_OPTIONS);
  addFormats(ajv);
  const validate = ajv.compile(schemaDocument);
  const valid = validate(value) === true;
  return { valid, errors: valid ? [] : (validate.errors ?? []) };
}
