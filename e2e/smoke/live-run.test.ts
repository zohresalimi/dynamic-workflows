/**
 * KAR-19.5 AC1, AC2, AC3, AC6 / EPIC-19-S33 — **the test whose absence is this
 * epic.**
 *
 * On 2026-08-12 ten thousand tests were green and `deflow run` did nothing at
 * all. The reason was structural rather than careless: every e2e in this
 * repository ran against a recorded fixture through the replay harness, and a
 * fixture is a ledger that already contains everything the missing code was
 * supposed to append. Replaying one proves the projections are right and proves
 * nothing about who produces the events. Every epic verified its own half of
 * every seam; every seam belonged to nobody.
 *
 * The missing property has a name: **no test started at the operator's command
 * and ended at an executed node, through processes rather than function
 * calls.** So this scenario is defined by what it refuses to substitute — the
 * built binary rather than the source tree, a daemon in its own process rather
 * than a `boot()` in this one, a SQLite file the run itself wrote rather than a
 * fixture, real event frames over a real socket. The only substitution is the
 * agent, and it is `deflow-mock-agent`: a real executable on `PATH` speaking
 * real ACP over a real subprocess, needing no vendor CLI, no credential and no
 * network.
 *
 * Its own vitest project (`smoke`), serialised, in `pnpm test`, with the AC6
 * budget as its timeout. A smoke test behind a flag is a smoke test nobody
 * runs, and this failure mode is exactly the one that survives in the gap
 * between "we should run that" and "we ran it" — which is why
 * `test/integration/smoke-project.test.ts` asserts the wiring rather than
 * trusting it.
 *
 * Verifies: EPIC-19-S33 · KAR-19.5 AC1, AC2, AC3, AC6 · test plan #1
 */
import { beforeAll, expect, it, describe as suite } from 'vitest';
import { ensureBuilt, LINKS, runSmokeScenario, SMOKE_BUDGET_MS } from './support/harness.ts';

/**
 * AC1's *"builds or resolves"*. Outside the scenario's own timeout on purpose:
 * the AC6 budget is a statement about how long a run takes, and a cold Vite
 * build folded into it would make the number mean nothing.
 */
beforeAll(() => {
  ensureBuilt();
}, 600_000);

/**
 * The order EPIC-19-S33 names, and every one of them is a link somebody had to
 * write. Asserted as a *subsequence* of the ledger rather than as the whole of
 * it: the run also pins a spec, provisions worktrees and evaluates a gate, and
 * a spec that listed every kind would go red the day a story adds an event
 * rather than the day the chain breaks.
 */
const CHAIN = [
  'task.submitted',
  'run.created',
  'plan.proposed',
  'node.started',
  'node.completed',
] as const;

/** What `classifyRun` prescribes for a run that completed: exit 0. */
const COMPLETED_EXIT = 0;

suite('EPIC-19-S33 — an operator command, all the way to an executed node', () => {
  it('runs deflow init and deflow run --file against the built binary and the bundled agent', {
    timeout: SMOKE_BUDGET_MS,
  }, async () => {
    const smoke = await runSmokeScenario();
    const ledger = `the whole ledger was:\n${smoke.kinds.join('\n')}`;

    // AC2 — the kinds appear **in order**, read back out of the on-disk
    // ledger the run wrote for itself.
    const ordered = smoke.kinds.filter((kind) => (CHAIN as readonly string[]).includes(kind));
    for (const [index, kind] of CHAIN.entries()) {
      expect(ordered.indexOf(kind), `${kind} is missing — ${ledger}`).toBeGreaterThanOrEqual(0);
      if (index > 0) {
        const previous = CHAIN[index - 1] as string;
        expect(
          ordered.indexOf(kind),
          `${kind} arrived before ${previous} — ${ledger}`,
        ).toBeGreaterThan(ordered.indexOf(previous));
      }
    }

    // AC2 — a plan with at least two nodes, at least one of them executed.
    expect(
      smoke.planNodes.length,
      `the compiled plan was ${JSON.stringify(smoke.planNodes)}`,
    ).toBeGreaterThanOrEqual(2);
    expect(smoke.completedNodes.length).toBeGreaterThanOrEqual(1);

    // AC2 — agent output on the CLI's own stdout, while the run was still in
    // flight. Sampled by the harness before any terminal event existed, so a
    // renderer that buffered to the end of the run fails here.
    expect(smoke.outputWhileRunning, `${LINKS.chunk} produced nothing on the terminal`).toBe(true);

    // AC2 — the run ended by saying which end it reached, and the process
    // exit code is `classifyRun`'s and nobody else's.
    expect(smoke.kinds.at(-1), ledger).toBe('run.completed');
    expect(smoke.exitCode, `stdout:\n${smoke.stdout}\nstderr:\n${smoke.stderr}`).toBe(
      COMPLETED_EXIT,
    );

    // AC3 — no outbound socket was opened, and that is a test rather than a
    // claim: every Node process in the scenario ran with a hook that refuses
    // and records a connection to anything that is not loopback.
    expect(smoke.outboundAttempts).toEqual([]);
  });
});
