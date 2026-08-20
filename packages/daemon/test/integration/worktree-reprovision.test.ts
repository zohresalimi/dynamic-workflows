/**
 * KAR-25.8 AC5 — the owner's actual failure, reproduced against real git and
 * a real `runReconNode`, one level up from ./worktree-lifecycle.test.ts's
 * `WorkspaceManager`-only coverage of the same fix (EPIC-25-S51 … EPIC-25-S55).
 *
 * **What this proves, and what it does not.** There is no run-driving harness
 * in this repository that spins up `drive.ts`'s ticker over a real daemon and
 * asserts a stuck run un-sticks itself — the closest such thing,
 * `e2e/smoke/`, drives a single scripted happy path and is not built to
 * inject a mid-run failure. So this spec does not exercise `advanceRun`,
 * `advanceOneRun` or the drive ticker at all. What it *does* reach is exactly
 * the two frames the owner's stack trace named:
 * `WorkspaceManager.provision` and `runReconNode` (recon.ts:257) — by
 * provisioning the recon worktree once, standing in for a first attempt that
 * crashed before it could remove its own worktree (the crash `remove`'s own
 * `try`/`catch` cannot cover, per recon.ts's module note), and then calling
 * `runReconNode` again exactly as a retried node would. Before KAR-25.8 this
 * second call is `WorkspaceManager.provision` throwing `WorktreeCreateFailed`
 * with the owner's own message, uncaught; after it, `runReconNode` resolves.
 *
 * That gap — from "the exact function that threw" to "the scheduler that
 * would have retried it" — is real and is not claimed to be covered here.
 *
 * Verifies: EPIC-25-S51 · KAR-25.8 AC5
 */
import type { Db, Handle, NodeId, RunId, StructuredOutput } from '@DeFlow/core';
import { HandleSchema, NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { blobHandle, openLedger, readRange, spillBytes } from '@DeFlow/ledger';
import { GIT_ENV, it, makeRepo, TestClock } from '@DeFlow/testkit';
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { nodeBranch, runRef } from '../../src/git/branch-name.ts';
import { Git } from '../../src/git/git.ts';
import {
  WipSalvageFailed,
  WorkspaceManager,
  WorktreeCreateFailed,
} from '../../src/git/worktree-manager.ts';
import { type ReconAgent, reconProvisionRequest, runReconNode } from '../../src/recon/recon.ts';
import { loadSchemaDirectory } from '../../src/schema-store.ts';
import { o200kTokenizer } from '../../src/tokens/tokenizer.ts';

const SCHEMAS_DIR = fileURLToPath(new URL('../../../../schemas/', import.meta.url));

const RUN: RunId = RunIdSchema.parse('run_20260819T090000Z_ac1005');
const RECON: NodeId = NodeIdSchema.parse('recon');
const T0 = 1_755_600_000_000;
const EPOCH = 4;

const present = (value: unknown): StructuredOutput => ({ present: true, value });

const survey = (): StructuredOutput =>
  present({
    schemaId: 'DeFlow.reconsurvey.v1',
    toolchain: { language: 'typescript', packageManager: 'pnpm' },
    commands: { test: 'pnpm test' },
  });

/** A session that answers once and never again — the ordinary happy-path
 * agent, standing in for whatever real provider the retried node reaches. */
function completes(): ReconAgent {
  return {
    open: () =>
      Promise.resolve({
        session: { repair: () => Promise.reject(new Error('no repair scripted')) },
        turn: { structuredOutput: survey() },
      }),
  };
}

async function scene(tmp: string) {
  const root = await realpath(tmp);
  const repo = join(root, 'repo');
  await makeRepo({
    dir: repo,
    files: {
      'package.json': '{"name":"ui","scripts":{"test":"pnpm test"}}\n',
      'src/index.ts': 'export const x = 1;\n',
    },
  });

  const wrapped = new Git(repo, { env: GIT_ENV });
  const worktreeCalls: string[][] = [];
  const db = openLedger(root);
  /** A second manager over the same repository and the same ledger is what a
   * daemon restart *is*: nothing is carried across but the file on disk. */
  const newManager = (): WorkspaceManager =>
    new WorkspaceManager({
      git: {
        run: (args, opts) => {
          if (args[0] === 'worktree') worktreeCalls.push([...args]);
          return wrapped.run(args, opts);
        },
      },
      db,
      clock: new TestClock(T0),
      epoch: EPOCH,
    });
  const manager = newManager();

  const worktreePath = join(repo, '.DeFlow', 'wt', `${RUN}__${RECON}`);
  const putSurvey = (bytes: Uint8Array): Handle =>
    HandleSchema.parse(blobHandle(spillBytes(root, Buffer.from(bytes), 'application/json').sha256));
  const captureEvidence = (text: string): Handle =>
    HandleSchema.parse(
      blobHandle(spillBytes(root, Buffer.from(text, 'utf8'), 'text/plain').sha256),
    );

  const runRecon = (agent: ReconAgent, workspace: WorkspaceManager = manager) =>
    runReconNode({
      db,
      runId: RUN,
      node: RECON,
      attempt: 0,
      epoch: EPOCH,
      ts: T0,
      provider: 'mock',
      model: 'mock-1',
      workspace,
      worktree: { path: worktreePath, baseRef: 'main' },
      scopePaths: ['src'],
      prompt: 'Survey this repository.',
      agent,
      schemas: loadSchemaDirectory(SCHEMAS_DIR),
      registry: loadSchemaDirectory(SCHEMAS_DIR),
      tokenizer: o200kTokenizer(),
      putSurvey,
      captureEvidence,
    });

  /** Raw git in the repository, outside the manager — an operator's terminal,
   * and the only way to build a fixture the manager itself refuses to build. */
  const raw = (args: readonly string[]) => wrapped.run([...args]);

  return {
    root,
    repo,
    db,
    manager,
    newManager,
    raw,
    worktreeCalls,
    worktreePath,
    runRecon,
    close: () => db.close(),
  };
}

const eventKinds = (db: Db): string[] =>
  readRange(db, RUN, 0, 500).events.map((event) => event.kind);

const eventsOfKind = (db: Db, kind: string): { payload: Record<string, unknown> }[] =>
  readRange(db, RUN, 0, 500)
    .events.filter((event) => event.kind === kind)
    .map((event) => ({ payload: event.payload as Record<string, unknown> }));

suite('EPIC-25-S51: the exact failure from the owner’s terminal, one level up', () => {
  it('before the fix: provisioning over a leftover worktree throws WorktreeCreateFailed', async ({
    tmp,
  }) => {
    // Pins the defect this story fixes. Not the retry path itself — a second
    // *unconditional* `git worktree add` at a path that already has a
    // worktree really did, and still does when asked outright, exit 128.
    const s = await scene(tmp);
    try {
      const request = reconProvisionRequest({
        runId: RUN,
        nodeId: RECON,
        path: s.worktreePath,
        baseRef: 'main',
      });
      await s.manager.provision(request);

      // The literal unconditional-add git ran before KAR-25.8, called
      // directly rather than through `provision` (which no longer makes it).
      const raw = await new Git(s.repo, { env: GIT_ENV }).run([
        'worktree',
        'add',
        '--detach',
        '--lock',
        '--reason',
        'anyone-else',
        s.worktreePath,
        'main',
      ]);
      expect(raw.exitCode).not.toBe(0);
      expect(raw.stderr).toContain('already exists');
    } finally {
      s.close();
    }
  });

  it('a node retried after crashing post-provision advances past recon rather than throwing', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      // Stand-in for the crash: a first attempt provisioned recon's worktree
      // and never reached `runReconNode`'s own `remove` — the daemon died in
      // between, which is the one gap that call's own try/catch cannot cover.
      const crashed = await s.manager.provision(
        reconProvisionRequest({
          runId: RUN,
          nodeId: RECON,
          path: s.worktreePath,
          baseRef: 'main',
        }),
      );
      expect(crashed.path).toBe(s.worktreePath);
      s.worktreeCalls.length = 0;

      // "the drive ticker carries the run on": the node is scheduled again,
      // over the very worktree the crashed attempt left locked and present.
      const outcome = await s.runRecon(completes());

      expect(outcome.outcome).toBe('completed');
      // Reused on the retry, not re-created a second time — S52's ledger
      // claim, visible from this call site too. Exactly one `_created` (the
      // crashed first attempt) and exactly one `_reused` (the retry).
      const kinds = eventKinds(s.db);
      expect(kinds.filter((kind) => kind === 'workspace.worktree_created')).toHaveLength(1);
      expect(kinds.filter((kind) => kind === 'workspace.worktree_reused')).toHaveLength(1);
      // The run genuinely continued: recon's own removal ran once the survey
      // completed, same as an uninterrupted first attempt.
      expect(kinds).toContain('workspace.worktree_removed');
    } finally {
      s.close();
    }
  });

  it('the retry never raises WorktreeCreateFailed — the loop the owner hit is gone', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      await s.manager.provision(
        reconProvisionRequest({ runId: RUN, nodeId: RECON, path: s.worktreePath, baseRef: 'main' }),
      );

      let thrown: unknown;
      try {
        await s.runRecon(completes());
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      // Would have been the exact class in the owner's own stack trace.
      expect(thrown).not.toBeInstanceOf(WorktreeCreateFailed);
    } finally {
      s.close();
    }
  });
});

// ── KAR-26.1 ────────────────────────────────────────────────────────────────

suite('EPIC-26-S04: a foreign worktree fails the recon node instead of escaping', () => {
  it('returns outcome failed rather than throwing out of runReconNode (AC3)', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      // Somebody else's worktree, locked with somebody else's reason, sitting
      // at exactly the path recon derives for itself. Built with raw git,
      // because `provision` is the thing under test and would refuse to make it.
      const seeded = await s.raw([
        'worktree',
        'add',
        '--detach',
        '--lock',
        '--reason',
        'DeFlow run=r2 node=n9',
        s.worktreePath,
        'main',
      ]);
      expect(seeded.exitCode).toBe(0);

      // Before KAR-26.1 the `provision` call sat outside `surveyAndSettle`'s
      // try, so the refusal escaped `runReconNode` entirely, reached
      // `advanceOneRun`'s catch, and was logged once per tick for ever with
      // nothing in the ledger to say the node had failed.
      const outcome = await s.runRecon(completes());

      expect(outcome.outcome).toBe('failed');
    } finally {
      s.close();
    }
  });

  it('journals node.failed for recon with the occupant named, and a gate class', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      await s.raw([
        'worktree',
        'add',
        '--detach',
        '--lock',
        '--reason',
        'DeFlow run=r2 node=n9',
        s.worktreePath,
        'main',
      ]);

      const outcome = await s.runRecon(completes());

      const failed = eventsOfKind(s.db, 'node.failed');
      expect(failed).toHaveLength(1);
      const failure = failed[0]?.payload.failure as Record<string, unknown>;
      expect(failure.class).toBe('gate');
      expect(String(failure.message)).toContain('run r2');
      expect(String(failure.message)).toContain('node n9');
      // The occupant is named from the lock reason DeFlow itself writes, so the
      // message never claims the path belongs to a worktree at that same path.
      expect(String(failure.message)).not.toContain('already belongs to');
      expect(outcome.outcome === 'failed' && outcome.failure.deflowFailure.class).toBe('gate');
      // Nothing was created over it, and the survey never ran.
      expect(eventKinds(s.db)).not.toContain('workspace.worktree_created');
    } finally {
      s.close();
    }
  });

  it('an operator’s own lock reason is quoted rather than an owner invented (S06)', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      await s.raw([
        'worktree',
        'add',
        '--detach',
        '--lock',
        '--reason',
        'on holiday',
        s.worktreePath,
        'main',
      ]);

      const outcome = await s.runRecon(completes());

      expect(outcome.outcome).toBe('failed');
      const failure = eventsOfKind(s.db, 'node.failed')[0]?.payload.failure as Record<
        string,
        unknown
      >;
      expect(String(failure.message)).toContain('on holiday');
      expect(String(failure.message)).toMatch(/operator/i);
    } finally {
      s.close();
    }
  });
});

suite('EPIC-26-S08: the owner’s console scenario, end to end on real git (AC5)', () => {
  it('an interrupted teardown whose remove git refused recovers on the next advance', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      // 1. The node provisioned its worktree, as it always does.
      await s.manager.provision(
        reconProvisionRequest({ runId: RUN, nodeId: RECON, path: s.worktreePath, baseRef: 'main' }),
      );

      // 2. Teardown ran its unlock…
      const unlocked = await s.raw(['worktree', 'unlock', s.worktreePath]);
      expect(unlocked.exitCode).toBe(0);

      // 3. …and an agent had left a file behind, so git refused the remove.
      //    Pinned rather than assumed: this is the exact refusal that leaves
      //    the entry registered and unlocked.
      await writeFile(join(s.worktreePath, 'unsaved-work.txt'), 'do not lose me\n');
      const refused = await s.raw(['worktree', 'remove', s.worktreePath]);
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain('use --force');

      // 4. The daemon restarts and the drive loop carries the run on. Nothing
      //    is remembered across the restart but the repository and the ledger.
      const outcome = await s.runRecon(completes(), s.newManager());

      expect(outcome.outcome).toBe('completed');
      const kinds = eventKinds(s.db);
      const workspaceKinds = kinds.filter(
        (kind) => kind.startsWith('workspace.') && kind !== 'workspace.reconciled',
      );
      // The first `_created` is step 1's; everything after it is this advance.
      expect(workspaceKinds).toEqual([
        'workspace.worktree_created',
        'workspace.dirty_on_remove',
        'workspace.wip_salvaged',
        'workspace.worktree_removed',
        'workspace.worktree_created',
        // recon's own teardown, once the survey completed.
        'workspace.worktree_removed',
      ]);
    } finally {
      s.close();
    }
  });

  it('the agent’s uncommitted file survives on a reachable salvage commit', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      await s.manager.provision(
        reconProvisionRequest({ runId: RUN, nodeId: RECON, path: s.worktreePath, baseRef: 'main' }),
      );
      await s.raw(['worktree', 'unlock', s.worktreePath]);
      await writeFile(join(s.worktreePath, 'unsaved-work.txt'), 'do not lose me\n');

      await s.runRecon(completes(), s.newManager());

      const salvaged = eventsOfKind(s.db, 'workspace.wip_salvaged')[0]?.payload;
      const ref = String(salvaged?.branch);
      expect(ref).toBe(`DeFlow/salvage/${runRef(RUN)}__${RECON}`);
      // Reachable by ref, which is the whole claim: the worktree is gone and
      // the work is still findable.
      const show = await s.raw(['show', `${ref}:unsaved-work.txt`]);
      expect(show.exitCode).toBe(0);
      expect(show.stdout).toContain('do not lose me');
    } finally {
      s.close();
    }
  });

  it('raises no WorktreePathOccupiedError anywhere on that path', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      await s.manager.provision(
        reconProvisionRequest({ runId: RUN, nodeId: RECON, path: s.worktreePath, baseRef: 'main' }),
      );
      await s.raw(['worktree', 'unlock', s.worktreePath]);
      await writeFile(join(s.worktreePath, 'unsaved-work.txt'), 'do not lose me\n');

      let thrown: unknown;
      let outcome: Awaited<ReturnType<typeof s.runRecon>> | undefined;
      try {
        outcome = await s.runRecon(completes(), s.newManager());
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeUndefined();
      expect(outcome?.outcome).toBe('completed');
      // The exact class the owner's daemon logged once per drive tick.
      expect(eventKinds(s.db)).not.toContain('node.failed');
      const failures = eventsOfKind(s.db, 'node.failed').map((event) =>
        String((event.payload.failure as Record<string, unknown>).message),
      );
      expect(failures.filter((message) => message.includes('is held by'))).toEqual([]);
    } finally {
      s.close();
    }
  });
});

// ── KAR-26.1 AC1, on real git, for the shapes the recon node cannot reach ───

suite('EPIC-26-S01: a write node’s interrupted teardown, on real git', () => {
  /** What `live-nodes.ts` composes for a write node: deterministic in the run
   * and node ids, so the branch a leftover is on is the branch its next
   * attempt asks for. */
  const NODE = 'n1';
  const BRANCH = nodeBranch(runRef(RUN), NODE);

  const writeRequest = (path: string) => ({
    mode: 'write' as const,
    runId: RUN,
    nodeId: NODE,
    branch: BRANCH,
    path,
    baseRef: 'main',
  });

  it('provisions again after the teardown that kept its branch (AC1)', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const path = join(s.repo, '.DeFlow', 'wt', `${RUN}__${NODE}`);
      await s.manager.provision(writeRequest(path));

      // §4.4 interrupted between its unlock and its remove, with the agent's
      // work still uncommitted in the worktree.
      const unlocked = await s.raw(['worktree', 'unlock', path]);
      expect(unlocked.exitCode).toBe(0);
      await writeFile(join(path, 'wip.ts'), 'export const half = true;\n');

      // The daemon restarts and the node is scheduled again.
      const result = await s.newManager().provision(writeRequest(path));

      expect(result.path).toBe(path);
      expect(result.branch).toBe(BRANCH);
      const kinds = eventKinds(s.db);
      expect(kinds.filter((kind) => kind === 'workspace.worktree_created')).toHaveLength(2);
      expect(kinds.filter((kind) => kind === 'workspace.worktree_removed')).toHaveLength(1);
      // git is where the claim is settled: one worktree, at that path, on that
      // branch, and locked to this run and node again.
      const listed = await s.raw(['worktree', 'list', '--porcelain']);
      expect(listed.stdout).toContain(path);
      expect(listed.stdout).toContain(`branch refs/heads/${BRANCH}`);
    } finally {
      s.close();
    }
  });

  it('the salvaged work is on the node’s own branch, and the branch is what it re-enters', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      const path = join(s.repo, '.DeFlow', 'wt', `${RUN}__${NODE}`);
      await s.manager.provision(writeRequest(path));
      await s.raw(['worktree', 'unlock', path]);
      await writeFile(join(path, 'wip.ts'), 'export const half = true;\n');

      await s.newManager().provision(writeRequest(path));

      // The salvage commit landed on the node's branch (KAR-07.4 AC2, not the
      // detached AC6 ref), and the re-provisioned worktree is standing on it —
      // so the work is not merely reachable, it is checked out.
      const show = await s.raw(['show', `${BRANCH}:wip.ts`]);
      expect(show.exitCode).toBe(0);
      expect(show.stdout).toContain('export const half = true;');
      expect(await readFile(join(path, 'wip.ts'), 'utf8')).toContain('export const half = true;');
    } finally {
      s.close();
    }
  });
});

suite('EPIC-26-S01: an interrupted teardown whose directory is already gone', () => {
  it('recovers on the next advance rather than failing "missing but already registered"', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      await s.manager.provision(
        reconProvisionRequest({ runId: RUN, nodeId: RECON, path: s.worktreePath, baseRef: 'main' }),
      );
      // `git worktree remove` deletes the working directory before it clears
      // the administrative entry, so this is what a kill inside that window
      // leaves — and what an operator's own `rm -rf` of a stale worktree does.
      await s.raw(['worktree', 'unlock', s.worktreePath]);
      await rm(s.worktreePath, { recursive: true, force: true });
      const stale = await s.raw(['worktree', 'list', '--porcelain']);
      expect(stale.stdout).toContain('prunable');

      const outcome = await s.runRecon(completes(), s.newManager());

      expect(outcome.outcome).toBe('completed');
      const kinds = eventKinds(s.db);
      expect(kinds.filter((kind) => kind === 'workspace.worktree_created')).toHaveLength(2);
      // Nothing was salvaged: there was no working tree left to hold work.
      expect(kinds).not.toContain('workspace.dirty_on_remove');
    } finally {
      s.close();
    }
  });
});

suite('EPIC-26-S06: a symlink at the node’s own path is refused, not adopted', () => {
  it('leaves the operator’s worktree, and their uncommitted file, untouched (AC3)', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      // An operator's own worktree — registered, unlocked because they never
      // locked it, and holding work only they know about.
      const operator = join(s.root, 'operator-wt');
      const added = await s.raw(['worktree', 'add', '--detach', operator, 'main']);
      expect(added.exitCode).toBe(0);
      await writeFile(join(operator, 'precious.txt'), 'hours of uncommitted work\n');
      // …and the node's own derived path is a link to it. `findRegistered`
      // matches by realpath, so without a guard the entry it finds is theirs.
      await mkdir(join(s.worktreePath, '..'), { recursive: true });
      await symlink(operator, s.worktreePath, 'dir');

      const outcome = await s.runRecon(completes(), s.newManager());

      expect(outcome.outcome).toBe('failed');
      const listed = await s.raw(['worktree', 'list', '--porcelain']);
      expect(listed.stdout).toContain(operator);
      expect(await readFile(join(operator, 'precious.txt'), 'utf8')).toContain('hours of');
      // Their work was never reduced to a DeFlow salvage branch.
      expect(eventKinds(s.db)).not.toContain('workspace.wip_salvaged');
      expect(eventKinds(s.db)).not.toContain('workspace.worktree_removed');
      const failure = eventsOfKind(s.db, 'node.failed')[0]?.payload.failure as Record<
        string,
        unknown
      >;
      expect(failure.class).toBe('gate');
      expect(String(failure.message)).toContain(operator);
    } finally {
      s.close();
    }
  });
});

// ── KAR-26.1 AC3, its own boundary ──────────────────────────────────────────

suite('a provisioning failure that is not the occupancy gate is not swallowed', () => {
  it('leaves the throw to the driver instead of planning on no facts at all', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      await s.manager.provision(
        reconProvisionRequest({ runId: RUN, nodeId: RECON, path: s.worktreePath, baseRef: 'main' }),
      );
      await s.raw(['worktree', 'unlock', s.worktreePath]);
      await writeFile(join(s.worktreePath, 'unsaved-work.txt'), 'do not lose me\n');
      // A repository-authored `pre-commit` hook that refuses the salvage
      // commit — `#salvage`'s own comment calls this the expected way to get
      // here. The teardown stops, correctly, with the worktree present and
      // dirty and nothing forced.
      const hooks = join(s.repo, '.git', 'hooks');
      await mkdir(hooks, { recursive: true });
      await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

      const thrown = await s.runRecon(completes(), s.newManager()).catch((error: unknown) => error);

      // AC3 made the *occupancy refusal* terminal, and only that one: it is the
      // failure no retry can clear. This one can — a person removes the hook,
      // or the next attempt salvages — so it stays the driver's to log and
      // re-attempt, rather than becoming a node failure that lets the chain
      // compile a plan against the zero facts recon never got to establish.
      expect(thrown).toBeInstanceOf(WipSalvageFailed);
      expect(eventKinds(s.db)).not.toContain('node.failed');
      // Untouched, which is the outcome KAR-07.4 insists on.
      const listed = await s.raw(['worktree', 'list', '--porcelain']);
      expect(listed.stdout).toContain(s.worktreePath);
    } finally {
      s.close();
    }
  });
});
