/**
 * KAR-08.1 AC8 / EPIC-08-S5 scenario 2 — the permission shapes DeFlow puts on
 * the wire, held against the vendored ACP schema with ajv.
 *
 * There is no official ACP conformance kit (see @DeFlow/testkit's
 * acp-conformance.ts for the verified negative). What there is, is
 * `@agentclientprotocol/sdk@1.3.0`'s `schema/schema.json`, and it is free to
 * check against — so the four `PermissionOptionKind` values and both arms of
 * `RequestPermissionOutcome` are held to it rather than to a copy of the union
 * typed out by hand. A hand-typed copy is exactly the thing that survives an
 * SDK bump looking correct.
 *
 * The `cancelled` arm is checked as carefully as the `selected` one because it
 * is the arm implementations forget: it carries **no** `optionId`, and an
 * agent whose client destructures one unconditionally wedges the node.
 *
 * Verifies: EPIC-08-S5 (scenario 2), EPIC-08-S6 · AC8
 */
import { OFFERED_PERMISSION_OPTIONS, PERMISSION_OPTION_KINDS } from '@DeFlow/core';
import { acpSchema } from '@DeFlow/testkit';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import { expect, it, describe as suite } from 'vitest';

const ajv = new Ajv2020.default({ allErrors: true, strict: false, logger: false });
ajv.addSchema(acpSchema(), 'acp');

const validatorFor = (definition: string): ValidateFunction =>
  ajv.compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: `acp#/$defs/${definition}`,
  });

const explain = (validate: ValidateFunction): string =>
  (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message ?? ''}`).join('; ');

suite('the four option kinds are the SDK’s four', () => {
  it('matches PermissionOptionKind exactly, in the schema’s own set', () => {
    // The `$def` is a `oneOf` of `const` arms rather than an `enum` — the
    // schema is generated from Rust types, and each arm carries its own doc
    // comment. Read the arms rather than restating the four values, or this
    // test is a copy of the thing it is checking.
    const definition = (acpSchema().$defs as Record<string, { oneOf?: { const?: unknown }[] }>)[
      'PermissionOptionKind'
    ];
    const kinds = (definition?.oneOf ?? []).map((arm) => arm.const);
    expect(kinds.length, 'PermissionOptionKind is no longer a oneOf in the SDK').toBe(4);
    expect([...kinds].sort()).toEqual([...PERMISSION_OPTION_KINDS].sort());
  });

  it('offers one option of each kind, and every one is schema-valid', () => {
    const validate = validatorFor('PermissionOption');
    expect(OFFERED_PERMISSION_OPTIONS.map((option) => option.kind)).toEqual([
      ...PERMISSION_OPTION_KINDS,
    ]);
    for (const option of OFFERED_PERMISSION_OPTIONS) {
      expect(validate(option), `${option.optionId}: ${explain(validate)}`).toBe(true);
    }
  });

  it('rejects an invented kind, so the check above is not vacuous', () => {
    const validate = validatorFor('PermissionOption');
    expect(validate({ optionId: 'x', name: 'X', kind: 'allow_sometimes' })).toBe(false);
  });
});

suite('both arms of the outcome DeFlow responds with are schema-valid', () => {
  const validate = validatorFor('RequestPermissionResponse');

  it('the selected arm', () => {
    const frame = { outcome: { outcome: 'selected', optionId: 'allow_once' } };
    expect(validate(frame), explain(validate)).toBe(true);
  });

  it('the cancelled arm, which carries no optionId', () => {
    const frame = { outcome: { outcome: 'cancelled' } };
    expect(validate(frame), explain(validate)).toBe(true);
  });

  it('rejects a selected outcome with no optionId', () => {
    expect(validate({ outcome: { outcome: 'selected' } })).toBe(false);
  });

  it('rejects an outcome the union does not have', () => {
    expect(validate({ outcome: { outcome: 'deferred' } })).toBe(false);
  });
});
