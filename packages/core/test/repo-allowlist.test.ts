/**
 * KAR-08.3 — the default-deny allowlist, against a real `DeFlow.config.ts`.
 *
 * The table below is twenty commands a run of a JavaScript/Python repository
 * actually issues, decided against ./fixtures/config/DeFlow.config.ts rather
 * than against a scope literal written next to the assertion. That is the
 * difference between testing the allowlist and testing a copy of it: §10.5's
 * argument is that the *repository's own verbs* must run free, and a scope
 * assembled by hand in the spec can always be widened until they do.
 *
 * The row that matters most is `./node_modules/.bin/vitest`. Matching on the
 * raw string gates it, and gating the test runner is the fastest possible way
 * to blow the gate budget — every node that runs tests would ask.
 *
 * Verifies: EPIC-08-S12 · AC1, AC2
 */

import { expect, it, describe as suite } from 'vitest';
import {
  decidePermission,
  type PermissionRequest,
  permissionScopeFrom,
  reasonCode,
} from '../src/index.ts';
import config from './fixtures/config/DeFlow.config.ts';

const WT = '/tmp/DeFlow-a1b2c3/wt';

const SCOPE = permissionScopeFrom(config.commands, { worktree: WT, scrubbedEnv: [] });

function terminal(line: string, cwd = WT): PermissionRequest {
  const [command = '', ...args] = line.split(' ');
  return { method: 'terminal/create', command, args, cwd };
}

const decide = (line: string): string => {
  const answer = decidePermission('worktree', terminal(line), SCOPE);
  return answer.outcome === 'allow' ? 'allow' : `${answer.outcome}:${reasonCode(answer.reason)}`;
};

suite('the config becomes the scope, and nothing is invented on the way', () => {
  it('carries the repository’s verbs, its read-only subset and its domains', () => {
    expect(SCOPE).toEqual({
      worktree: WT,
      allowlist: config.commands.allow,
      readOnlyCommands: config.commands.readOnly,
      allowedDomains: config.commands.allowDomains,
      scrubbedEnv: [],
    });
  });

  it('defaults the optional blocks to empty rather than to something permissive', () => {
    const bare = permissionScopeFrom({ allow: ['node'] }, { worktree: WT, scrubbedEnv: [] });

    expect(bare.readOnlyCommands).toEqual([]);
    expect(bare.allowedDomains).toEqual([]);
  });
});

suite('twenty commands from one repository, decided by its own config', () => {
  const rows: [string, 'allow' | 'deny' | 'gate'][] = [
    ['pnpm install', 'allow'],
    ['pnpm test', 'allow'],
    ['pnpm -w run build', 'allow'],
    ['npm ci', 'allow'],
    ['node scripts/codegen.mjs', 'allow'],
    ['git status', 'allow'],
    ['git add -A', 'allow'],
    ['git commit -m wip', 'allow'],
    ['tsc --noEmit', 'allow'],
    ['eslint . --fix', 'allow'],
    ['make build', 'allow'],
    ['pytest -q', 'allow'],
    ['python -m build', 'allow'],
    ['go test ./...', 'allow'],
    ['cargo build --release', 'allow'],
    // The one the raw-string implementation gets wrong.
    ['./node_modules/.bin/vitest run', 'allow'],
    ['/usr/local/bin/node --version', 'allow'],
    // And the default-deny half: three verbs this repository does not use.
    ['rsync -av / /backup', 'gate'],
    ['docker run --rm alpine', 'gate'],
    // Egress is a *row of the ladder*, decided before the binary allowlist is
    // consulted — so at `worktree` this is a deny, not a question.
    ['curl -O https://example.com/x', 'deny'],
  ];

  it.for(rows)('%s -> %s', ([line, decision]) => {
    expect(decide(line).split(':')[0]).toBe(decision);
  });

  it('names the binary the operator is being asked about, not the raw string', () => {
    expect(decide('rsync -av / /backup')).toBe('gate:not-allowlisted:rsync');
    // A path prefix on a binary nobody allowlisted still reduces to its name,
    // so the approval queue does not show twenty spellings of one question.
    expect(decide('/opt/homebrew/bin/rsync -av / /backup')).toBe('gate:not-allowlisted:rsync');
  });

  it('refuses a cwd outside the worktree even for a verb it allows', () => {
    // EPIC-08-S12's third scenario: the command and args get all the
    // attention, and an allowlisted `git` with a cwd elsewhere is a full
    // escape with no exotic syntax at all.
    const answer = decidePermission(
      'worktree',
      terminal('git status', '/tmp/DeFlow-a1b2c3/other'),
      SCOPE,
    );

    expect(answer.outcome).toBe('deny');
    if (answer.outcome === 'allow') return;
    expect(reasonCode(answer.reason)).toBe('path-escape:cwd');
  });
});
