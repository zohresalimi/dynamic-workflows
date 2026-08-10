/**
 * KAR-12.5 test plan #12 / EPIC-12-S29 — the surgical repair loop, end to end,
 * and the `gate-failure-repair` fixture as its output.
 *
 * e2e rather than integration because the claim is about a **run**: a gate that
 * fails, the fix node the failure earns, the two commits that fix node makes,
 * the gate set re-run from the deterministic tier, and the pass — in that order,
 * in one ledger, driven by DeFlowd's own executor in its own process. Four
 * separate programs are load-bearing and none of them is a double:
 *
 *   1. a real `git`, holding the run's repository and the fix node's worktree;
 *   2. a real `tsc`, spawned by the gate runner over a real type error, and
 *      again at each commit the fix node made;
 *   3. a real agent process on the other side of a real ACP pipe, writing files
 *      and running commands through DeFlowd's own `fs` and `terminal` services;
 *   4. the run itself — `node packages/daemon/scripts/build-gate-repair-fixture.ts`
 *      — in a child process, holding the ledger's lease while it works.
 *
 * The assertions are asked of the ledger the run wrote, never of the script's
 * own report: the ordering claim is two `gate.evaluated` seqs, and the milestone
 * claim is the same comparison the rule makes — *"a `pass` recorded at a ledger
 * offset after the last write"*.
 *
 * Verifies: EPIC-12-S29 · AC1, AC4, AC5 · test plan #12
 */
import { RunIdSchema } from '@DeFlow/core';
import { openRead, readRange } from '@DeFlow/ledger';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import { repoRoot } from './support/daemon.ts';

const BUILDER = join(repoRoot, 'packages/daemon/scripts/build-gate-repair-fixture.ts');

/** The run the fixture belongs to — fixed, so this spec reads it without
 * discovering it first. */
const RUN = RunIdSchema.parse('run_20260810T090000Z_9f31ab');

/** Where the run is built. Synthetic and under `/tmp`, because every absolute
 * path a run records ends up in the ledger this spec then reads. */
const WORK_DIR = '/tmp/deflow-gate-failure-repair-e2e';

interface LedgerEvent {
  readonly seq: number;
  readonly kind: string;
  readonly nodeId: string | null;
  readonly payload: Record<string, unknown>;
}

let outDir = '';
let events: LedgerEvent[] = [];
let summary: Record<string, unknown> = {};

/** Builds the fixture in its own process, and answers what it printed. */
function build(out: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [BUILDER, out, WORK_DIR], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(stdout.join(''));
      else reject(new Error(`the fixture builder exited ${String(code)}\n${stderr.join('')}`));
    });
  });
}

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), 'DeFlow-repair-'));
  await build(outDir);

  const db = openRead(join(outDir, 'ledger.db'));
  try {
    events = readRange(db, RUN, 0, 5_000).events.map((event) => ({
      seq: event.seq,
      kind: event.kind,
      nodeId: event.nodeId ?? null,
      payload: event.payload as Record<string, unknown>,
    }));
  } finally {
    db.close();
  }
  summary = JSON.parse(readFileSync(join(outDir, 'repair.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}, 600_000);

afterAll(async () => {
  if (outDir !== '') await rm(outDir, { recursive: true, force: true });
  await rm(WORK_DIR, { recursive: true, force: true });
});

const verdicts = (): { gate: string; outcome: string; seq: number }[] =>
  events
    .filter((event) => event.kind === 'gate.evaluated')
    .map((event) => {
      const payload = event.payload as { gate: string; verdict: { outcome: string } };
      return { gate: payload.gate, outcome: payload.verdict.outcome, seq: event.seq };
    });

const fixNode = (): string => String(summary.fixNode);

suite('EPIC-12-S29 — one finding, a regression test first, and a re-run from the top', () => {
  it('records exactly two verdicts for the same gate: a fail, then a pass', () => {
    expect(verdicts().map((verdict) => `${verdict.gate}:${verdict.outcome}`)).toEqual([
      'typecheck:fail',
      'typecheck:pass',
    ]);
  });

  it('earns exactly one fix node, named for the finding, from a committed plan version', () => {
    const failed = events.find((event) => event.kind === 'gate.evaluated');
    const finding = (failed?.payload as { verdict: { findings: { id: string }[] } }).verdict
      .findings[0];

    expect(finding?.id).toBeTruthy();
    expect(fixNode()).toBe(`fix-${String(finding?.id)}`);

    // AC1 — the fix node arrives through the plan, not around it: a repair with
    // no version behind it is invisible in the plan scrubber.
    const patched = events.filter((event) => event.kind === 'plan.patched');
    expect(patched).toHaveLength(2);
    expect((patched[0]?.payload as { decision: { decision: string } }).decision.decision).toBe(
      'auto',
    );

    // And it really ran: `node.completed` for the fix node, once.
    expect(
      events.filter((event) => event.kind === 'node.completed' && event.nodeId === fixNode()),
    ).toHaveLength(1);
  });

  it('re-runs the gate as a fresh node that waits for the fix, not as the node that failed', () => {
    const gateNodes = events
      .filter((event) => event.kind === 'gate.evaluated')
      .map((event) => event.nodeId);

    // AC5 — the second verdict comes from a different node, because a gate node
    // that answered `fail` is answered for ever.
    expect(gateNodes[0]).toBe('gate-typecheck');
    expect(gateNodes[1]).toBe(String(summary.rerunNode));
    expect(gateNodes[1]).not.toBe(gateNodes[0]);

    // It was scheduled after the fix node finished, and never before it.
    const fixDone = events.find(
      (event) => event.kind === 'node.completed' && event.nodeId === fixNode(),
    );
    const rerunStarted = events.find(
      (event) => event.kind === 'node.started' && event.nodeId === String(summary.rerunNode),
    );
    expect(fixDone?.seq).toBeLessThan(rerunStarted?.seq ?? 0);
  });

  it('advances the milestone: the pass is recorded after the last write', () => {
    const pass = verdicts()[1];
    const fixDone = events.find(
      (event) => event.kind === 'node.completed' && event.nodeId === fixNode(),
    );

    // The milestone rule's own comparison, on `seq` and never on `ts`
    // (docs/10-verification-gates.md §1).
    expect(pass?.outcome).toBe('pass');
    expect(pass?.seq).toBeGreaterThan(fixDone?.seq ?? Number.POSITIVE_INFINITY);
    expect(events.at(-1)?.kind).toBe('run.completed');
  });

  it('shows the ordering on the branch: a test commit that fails, then a fix that passes', () => {
    const commits = summary.commits as { paths: string[]; outcome: string }[];

    // AC4 — read off `DeFlow/<runId>__<nodeId>` by re-running the gate at each
    // commit, which is the only way to tell "the agent wrote the test first"
    // from "the agent said it did".
    expect(commits).toHaveLength(2);
    expect(commits[0]?.paths).toEqual(['test/days-until.test.ts']);
    expect(commits[0]?.outcome).toBe('fail');
    expect(commits[1]?.paths).toEqual(['src/date-picker.ts']);
    expect(commits[1]?.outcome).toBe('pass');
  });

  it('is the run the committed fixture holds — rebuilt, not remembered', () => {
    // The drift check. `test/fixtures/runs/gate-failure-repair/` is what
    // EPIC-16 and EPIC-17 develop against; a committed binary nothing rebuilds
    // is a fixture that quietly stops resembling what DeFlow writes, and then
    // the view is developed against a shape production no longer produces.
    // Every field compared here is derived from the run, and the commit ids are
    // reproducible because the fix node declares its own hermetic git
    // environment rather than inheriting a developer's.
    const committed = JSON.parse(
      readFileSync(join(repoRoot, 'test/fixtures/runs/gate-failure-repair/repair.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(summary).toEqual(committed);
  });

  it('carries no machine-local path into the fixture it exports', () => {
    // The fixture is committed, so a home directory in a payload is a privacy
    // leak with a long half-life. Every absolute path in it is `/tmp/...` by
    // construction; this is the assertion that keeps it that way.
    const paths = JSON.stringify(events);

    expect(paths).not.toContain('/Users/');
    expect(paths).not.toContain('/home/');
    expect(paths).toContain(WORK_DIR);
  });
});
