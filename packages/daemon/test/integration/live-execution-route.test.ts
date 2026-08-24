/**
 * KAR-23.5 — an execution node is driven down the route this machine can
 * actually serve.
 *
 * **The test that would have caught the 2026-08-24 incident.** On the first
 * real end-to-end execution, `chooseProvider` resolved claude with the *shim*
 * route and `liveAgentPerformer` spoke ACP JSON-RPC at the plain vendor CLI
 * anyway. The children never handshook: no `provider.session_opened`, no
 * terminal event, `run.stalled` as a false positive, and — because no `process`
 * row was ever written — a cooperative cancel that could not reach them, so
 * they outlived the run.
 *
 * Every one of those symptoms is a claim about a **process**, which is why
 * nothing here is scripted below the performer. `perform` comes from
 * `createLiveRunExecution` — the production performer, which no daemon spec
 * drove before this one — over a real fake vendor CLI on a real `PATH` root,
 * spawned with the environment `buildChildEnv` really builds. The three
 * pre-execution turns stay scripted, exactly as `./live-execution.test.ts`
 * scripts them: what is under test is the node, not the chain.
 *
 * The fake validates its own argv (`decideCli`), so a wrongly-shaped
 * `--session-id` or a `--json-schema` carrying a path where the vendor wants a
 * document exits non-zero before a byte of transcript. Completion is therefore
 * evidence about the invocation and not only about the parser.
 *
 * The scene itself lives in `./support/live-scene.ts` since KAR-23.10, because
 * `./live-permission-mediation.test.ts` drives the same production performer
 * and a second copy of the assembly would be a second thing to keep true.
 *
 * Verifies: KAR-23.5 — the shim route reaches `runShimNode`, the ACP route
 * spawns the *adapter* binary, an unservable route refuses in the ledger, and a
 * shim child dies with its run.
 */

import { readIoChunks, readProcesses, replayRun } from '@DeFlow/ledger';
import { it, waitFor } from '@DeFlow/testkit';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { systemClock } from '../../src/clock.ts';
import { killRun } from '../../src/kill-switch.ts';
import {
  driveToPlan,
  eventsOf,
  kinds,
  NODE,
  scene,
  WRITE_NODE_PLAN,
} from './support/live-scene.ts';

/** A turn that ignores SIGTERM and never ends on its own. */
const WEDGED_SCENARIO = JSON.stringify({
  name: 'shim-execution-wedged',
  description: 'Installs a no-op SIGTERM handler and then never exits, so only SIGKILL ends it.',
  ignoreSigterm: true,
  hangForever: true,
});

// ── (a) the shim route reaches runShimNode ───────────────────────────────────

suite('KAR-23.5 — a shim-routed execution node runs through the shim', () => {
  it('opens a minted session, streams io and completes the node', async ({ tmp }) => {
    const s = await scene(tmp);
    try {
      await driveToPlan(s);

      const started = eventsOf(s.db, s.runId, 'node.started').find((e) => e.nodeId === NODE);
      expect(
        started,
        `the execution node never started: ${kinds(s.db, s.runId).join(' → ')}`,
      ).toBeDefined();

      // The uuid DeFlow minted, on the path where DeFlow mints it. `origin` is
      // what tells a reader which of the two adapter paths produced the id.
      expect(started?.payload).toMatchObject({
        session: { origin: 'minted' },
        binary: { path: join(s.binDir, 'claude') },
      });
      expect((started?.payload as { session: { id: string } }).session.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );

      // The transcript reached the data plane, under the 1-based attempt the
      // data plane counts in.
      const page = readIoChunks(s.db, { runId: s.runId, nodeId: NODE, attempt: 1 }, 0, 200);
      const transcript = page.chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join('');
      expect(transcript).toContain('reading packages/ui');

      // …and the control plane carries the shim's own phases, which only
      // `runShimNode` writes.
      const phases = eventsOf(s.db, s.runId, 'node.progress').map(
        (event) => (event.payload as { phase?: string }).phase,
      );
      expect(phases).toContain('shim.assistant');
      expect(phases).toContain('shim.result');

      // The node concluded, the spend landed, and the run said which end it
      // reached — the three things the incident's ledger never got.
      expect(eventsOf(s.db, s.runId, 'node.completed').map((e) => e.nodeId)).toContain(NODE);
      expect(kinds(s.db, s.runId)).toContain('budget.consumed');
      expect(replayRun(s.db, s.runId).state.status).toBe('completed');

      // Nothing is left holding a process row.
      expect(readProcesses(s.db).filter((row) => row.state === 'live')).toEqual([]);
    } finally {
      s.close();
    }
  });
});

// ── (b) the shim child dies with its run ─────────────────────────────────────

suite('KAR-23.5 — the kill switch reaches a shim child', () => {
  it('records the process group and kills it', async ({ tmp }) => {
    const s = await scene(tmp, { scenario: WEDGED_SCENARIO });
    try {
      // Not awaited: the child never exits on its own, so the claim is about
      // what the rest of the daemon can do while it is genuinely in flight.
      const driving = driveToPlan(s);

      await waitFor(
        () => readProcesses(s.db).some((row) => row.runId === s.runId && row.state === 'live'),
        { describe: 'a live process row for the shim child', timeoutMs: 20_000 },
      );
      const live = readProcesses(s.db).find((row) => row.runId === s.runId);
      expect(live?.nodeId).toBe(NODE);

      const report = await killRun(s.runId, {
        db: s.db,
        clock: systemClock,
        epoch: s.epoch,
        termGraceMs: 250,
        killGraceMs: 250,
      });
      // Not `nothing-running`: that is exactly what the incident's kill switch
      // answered while three vendor children were alive.
      expect(report.outcome).toBe('stopped');
      expect(report.survivors).toEqual([]);

      await driving;

      // The node is terminal — which of `node.cancelled` and a
      // `node.failed`-by-signal wins is a race between the canceller and the
      // runner's own `exited`, and both are honest terminals.
      const terminal = kinds(s.db, s.runId).filter(
        (kind) => kind === 'node.cancelled' || kind === 'node.failed',
      );
      expect(terminal.length).toBeGreaterThan(0);
      expect(readProcesses(s.db).filter((row) => row.state === 'live')).toEqual([]);
    } finally {
      s.close();
    }
  });
});

// ── (c) the shim route refuses a level DeFlow cannot enforce ─────────────────

suite('KAR-23.5 — the shim route refuses what it may not mediate', () => {
  it('fails a write node before a process exists, on the row the shim mints', async ({ tmp }) => {
    // The incident's exact machine: the probed row is the ACP bridge's — no
    // `mediatedExecution` key, so planning admits a `worktree` node — while the
    // only route this machine can open is the shim.
    const s = await scene(tmp, { plan: WRITE_NODE_PLAN, capabilities: 'acp-bridge' });
    try {
      await driveToPlan(s);

      const failed = eventsOf(s.db, s.runId, 'node.failed').find((e) => e.nodeId === NODE);
      expect(
        failed,
        `a write node on a shim-only machine must not run: ${kinds(s.db, s.runId).join(' → ')}`,
      ).toBeDefined();
      // On the shim, DeFlow is not in front of the vendor's file access at all,
      // so the row it mints says `mediatedExecution: false` and every level
      // above `read` is refused. Passing the permissive probed row here instead
      // would be the silent escalation KAR-05.8 AC8 forbids.
      expect((failed?.payload as { failure: { reason: string } }).failure.reason).toBe(
        'safety.permission-unschedulable',
      );
      // Refused before a spawn: no start, no bytes, no process.
      expect(eventsOf(s.db, s.runId, 'node.started').map((e) => e.nodeId)).not.toContain(NODE);
      expect(
        readIoChunks(s.db, { runId: s.runId, nodeId: NODE, attempt: 1 }, 0, 10).chunks,
      ).toEqual([]);
      expect(readProcesses(s.db).filter((row) => row.state === 'live')).toEqual([]);
      // And the run said which end it reached, rather than wedging.
      expect(replayRun(s.db, s.runId).state.status).not.toBe('running');
    } finally {
      s.close();
    }
  });
});

// ── (d) the ACP route spawns the adapter, not the vendor CLI ─────────────────

suite('KAR-23.5 — the ACP route spawns the ACP binary', () => {
  it('starts the node on claude-agent-acp and never on the vendor CLI', async ({ tmp }) => {
    const s = await scene(tmp, { withAdapter: 'mock-agent' });
    try {
      await driveToPlan(s);

      const started = eventsOf(s.db, s.runId, 'node.started').find((e) => e.nodeId === NODE);
      expect(
        started,
        `the execution node never started: ${kinds(s.db, s.runId).join(' → ')}`,
      ).toBeDefined();
      expect((started?.payload as { binary: { path: string } }).binary.path).toBe(
        join(s.binDir, 'claude-agent-acp'),
      );
      // …and the shim runner was not what ran it: its phases are absent.
      const phases = eventsOf(s.db, s.runId, 'node.progress').map(
        (event) => (event.payload as { phase?: string }).phase ?? '',
      );
      expect(phases.filter((phase) => phase.startsWith('shim.'))).toEqual([]);
      // The attempt concluded rather than hanging, and left no process behind.
      expect(
        kinds(s.db, s.runId).filter((kind) => kind === 'node.completed' || kind === 'node.failed')
          .length,
      ).toBeGreaterThan(0);
      expect(readProcesses(s.db).filter((row) => row.state === 'live')).toEqual([]);
    } finally {
      s.close();
    }
  });
});
