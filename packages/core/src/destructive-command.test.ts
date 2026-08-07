/**
 * KAR-08.3 — the cheap syntactic second layer.
 *
 * EPIC-08-S14 is a scenario outline and it is transcribed here as a table,
 * cell for cell, because that is what it is. Every row is one line of
 * docs/09-workspace-and-safety.md §10.4, and a row that disagrees with the
 * document fails with the level, the command line and both decisions in its
 * name.
 *
 * The three rows that are not obvious, and that each name a way a plausible
 * implementation goes wrong:
 *
 *   - **`--force-with-lease` is an allow.** Gating it would train the operator
 *     to approve force-pushes, which is precisely backwards, and it is the
 *     only row in the table whose purpose is to *not* fire.
 *   - **The `rm -r` rule is a depth rule, on the resolved path.** The list of
 *     dangerous paths is infinite and the depth is not — and counting segments
 *     on the agent's own string gates `rm -rf dist`, which is a verb every
 *     repository uses and which blows the §10.5 gate budget on its own.
 *   - **Host extraction is not "does the argument look like a URL".** `mysql`
 *     spells its host `-h db.prod.internal`, and a naive reading calls that a
 *     local command.
 *
 * Verifies: EPIC-08-S14 · AC3, AC4, AC5
 */

import { expect, it, describe as suite } from 'vitest';
import { destructiveCommand } from './destructive-command.ts';
import {
  decidePermission,
  type PermissionRequest,
  type PermissionScope,
  reasonCode,
} from './permission.ts';

/** The tmpdir the flow file's `<tmp>` stands for. A literal so the table reads
 * like the scenario outline; nothing here touches a filesystem. */
const TMP = '/tmp/DeFlow-a1b2c3';
const WT = `${TMP}/wt`;

/**
 * EPIC-08-S14's Background: *every* binary in the table is on the repository
 * allowlist, so a `gate` in the decision column can only have come from the
 * syntactic layer and never from default-deny.
 */
const SCOPE: PermissionScope = {
  worktree: WT,
  allowlist: [
    'git',
    'rm',
    'terraform',
    'kubectl',
    'aws',
    'gcloud',
    'az',
    'psql',
    'mysql',
    'prisma',
    'drizzle-kit',
    'flyway',
    'pnpm',
  ],
  readOnlyCommands: ['git status', 'git log'],
  allowedDomains: [],
  scrubbedEnv: [],
};

/** A command line the way the flow file writes it, split the way ACP sends
 * it: `terminal/create` carries `command` and `args` separately, and nothing
 * between here and `spawn` re-joins them. */
function terminal(line: string, cwd = WT): PermissionRequest {
  const [command = '', ...args] = line.split(' ');
  return { method: 'terminal/create', command, args, cwd };
}

const decide = (line: string, scope: PermissionScope = SCOPE): string => {
  const answer = decidePermission('worktree', terminal(line), scope);
  return answer.outcome === 'allow' ? 'allow' : `${answer.outcome}:${reasonCode(answer.reason)}`;
};

suite('EPIC-08-S14 — the gated set, as the scenario outline writes it', () => {
  const rows: [string, 'allow' | 'gate'][] = [
    ['git push --force origin DeFlow/r1__n1', 'gate'],
    ['git push -f origin DeFlow/r1__n1', 'gate'],
    // AC4 — the safe form is not collateral damage.
    ['git push --force-with-lease origin DeFlow/r1__n1', 'allow'],
    ['git reset --hard HEAD~1', 'allow'],
    ['git reset --hard -- /etc', 'gate'],
    ['rm -rf /', 'gate'],
    ['rm -r /usr', 'gate'],
    [`rm -rf ${WT}/dist/cache/tmp`, 'allow'],
    ['terraform apply', 'gate'],
    ['terraform destroy', 'gate'],
    ['terraform plan', 'allow'],
    ['kubectl delete pod x', 'gate'],
    ['kubectl get pods', 'allow'],
    ['aws s3 rm s3://bucket --recursive', 'gate'],
    ['psql postgres://localhost:5432/dev', 'allow'],
    ['psql postgres://db.prod.internal/main', 'gate'],
    ['prisma migrate deploy', 'gate'],
    ['prisma migrate dev', 'allow'],
    ['drizzle-kit push', 'gate'],
    ['flyway migrate', 'gate'],
  ];

  it.for(rows)('%s -> %s', ([line, decision]) => {
    expect(decide(line).split(':')[0]).toBe(decision);
  });

  it('covers the rest of AC3’s list too', () => {
    // The scenario outline is a sample of the AC; these are the entries it
    // leaves implicit, and each one is its own line of §10.4.
    expect(decide('kubectl apply -f k8s/')).toBe('gate:destructive-command:kubectl-apply');
    expect(decide('gcloud compute instances list')).toBe('gate:destructive-command:gcloud');
    expect(decide('az group delete --name prod')).toBe('gate:destructive-command:az');
    expect(decide('mysql -h db.prod.internal -u root')).toBe(
      'gate:destructive-command:mysql-remote',
    );
  });

  it('names what fired, so the gate budget can be counted by code', () => {
    // AC8: a reason is a code plus a detail, never a sentence — the approval
    // queue groups by this and the budget assertion counts by it.
    expect(decide('git push --force origin main')).toBe('gate:destructive-command:git-push-force');
    expect(decide('git reset --hard -- /etc')).toBe('gate:destructive-command:git-reset-hard');
    expect(decide('rm -rf /')).toBe('gate:destructive-command:rm-recursive-shallow');
    expect(decide('terraform destroy')).toBe('gate:destructive-command:terraform-destroy');
    expect(decide('prisma migrate deploy')).toBe('gate:destructive-command:prisma-migrate-deploy');
    expect(decide('drizzle-kit push')).toBe('gate:destructive-command:drizzle-kit-push');
    expect(decide('flyway migrate')).toBe('gate:destructive-command:flyway-migrate');
  });
});

suite('the rm rule is a depth rule on the resolved path', () => {
  it('gates a path of two segments or fewer, whatever it is called', () => {
    for (const line of ['rm -rf /', 'rm -r /usr', 'rm -rf /usr/local', 'rm -R /var/tmp']) {
      expect(decide(line), line).toBe('gate:destructive-command:rm-recursive-shallow');
    }
  });

  it('allows a deep path inside the worktree, including a relative one', () => {
    // The row that makes this a *depth* rule rather than a string rule:
    // `dist` is one segment as a string and four once resolved against the
    // worktree, and gating it would put `rm -rf dist` in the approval queue of
    // every run that builds anything.
    expect(decide('rm -rf dist')).toBe('allow');
    expect(decide('rm -rf build/cache')).toBe('allow');
    expect(decide(`rm -rf ${WT}/dist/cache/tmp`)).toBe('allow');
  });

  it('resolves the path before counting, so `..` cannot walk out unnoticed', () => {
    // `../..` is two segments as a string and lands on /tmp — one segment.
    expect(decide('rm -rf ../..')).toBe('gate:destructive-command:rm-recursive-shallow');
  });

  it('only fires when the removal is recursive, bundled flags included', () => {
    // `rm /usr/x` is not the operation the rule is about; `-fr` is.
    expect(decide('rm /etc/hosts')).toBe('allow');
    expect(decide('rm -fr /etc')).toBe('gate:destructive-command:rm-recursive-shallow');
    expect(decide('rm --recursive --force /etc')).toBe(
      'gate:destructive-command:rm-recursive-shallow',
    );
  });
});

suite('git push force, and the safe form that must survive it', () => {
  it('gates both spellings of the unsafe force', () => {
    expect(decide('git push -f origin DeFlow/r1__n1')).toBe(
      'gate:destructive-command:git-push-force',
    );
    expect(decide('git push --force origin DeFlow/r1__n1')).toBe(
      'gate:destructive-command:git-push-force',
    );
  });

  it('allows --force-with-lease, including its = form and its companion flag', () => {
    expect(decide('git push --force-with-lease origin DeFlow/r1__n1')).toBe('allow');
    expect(decide('git push --force-with-lease=DeFlow/r1__n1 origin')).toBe('allow');
    expect(decide('git push --force-if-includes --force-with-lease origin')).toBe('allow');
  });

  it('does not fire on a push that is not a force push', () => {
    expect(decide('git push origin DeFlow/r1__n1')).toBe('allow');
    expect(decide('git push --set-upstream origin DeFlow/r1__n1')).toBe('allow');
  });
});

suite('git reset --hard is judged by where it points', () => {
  it('allows a revision, which is what the flag is normally given', () => {
    expect(decide('git reset --hard HEAD~1')).toBe('allow');
    expect(decide('git reset --hard origin/main')).toBe('allow');
    expect(decide('git reset --soft HEAD~1')).toBe('allow');
  });

  it('gates a path outside the worktree, however it is spelled', () => {
    expect(decide('git reset --hard -- /etc')).toBe('gate:destructive-command:git-reset-hard');
    expect(decide('git reset --hard ../../etc')).toBe('gate:destructive-command:git-reset-hard');
  });

  it('allows a path inside the worktree', () => {
    expect(decide(`git reset --hard -- ${WT}/src`)).toBe('allow');
    expect(decide('git reset --hard -- ./src')).toBe('allow');
  });
});

suite('database clients are judged by the host they reach', () => {
  it('allows a loopback target, because that is not egress at all', () => {
    for (const line of [
      'psql postgres://localhost:5432/dev',
      'psql postgres://127.0.0.1/dev',
      'psql -h localhost -d dev',
      'mysql --host=127.0.0.1 -u root',
      'psql -d dev',
    ]) {
      expect(decide(line), line).toBe('allow');
    }
  });

  it('gates a non-localhost host in any of the spellings the clients accept', () => {
    const remote = [
      'psql postgres://db.prod.internal/main',
      'psql -h db.prod.internal -d main',
      'psql --host db.prod.internal',
      'psql --host=db.prod.internal',
      'psql host=db.prod.internal dbname=main',
    ];
    for (const line of remote) {
      expect(decide(line), line).toBe('gate:destructive-command:psql-remote');
    }
    expect(decide('mysql -h db.prod.internal -u root')).toBe(
      'gate:destructive-command:mysql-remote',
    );
  });
});

suite('AC5 — a command needing a scrubbed variable is gated, not failed', () => {
  const scrubbed: PermissionScope = { ...SCOPE, scrubbedEnv: ['AWS_PROFILE', 'DATABASE_URL'] };

  it('gates with the variable name, so the operator sees which one and why', () => {
    // Not "allowed to run and fail confusingly": KAR-08.4 removed the variable
    // from the child environment, so the command cannot work, and the useful
    // answer names it rather than letting the agent read a blank.
    const answer = decidePermission(
      'worktree',
      terminal('pnpm deploy --profile $AWS_PROFILE'),
      scrubbed,
    );

    expect(answer.outcome).toBe('gate');
    if (answer.outcome !== 'gate') return;
    expect(reasonCode(answer.reason)).toBe('scrubbed-env:AWS_PROFILE');
  });

  it('sees the ${…} spelling too, and the one embedded in a larger argument', () => {
    expect(decide('pnpm run migrate --url ${DATABASE_URL}', scrubbed)).toBe(
      'gate:scrubbed-env:DATABASE_URL',
    );
    expect(decide('pnpm x --dsn=prefix$DATABASE_URL/suffix', scrubbed)).toBe(
      'gate:scrubbed-env:DATABASE_URL',
    );
  });

  it('says nothing about a variable that was never scrubbed', () => {
    expect(decide('pnpm test --reporter $CI_REPORTER', scrubbed)).toBe('allow');
    // And nothing at all when the scrub list is empty, which is the state
    // before a level asks for anything to be removed.
    expect(decide('pnpm deploy --profile $AWS_PROFILE')).toBe('allow');
  });

  it('prefers the sharper reason when a command is both', () => {
    // `aws` is an identity-boundary binary whatever its arguments are, and
    // that is the more useful thing to tell the operator.
    expect(decide('aws s3 ls --profile $AWS_PROFILE', scrubbed)).toBe(
      'gate:destructive-command:aws',
    );
  });
});

suite('no static analysis of shell strings is attempted', () => {
  it('judges a command substitution by its outer binary alone', () => {
    // "`rm -rf /` has infinite spellings" is the argument *for* the allowlist,
    // not an invitation to try to recognise them. `$(echo rm)` is a binary
    // nobody allowlisted, and that is the whole decision.
    const answer = decidePermission('worktree', terminal('$(echo rm) -rf /'), SCOPE);

    expect(answer.outcome).toBe('gate');
    if (answer.outcome !== 'gate') return;
    expect(answer.reason.code).toBe('not-allowlisted');
  });

  it('does not look inside a quoted argument for a verb it knows', () => {
    // `sh` is not on the allowlist, so this gates — but as `not-allowlisted`,
    // which is the proof that nothing parsed the string after `-c`.
    expect(decide("sh -c 'rm -rf /'")).toBe('gate:not-allowlisted:sh');
    // And an allowlisted binary carrying the same text is not re-parsed.
    expect(decide("pnpm run 'terraform destroy'")).toBe('allow');
  });
});

suite('the layer is a pure predicate over one command', () => {
  it('answers null for the ordinary case and a reason for the gated one', () => {
    const context = { worktree: WT, cwd: WT, scrubbedEnv: [] as readonly string[] };

    expect(destructiveCommand('pnpm', ['test'], context)).toBeNull();
    expect(destructiveCommand('terraform', ['destroy'], context)).toEqual({
      code: 'destructive-command',
      detail: 'terraform-destroy',
    });
  });

  it('is total: no input throws and every answer is a reason or null', () => {
    const context = { worktree: WT, cwd: WT, scrubbedEnv: ['AWS_PROFILE'] };
    const inputs: [string, string[]][] = [
      ['', []],
      ['rm', []],
      ['git', ['push']],
      ['psql', ['-h']],
      ['mysql', ['--host=']],
      ['rm', ['-r', '']],
      ['aws', ['$AWS_PROFILE']],
      ['\0', ['\0']],
    ];

    for (const [command, args] of inputs) {
      const reason = destructiveCommand(command, args, context);
      expect(reason === null || typeof reason.code === 'string').toBe(true);
    }
  });
});
