/**
 * KAR-08.7 AC3, AC5 — EPIC-08-S30: a completion-time scope violation, over a
 * real git repository and — in the last suite — a real node.
 *
 * `changedPaths` is the one function in ../../src/services/scope-diff.ts that
 * touches a filesystem, and what only a real `git status` proves is the thing
 * the unit suite cannot: that an untracked file, a modified tracked file and
 * a renamed one all come back as paths this module can compare against a
 * declared scope, from the exact byte layout git actually writes.
 *
 * The final suite is the scenario itself, and it is deliberately not a call to
 * these functions: it drives a **real agent to completion** through
 * `runAcpNode` with `createScopeAudit` wired as the adapter's port, and reads
 * the resulting `node.scope_warning` back off a real ledger. A suite that only
 * called `scopeWarningOf` would pass just as happily with nothing in the
 * running system calling it at all — which is exactly the failure AC3 is
 * about, since the write it catches is the one no request-time check ever saw.
 *
 * Hermetic: `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`, and
 * a forced identity (`@DeFlow/testkit`'s `GIT_ENV`), so a developer's own
 * global config cannot change what this suite proves.
 *
 * Verifies: EPIC-08-S30 · AC3, AC5, AC6
 */
import type { EventRecord, IoRecord, LedgerSink } from '@DeFlow/adapters';
import { runAcpNode } from '@DeFlow/adapters';
import {
  type EventSeq,
  type Handle,
  HandleSchema,
  type NodeId,
  NodeIdSchema,
  NodeScopeWarningSchema,
  type PermissionScope,
  type ProviderId,
  ProviderIdSchema,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';
import {
  appendEvents,
  appendIoChunk,
  blobHandle,
  openLedger,
  readEpoch,
  readRange,
  spillBytes,
} from '@DeFlow/ledger';
import { GIT_ENV, makeRepo, makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  acpFsHandlers,
  createFsService,
  createPathMediator,
  createScopeAudit,
  worktreePathPolicy,
} from '../../src/index.ts';
import { changedPaths, outOfScopePaths, scopeWarningOf } from '../../src/services/scope-diff.ts';

const NODE = NodeIdSchema.parse('implement');

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

const RUN_ID: RunId = RunIdSchema.parse('run_20260807T120000Z_ac0807');
const NODE_ID: NodeId = NodeIdSchema.parse('n1');
const PROVIDER: ProviderId = ProviderIdSchema.parse('mock');

let dir = '';

beforeEach(async () => {
  dir = await makeTempDir();
});

afterEach(async () => {
  await removeTempDir(dir);
});

suite('changedPaths — the real shapes git status --porcelain=v2 -z reports', () => {
  it('finds an untracked file, individually rather than collapsed to its new directory', async () => {
    const repo = await makeRepo({ dir: join(dir, 'r1'), files: { 'src/a.ts': 'export {};\n' } });
    await mkdir(join(repo.dir, 'docs'), { recursive: true });
    await writeFile(join(repo.dir, 'docs', 'readme.md'), '# notes\n');

    expect(await changedPaths(repo.dir, { env: GIT_ENV })).toEqual(['docs/readme.md']);
  });

  it('finds a modified tracked file', async () => {
    const repo = await makeRepo({ dir: join(dir, 'r2'), files: { 'src/a.ts': 'export {};\n' } });
    await writeFile(join(repo.dir, 'src', 'a.ts'), 'export const x = 1;\n');

    expect(await changedPaths(repo.dir, { env: GIT_ENV })).toEqual(['src/a.ts']);
  });

  it('finds both sides of a rename', async () => {
    const repo = await makeRepo({ dir: join(dir, 'r3'), files: { 'src/a.ts': 'export {};\n' } });
    await rename(join(repo.dir, 'src', 'a.ts'), join(repo.dir, 'src', 'b.ts'));
    await repo.git('add', '-A');

    expect(await changedPaths(repo.dir, { env: GIT_ENV })).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('is empty for a clean worktree', async () => {
    const repo = await makeRepo({ dir: join(dir, 'r4'), files: { 'src/a.ts': 'export {};\n' } });

    expect(await changedPaths(repo.dir, { env: GIT_ENV })).toEqual([]);
  });
});

suite('EPIC-08-S30 — a completion-time violation is recorded as a warning', () => {
  it('flags the write that landed outside the declared scope, and only that one', async () => {
    const repo = await makeRepo({ dir: join(dir, 'r5'), files: { 'src/a.ts': 'export {};\n' } });
    await mkdir(join(repo.dir, 'docs'), { recursive: true });
    await writeFile(join(repo.dir, 'docs', 'readme.md'), '# notes\n');
    await writeFile(join(repo.dir, 'src', 'a.ts'), 'export const x = 1;\n');

    const paths = await changedPaths(repo.dir, { env: GIT_ENV });
    const warning = scopeWarningOf(NODE, 0, repo.dir, ['src/**'], paths);

    expect(warning).toEqual({
      node: NODE,
      attempt: 0,
      declared: ['src/**'],
      paths: ['docs/readme.md'],
    });
  });

  it('is null when every change stayed in scope', async () => {
    const repo = await makeRepo({ dir: join(dir, 'r6'), files: { 'src/a.ts': 'export {};\n' } });
    await writeFile(join(repo.dir, 'src', 'a.ts'), 'export const x = 1;\n');

    const paths = await changedPaths(repo.dir, { env: GIT_ENV });

    expect(scopeWarningOf(NODE, 0, repo.dir, ['src/**'], paths)).toBeNull();
  });

  it('normalizes git’s own relative paths the same way as request-time enforcement (AC6)', async () => {
    const repo = await makeRepo({ dir: join(dir, 'r7'), files: { 'src/a.ts': 'export {};\n' } });
    await writeFile(join(repo.dir, 'src', 'a.ts'), 'export const x = 1;\n');

    const paths = await changedPaths(repo.dir, { env: GIT_ENV });

    expect(outOfScopePaths(repo.dir, ['src/**'], paths)).toEqual([]);
  });
});

// ── the scenario itself: a real node, completing (AC3, AC5) ──────────────────

/**
 * The permission scope the daemon builds for a `worktree` node. `pathScope` is
 * deliberately **not** part of it: this suite's whole subject is the write no
 * request-time check ever sees, so the fs front here is KAR-08.2's containment
 * mediation and nothing else — exactly what an adapter that never populates
 * `ToolCallLocation` leaves DeFlow with.
 */
const scopeFor = (worktree: string): PermissionScope => ({
  worktree,
  allowlist: [],
  readOnlyCommands: [],
  allowedDomains: [],
  scrubbedEnv: [],
});

interface Harness {
  readonly worktree: string;
  readonly sink: LedgerSink;
  readonly captureEvidence: (evidence: string | Uint8Array) => Handle;
  /** Every event of the run, in ledger order. */
  readonly events: () => readonly { readonly kind: string; readonly payload: unknown }[];
}

let db: ReturnType<typeof openLedger> | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

/** A real git worktree with one committed file, and a real file-backed ledger
 * beside it — never inside it, or the ledger would be in its own diff. */
async function harness(): Promise<Harness> {
  const worktree = join(dir, 'wt', 'n1');
  await makeRepo({ dir: worktree, files: { 'src/a.ts': 'export {};\n' } });
  const opened = openLedger(dir);
  db = opened;
  const epoch = readEpoch(opened);

  return {
    worktree,
    sink: {
      append: (event: EventRecord) =>
        Promise.resolve(
          appendEvents(opened, [
            {
              runId: RUN_ID,
              ts: event.ts,
              kind: event.kind,
              v: event.v,
              epoch,
              nodeId: event.nodeId,
              attempt: event.attempt,
              ...(event.ikey === undefined ? {} : { ikey: event.ikey }),
              payload: event.payload,
            },
          ])[0] as EventSeq,
        ),
      appendIo: (chunk: IoRecord) =>
        Promise.resolve(
          appendIoChunk(opened, {
            runId: RUN_ID,
            nodeId: chunk.nodeId,
            attempt: chunk.attempt + 1,
            stream: chunk.stream,
            ts: chunk.ts,
            data: chunk.data,
          }),
        ),
    },
    captureEvidence: (evidence) =>
      HandleSchema.parse(
        blobHandle(
          spillBytes(
            dir,
            typeof evidence === 'string' ? Buffer.from(evidence, 'utf8') : Buffer.from(evidence),
            'text/plain',
          ).sha256,
        ),
      ),
    events: () => readRange(opened, RUN_ID, 0, 1000).events,
  };
}

/** An agent that writes the given worktree-relative paths through `fs/*` and
 * finishes — no `session/request_permission`, so nothing carries a
 * `ToolCallLocation` and the request-time check of AC2 never fires. */
async function scenarioWriting(
  worktree: string,
  paths: readonly string[],
  name: string,
): Promise<string> {
  const scenarioPath = join(dir, `${name}.json`);
  await writeFile(
    scenarioPath,
    JSON.stringify({
      name,
      steps: [
        ...paths.map((path) => ({
          type: 'clientCall',
          method: 'fs/write_text_file',
          params: { path: join(worktree, path), content: `written by the agent: ${path}\n` },
          onError: { steps: [{ type: 'message', text: 'denied {{error}}' }] },
        })),
        { type: 'message', text: 'done' },
      ],
      stopReason: 'end_turn',
    }),
  );
  return scenarioPath;
}

async function runNode(
  harnessed: Harness,
  options: {
    readonly declared: readonly string[];
    readonly writes: readonly string[];
    readonly attempt?: number;
  },
): Promise<Awaited<ReturnType<typeof runAcpNode>>> {
  const attempt = options.attempt ?? 0;
  const clock = new TestClock(1_700_000_000_000);
  const scenarioPath = await scenarioWriting(
    harnessed.worktree,
    options.writes,
    `scope-diff-${attempt}`,
  );
  const fs = createFsService({
    root: harnessed.worktree,
    policy: worktreePathPolicy(
      createPathMediator({ level: 'worktree', scope: scopeFor(harnessed.worktree) }),
    ),
  });

  return runAcpNode(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt,
      provider: PROVIDER,
      permission: 'worktree',
      worktree: harnessed.worktree,
      binary: { path: MOCK_AGENT_BIN, version: '0.0.0', sha256: 'b'.repeat(64) },
      argv: ['--seed', '42', '--scenario', scenarioPath],
      mcpServers: [],
      prompt: 'go',
      // What the plan declared this write node would touch (AC1).
      pathScope: options.declared,
    },
    {
      clock,
      ledger: harnessed.sink,
      captureEvidence: harnessed.captureEvidence,
      handlers: acpFsHandlers(fs),
      // The wiring this whole story turns on: the daemon's real git-backed
      // auditor, handed to the adapter that decides a node is finished.
      scopeAudit: createScopeAudit({ env: GIT_ENV }),
    },
  );
}

const kinds = (harnessed: Harness): string[] => harnessed.events().map((event) => event.kind);
const warnings = (harnessed: Harness): unknown[] =>
  harnessed
    .events()
    .filter((event) => event.kind === 'node.scope_warning')
    .map((event) => event.payload);

suite('EPIC-08-S30 — a real node writes out of scope and completes anyway', () => {
  it('records node.scope_warning on completion, and the node still completes', async () => {
    const harnessed = await harness();

    const outcome = await runNode(harnessed, {
      declared: ['src/**'],
      writes: ['docs/readme.md'],
    });

    expect(outcome.status).toBe('completed');
    // The write really did land: nothing at request time stopped it, which is
    // the premise of the whole backstop.
    expect(await readFile(join(harnessed.worktree, 'docs', 'readme.md'), 'utf8')).toContain(
      'written by the agent',
    );

    expect(warnings(harnessed)).toEqual([
      { node: 'n1', attempt: 0, declared: ['src/**'], paths: ['docs/readme.md'] },
    ]);
    // …and in a shape a reader can parse back off the ledger.
    expect(() => NodeScopeWarningSchema.parse(warnings(harnessed)[0])).not.toThrow();
  });

  it('warns rather than gates: no gate, no failure, the terminal event is completion', async () => {
    const harnessed = await harness();

    await runNode(harnessed, { declared: ['src/**'], writes: ['docs/readme.md'] });

    const observed = kinds(harnessed);
    expect(observed).toContain('node.completed');
    expect(observed).not.toContain('node.failed');
    expect(observed.filter((kind) => kind.startsWith('gate.'))).toEqual([]);
    // Named before the ordering is compared: `indexOf` returns -1 for an event
    // that was never appended, and -1 is less than everything — an ordering
    // assertion on its own would pass most loudly when the warning is missing.
    expect(observed).toContain('node.scope_warning');
    // The warning is the node's, so it belongs before the record that ends it.
    expect(observed.indexOf('node.scope_warning')).toBeLessThan(observed.indexOf('node.completed'));
  });

  it('says nothing at all when the agent stayed inside the declared scope', async () => {
    const harnessed = await harness();

    const outcome = await runNode(harnessed, { declared: ['src/**'], writes: ['src/b.ts'] });

    expect(outcome.status).toBe('completed');
    await expect(stat(join(harnessed.worktree, 'src', 'b.ts'))).resolves.toBeDefined();
    expect(warnings(harnessed)).toEqual([]);
  });

  it('accumulates one warning per attempt, queryable per run (AC5)', async () => {
    const harnessed = await harness();

    await runNode(harnessed, { declared: ['src/**'], writes: ['docs/readme.md'], attempt: 0 });
    await runNode(harnessed, { declared: ['src/**'], writes: ['infra/main.tf'], attempt: 1 });

    expect(warnings(harnessed)).toEqual([
      { node: 'n1', attempt: 0, declared: ['src/**'], paths: ['docs/readme.md'] },
      // The second attempt sees the first attempt's file too — it is still
      // uncommitted in the same worktree, and a diff cannot tell who wrote it.
      { node: 'n1', attempt: 1, declared: ['src/**'], paths: ['docs/readme.md', 'infra/main.tf'] },
    ]);
  });
});
