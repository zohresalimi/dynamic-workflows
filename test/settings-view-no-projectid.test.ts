/**
 * KAR-25.2 AC1, EPIC-25-S09 — `/settings` never reads a `projectId`.
 *
 * Verifies: EPIC-25-S09
 *
 * The scenario is about the file's own text — "the settings view's source is
 * read" — not about what renders, so this checks the text directly rather
 * than mounting the component. Modelled on `./no-workspace-word.test.ts`:
 * `webSourceFiles()`/`stripComments()` already exist for exactly this shape
 * of rule, and `packages/web/src/views/SettingsView.vue`'s own browser
 * project has no `node:fs` to read itself with, so a source-reading spec for
 * it belongs here, in the `unit` project, rather than beside its
 * behavioural specs in `packages/web/src/views/settings.test.ts`.
 */
import { expect, it, describe as suite } from 'vitest';
import { stripComments, webSourceFiles } from '../packages/web/scripts/check-graph-facade.ts';

const source = stripComments(
  webSourceFiles().find((file) => file.path === 'src/views/SettingsView.vue')?.text ?? '',
);

suite('EPIC-25-S09 — settings never reads a projectId', () => {
  it('has a file to check, so a passing rule is not a rule over nothing', () => {
    expect(source.length).toBeGreaterThan(200);
  });

  it('declares no projectId prop', () => {
    expect(source).not.toMatch(/defineProps/);
  });

  it('reads no projectId route param, and imports no router', () => {
    expect(source).not.toMatch(/useRoute\s*\(/);
    expect(source).not.toMatch(/\bprojectId\b/);
    expect(source).not.toMatch(/from ['"]vue-router['"]/);
  });

  it('makes no request to a path with a project segment', () => {
    expect(source).not.toMatch(/\/projects\/[:$]/);
  });
});
