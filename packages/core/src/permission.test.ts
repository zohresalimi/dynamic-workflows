/**
 * KAR-08.1 — the four-level ladder as one pure function.
 *
 * EPIC-08-S1 and EPIC-08-S2 are scenario outlines and they are transcribed
 * here as tables, cell for cell, because that is what they are: the truth
 * table of `decidePermission` lifted straight out of
 * docs/09-workspace-and-safety.md §8.1. A cell that disagrees with the
 * document is a failing row with the level, the request and both decisions in
 * its name.
 *
 * Two orderings are pinned rather than left to fall out of the implementation,
 * because both are load-bearing and neither is obvious:
 *
 *   - **The level decides before the path does.** A `read` node's write is
 *     denied `level-read` even for a path inside its own worktree
 *     (EPIC-08-S1 scenario 2). Implement `read` as "worktree minus network"
 *     and the reason code becomes `path-escape` for paths outside and `allow`
 *     for paths inside — which is a different, wrong ladder that passes a
 *     careless reading of the table.
 *   - **The syntactic layer decides before the network row does.** EPIC-08-S2
 *     says `worktree` + `curl https://example.com` is *deny* (`level-no-network`)
 *     while EPIC-08-S14 says `worktree` + `psql postgres://db.prod/main` is
 *     *gate*. Both are egress at the same level, so the only reading that
 *     satisfies both is that the identity/infrastructure-boundary checks run
 *     first and are orthogonal to the ladder, exactly as EPIC-08-S2's notes say.
 *
 * Verifies: EPIC-08-S1, EPIC-08-S2 · AC1, AC2, AC3
 */
import { expect, it, describe as suite } from 'vitest';
import {
  decidePermission,
  PERMISSION_DENY_CODES,
  PERMISSION_GATE_CODES,
  PERMISSION_OUTCOMES,
  type PermissionRequest,
  type PermissionScope,
  reasonCode,
} from './permission.ts';
import type { PermissionLevel } from './plan-graph.ts';

/** The tmpdir the flow file's `<tmp>` stands for. A literal so the table reads
 * like the scenario outline; nothing here touches a filesystem. */
const TMP = '/tmp/DeFlow-a1b2c3';
const WT = `${TMP}/wt`;

/** EPIC-08-S2's Background: the repository allowlist from `DeFlow.config.ts`
 * and the read-only subset of it. */
const SCOPE: PermissionScope = {
  worktree: WT,
  allowlist: ['git', 'pnpm', 'npm', 'node', 'pytest', 'make', 'cargo', 'go', 'tsc', 'eslint'],
  readOnlyCommands: ['git status', 'git log', 'git diff', 'ls', 'cat'],
  allowedDomains: ['registry.npmjs.org'],
  scrubbedEnv: [],
};

const write = (path: string): PermissionRequest => ({ method: 'fs/write_text_file', path });
const read = (path: string): PermissionRequest => ({ method: 'fs/read_text_file', path });

/** A command line the way the flow file writes it, split the way ACP sends
 * it: `terminal/create` carries `command` and `args` separately. */
function terminal(line: string, cwd = WT): PermissionRequest {
  const [command = '', ...args] = line.split(' ');
  return { method: 'terminal/create', command, args, cwd };
}

suite('the three outcomes are a closed set (AC2)', () => {
  it('is exactly allow, deny and gate', () => {
    expect([...PERMISSION_OUTCOMES]).toEqual(['allow', 'deny', 'gate']);
  });

  it('names every reason code, so a reason is never a prose blob', () => {
    expect([...PERMISSION_DENY_CODES]).toEqual(['level-read', 'level-no-network', 'path-escape']);
    expect([...PERMISSION_GATE_CODES]).toEqual([
      'not-allowlisted',
      'domain-not-allowlisted',
      'destructive-command',
      // KAR-08.3: a command that needs a variable KAR-08.4 removed cannot
      // work, so it is a question rather than a confusing failure.
      'scrubbed-env',
    ]);
  });

  it('renders a reason as code or code:detail, never as a sentence', () => {
    expect(reasonCode({ code: 'path-escape' })).toBe('path-escape');
    expect(reasonCode({ code: 'not-allowlisted', detail: 'rsync' })).toBe('not-allowlisted:rsync');
  });
});

suite('EPIC-08-S1 — fs/write_text_file across the ladder', () => {
  const rows: [PermissionLevel, string, 'allow' | 'deny', string | null][] = [
    ['read', `${WT}/src/a.ts`, 'deny', 'level-read'],
    ['read', `${WT}/README.md`, 'deny', 'level-read'],
    ['read', '/etc/passwd', 'deny', 'level-read'],
    ['worktree', `${WT}/src/a.ts`, 'allow', null],
    ['worktree', `${WT}/nested/deep/b`, 'allow', null],
    ['worktree', '/etc/passwd', 'deny', 'path-escape'],
    ['worktree', `${TMP}/other/c.ts`, 'deny', 'path-escape'],
    ['worktree+net', `${WT}/src/a.ts`, 'allow', null],
    ['worktree+net', '/etc/passwd', 'deny', 'path-escape'],
    // The row people get wrong: `full` is "allow within the worktree", not
    // "allow anything". It relaxes the command and network rows only.
    ['full', `${WT}/src/a.ts`, 'allow', null],
    ['full', '/etc/passwd', 'deny', 'path-escape'],
  ];

  it.for(rows)('%s + write %s -> %s', ([level, path, decision, reason]) => {
    const answer = decidePermission(level, write(path), SCOPE);
    expect(answer.outcome).toBe(decision);
    if (answer.outcome === 'allow') return;
    expect(answer.reason.code).toBe(reason);
  });

  it('read denies a write inside its own worktree, and the reason is the level', () => {
    const answer = decidePermission('read', write(`${WT}/src/a.ts`), SCOPE);

    expect(answer.outcome).toBe('deny');
    if (answer.outcome === 'allow') return;
    // NOT `path-escape`: the level decided before the path did, so the reason
    // a node inspector renders is stable rather than a function of which path
    // the agent happened to try.
    expect(answer.reason.code).toBe('level-read');
  });
});

suite('fs/read_text_file is mediated too — the ladder half of EPIC-08-S10', () => {
  it('allows a read inside the worktree at read level', () => {
    expect(decidePermission('read', read(`${WT}/src/a.ts`), SCOPE).outcome).toBe('allow');
  });

  const outside = ['/etc/passwd', `${TMP}/other/c.ts`, `${WT}/../other/c.ts`];
  const levels: PermissionLevel[] = ['read', 'worktree', 'worktree+net', 'full'];

  it.for(levels)('%s denies a read outside the worktree', (level) => {
    for (const path of outside) {
      const answer = decidePermission(level, read(path), SCOPE);
      expect(answer.outcome, `${level} + ${path}`).toBe('deny');
      if (answer.outcome === 'allow') continue;
      expect(answer.reason.code).toBe('path-escape');
    }
  });
});

suite('EPIC-08-S2 — terminal/create across the ladder', () => {
  const rows: [PermissionLevel, string, 'allow' | 'deny' | 'gate'][] = [
    ['read', 'git status', 'allow'],
    ['read', 'git log --oneline', 'allow'],
    ['read', 'pnpm test', 'deny'],
    ['read', 'git commit -m x', 'deny'],
    ['read', 'curl https://example.com', 'deny'],
    ['worktree', 'pnpm test', 'allow'],
    ['worktree', 'git commit -m x', 'allow'],
    ['worktree', 'terraform destroy', 'gate'],
    ['worktree', 'curl https://example.com', 'deny'],
    ['worktree+net', 'pnpm install', 'allow'],
    ['worktree+net', 'curl https://registry.npmjs.org', 'allow'],
    ['worktree+net', 'curl https://evil.example', 'gate'],
    // `full` means "the provider allows it", not "DeFlow stops looking".
    ['full', 'terraform destroy', 'gate'],
    ['full', 'anything-at-all', 'allow'],
  ];

  it.for(rows)('%s + %s -> %s', ([level, line, decision]) => {
    expect(decidePermission(level, terminal(line), SCOPE).outcome).toBe(decision);
  });

  it('gates an unknown binary by name, so the operator sees what was asked for', () => {
    const answer = decidePermission('worktree', terminal('rsync -av / /backup'), SCOPE);

    expect(answer.outcome).toBe('gate');
    if (answer.outcome !== 'gate') return;
    expect(reasonCode(answer.reason)).toBe('not-allowlisted:rsync');
  });

  it('matches the allowlist on the resolved binary, not the raw string', () => {
    // EPIC-08-S12: `./node_modules/.bin/eslint` is `eslint`, which is on the
    // allowlist; a raw string comparison would gate it.
    const answer = decidePermission('worktree', terminal('./node_modules/.bin/eslint .'), SCOPE);
    expect(answer.outcome).toBe('allow');
  });

  it('denies a cwd outside the worktree even for an allowlisted binary', () => {
    // EPIC-08-S12's third scenario. The command and args get all the
    // attention; an allowlisted `git` with a cwd elsewhere is a full escape
    // with no exotic syntax at all.
    const answer = decidePermission('worktree', terminal('git status', `${TMP}/other`), SCOPE);

    expect(answer.outcome).toBe('deny');
    if (answer.outcome === 'allow') return;
    expect(reasonCode(answer.reason)).toBe('path-escape:cwd');
  });

  it('rejects a non-read-only command at read level, however harmless it looks', () => {
    const answer = decidePermission('read', terminal('pnpm test'), SCOPE);

    expect(answer.outcome).toBe('deny');
    if (answer.outcome === 'allow') return;
    expect(answer.reason.code).toBe('level-read');
  });
});

suite('network is a row of the ladder, not a property of a command', () => {
  const egress: PermissionRequest = { method: 'network', url: 'https://example.com/x' };

  it('denies at read and at worktree without consulting the domain allowlist', () => {
    for (const level of ['read', 'worktree'] as const) {
      const answer = decidePermission(level, egress, SCOPE);
      expect(answer.outcome, level).toBe('deny');
      if (answer.outcome === 'allow') continue;
      expect(answer.reason.code).toBe('level-no-network');
    }
  });

  it('does not consult the allowlist below worktree+net, even for an allowed domain', () => {
    const allowed: PermissionRequest = { method: 'network', url: 'https://registry.npmjs.org/x' };
    const answer = decidePermission('worktree', allowed, SCOPE);

    expect(answer.outcome).toBe('deny');
    if (answer.outcome === 'allow') return;
    expect(answer.reason.code).toBe('level-no-network');
  });

  it('checks the domain allowlist at worktree+net and allows at full', () => {
    expect(
      decidePermission(
        'worktree+net',
        { method: 'network', url: 'https://registry.npmjs.org/pnpm' },
        SCOPE,
      ).outcome,
    ).toBe('allow');

    const gated = decidePermission('worktree+net', egress, SCOPE);
    expect(gated.outcome).toBe('gate');
    if (gated.outcome !== 'gate') return;
    expect(reasonCode(gated.reason)).toBe('domain-not-allowlisted:example.com');

    expect(decidePermission('full', egress, SCOPE).outcome).toBe('allow');
  });

  it('treats localhost as not being egress at all', () => {
    // §10.5's rule is "reaches a non-localhost host". A dev server on 127.0.0.1
    // is inside the boundary, and gating it would be exactly the 200-gates run
    // the frequency argument forbids.
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const answer = decidePermission(
        'worktree',
        { method: 'network', url: `http://${host}:5173/` },
        SCOPE,
      );
      expect(answer.outcome, host).toBe('allow');
    }
  });
});

suite('every cell of the table is a decision, and no cell throws', () => {
  it('answers for all four levels against all four methods', () => {
    const requests: PermissionRequest[] = [
      write(`${WT}/a`),
      read(`${WT}/a`),
      terminal('git status'),
      { method: 'network', url: 'https://example.com' },
    ];
    const levels: PermissionLevel[] = ['read', 'worktree', 'worktree+net', 'full'];

    for (const level of levels) {
      for (const request of requests) {
        const answer = decidePermission(level, request, SCOPE);
        expect(PERMISSION_OUTCOMES).toContain(answer.outcome);
      }
    }
  });

  it('is pure: the same inputs answer the same way, and the scope is not mutated', () => {
    const before = JSON.stringify(SCOPE);
    const first = decidePermission('worktree', write(`${WT}/a`), SCOPE);
    const second = decidePermission('worktree', write(`${WT}/a`), SCOPE);

    expect(first).toEqual(second);
    expect(JSON.stringify(SCOPE)).toBe(before);
  });
});
