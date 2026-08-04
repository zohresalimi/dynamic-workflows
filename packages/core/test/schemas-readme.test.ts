/**
 * KAR-02.8 — `packages/core/README.md` lists every shipped `schemaId` and
 * states the append-only rule (EPIC-02 acceptance).
 *
 * A README that lists seven of eight ids is worse than no README: it is the
 * one place a reader will trust without checking. So the list is asserted
 * against the registry rather than reviewed.
 */

import { readFileSync } from 'node:fs';
import { expect, it, describe as suite } from 'vitest';
import { REGISTERED_SCHEMA_IDS } from '../src/json-schema.ts';

const readme = (): string =>
  readFileSync(new URL('../README.md', import.meta.url).pathname, 'utf8');

suite('packages/core/README.md', () => {
  it('names every registered schemaId', () => {
    const text = readme();
    for (const schemaId of REGISTERED_SCHEMA_IDS) expect(text, schemaId).toContain(schemaId);
  });

  it('states the append-only rule in the terms the epic uses', () => {
    const text = readme();
    expect(text).toContain('append-only');
    expect(text).toMatch(/\.v2\b/);
    expect(text).toContain('pnpm schemas:emit');
    expect(text).toContain('pnpm schemas:check');
  });
});
