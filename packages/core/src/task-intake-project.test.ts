/**
 * KAR-22.1 AC7 — a run knows which project it belongs to, and a run from before
 * projects existed is still readable.
 *
 * `projectId` rides on `task.submitted`'s provenance beside `cwd`, and it is
 * **optional for exactly the reason `cwd` is optional** (see `./task-intake.ts`'s
 * own note): payloads already on disk do not have it, and a required field would
 * make every run submitted before this story unparseable. That is the one thing
 * a ledger may never do to its own history, and it is cheap to assert and
 * expensive to discover.
 *
 * Unit, because both halves are properties of a schema and a pure normaliser.
 * The wire half — a 400 for a project id nothing holds — is
 * `packages/daemon/test/integration/run-project-id.test.ts`'s.
 *
 * Verifies: EPIC-22-S15 (the payload clause), EPIC-22-S16 · KAR-22.1 AC7 ·
 * test plan #13, #15
 */
import { expect, it, describe as suite } from 'vitest';
import type { Handle } from './ids.ts';
import { normaliseInput, TaskSubmittedSchema } from './task-intake.ts';

const NOW = 1_755_000_000_000;
const PROJECT = 'prj_20260815T101112Z_a1b2c3';

const store = (): Handle => {
  throw new Error('this spec never exceeds the inline threshold');
};

suite('EPIC-22-S15 — a submitted task carries its project id', () => {
  it('records projectId on the provenance of every intake shape', async () => {
    const text = await normaliseInput(
      { kind: 'text', text: 'migrate the checkout module' },
      { now: NOW, by: 'ui', store, cwd: '/repo', projectId: PROJECT },
    );
    expect(text.provenance).toMatchObject({ kind: 'text', cwd: '/repo', projectId: PROJECT });

    const file = await normaliseInput(
      {
        kind: 'file',
        bytes: new TextEncoder().encode('a spec document'),
        resolvedPath: '/repo/spec.md',
        mediaType: 'text/markdown',
      },
      { now: NOW, by: 'ui', store, cwd: '/repo', projectId: PROJECT },
    );
    expect(file.provenance).toMatchObject({ kind: 'file', projectId: PROJECT });

    const issue = await normaliseInput(
      {
        kind: 'issue',
        raw: '{"title":"a bug"}',
        url: 'https://example.invalid/issues/1',
        resolver: 'gh',
        httpStatus: 200,
      },
      { now: NOW, by: 'ui', store, cwd: '/repo', projectId: PROJECT },
    );
    expect(issue.provenance).toMatchObject({ kind: 'issue', projectId: PROJECT });
  });

  it('leaves the field off entirely rather than writing an empty string', async () => {
    const payload = await normaliseInput(
      { kind: 'text', text: 'no project' },
      { now: NOW, by: 'cli', store, cwd: '/repo' },
    );
    expect('projectId' in payload.provenance).toBe(false);
  });
});

suite('EPIC-22-S16 — a run submitted before projects existed is still readable', () => {
  it('parses a payload whose provenance carries no projectId', () => {
    const parsed = TaskSubmittedSchema.parse({
      sha256: 'a'.repeat(64),
      raw: 'the three runs of 2026-08-12',
      provenance: { kind: 'text', by: 'cli', submittedAt: NOW },
    });
    expect(parsed.provenance.kind).toBe('text');
    expect('projectId' in parsed.provenance).toBe(false);
  });

  it('parses one that carries neither cwd nor projectId', () => {
    const parsed = TaskSubmittedSchema.parse({
      sha256: 'b'.repeat(64),
      raw: 'older still',
      provenance: {
        kind: 'file',
        by: 'cli',
        submittedAt: NOW,
        resolvedPath: '/repo/spec.md',
        bytes: 11,
        mediaType: 'text/markdown',
      },
    });
    expect(parsed.provenance.kind).toBe('file');
  });

  it('refuses a projectId that is the empty string, which is not "absent"', () => {
    expect(() =>
      TaskSubmittedSchema.parse({
        sha256: 'c'.repeat(64),
        raw: 'x',
        provenance: { kind: 'text', by: 'ui', submittedAt: NOW, projectId: '' },
      }),
    ).toThrow();
  });
});
