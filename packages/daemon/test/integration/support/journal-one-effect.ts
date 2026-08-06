/**
 * A daemon life that journals and performs exactly one effect, then waits to
 * be killed.
 *
 * It exists so the restart in `effect-ordinal.test.ts` is a **real** one: a
 * separate process, `SIGKILL`ed with no handler and no flush, leaving behind
 * only what SQLite had already committed. Simulating the crash in-process
 * would leave the runner's own memory intact, and the bug under test is
 * precisely a counter that lives in that memory.
 *
 * argv: <dataDir> <sideEffectLog> <agentBinary> <readyFile> <nodeId>
 */
import { NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { openLedger } from '@DeFlow/ledger';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { execa } from 'execa';
import { createEffectRunner, type EffectCtx, systemClock } from '../../../src/index.ts';

const [dataDir, log, binary, readyFile, nodeId] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
];

const RUN = RunIdSchema.parse('run_20260805T090000Z_5c1d2e');

const db = openLedger(dataDir);
const runner = createEffectRunner({
  db,
  clock: systemClock,
  daemonStartedAt: systemClock.now(),
  epoch: 1,
});

await runner.durable({
  runId: RUN,
  nodeId: NodeIdSchema.parse(nodeId),
  attempt: 0,
  kind: 'agent',
  requestHash: `sha256-${'a'.repeat(64)}`,
  async perform(ctx: EffectCtx): Promise<string> {
    await execa(binary, ['--print'], {
      env: {
        DeFlow_SIDE_EFFECT_LOG: log,
        DeFlow_RUN_ID: RUN,
        DeFlow_NODE_ID: nodeId,
        DeFlow_ATTEMPT: '0',
        DeFlow_IKEY: ctx.ikey,
      },
    });
    return ctx.ikey;
  },
});

// Committed and visible to any other connection from here on.
writeFileSync(readyFile, 'ready');

// Wait to be killed. No handler: SIGKILL is the point.
await new Promise(() => {});
