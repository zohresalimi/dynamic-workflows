/**
 * KAR-04.2 AC7 — the scenario library validates against its own JSON Schema.
 *
 * Two independent readers of the same format exist on purpose. The binary
 * carries a hand-written parser, because `packages/mock-agent` ships one
 * dependency and ajv is not it. The suite carries the schema, because a
 * published schema is what makes a scenario file writable by someone who has
 * not read `src/scenario.ts`.
 *
 * Two readers only help if they agree, so this file asserts both directions:
 * every shipped scenario passes both, and a set of deliberately broken ones is
 * rejected by both. A schema that quietly drifted looser than the parser would
 * bless a file the binary then refuses at spawn time, which is the mysterious
 * empty turn AC7 exists to prevent.
 *
 * Verifies: KAR-04.2 · AC7
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { expect, it, describe as suite } from 'vitest';
import { parseScenario } from '../src/scenario.ts';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const scenarioDir = join(packageRoot, 'scenarios');
const schemaPath = join(packageRoot, 'schema', 'mock-scenario.v1.json');

const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;
// strict: false because the schema is written for publication, not for ajv:
// it carries $comment and title everywhere, and strict mode objects to a few
// of those in a way that says nothing about whether a scenario is valid.
const validate = new Ajv2020.default({ allErrors: true, strict: false }).compile(schema);

const scenarioFiles = readdirSync(scenarioDir)
  .filter((name) => name.endsWith('.jsonc') || name.endsWith('.json'))
  .sort();

suite('AC7 — the scenario library lives in one directory', () => {
  it('has scenario files in it', () => {
    // A glob that matched nothing would make every assertion below vacuous.
    expect(scenarioFiles.length).toBeGreaterThanOrEqual(5);
  });

  it('declares the 2020-12 dialect and an $id', () => {
    expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(typeof schema.$id).toBe('string');
  });
});

suite.each(scenarioFiles)('AC7 — %s', (name) => {
  const text = readFileSync(join(scenarioDir, name), 'utf8');

  it('parses with the binary’s own parser', () => {
    const parsed = parseScenario(text, name);
    expect(parsed.ok ? '' : parsed.message).toBe('');
  });

  it('validates against the published schema', () => {
    const parsed = parseScenario(text, name);
    // The schema validates the *data*, so it is fed the comment-stripped value
    // the parser produced rather than the raw JSONC text.
    expect(validate(parsed.ok ? parsed.value : {})).toBe(true);
    expect(validate.errors ?? []).toEqual([]);
  });

  it('points at the schema with $schema, so an editor can help', () => {
    expect(text).toContain('$schema');
  });
});

/** Each of these breaks the format in a way a real typo would. */
const brokenScenarios: ReadonlyArray<readonly [string, unknown]> = [
  ['an unknown step type', { steps: [{ type: 'chunkz' }] }],
  ['a misspelled delay key', { steps: [{ type: 'chunks', count: 2, delayMS: 50 }] }],
  ['a count of zero', { steps: [{ type: 'chunks', count: 0 }] }],
  [
    'a tool call status ACP does not define',
    {
      steps: [
        { type: 'toolCall', title: 't', toolKind: 'read', path: '/a', statuses: ['running'] },
      ],
    },
  ],
  [
    'a tool call with no location path',
    { steps: [{ type: 'toolCall', title: 't', toolKind: 'read', statuses: ['pending'] }] },
  ],
  ['a client method that does not exist', { steps: [{ type: 'clientCall', method: 'fs/rm' }] }],
  ['a stop reason outside the union', { steps: [], stopReason: 'finished' }],
  ['no steps at all', { name: 'nothing' }],
];

suite.each(brokenScenarios)('AC7 — %s is rejected', (_label, value) => {
  const text = JSON.stringify(value);

  it('by the schema', () => {
    expect(validate(value)).toBe(false);
  });

  it('and by the parser', () => {
    expect(parseScenario(text).ok).toBe(false);
  });
});
