/**
 * KAR-07.3 — flat branch naming and ref-name validation, against real git and
 * a recording shim (docs/09-workspace-and-safety.md §2, §2.1; EPIC-07-S5..S8).
 *
 * Real git, hermetically (GIT_ENV strips the developer's own ~/.gitconfig,
 * per docs/14-testing-strategy.md §6) everywhere a real repository is what is
 * under test. The fake `git` shim (../support/fake-git-bin.ts) is used only
 * for counting invocations — proving "spawns no git process" needs a real
 * process to not spawn, which real git cannot demonstrate any more cheaply
 * than a recording double can.
 *
 * Verifies: EPIC-07-S5, EPIC-07-S6, EPIC-07-S7, EPIC-07-S8 · KAR-07.3 test
 * plan rows 3-5.
 */
import { GIT_ENV, git, it, makeRepo, mulberry32, tryGit } from '@DeFlow/testkit';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { integrationBranch, nodeBranch } from '../../src/git/branch-name.ts';
import { Git } from '../../src/git/git.ts';
import { RefFormatChecker } from '../../src/git/ref-format.ts';
import { writeFakeGit } from '../support/fake-git-bin.ts';

suite(
  'S5: check-ref-format is invoked once per composed name, and cached (test plan row 3)',
  () => {
    it('nodeBranch + integrationBranch compose, and RefFormatChecker verifies each exactly once', async ({
      tmp,
    }) => {
      const fakeGit = await writeFakeGit(tmp);
      const wrapper = new Git(tmp, { env: { ...process.env, PATH: fakeGit.pathEnv } });
      const checker = new RefFormatChecker(wrapper);

      const node = nodeBranch('r1', 'n1');
      const integration = integrationBranch('r1');
      expect(node).toBe('DeFlow/r1__n1');
      expect(integration).toBe('DeFlow/int/r1');

      expect(await checker.isValid(node)).toBe(true);
      expect(await checker.isValid(integration)).toBe(true);
      // Re-checking the same two names again must not spawn a third or fourth
      // git process — the cache is what makes this "exactly once".
      await checker.isValid(node);
      await checker.isValid(integration);

      const invocations = await fakeGit.invocations();
      expect(invocations).toHaveLength(2);
      expect(invocations.map((call) => call.argv)).toEqual([
        `-C ${tmp} check-ref-format --branch ${node}`,
        `-C ${tmp} check-ref-format --branch ${integration}`,
      ]);
    });
  },
);

suite('S5: the integration branch coexists with node branches on a real repository', () => {
  it('creating the integration branch first, then three node branches, all four exist', async ({
    tmp,
  }) => {
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo });

    await git(repo, ['branch', integrationBranch('r1')]);
    await git(repo, ['branch', nodeBranch('r1', 'n1')]);
    await git(repo, ['branch', nodeBranch('r1', 'n2')]);
    await git(repo, ['branch', nodeBranch('r1', 'n3')]);

    const branches = await git(repo, ['branch', '--list', 'DeFlow/*']);
    expect(branches).toContain('DeFlow/int/r1');
    expect(branches).toContain('DeFlow/r1__n1');
    expect(branches).toContain('DeFlow/r1__n2');
    expect(branches).toContain('DeFlow/r1__n3');
  });

  it('creating them in the reverse order also succeeds — the fix is not order-dependent', async ({
    tmp,
  }) => {
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo });

    await git(repo, ['branch', nodeBranch('r1', 'n3')]);
    await git(repo, ['branch', nodeBranch('r1', 'n2')]);
    await git(repo, ['branch', nodeBranch('r1', 'n1')]);
    await git(repo, ['branch', integrationBranch('r1')]);

    const branches = await git(repo, ['branch', '--list', 'DeFlow/*']);
    expect(branches.split('\n').filter((line) => line.trim() !== '')).toHaveLength(4);
  });
});

suite('S6: regression — the PRD hierarchical scheme cannot hold an integration branch', () => {
  it('a run-level branch cannot be created beneath an existing node-level branch', async ({
    tmp,
  }) => {
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo });
    await git(repo, ['branch', 'DeFlow/r1/n1']);

    const result = await tryGit(repo, ['branch', 'DeFlow/r1']);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("cannot lock ref 'refs/heads/DeFlow/r1'");
    expect(result.stderr).toContain("'refs/heads/DeFlow/r1/n1' exists");
    expect(result.stderr).toContain("cannot create 'refs/heads/DeFlow/r1'");
  });

  it('and the reverse order fails symmetrically', async ({ tmp }) => {
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo });
    await git(repo, ['branch', 'DeFlow/r1']);

    const result = await tryGit(repo, ['branch', 'DeFlow/r1/n1']);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('refs/heads/DeFlow/r1');
  });

  it("DeFlow's own generator can never produce the failing shape (git branch --list, real repo)", async ({
    tmp,
  }) => {
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo });
    const random = mulberry32(0x0705_0706);
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const runId = 'r1';
    const created: string[] = [];

    for (let i = 0; i < 5; i += 1) {
      let nodeId = '';
      const length = 3 + Math.floor(random() * 8);
      for (let c = 0; c < length; c += 1)
        nodeId += alphabet[Math.floor(random() * alphabet.length)];
      const name = nodeBranch(runId, nodeId);
      await git(repo, ['branch', name]);
      created.push(name);
    }
    await git(repo, ['branch', integrationBranch(runId)]);

    const branches = await git(repo, ['branch', '--list', 'DeFlow/*']);
    const list = branches.split('\n').filter((line) => line.trim() !== '');
    expect(list).toHaveLength(created.length + 1);
  });
});

suite(
  'S7: the domain layer and real check-ref-format agree on the accept set (test plan row 3)',
  () => {
    it('every name BRANCH_SAFE-composed id pairs produce is also accepted by real "check-ref-format --branch"', async ({
      tmp,
    }) => {
      const wrapper = new Git(tmp, { env: GIT_ENV });
      const checker = new RefFormatChecker(wrapper);
      const random = mulberry32(0x0705_0707);
      const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';

      function randomValidId(): string {
        const length = 1 + Math.floor(random() * 12);
        let id = '';
        for (let i = 0; i < length; i += 1) id += alphabet[Math.floor(random() * alphabet.length)];
        return id;
      }

      for (let i = 0; i < 40; i += 1) {
        const name = nodeBranch(randomValidId(), randomValidId());
        expect(await checker.isValid(name)).toBe(true);
      }
    });

    it(
      '"-n": BRANCH_SAFE rejects it at the domain layer, and on this git version ' +
        '"check-ref-format --branch" rejects it too — a stricter agreement than ' +
        "the architecture doc's git-2.43 baseline documented (§2.1), not a " +
        'contradiction of it: the domain-layer refusal (AC2) does not depend on ' +
        'which way git happens to fall',
      async ({ tmp }) => {
        const wrapper = new Git(tmp, { env: GIT_ENV });
        const checker = new RefFormatChecker(wrapper);

        expect(() => nodeBranch('r1', '-n')).toThrow('unsafe nodeId');
        expect(await checker.isValid('-n')).toBe(false);
      },
    );
  },
);

suite('S8: the -n trap — a structurally valid ref that a bare positional turns into a flag', () => {
  it('"-n" is a valid ref-path component in git\'s general (non-branch-mode) rules', async ({
    tmp,
  }) => {
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo });

    const result = await tryGit(repo, ['check-ref-format', 'refs/heads/-n']);

    expect(result.exitCode).toBe(0);
  });

  it('and a bare "git branch -n" (no "--" separator) is parsed as a flag, not as that ref name', async ({
    tmp,
  }) => {
    const repo = join(tmp, 'repo');
    await makeRepo({ dir: repo });

    const result = await tryGit(repo, ['branch', '-n']);

    // "unknown switch" (or, on a git that does define -n, whatever -n's own
    // behaviour is) is proof git treated "-n" as an option: creating a
    // branch would fail instead with "not a valid branch name". Either way,
    // no branch named "-n" is ever created — the trap this AC closes.
    expect(result.exitCode).not.toBe(0);
    const branches = await git(repo, ['branch', '--list']);
    expect(branches).not.toContain('-n');
  });

  it('DeFlow closes the hole before any of this: nodeBranch("-n") throws, and no git process is ever asked', async ({
    tmp,
  }) => {
    const fakeGit = await writeFakeGit(tmp);
    // No production code path is exercised here at all — the point is that
    // the throw happens synchronously, before a caller could even reach a
    // git call built from PATH=fakeGit.pathEnv.
    expect(() => nodeBranch('r1', '-n')).toThrow('unsafe nodeId');
    expect(await fakeGit.invocations()).toEqual([]);
  });
});
