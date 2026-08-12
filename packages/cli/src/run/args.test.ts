/**
 * KAR-18.3 AC7, AC8 — `DeFlow run`'s argv: the four F1.1 sources, and the
 * flags that change what the command *is* rather than what it says.
 *
 * The four sources are the interesting half. F1.1 is "free text, a file, a git
 * issue reference, or a spec document", and KAR-10.1 settled that the wire has
 * **three** shapes rather than four — *"a spec document is the `file` kind with
 * its own `mediaType` in provenance; there is no fourth shape"*
 * (@DeFlow/core's task-intake.ts). So `--spec` resolves onto the `file` kind
 * and the operator's own word for it is carried beside it, which is what lets
 * a refusal say `--spec` when that is what was typed.
 *
 * Verifies: EPIC-18-S24, EPIC-18-S25 · AC7, AC8
 */
import { expect, it, describe as suite } from 'vitest';
import { parseRunArgs } from './args.ts';

const ok = (argv: readonly string[]): ReturnType<typeof parseRunArgs> => {
  const parsed = parseRunArgs(argv);
  expect(parsed.ok, parsed.ok ? '' : parsed.message).toBe(true);
  return parsed;
};

suite('the four F1.1 sources (AC8)', () => {
  it('free text is the bare argument', () => {
    const parsed = ok(['migrate the button to v3']);
    expect(parsed.ok && parsed.args.source).toBe('text');
    expect(parsed.ok && parsed.args.input).toEqual({
      kind: 'text',
      text: 'migrate the button to v3',
    });
  });

  it('--file carries the locator, never the content', () => {
    const parsed = ok(['--file', 'docs/task.md']);
    expect(parsed.ok && parsed.args.source).toBe('file');
    expect(parsed.ok && parsed.args.input).toEqual({ kind: 'file', path: 'docs/task.md' });
  });

  it('--issue is its own kind, and a full URL passes through untouched', () => {
    const parsed = ok(['--issue', 'https://github.com/acme/web/issues/412']);
    expect(parsed.ok && parsed.args.source).toBe('issue');
    expect(parsed.ok && parsed.args.input).toEqual({
      kind: 'issue',
      url: 'https://github.com/acme/web/issues/412',
    });
  });

  it('expands the owner/repo#n shorthand, because the resolver takes URLs', () => {
    const parsed = ok(['--issue', 'acme/web#412']);
    expect(parsed.ok && parsed.args.input).toEqual({
      kind: 'issue',
      url: 'https://github.com/acme/web/issues/412',
    });
  });

  it('--spec is the file kind, and remembers it was typed as --spec', () => {
    const parsed = ok(['--spec', '.DeFlow/specs/x.md']);
    expect(parsed.ok && parsed.args.source).toBe('spec');
    expect(parsed.ok && parsed.args.input).toEqual({ kind: 'file', path: '.DeFlow/specs/x.md' });
  });

  it('accepts --file=<path> as well as --file <path>', () => {
    expect(ok(['--file=docs/task.md']).ok && parseRunArgs(['--file=docs/task.md'])).toMatchObject({
      ok: true,
      args: { input: { kind: 'file', path: 'docs/task.md' } },
    });
  });

  it('refuses two sources rather than picking one', () => {
    const parsed = parseRunArgs(['--file', 'a.md', '--issue', 'o/r#1']);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.message).toContain('one source');
  });

  it('refuses a bare argument beside a source flag', () => {
    const parsed = parseRunArgs(['--file', 'a.md', 'and also this text']);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.message).toContain('one source');
  });

  it('refuses a source flag with nothing after it', () => {
    const parsed = parseRunArgs(['--file']);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.message).toContain('--file needs a path');
  });

  it('refuses no source at all, and says what one looks like', () => {
    const parsed = parseRunArgs([]);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.message).toContain('DeFlow run "<task>"');
  });
});

suite('--attach: watching a run somebody else started (AC3)', () => {
  it('takes a run id and submits nothing', () => {
    const parsed = ok(['--attach', 'run_20260810T101500Z_c4a5b1']);
    expect(parsed.ok && parsed.args.attach).toBe('run_20260810T101500Z_c4a5b1');
    expect(parsed.ok && parsed.args.input).toBeNull();
  });

  it('refuses --attach beside a task, because only one of them can be true', () => {
    const parsed = parseRunArgs(['--attach', 'run_20260810T101500Z_c4a5b1', 'do a thing']);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.message).toContain('--attach');
  });

  it('refuses a run id that is not one', () => {
    const parsed = parseRunArgs(['--attach', 'yesterday']);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.message).toContain('run id');
  });
});

suite('the flags that change the contract (AC6, AC7)', () => {
  it('--json and --no-wait default to off', () => {
    const parsed = ok(['a task']);
    expect(parsed.ok && parsed.args.json).toBe(false);
    expect(parsed.ok && parsed.args.noWait).toBe(false);
  });

  it('reads --json, --no-wait and --permission', () => {
    const parsed = ok(['--json', '--no-wait', '--permission', 'read', 'a task']);
    expect(parsed.ok && parsed.args).toMatchObject({
      json: true,
      noWait: true,
      permission: 'read',
    });
  });

  it('defaults the permission to worktree, the same default the HTTP route takes', () => {
    expect(ok(['a task']).ok && parseRunArgs(['a task'])).toMatchObject({
      args: { permission: 'worktree' },
    });
  });

  it('refuses a permission level that is not one of the ladder', () => {
    const parsed = parseRunArgs(['--permission', 'root', 'a task']);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.message).toContain('--permission');
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    const parsed = parseRunArgs(['--detach', 'a task']);
    expect(parsed.ok).toBe(false);
    expect(!parsed.ok && parsed.message).toContain('--detach');
  });

  it('treats everything after -- as text, so a task may start with a dash', () => {
    const parsed = ok(['--', '--not-a-flag, an actual task']);
    expect(parsed.ok && parsed.args.input).toEqual({
      kind: 'text',
      text: '--not-a-flag, an actual task',
    });
  });
});
