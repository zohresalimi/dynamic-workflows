/**
 * KAR-10.5 AC1 — recon runs detached, locked and read-only (EPIC-10-S26).
 *
 * Two halves, both against something real.
 *
 * The **git half** is real `git`, hermetically: the argv DeFlow ran, and what
 * `git worktree list --porcelain -z` says about the result. Detached HEAD is not
 * a stylistic choice — git refuses to check the same branch out twice
 * ([PRD §4.1](../../../../docs/prd.md)'s *"hard practical lesson"*) — and a read
 * node needs no branch, so it claims none. `--force` never appears anywhere on
 * this path.
 *
 * The **permission half** is a real mock agent over a real pipe, reaching back
 * into DeFlow's own `fs/*` handlers inside the recon worktree. That is the
 * ACP-client dividend [14 §10](../../../../docs/14-testing-strategy.md)
 * describes: because DeFlow implements `fs/*` itself, the ladder is one policy
 * function in DeFlow's own code and the scenario needs no vendor. The rule under
 * test is not only "the write was denied" but "the turn reached its own end,
 * having been denied" — a recon agent that probes and is told no is behaving
 * correctly, and killing the node on the first refusal would make `read`
 * unusable for exactly the node type that reads for a living.
 *
 * Verifies: EPIC-10-S26 · AC1 · test plan #3, #4
 */
import type { LedgerSink } from '@DeFlow/adapters';
import { runAcpNode } from '@DeFlow/adapters';
import type { Db, Handle, NodeId, PermissionScope, ProviderId, RunId } from '@DeFlow/core';
import {
  HandleSchema,
  NodeIdSchema,
  ProviderIdSchema,
  RECON_PERMISSION,
  RunIdSchema,
} from '@DeFlow/core';
import { blobHandle, openLedger, readEpoch, readRange, spillBytes } from '@DeFlow/ledger';
import { GIT_ENV, it, makeRepo, TestClock } from '@DeFlow/testkit';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { Git } from '../../src/git/git.ts';
import { worktreePathFor } from '../../src/git/worktree-args.ts';
import { WorkspaceManager } from '../../src/git/worktree-manager.ts';
import {
  acpFsHandlers,
  acpTerminalHandlers,
  buildChildEnv,
  createCommandMediator,
  createFsService,
  createPathMediator,
  createTerminalService,
  permissionDeniedPayload,
  worktreeCommandPolicy,
  worktreePathPolicy,
} from '../../src/index.ts';
import { reconProvisionRequest } from '../../src/recon/recon.ts';
import { sqliteLedgerSink } from './support/ledger.ts';

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

const RUN: RunId = RunIdSchema.parse('run_20260807T101500Z_ac1026');
const RECON: NodeId = NodeIdSchema.parse('recon');
const PROVIDER: ProviderId = ProviderIdSchema.parse('mock');
const T0 = 1_754_380_800_000;
const EPOCH = 4;

interface Scene {
  readonly root: string;
  readonly repo: string;
  readonly db: Db;
  readonly manager: WorkspaceManager;
  readonly calls: string[][];
  close(): void;
}

async function scene(tmp: string): Promise<Scene> {
  const root = await realpath(tmp);
  const repo = join(root, 'repo');
  await makeRepo({
    dir: repo,
    files: {
      'package.json': '{\n  "name": "ui",\n  "scripts": {\n    "test": "vitest run"\n  }\n}\n',
      // The gitignored directory EPIC-10-S26's last scenario is about.
      '.gitignore': 'node_modules/\n',
    },
  });

  const wrapped = new Git(repo, { env: GIT_ENV });
  const calls: string[][] = [];
  const db = openLedger(root);
  const manager = new WorkspaceManager({
    git: {
      run: (args, opts) => {
        calls.push([...args]);
        return wrapped.run(args, opts);
      },
    },
    db,
    clock: new TestClock(T0),
    epoch: EPOCH,
  });

  return { root, repo, db, manager, calls, close: () => db.close() };
}

const worktreeCalls = (s: Scene): string[][] => s.calls.filter((argv) => argv[0] === 'worktree');

suite('EPIC-10-S26 — the worktree is detached and locked at creation (test plan #3)', () => {
  it('runs §4.1 verbatim and creates no branch for the read node', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      const path = worktreePathFor(s.repo, RUN, RECON);
      await s.manager.provision(
        reconProvisionRequest({ runId: RUN, nodeId: RECON, path, baseRef: 'main' }),
      );

      expect(worktreeCalls(s)).toEqual([
        [
          'worktree',
          'add',
          '--detach',
          '--lock',
          '--reason',
          `DeFlow run=${RUN} node=${RECON}`,
          path,
          'main',
        ],
      ]);
      // AC1 — a read node needs no occupancy pre-check, and no --force ever.
      expect(s.calls.flat()).not.toContain('--force');
      expect(s.calls.flat()).not.toContain('-f');

      // git's own view: detached, and locked with DeFlow's reason.
      const resolved = await realpath(path);
      const entries = await s.manager.list();
      const recon = entries.find((entry) => entry.path === resolved);
      expect(recon?.detached).toBe(true);
      expect(recon?.locked).toBe(true);
      expect(recon?.lockReason).toBe(`DeFlow run=${RUN} node=${RECON}`);
      expect(recon?.branch).toBeNull();

      // No ref was created for it, and the main working copy is untouched.
      const refs = await new Git(s.repo, { env: GIT_ENV }).run(['branch', '--list', '--all']);
      expect(refs.stdout).not.toContain(`DeFlow/${RUN}__${RECON}`);
      // Not one tracked file moved. The only thing that appeared in the main
      // checkout is DeFlow's own `.DeFlow/wt/` directory, which is DeFlow's
      // state rather than the operator's work — and is why D13 puts it there.
      const tracked = await new Git(s.repo, { env: GIT_ENV }).run([
        'status',
        '--porcelain',
        '--untracked-files=no',
      ]);
      expect(tracked.stdout.trim()).toBe('');
      const all = await new Git(s.repo, { env: GIT_ENV }).run(['status', '--porcelain']);
      expect(all.stdout.trim()).toBe('?? .DeFlow/');
    } finally {
      s.close();
    }
  });

  it('removes cleanly even though the worktree holds a gitignored node_modules/', async ({
    tmp,
  }) => {
    const s = await scene(tmp);
    try {
      const path = worktreePathFor(s.repo, RUN, RECON);
      await s.manager.provision(
        reconProvisionRequest({ runId: RUN, nodeId: RECON, path, baseRef: 'main' }),
      );
      await mkdir(join(path, 'node_modules', 'left-pad'), { recursive: true });
      await writeFile(join(path, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1;\n');

      await s.manager.remove({ runId: RUN, nodeId: RECON, path });

      await expect(stat(path)).rejects.toThrow();
      expect(s.calls.flat()).not.toContain('--force');
    } finally {
      s.close();
    }
  });
});

/* -------------------------------------------------------------------------- *
 * The permission half — a real agent process inside the recon worktree
 * -------------------------------------------------------------------------- */

interface Observed {
  readonly denials: string[];
}

async function scenarioFile(root: string, worktree: string): Promise<string> {
  const path = join(root, 'recon.json');
  await writeFile(
    path,
    JSON.stringify({
      name: 'recon-read-only',
      steps: [
        {
          type: 'clientCall',
          method: 'fs/read_text_file',
          params: { path: join(worktree, 'package.json') },
          onError: { steps: [{ type: 'message', text: 'read-denied {{error}}' }] },
        },
        {
          type: 'clientCall',
          method: 'fs/write_text_file',
          params: { path: join(worktree, 'SURVEY.md'), content: 'the recon agent wrote this\n' },
          onError: { steps: [{ type: 'message', text: 'write-denied {{error}}' }] },
        },
        { type: 'message', text: 'survey continues' },
      ],
      stopReason: 'end_turn',
    }),
  );
  return path;
}

suite('EPIC-10-S26 — writes are refused inside the recon worktree (test plan #4)', () => {
  it('denies fs/write_text_file at read, records it, and the node continues', async ({ tmp }) => {
    const s = await scene(tmp);
    const clock = new TestClock(T0);
    try {
      const path = worktreePathFor(s.repo, RUN, RECON);
      await s.manager.provision(
        reconProvisionRequest({ runId: RUN, nodeId: RECON, path, baseRef: 'main' }),
      );
      const worktree = await realpath(path);

      const sink: LedgerSink = sqliteLedgerSink({ db: s.db, runId: RUN, epoch: readEpoch(s.db) });
      const captureEvidence = (text: string): Handle =>
        HandleSchema.parse(
          blobHandle(spillBytes(s.root, Buffer.from(text, 'utf8'), 'text/plain').sha256),
        );

      const scope: PermissionScope = {
        worktree,
        allowlist: ['git', 'node'],
        readOnlyCommands: ['git status', 'git log', 'ls', 'cat'],
        allowedDomains: [],
        scrubbedEnv: [],
      };
      const observed: Observed = { denials: [] };
      const record = (denial: { reason: { code: string; detail?: string } }) => {
        observed.denials.push(denial.reason.code);
        void sink.append({
          kind: 'permission.denied',
          v: 1,
          ts: clock.now(),
          nodeId: RECON,
          attempt: 0,
          payload: permissionDeniedPayload(denial as never, { node: RECON, attempt: 0 }),
        });
      };

      const fs = createFsService({
        root: worktree,
        policy: worktreePathPolicy(createPathMediator({ level: RECON_PERMISSION, scope }), {
          onDenied: record,
        }),
      });
      const terminal = createTerminalService({
        root: worktree,
        childEnv: buildChildEnv({
          base: process.env,
          loginPath: process.env.PATH ?? '',
          tmpdir: s.root,
        }).env,
        policy: worktreeCommandPolicy(createCommandMediator({ level: RECON_PERMISSION, scope }), {
          onDenied: record,
        }),
      });

      const outcome = await runAcpNode(
        {
          runId: RUN,
          nodeId: RECON,
          attempt: 0,
          provider: PROVIDER,
          permission: RECON_PERMISSION,
          worktree,
          binary: { path: MOCK_AGENT_BIN, version: '0.0.0', sha256: 'd'.repeat(64) },
          argv: ['--seed', '42', '--scenario', await scenarioFile(s.root, worktree)],
          mcpServers: [],
          prompt: 'Survey this repository and report what you find.',
        },
        {
          clock,
          ledger: sink,
          captureEvidence,
          handlers: { ...acpFsHandlers(fs), ...acpTerminalHandlers(terminal) },
        },
      );

      expect(outcome.status).toBe('completed');
      if (outcome.status !== 'completed') return;
      const text = (outcome.result.output as { text: string }).text;
      expect(text).toContain('write-denied');
      expect(text).toContain('survey continues');
      expect(text).not.toContain('read-denied');

      // No bytes reached the worktree, and the refusal is on the ledger.
      await expect(stat(join(worktree, 'SURVEY.md'))).rejects.toThrow();
      expect(observed.denials).toEqual(['level-read']);
      const denied = readRange(s.db, RUN, 0, 500).events.filter(
        (event) => event.kind === 'permission.denied',
      );
      expect(denied).toHaveLength(1);
      expect((denied[0]?.payload as { permission: string }).permission).toBe('read');

      // The repository itself never saw the attempt either.
      expect(await readFile(join(s.repo, 'package.json'), 'utf8')).toContain('vitest run');
    } finally {
      s.close();
    }
  });
});
