#!/usr/bin/env node
/**
 * Validates every recorded frame against the ACP wire schema.
 *
 *   node spikes/s1-acp/verify-recording.ts recordings/<agent>@<v>/full-cycle.ndjson
 *
 * There is **no official ACP conformance kit** — that is a verified negative,
 * and web search asserts otherwise by conflating ACP with an unrelated
 * academic protocol of the same abbreviation. The `schema/schema.json` shipped
 * inside `@agentclientprotocol/sdk@1.3.0` (262 `$defs`) plus `ajv` is
 * therefore the only conformance signal that exists, and it is nearly free.
 *
 * Each frame is checked twice: against the top-level envelope, and — where the
 * method is one of the six the cycle uses — against that method's own `$def`,
 * which is much stricter than the envelope's `anyOf`.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFrames, readRecording } from './src/recording.ts';

const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020') as typeof import('ajv/dist/2020').default;
// The SDK's `exports` map does not expose `package.json`; `schema/schema.json`
// is one of only two non-entry subpaths it does expose, so the package root —
// and with it the exact version this run validated against — is derived from
// the schema's own resolved path.
const schemaPath = require.resolve('@agentclientprotocol/sdk/schema/schema.json');
const sdkVersion = (
  JSON.parse(readFileSync(join(dirname(dirname(schemaPath)), 'package.json'), 'utf8')) as {
    version: string;
  }
).version;
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
  $defs: Record<string, unknown>;
};

const path = process.argv[2];
if (path === undefined) {
  console.error('usage: node spikes/s1-acp/verify-recording.ts <recording.ndjson>');
  process.exit(2);
}

// `strict: false`: the schema uses `discriminator` and a handful of `x-*`
// vendor keywords that ajv would otherwise reject outright. Turning them into
// errors would mean validating nothing at all, which is worse than validating
// against the schema as the SDK actually ships it.
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: false });
const validateEnvelope = ajv.compile(schema);

/** Method → the `$def` its params (request) or result (response) must match. */
const PARAMS_DEFS: Record<string, string> = {
  initialize: 'InitializeRequest',
  'session/new': 'NewSessionRequest',
  'session/prompt': 'PromptRequest',
  'session/cancel': 'CancelNotification',
  'session/update': 'SessionNotification',
  'session/request_permission': 'RequestPermissionRequest',
};

const RESULT_DEFS: Record<string, string> = {
  initialize: 'InitializeResponse',
  'session/new': 'NewSessionResponse',
  'session/prompt': 'PromptResponse',
};

// The root schema is an `anyOf` over every message shape, which is a weak
// check. Compiling a `$def` on its own — carrying `$defs` so its internal
// `$ref`s still resolve, but *not* the root `anyOf` — is what makes the second
// pass stricter than the first rather than a duplicate of it.
const defValidator = (name: string) =>
  ajv.compile({ $defs: schema.$defs, ...(schema.$defs[name] as object) });

const frames = readFrames(readRecording(path));
const invalid: { line: number; errors: string }[] = [];
/** Correlates a response back to the method that asked for it. */
const methodOf = new Map<string, string>();

frames.forEach((frame, index) => {
  const message = frame.json as {
    id?: number | string;
    method?: string;
    params?: unknown;
    result?: unknown;
  };
  if (!validateEnvelope(message)) {
    invalid.push({ line: index, errors: ajv.errorsText(validateEnvelope.errors) });
    return;
  }
  if (message.method !== undefined) {
    if (message.id !== undefined) methodOf.set(String(message.id), message.method);
    const def = PARAMS_DEFS[message.method];
    if (def !== undefined) {
      const validate = defValidator(def);
      if (!validate(message.params)) {
        invalid.push({ line: index, errors: `${def}: ${ajv.errorsText(validate.errors)}` });
      }
    }
    return;
  }
  if (message.result !== undefined && message.id !== undefined) {
    const def = RESULT_DEFS[methodOf.get(String(message.id)) ?? ''];
    if (def !== undefined) {
      const validate = defValidator(def);
      if (!validate(message.result)) {
        invalid.push({ line: index, errors: `${def}: ${ajv.errorsText(validate.errors)}` });
      }
    }
  }
});

process.stdout.write(
  `${JSON.stringify(
    {
      recording: path,
      defs: Object.keys(schema.$defs).length,
      frames: frames.length,
      sdk: sdkVersion,
      invalid,
    },
    null,
    2,
  )}\n`,
);
process.exit(invalid.length === 0 ? 0 : 1);
