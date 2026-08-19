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
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { Git } from '../../src/git/git.ts';
import { WorkspaceManager, WorktreeCreateFailed } from '../../src/git/worktree-manager.ts';
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
  const manager = new WorkspaceManager({
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

  const worktreePath = join(repo, '.DeFlow', 'wt', `${RUN}__${RECON}`);
  const putSurvey = (bytes: Uint8Array): Handle =>
    HandleSchema.parse(blobHandle(spillBytes(root, Buffer.from(bytes), 'application/json').sha256));
  const captureEvidence = (text: string): Handle =>
    HandleSchema.parse(
      blobHandle(spillBytes(root, Buffer.from(text, 'utf8'), 'text/plain').sha256),
    );

  const runRecon = (agent: ReconAgent) =>
    runReconNode({
      db,
      runId: RUN,
      node: RECON,
      attempt: 0,
      epoch: EPOCH,
      ts: T0,
      provider: 'mock',
      model: 'mock-1',
      workspace: manager,
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

  return {
    root,
    repo,
    db,
    manager,
    worktreeCalls,
    worktreePath,
    runRecon,
    close: () => db.close(),
  };
}

const eventKinds = (db: Db): string[] =>
  readRange(db, RUN, 0, 500).events.map((event) => event.kind);

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
