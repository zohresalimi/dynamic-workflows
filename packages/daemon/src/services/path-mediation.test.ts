/**
 * KAR-08.2 — the four escape routes, decided on the resolved path.
 *
 * The ladder's containment check (@DeFlow/core's `decidePermission`) is
 * lexical, because @DeFlow/core may not touch a filesystem. This is the half
 * that can: it resolves the agent's string against the node's worktree,
 * `realpath`s the deepest existing ancestor, and applies the ladder to the
 * result.
 *
 * The filesystem is a port here rather than a real tmpdir, so this stays in
 * the unit slice and so the lexically-inside / realpath-outside case can be
 * constructed *exactly* — one symlink, no ambient state. The same routes are
 * then re-proved against real symlinks on a real filesystem in
 * ../../test/integration/fs-mediation.test.ts, because a port double can
 * always be wrong about what `realpath` does.
 *
 * Verifies: EPIC-08-S7, EPIC-08-S8, EPIC-08-S9, EPIC-08-S10 · AC1–AC5, AC7
 */
import { NodeIdSchema, PermissionDeniedSchema, type PermissionScope } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import {
  createPathMediator,
  type PathFs,
  type PathMediation,
  permissionDeniedPayload,
} from './path-mediation.ts';

const WORKTREE = '/wt';
const HOME = '/home/agent';

const SCOPE: PermissionScope = {
  worktree: WORKTREE,
  allowlist: ['git', 'pnpm'],
  readOnlyCommands: ['git status'],
  allowedDomains: [],
};

/**
 * A filesystem that knows exactly which paths exist and what each one really
 * is. Anything not named here does not exist, which is what makes "the
 * deepest existing ancestor" a statement the test controls rather than
 * discovers.
 */
function fs(real: Readonly<Record<string, string>> = { [WORKTREE]: WORKTREE }): PathFs {
  return {
    realpath: (path) => {
      const answer = real[path];
      if (answer === undefined) {
        const error = new Error(`ENOENT: no such file or directory, realpath '${path}'`);
        return Promise.reject(Object.assign(error, { code: 'ENOENT' }));
      }
      return Promise.resolve(answer);
    },
    sameEntry: () => Promise.resolve(false),
  };
}

function mediator(
  options: {
    readonly level?: 'read' | 'worktree' | 'worktree+net' | 'full';
    readonly real?: Readonly<Record<string, string>>;
    readonly caseInsensitive?: boolean;
  } = {},
) {
  return createPathMediator({
    level: options.level ?? 'worktree',
    scope: SCOPE,
    fs: fs(options.real),
    home: HOME,
    caseInsensitive: options.caseInsensitive ?? false,
  });
}

/** The renderable `code:detail` pair, or `allow`. */
function verdict(mediation: PathMediation): string {
  if (mediation.outcome === 'allow') return 'allow';
  const { code, detail } = mediation.denial.reason;
  return detail === undefined ? code : `${code}:${detail}`;
}

suite('EPIC-08-S7 — traversal is decided on the resolved path', () => {
  it.each([
    '../../etc/passwd',
    'src/../../../etc/passwd',
    './src/./../../outside.txt',
    'src/sub/../../../../tmp/x',
  ])('denies %s as path-escape:traversal', async (requested) => {
    const result = await mediator().mediate('fs/write_text_file', requested);

    expect(verdict(result)).toBe('path-escape:traversal');
    expect(result.outcome === 'deny' && result.denial.requested).toBe(requested);
  });

  it('allows harmless dot segments and answers with the resolved path', async () => {
    const result = await mediator().mediate('fs/write_text_file', 'src/./sub/../a.ts');

    expect(result).toEqual({ outcome: 'allow', path: '/wt/src/a.ts' });
  });

  it('never answers with the agent’s own string when it differs from the resolution', async () => {
    // The quiet failure S7 names: decide on the resolved path, then write the
    // raw one, and the entire class is back.
    const result = await mediator().mediate('fs/write_text_file', './src/../src/a.ts');

    expect(result.outcome === 'allow' && result.path).toBe('/wt/src/a.ts');
  });

  it('denies a path carrying a NUL byte rather than handing it to the filesystem', async () => {
    // The poison-NUL trick: every C-level filesystem API stops at the NUL,
    // so the path the kernel sees is not the path the check read.
    const result = await mediator().mediate('fs/write_text_file', 'src/a.ts\u0000.png');

    expect(verdict(result)).toBe('path-escape:invalid');
  });

  it('denies the empty path', async () => {
    expect(verdict(await mediator().mediate('fs/write_text_file', ''))).toBe('path-escape:invalid');
  });
});

suite('EPIC-08-S8 — realpath, not just resolve', () => {
  it('denies a write through a symlink that leaves the worktree', async () => {
    const result = await mediator({
      real: { [WORKTREE]: WORKTREE, '/wt/link': '/outside' },
    }).mediate('fs/write_text_file', '/wt/link/x.txt');

    expect(verdict(result)).toBe('path-escape:symlink');
  });

  it('denies the lexically-inside, realpath-outside case', async () => {
    const under = mediator({ real: { [WORKTREE]: WORKTREE, '/wt/a': '/etc' } });

    // path.resolve() alone reports this as inside the worktree…
    expect('/wt/a/passwd'.startsWith(`${WORKTREE}/`)).toBe(true);
    // …and the realpath check reports it as outside.
    expect(verdict(await under.mediate('fs/write_text_file', '/wt/a/passwd'))).toBe(
      'path-escape:symlink',
    );
  });

  it('allows a symlink that stays inside', async () => {
    const result = await mediator({
      real: { [WORKTREE]: WORKTREE, '/wt/inner': '/wt/src' },
    }).mediate('fs/write_text_file', '/wt/inner/a.ts');

    expect(result).toEqual({ outcome: 'allow', path: '/wt/inner/a.ts' });
  });

  it('allows a path whose parent does not exist yet, checking the deepest existing ancestor', async () => {
    const result = await mediator().mediate('fs/write_text_file', '/wt/new/dir/a.ts');

    expect(result).toEqual({ outcome: 'allow', path: '/wt/new/dir/a.ts' });
  });

  it('applies the check to the ancestor that exists, not to the one that does not', async () => {
    // `/wt/link` is the deepest existing ancestor of `/wt/link/new/deep/a.ts`,
    // and it points out. Skipping the check for not-yet-existing files is the
    // tempting fix that reopens the hole.
    const result = await mediator({
      real: { [WORKTREE]: WORKTREE, '/wt/link': '/outside' },
    }).mediate('fs/write_text_file', '/wt/link/new/deep/a.ts');

    expect(verdict(result)).toBe('path-escape:symlink');
  });

  it('resolves the worktree root itself, so a symlinked worktree is not an escape', async () => {
    // `<tmp>` is a symlink to `/private/<tmp>` on macOS: comparing a realpath'd
    // target against a non-realpath'd root denies every legitimate write.
    const under = createPathMediator({
      level: 'worktree',
      scope: { ...SCOPE, worktree: '/var/wt' },
      fs: fs({ '/var/wt': '/private/var/wt', '/var/wt/src': '/private/var/wt/src' }),
      home: HOME,
      caseInsensitive: false,
    });

    expect(await under.mediate('fs/write_text_file', 'src/a.ts')).toEqual({
      outcome: 'allow',
      path: '/var/wt/src/a.ts',
    });
  });
});

suite('EPIC-08-S9 — absolute paths', () => {
  it('denies an absolute path outside the worktree', async () => {
    expect(verdict(await mediator().mediate('fs/write_text_file', '/etc/hosts'))).toBe(
      'path-escape:absolute',
    );
  });

  it('allows an absolute path inside the worktree', async () => {
    expect(await mediator().mediate('fs/write_text_file', '/wt/src/a.ts')).toEqual({
      outcome: 'allow',
      path: '/wt/src/a.ts',
    });
  });

  it('does not treat a sibling directory sharing a prefix as inside', async () => {
    expect(verdict(await mediator().mediate('fs/write_text_file', '/wt-other/a.ts'))).toBe(
      'path-escape:absolute',
    );
  });

  it('evaluates containment case-insensitively where the filesystem does', async () => {
    const under = createPathMediator({
      level: 'worktree',
      scope: SCOPE,
      fs: fs({ [WORKTREE]: WORKTREE, '/WT': WORKTREE }),
      home: HOME,
      caseInsensitive: true,
    });

    expect(await under.mediate('fs/write_text_file', '/WT/src/a.ts')).toEqual({
      outcome: 'allow',
      path: '/WT/src/a.ts',
    });
  });

  it('evaluates containment case-sensitively where the filesystem does', async () => {
    expect(verdict(await mediator().mediate('fs/write_text_file', '/WT/src/a.ts'))).toBe(
      'path-escape:absolute',
    );
  });
});

suite('EPIC-08-S10 — a read node cannot exfiltrate through fs/read_text_file', () => {
  it('denies the user’s cloud credentials, expanded from the shell’s own ~', async () => {
    const result = await mediator({ level: 'read' }).mediate(
      'fs/read_text_file',
      '~/.aws/credentials',
    );

    expect(verdict(result)).toBe('path-escape:absolute');
    // A `~` that resolved to a directory *inside* the worktree would be an
    // allow, which is the one wrong answer available here.
    expect(result.outcome === 'deny' && result.denial.requested).toBe('~/.aws/credentials');
  });

  it.each([
    ['read', '~/.ssh/id_ed25519'],
    ['worktree', '~/.aws/credentials'],
    ['worktree+net', '~/.config/gh/hosts.yml'],
    ['worktree+net', '~/.claude/.credentials.json'],
  ] as const)('denies %s reading %s', async (level, path) => {
    const result = await mediator({ level }).mediate('fs/read_text_file', path);

    expect(result.outcome).toBe('deny');
  });

  it('allows a read inside the worktree, which is the whole point of the level', async () => {
    expect(await mediator({ level: 'read' }).mediate('fs/read_text_file', '/wt/src/a.ts')).toEqual({
      outcome: 'allow',
      path: '/wt/src/a.ts',
    });
  });

  it('denies a read-level write inside the worktree with the level’s reason, not the path’s', async () => {
    // KAR-08.1's pinned ordering, re-proved through the mediator: the level
    // decides before the path does, or the reason code becomes a function of
    // which path the agent happened to try.
    expect(
      verdict(await mediator({ level: 'read' }).mediate('fs/write_text_file', 'src/a.ts')),
    ).toBe('level-read');
    expect(
      verdict(await mediator({ level: 'read' }).mediate('fs/write_text_file', '../../etc/passwd')),
    ).toBe('level-read');
  });

  it('still contains a full-level write, because full is not "write anywhere"', async () => {
    expect(
      verdict(await mediator({ level: 'full' }).mediate('fs/write_text_file', '/etc/hosts')),
    ).toBe('path-escape:absolute');
  });
});

suite('AC7 — the denial a node inspector renders', () => {
  it('is structured, and carries the level, the method, the path and the code', async () => {
    const result = await mediator({ level: 'worktree' }).mediate(
      'fs/write_text_file',
      '../../etc/passwd',
    );
    if (result.outcome !== 'deny') throw new Error('expected a denial');
    const payload = permissionDeniedPayload(result.denial, {
      node: NodeIdSchema.parse('n1'),
      attempt: 0,
    });

    // The §9 schema is what the ledger will hold it to, so hold it to the same
    // thing here rather than to a snapshot alone.
    expect(PermissionDeniedSchema.parse(payload)).toEqual(payload);
    expect(
      permissionDeniedPayload(result.denial, { node: NodeIdSchema.parse('n1'), attempt: 0 }),
    ).toMatchInlineSnapshot(`
      {
        "attempt": 0,
        "method": "fs/write_text_file",
        "node": "n1",
        "permission": "worktree",
        "reason": {
          "code": "path-escape",
          "detail": "traversal",
        },
        "requested": "../../etc/passwd",
      }
    `);
  });
});
