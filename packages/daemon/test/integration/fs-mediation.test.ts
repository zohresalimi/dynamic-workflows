/**
 * KAR-08.2 — the fs boundary, against real symlinks and a real agent.
 *
 * The unit suite (../../src/services/path-mediation.test.ts) proves the four
 * routes against a filesystem port. What only a real filesystem can prove is
 * that `realpath` behaves the way the port double claims — a symlink to a
 * directory, a symlink to a file, a not-yet-created leaf, and a `/tmp` that is
 * itself a symlink on macOS. And what only a real agent over a real pipe can
 * prove is that a denial is a *rejection the agent survives*: the request
 * fails, the turn carries on, and the next legal write lands.
 *
 * Nothing here reads or writes anything of the user's. The "credentials" file
 * is a synthetic one in the test's own tmpdir, so the exfiltration case is
 * exercised without the machine's real `~/.aws` being anywhere near it.
 *
 * Verifies: EPIC-08-S7, EPIC-08-S8, EPIC-08-S9, EPIC-08-S10 · AC1–AC5, AC7, AC8
 */

import type { EventRecord, IoRecord, LedgerSink } from '@DeFlow/adapters';
import { runAcpNode } from '@DeFlow/adapters';
import {
  type EventSeq,
  type Handle,
  HandleSchema,
  type NodeId,
  NodeIdSchema,
  type PermissionLevel,
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
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  acpFsHandlers,
  createFsService,
  createPathMediator,
  type PathDenial,
  permissionDeniedPayload,
  worktreePathPolicy,
} from '../../src/index.ts';

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

const RUN_ID: RunId = RunIdSchema.parse('run_20260806T101500Z_ac0802');
const NODE_ID: NodeId = NodeIdSchema.parse('n1');
const PROVIDER: ProviderId = ProviderIdSchema.parse('mock');

let dir = '';
let worktree = '';
let outside = '';
let db: ReturnType<typeof openLedger>;
let sink: LedgerSink;
let captureEvidence: (text: string) => Handle;

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', 'n1');
  outside = join(dir, 'outside');
  await mkdir(join(worktree, 'src'), { recursive: true });
  await mkdir(outside, { recursive: true });
  db = openLedger(dir);
  const epoch = readEpoch(db);
  sink = {
    append: (event: EventRecord) =>
      Promise.resolve(
        appendEvents(db, [
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
        appendIoChunk(db, {
          runId: RUN_ID,
          nodeId: chunk.nodeId,
          attempt: chunk.attempt + 1,
          stream: chunk.stream,
          ts: chunk.ts,
          data: chunk.data,
        }),
      ),
  };
  captureEvidence = (text: string): Handle =>
    HandleSchema.parse(blobHandle(spillBytes(dir, Buffer.from(text, 'utf8'), 'text/plain').sha256));
});

afterEach(async () => {
  db.close();
  await removeTempDir(dir);
});

const scopeFor = (): PermissionScope => ({
  worktree,
  allowlist: ['git', 'pnpm'],
  readOnlyCommands: ['git status'],
  allowedDomains: [],
});

/** The mediator as the daemon builds it: the real filesystem, the real home. */
const realMediator = (level: PermissionLevel = 'worktree') =>
  createPathMediator({ level, scope: scopeFor() });

const verdict = async (
  level: PermissionLevel,
  method: 'fs/read_text_file' | 'fs/write_text_file',
  path: string,
): Promise<string> => {
  const result = await realMediator(level).mediate(method, path);
  if (result.outcome === 'allow') return 'allow';
  const { code, detail } = result.denial.reason;
  return detail === undefined ? code : `${code}:${detail}`;
};

suite('EPIC-08-S8 — real symlinks on a real filesystem', () => {
  it('denies a write through a symlink pointing out of the worktree', async () => {
    await symlink(outside, join(worktree, 'link'), 'dir');

    expect(await verdict('worktree', 'fs/write_text_file', join(worktree, 'link', 'x.txt'))).toBe(
      'path-escape:symlink',
    );
    // "And <tmp>/outside/x.txt does not exist afterwards."
    await expect(stat(join(outside, 'x.txt'))).rejects.toThrow();
  });

  it('denies the lexically-inside, realpath-outside case', async () => {
    await symlink(outside, join(worktree, 'a'), 'dir');
    const requested = join(worktree, 'a', 'passwd');

    // path.resolve() alone reports it as inside…
    expect(requested.startsWith(`${worktree}/`)).toBe(true);
    // …and the realpath check is the one that catches it.
    expect(await verdict('worktree', 'fs/write_text_file', requested)).toBe('path-escape:symlink');
  });

  it('denies a write to a symlinked *file* whose target is outside', async () => {
    await writeFile(join(outside, 'target.txt'), 'outside\n');
    await symlink(join(outside, 'target.txt'), join(worktree, 'sneaky.txt'));

    expect(await verdict('worktree', 'fs/write_text_file', join(worktree, 'sneaky.txt'))).toBe(
      'path-escape:symlink',
    );
  });

  it('allows a symlink that stays inside', async () => {
    await symlink(join(worktree, 'src'), join(worktree, 'inner'), 'dir');

    expect(await verdict('worktree', 'fs/write_text_file', join(worktree, 'inner', 'a.ts'))).toBe(
      'allow',
    );
  });

  it('allows a path whose parent does not exist yet', async () => {
    expect(
      await verdict('worktree', 'fs/write_text_file', join(worktree, 'new', 'dir', 'a.ts')),
    ).toBe('allow');
  });

  it('allows an ordinary write into a tmpdir whose root is itself a symlink', async () => {
    // macOS: /var is a symlink to /private/var, so a containment check that
    // realpath'd the target but not the root would deny every write DeFlow
    // makes on a developer's laptop.
    expect(await verdict('worktree', 'fs/write_text_file', join(worktree, 'src', 'a.ts'))).toBe(
      'allow',
    );
  });
});

suite('EPIC-08-S9 — containment follows the filesystem’s own case rule', () => {
  it('agrees with what the filesystem actually does about case', async () => {
    const shouted = worktree.replace(/\/wt\/n1$/, '/WT/n1');
    const sameDirectory = await stat(shouted).then(
      (flipped) => stat(worktree).then((plain) => flipped.ino === plain.ino),
      () => false,
    );

    expect(await verdict('worktree', 'fs/write_text_file', join(shouted, 'src', 'a.ts'))).toBe(
      sameDirectory ? 'allow' : 'path-escape:absolute',
    );
  });
});

// ── through the ACP boundary, with a real agent ──────────────────────────────

/** One `fs/*` call per entry, each with an onError branch that names itself,
 * so the transcript says which way every one of them went. */
async function scenario(
  calls: readonly {
    readonly method: 'fs/read_text_file' | 'fs/write_text_file';
    readonly path: string;
  }[],
): Promise<string> {
  const path = join(dir, 'fs-mediation.json');
  await writeFile(
    path,
    JSON.stringify({
      name: 'fs-mediation',
      steps: calls.map((call, index) => ({
        type: 'clientCall',
        method: call.method,
        params:
          call.method === 'fs/write_text_file'
            ? { path: call.path, content: `written by the agent ${index}\n` }
            : { path: call.path },
        onError: { steps: [{ type: 'message', text: `denied:${index} {{error}}` }] },
      })),
      stopReason: 'end_turn',
    }),
  );
  return path;
}

async function runWith(
  scenarioPath: string,
  level: PermissionLevel,
  denials: PathDenial[],
): Promise<Awaited<ReturnType<typeof runAcpNode>>> {
  const clock = new TestClock();
  const fs = createFsService({
    root: worktree,
    policy: worktreePathPolicy(createPathMediator({ level, scope: scopeFor() }), {
      onDenied: (denial) => {
        denials.push(denial);
        void sink.append({
          kind: 'permission.denied',
          v: 1,
          ts: clock.now(),
          nodeId: NODE_ID,
          attempt: 0,
          payload: permissionDeniedPayload(denial, { node: NODE_ID, attempt: 0 }),
        });
      },
    }),
  });

  return runAcpNode(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      provider: PROVIDER,
      permission: level,
      worktree,
      binary: { path: MOCK_AGENT_BIN, version: '0.0.0', sha256: 'c'.repeat(64) },
      argv: ['--seed', '42', '--scenario', scenarioPath],
      mcpServers: [],
      prompt: 'go',
    },
    {
      clock,
      ledger: sink,
      captureEvidence,
      handlers: acpFsHandlers(fs),
      // The tee, so the *rejection frame itself* can be read back rather than
      // inferred from the fact that the agent took its error branch.
      record: { DeFlow_RECORD: '1', DeFlow_RECORD_DIR: join(dir, 'rec'), DeFlow_RECORD_CASE: 'fs' },
    },
  );
}

/** Every JSON-RPC error response DeFlow put on the wire, in order. */
async function rejectionFrames(): Promise<
  { readonly code: number; readonly data?: { readonly reason?: unknown } }[]
> {
  const text = await readFile(join(dir, 'rec', 'mock@0.0.0', 'fs.ndjson'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as { msg?: { error?: { code: number; data?: never } } })
    .flatMap((entry) => (entry.msg?.error === undefined ? [] : [entry.msg.error]));
}

const transcript = (outcome: Awaited<ReturnType<typeof runAcpNode>>): string =>
  outcome.status === 'completed' ? ((outcome.result.output as { text: string }).text ?? '') : '';

const events = (kind: string): { readonly payload: unknown }[] =>
  readRange(db, RUN_ID, 0, 500).events.filter((event) => event.kind === kind);

suite('EPIC-08-S7/S8/S9 — all four routes, over the wire, and the session survives', () => {
  it('rejects each escape, keeps the turn alive, and lets the legal write land', async () => {
    await symlink(outside, join(worktree, 'link'), 'dir');
    const denials: PathDenial[] = [];

    const outcome = await runWith(
      await scenario([
        { method: 'fs/write_text_file', path: '../../../etc/passwd' },
        { method: 'fs/write_text_file', path: join(worktree, 'link', 'x.txt') },
        { method: 'fs/write_text_file', path: join(outside, 'absolute.txt') },
        { method: 'fs/write_text_file', path: join(worktree, 'ok.txt') },
      ]),
      'worktree',
      denials,
    );

    // AC8 — a denial is a rejection, not a teardown.
    expect(outcome.status).toBe('completed');
    expect(outcome.exit).toEqual({ code: 0, signal: null });
    expect(transcript(outcome)).toContain('denied:0');
    expect(transcript(outcome)).toContain('denied:1');
    expect(transcript(outcome)).toContain('denied:2');
    expect(transcript(outcome)).not.toContain('denied:3');
    // AC7 — and the rejection that crossed the wire named the route, so the
    // agent (and the transcript) can tell the three refusals apart.
    expect(transcript(outcome)).toContain('path-escape:traversal');
    expect(transcript(outcome)).toContain('path-escape:symlink');
    expect(transcript(outcome)).toContain('path-escape:absolute');

    // AC1/AC2/AC3 — and no filesystem write occurred for any of the three.
    expect(denials.map((denial) => denial.reason.detail)).toEqual([
      'traversal',
      'symlink',
      'absolute',
    ]);
    await expect(stat(join(outside, 'x.txt'))).rejects.toThrow();
    await expect(stat(join(outside, 'absolute.txt'))).rejects.toThrow();
    expect(await readFile(join(worktree, 'ok.txt'), 'utf8')).toBe('written by the agent 3\n');
  });

  it('records a structured permission.denied for every rejection', async () => {
    const denials: PathDenial[] = [];
    await runWith(
      await scenario([{ method: 'fs/write_text_file', path: '../../../etc/passwd' }]),
      'worktree',
      denials,
    );

    // AC7, first half: the rejection that went back is an ordinary JSON-RPC
    // error carrying the structured reason on `data` — not a torn-down
    // connection, and not a prose message the UI would have to parse.
    expect(await rejectionFrames()).toEqual([
      expect.objectContaining({
        code: -32602,
        data: expect.objectContaining({ reason: { code: 'path-escape', detail: 'traversal' } }),
      }),
    ]);

    const recorded = events('permission.denied');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.payload).toEqual({
      node: 'n1',
      attempt: 0,
      permission: 'worktree',
      method: 'fs/write_text_file',
      requested: '../../../etc/passwd',
      reason: { code: 'path-escape', detail: 'traversal' },
    });
  });
});

suite('EPIC-08-S10 — a read node cannot exfiltrate through fs/read_text_file', () => {
  it('denies the read and never puts the secret anywhere the agent can see it', async () => {
    const secret = join(outside, 'credentials');
    await writeFile(secret, 'aws_secret_access_key = totally-synthetic\n');
    await writeFile(join(worktree, 'src', 'a.ts'), 'export const a = 1;\n');
    const denials: PathDenial[] = [];

    const outcome = await runWith(
      await scenario([
        { method: 'fs/read_text_file', path: secret },
        { method: 'fs/read_text_file', path: join(worktree, 'src', 'a.ts') },
      ]),
      'read',
      denials,
    );

    expect(outcome.status).toBe('completed');
    expect(transcript(outcome)).toContain('denied:0');
    expect(transcript(outcome)).not.toContain('totally-synthetic');
    expect(denials.map((denial) => denial.method)).toEqual(['fs/read_text_file']);
    // The read *inside* the worktree is the whole point of the level.
    expect(transcript(outcome)).not.toContain('denied:1');
  });
});
