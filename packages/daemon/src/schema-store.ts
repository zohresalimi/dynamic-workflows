/**
 * KAR-02.8 — the Ajv2020 validator over `.DeFlow/schemas/`.
 *
 * `@DeFlow/core` decides what acceptance *means* (`acceptFact`) and owns the
 * Zod source the files are generated from; it cannot read a directory (R1).
 * This module is the port implementation: it loads the emitted documents,
 * compiles each one, and answers "is this schemaId registered" and "does this
 * value satisfy it" — which is the whole of `FactSchemaRegistry`.
 *
 * Two options are not negotiable and both come from `AJV_2020_OPTIONS` in
 * core, so the runtime validator and `pnpm schemas:check` compile the same
 * bytes the same way:
 *
 *   * `strict: true` — a schema Ajv refuses in strict mode is a schema whose
 *     behaviour depends on a keyword one of the two validators silently
 *     ignores. Failing at boot beats validating against half a document.
 *   * `allErrors: true` — an agent handed one error at a time takes N turns to
 *     fix N problems, and each turn costs quota (F6.9).
 *
 * The `ext:` namespace rides on exactly this: DeFlow constrains nothing about
 * what an `ext` fact means, but the schema must be *present here* first, which
 * is what stops the namespace becoming an untyped bag (PRD §15.2).
 *
 * Verifies: EPIC-02-S14, EPIC-02-S15, EPIC-02-S25 · AC3, AC4, AC5
 */

import { AJV_2020_OPTIONS, type FactSchemaRegistry, type SchemaIssue } from '@DeFlow/core';
import { readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import Ajv2020Module, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsModule from 'ajv-formats';

// ajv and ajv-formats are CommonJS with a `default` export, which Node's ESM
// interop hands over as `.default` under some resolutions and as the module
// itself under others.
type Interop<T> = T & { default?: T };
const Ajv2020 = (Ajv2020Module as Interop<typeof Ajv2020Module>).default ?? Ajv2020Module;
const addFormats =
  (addFormatsModule as Interop<typeof addFormatsModule>).default ?? addFormatsModule;

/** Validates one value, returning every violation. Empty means valid. */
export type ValidateValue = (value: unknown) => readonly SchemaIssue[];

export interface SchemaDirectory extends FactSchemaRegistry {
  /** Every `schemaId` with a file in the directory, including `ext:` ones. */
  readonly schemaIds: readonly string[];
  /** The compiled validator for one id. Throws `UnknownSchemaFile` if absent. */
  validator(schemaId: string): ValidateValue;
}

/** AC5's rejection, as an exception for the callers that are not `acceptFact`. */
export class UnknownSchemaFile extends Error {
  readonly schemaId: string;
  readonly dir: string;

  constructor(schemaId: string, dir: string) {
    super(
      `no schema named "${schemaId}" in ${dir} — write ${schemaId}.json there before ` +
        'anything can be validated against it',
    );
    this.name = 'UnknownSchemaFile';
    this.schemaId = schemaId;
    this.dir = dir;
  }
}

/** A document Ajv refuses in strict mode, named with its file. */
export class SchemaCompilationFailed extends Error {
  readonly schemaId: string;

  constructor(schemaId: string, dir: string, cause: unknown) {
    super(
      `${schemaId}.json in ${dir} does not compile under Ajv2020 { strict: true }: ` +
        (cause instanceof Error ? cause.message : String(cause)),
    );
    this.name = 'SchemaCompilationFailed';
    this.schemaId = schemaId;
  }
}

/**
 * `<cwd>/.DeFlow/schemas` — where `DeFlow init` puts a copy of the repository's
 * `schemas/` directory, and what an `agent` node hands a vendor CLI as
 * `--json-schema`/`--output-schema`.
 */
export function defaultSchemasDir(): string {
  return join(process.cwd(), '.DeFlow', 'schemas');
}

function toIssue(error: ErrorObject): SchemaIssue {
  const missing = (error.params as { missingProperty?: string }).missingProperty;
  // Ajv reports a missing member against its *parent*; addressing the member
  // itself is what makes the pointer usable as a repair instruction.
  const pointer = missing === undefined ? error.instancePath : `${error.instancePath}/${missing}`;
  return { pointer, message: error.message ?? 'is invalid' };
}

function wrap(validate: ValidateFunction): ValidateValue {
  return (value) => (validate(value) ? [] : (validate.errors ?? []).map((error) => toIssue(error)));
}

/**
 * Compiles every `*.json` in `dir` once. Deliberately uncached: a store is
 * loaded at boot and held, and a cache keyed by path would hand a long-lived
 * daemon a schema the operator has since replaced.
 */
export function loadSchemaDirectory(dir: string = defaultSchemasDir()): SchemaDirectory {
  const location = isAbsolute(dir) ? dir : resolve(dir);
  const ajv = new Ajv2020(AJV_2020_OPTIONS);
  addFormats(ajv);

  const validators = new Map<string, ValidateValue>();
  let entries: string[] = [];
  try {
    entries = readdirSync(location);
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const schemaId = entry.slice(0, -'.json'.length);
    const document: unknown = JSON.parse(readFileSync(join(location, entry), 'utf8'));
    try {
      validators.set(schemaId, wrap(ajv.compile(document as object)));
    } catch (thrown) {
      throw new SchemaCompilationFailed(schemaId, location, thrown);
    }
  }

  return {
    location,
    schemaIds: [...validators.keys()],
    has: (schemaId) => validators.has(schemaId),
    validator: (schemaId) => {
      const validate = validators.get(schemaId);
      if (validate === undefined) throw new UnknownSchemaFile(schemaId, location);
      return validate;
    },
    validate: (schemaId, value) => {
      const validate = validators.get(schemaId);
      if (validate === undefined) throw new UnknownSchemaFile(schemaId, location);
      return validate(value);
    },
  };
}

/**
 * The single-schema convenience AC4 names: `makeValidator('DeFlow.finding.v1')`.
 *
 * It loads the whole directory, so a caller validating many values should hold
 * a `loadSchemaDirectory` store instead of calling this per value.
 */
export function makeValidator(
  schemaId: string,
  options: { readonly dir?: string } = {},
): ValidateValue {
  return loadSchemaDirectory(options.dir ?? defaultSchemasDir()).validator(schemaId);
}
