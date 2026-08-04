/**
 * KAR-02.2 — parses a realistic, hand-written `TaskSpec` fixture.
 *
 * Verifies: EPIC-02-S7 (well-formed baseline) · AC1
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { TaskSpecSchema } from '../src/task-spec.ts';

const fixturePath = fileURLToPath(new URL('./fixtures/specs/vue3-migration.json', import.meta.url));
const specFixture: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'));

suite('TaskSpecSchema — fixture', () => {
  it('parses a realistic, hand-written TaskSpec', () => {
    const result = TaskSpecSchema.safeParse(specFixture);
    expect(result.success).toBe(true);
  });
});
