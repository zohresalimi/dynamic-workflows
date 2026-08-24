/**
 * KAR-23.10 — the permission channel, wired, on the route that actually runs
 * nodes.
 *
 * On `run_20260824T143505Z_3a7365` four implementation nodes ran twenty-two
 * minutes and wrote zero files. The agent said why, in its own output:
 *
 *     Tool permission request failed: Error: "Method not found":
 *     session/request_permission
 *
 * It re-verified the finding after a failed write: every non-read tool call
 * failed identically — a `Write` inside a declared write scope, `mkdir -p`,
 * `pnpm install`, `pnpm --version`, `docker info` — while read-only `Bash` kept
 * working. `acpPermissionHandlers` was complete, tested and exported, and
 * **nothing imported it**; so were `acpFsHandlers` and `acpTerminalHandlers`.
 * The whole EPIC-08/EPIC-13 mediation stack — the ladder, the path mediator,
 * the command mediator, the scope diff, the escalation — was unreachable from
 * the execution path. The same shape as KAR-23.5's `runShimNode`.
 *
 * So this file drives the **production** performer, through
 * `createLiveRunExecution`, against the real mock agent over a real process,
 * and asks the two questions that tell the fix apart from a weakening of it:
 *
 *  1. A write **inside** the node's declared `pathScopes.write` is *allowed* —
 *     by the ladder, without a human, and it reaches the disk.
 *  2. A write **outside** it is **denied** — a denial, not a method-not-found,
 *     recorded as `permission.denied { reason: { code: 'scope-violation' } }`
 *     with the node's own globs beside it, and the agent takes its own
 *     "the user declined" branch and finishes the node.
 *
 * The difference between those two answers is the entire story. A `-32601`
 * gives the agent one answer to both, and that answer is "this client is
 * read-only".
 *
 * Every assertion is off the ledger rather than off the worktree, because the
 * performer removes the worktree in its `finally` — a fact about the filesystem
 * would be gone before the spec could read it.
 *
 * Verifies: KAR-23.10
 */

import type { RunId } from '@DeFlow/core';
import { it, waitFor } from '@DeFlow/testkit';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { systemClock } from '../../src/clock.ts';
import { worktreePathFor } from '../../src/git/worktree-args.ts';
import {
  driveToPlan,
  eventsOf,
  kinds,
  NODE,
  ONE_NODE_PLAN,
  READ_NODE,
  type Scene,
  scene,
} from './support/live-scene.ts';

/** The node's own declared write scope — one glob, and the spec's whole point. */
const WRITE_SCOPE = 'packages/ui/src/**';

/**
 * The plan: one `worktree` agent node with a declared write scope.
 *
 * `worktree` rather than `read` because a `read` node has nothing to mediate:
 * the ladder refuses every write at that level for the level's own reason, and
 * the scope check — which only ever narrows an `allow` — never runs. The
 * capability row is the ACP bridge's, which advertises no `mediatedExecution`
 * key, so KAR-05.2 admits the level.
 */
const WRITE_PLAN = {
  ...ONE_NODE_PLAN,
  nodes: [
    {
      ...READ_NODE,
      permission: 'worktree',
      pathScopes: { write: [WRITE_SCOPE] },
      writes: [],
    },
  ],
};

/** Where the node's worktree will be, which is what an absolute path is
 * resolved against by `contain()`, `relativeToWorktree` and the ladder alike. */
const worktreeOf = (s: Scene): string => worktreePathFor(s.repoDir, s.runId as RunId, NODE);

/**
 * An agent that asks before it writes, and then writes — or says it was
 * refused.
 *
 * `permission` first and `fs/write_text_file` only on the allow branch, because
 * that is what a real coding agent does and it is what makes the two fronts
 * observable separately: the ladder answers the question, and the fs front
 * carries out (or refuses) the act.
 */
function askThenWrite(path: string): unknown {
  return {
    name: 'ask-then-write',
    description: 'Asks permission for an edit, writes on allow, reports on reject.',
    steps: [
      {
        type: 'permission',
        title: 'may I edit the session module',
        toolKind: 'edit',
        path,
        options: [
          { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
        ],
        onAllowed: {
          steps: [
            {
              type: 'clientCall',
              method: 'fs/write_text_file',
              params: { path, content: 'export const cookie = "sid=1; Secure";\n' },
              onError: { steps: [{ type: 'message', text: 'the write itself was refused' }] },
            },
            { type: 'message', text: 'wrote' },
          ],
        },
        onRejected: { steps: [{ type: 'message', text: 'refused' }] },
        onCancelled: { steps: [{ type: 'message', text: 'cancelled' }] },
      },
    ],
    stopReason: 'end_turn',
  };
}

/** Drives the run to a terminal node event, whichever one it reaches. */
async function driveToTheNode(s: Scene): Promise<void> {
  await driveToPlan(s);
  await waitFor(
    () => kinds(s.db, s.runId).some((kind) => kind === 'node.completed' || kind === 'node.failed'),
    { describe: 'the execution node to end', timeoutMs: 25_000 },
  );
  await s.driver.settle();
}

const transcriptOf = (s: Scene): string =>
  JSON.stringify(eventsOf(s.db, s.runId, 'node.completed').map((event) => event.payload));

// ── in scope: allowed by the ladder, and it reaches the disk ─────────────────

suite('KAR-23.10 — a write inside the node’s declared scope is allowed', () => {
  it('answers session/request_permission from the ladder and lets the write through', async ({
    tmp,
  }) => {
    const scenarioPath = join(tmp, 'ask-then-write.json');
    const s = await scene(tmp, {
      plan: WRITE_PLAN,
      withAdapter: 'mock-agent',
      capabilities: 'acp-bridge',
      mockScenarioPath: scenarioPath,
    });
    try {
      // Written now rather than in `scene`, because the path the agent asks
      // about is the node's own worktree and that is derived from the run id.
      const inScope = join(worktreeOf(s), 'packages', 'ui', 'src', 'session.ts');
      await writeFile(scenarioPath, JSON.stringify(askThenWrite(inScope)), 'utf8');

      await driveToTheNode(s);

      const seen = kinds(s.db, s.runId);
      expect(seen, `the ledger was: ${seen.join(' → ')}`).toContain('node.completed');
      expect(seen).not.toContain('node.failed');

      // The ladder answered, on its own, and it is in the ledger (AC9).
      const decided = eventsOf(s.db, s.runId, 'permission.decided').map(
        (event) => event.payload as Record<string, unknown>,
      );
      expect(decided.length, 'no permission was mediated at all').toBeGreaterThan(0);
      expect(decided[0]).toMatchObject({
        node: NODE,
        method: 'fs/write_text_file',
        outcome: 'allow',
        answered: 'allow',
        by: 'ladder',
      });
      // Nobody was interrupted for a routine in-scope write. Scoped to the
      // node, because the F1.3 spec gate earlier in the run is a
      // `human.requested` too and it is nothing to do with this claim.
      expect(
        eventsOf(s.db, s.runId, 'human.requested').filter((event) => event.nodeId === NODE),
      ).toEqual([]);
      expect(eventsOf(s.db, s.runId, 'permission.denied')).toEqual([]);

      // …and the agent's own branch says the write went through, which is the
      // half a `-32601` could never produce.
      expect(transcriptOf(s)).toContain('wrote');
    } finally {
      s.close();
    }
  });
});

// ── out of scope: DENIED, and denied is not method-not-found ─────────────────

suite('KAR-23.10 — a write outside the declared scope is denied, not unanswered', () => {
  it('refuses with scope-violation, names the declared globs, and the node still finishes', async ({
    tmp,
  }) => {
    const scenarioPath = join(tmp, 'ask-then-write-outside.json');
    const s = await scene(tmp, {
      plan: WRITE_PLAN,
      withAdapter: 'mock-agent',
      capabilities: 'acp-bridge',
      mockScenarioPath: scenarioPath,
      // Inside the worktree, outside `packages/ui/src/**`: so the denial is the
      // *scope* check's and not containment's, which is the one this node's
      // plan actually declared.
      repoFiles: { 'packages/api/src/tokens.ts': 'export const token = "t";\n' },
    });
    try {
      const outOfScope = join(worktreeOf(s), 'packages', 'api', 'src', 'tokens.ts');
      await mkdir(join(worktreeOf(s), '..'), { recursive: true }).catch(() => undefined);
      await writeFile(scenarioPath, JSON.stringify(askThenWrite(outOfScope)), 'utf8');

      await driveToTheNode(s);

      const seen = kinds(s.db, s.runId);
      // The *request* was refused; the node was not. That distinction is the
      // difference between a mediated agent and a broken client.
      expect(seen, `the ledger was: ${seen.join(' → ')}`).toContain('node.completed');

      const denied = eventsOf(s.db, s.runId, 'permission.denied').map(
        (event) => event.payload as Record<string, unknown>,
      );
      expect(denied.length, 'the out-of-scope write was not recorded as denied').toBeGreaterThan(0);
      expect(denied[0]).toMatchObject({
        node: NODE,
        permission: 'worktree',
        method: 'fs/write_text_file',
        reason: { code: 'scope-violation' },
        declared: [WRITE_SCOPE],
      });

      expect(
        eventsOf(s.db, s.runId, 'permission.decided')[0]?.payload as Record<string, unknown>,
      ).toMatchObject({ outcome: 'deny', answered: 'reject', by: 'ladder' });

      // The agent took its own "the user declined" branch and carried on.
      expect(transcriptOf(s)).toContain('refused');
      expect(transcriptOf(s)).not.toContain('wrote');
    } finally {
      s.close();
    }
  });
});

// ── the run itself, for the record ───────────────────────────────────────────

suite('KAR-23.10 — the mediation reaches the run without a human in the loop', () => {
  it('leaves a run that ended and a ledger that says how each request was decided', async ({
    tmp,
  }) => {
    const scenarioPath = join(tmp, 'ask-then-write-run.json');
    const s = await scene(tmp, {
      plan: WRITE_PLAN,
      withAdapter: 'mock-agent',
      capabilities: 'acp-bridge',
      mockScenarioPath: scenarioPath,
    });
    try {
      await writeFile(
        scenarioPath,
        JSON.stringify(askThenWrite(join(worktreeOf(s), 'packages', 'ui', 'src', 'session.ts'))),
        'utf8',
      );

      await driveToTheNode(s);

      // The run's own ending, driven by real ticks — KAR-23.12's guarantee
      // standing behind KAR-23.10's: a mediated node that finished must not
      // leave the run concluded as failed.
      const deadline = Date.now() + 20_000;
      for (;;) {
        const seen = kinds(s.db, s.runId);
        if (seen.includes('run.completed') || seen.includes('run.aborted')) break;
        if (Date.now() > deadline) throw new Error(`the run never ended: ${seen.join(' → ')}`);
        await s.driver.tick(systemClock.now());
        await s.driver.settle();
      }

      expect(kinds(s.db, s.runId)).toContain('run.completed');
    } finally {
      s.close();
    }
  });
});
