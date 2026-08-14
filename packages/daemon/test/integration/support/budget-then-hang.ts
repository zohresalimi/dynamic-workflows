/**
 * A daemon that runs a plan into its cost ceiling and then dies without
 * shutting down (EPIC-14-S12).
 *
 *     node budget-then-hang.ts <dataDir> <readyFile>
 *
 * It seeds the run, ticks a real `decide()` loop until the ceiling trips, writes
 * `readyFile`, and then hangs forever. The parent SIGKILLs it — SIGTERM would
 * test a shutdown handler, and the claim under test is that there is nothing to
 * shut down: the pause is an event, so it is already on disk.
 *
 * The trip has to be produced by a process that then *dies*, because a `paused`
 * boolean on an object in this process would produce exactly the same ledger and
 * exactly the same assertions up to the kill, and differ only afterwards.
 *
 * The loop here is deliberately smaller than `../../support/run-loop.ts`: no
 * child processes, because what is being crashed is the scheduler's memory, not
 * an agent's. Everything that decides anything — `decide()`, `reduce()` — is
 * shipped code.
 */
import { decide, EVENT_CURRENT_VERSIONS, initialRunState, type RunState } from '@DeFlow/core';
import { appendEvents, type EventDraft, openLedger, replayAll } from '@DeFlow/ledger';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { BUDGET_RUN, ceilingSet, draft, seedBudgetRun, T0 } from './budget-run.ts';

const [dataDir, readyFile] = process.argv.slice(2);
if (dataDir === undefined || readyFile === undefined) {
  throw new Error('usage: budget-then-hang.ts <dataDir> <readyFile>');
}

const eventVersionOf = (kind: string): number =>
  (EVENT_CURRENT_VERSIONS as Readonly<Record<string, number>>)[kind] ?? 1;

const BINARY = { path: '/usr/bin/deflow-mock-agent', version: '0.0.0', sha256: 'd'.repeat(64) };

const RESULT = {
  status: 'completed',
  output: { summary: 'done' },
  outputSchemaId: 'DeFlow.finding.v1',
  usage: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
  costUsd: 0.1,
  producedFacts: [],
  artifacts: [],
};

const db = openLedger(dataDir);
seedBudgetRun(db, [ceilingSet('run', { costUsd: 0.25 })]);

const state = (): RunState => replayAll(db).runs.get(BUDGET_RUN) ?? initialRunState();

for (let tick = 0; tick < 50; tick += 1) {
  const now = T0 + tick * 1_000;
  const commands = decide(state(), now);
  if (commands.length === 0) break;

  // Emitted events in one batch, which is one transaction — the property
  // KAR-14.2 AC2 is about, and the one this crash is aimed at.
  const emitted: EventDraft[] = [];
  const performed: EventDraft[] = [];

  for (const command of commands) {
    if (command.kind === 'EmitEvent') {
      emitted.push(
        draft(command.event.kind, command.event.payload, {
          ts: now,
          v: eventVersionOf(command.event.kind),
          ...(command.node === null ? {} : { nodeId: command.node }),
          ...(command.attempt === null ? {} : { attempt: command.attempt }),
        }),
      );
      continue;
    }
    if (command.kind !== 'StartNode') continue;

    const ikey = `${BUDGET_RUN}/${command.node}/${command.attempt}/0`;
    performed.push(
      draft(
        'node.started',
        { node: command.node, attempt: command.attempt, ikey, binary: BINARY },
        { ts: now, nodeId: command.node, attempt: command.attempt, ikey },
      ),
      draft(
        'node.completed',
        { node: command.node, attempt: command.attempt, result: RESULT },
        { ts: now, nodeId: command.node, attempt: command.attempt },
      ),
      draft(
        'budget.consumed',
        {
          node: command.node,
          attempt: command.attempt,
          provider: 'claude-code',
          usage: { inputTokens: 1200, outputTokens: 340, source: 'vendor-reported' },
          costUsd: 0.1,
          authMode: 'subscription',
        },
        {
          ts: now,
          v: eventVersionOf('budget.consumed'),
          nodeId: command.node,
          attempt: command.attempt,
        },
      ),
    );
  }

  if (emitted.length > 0) appendEvents(db, emitted);
  if (performed.length > 0) appendEvents(db, performed);
  if (state().status === 'paused') break;
}

writeFileSync(readyFile, JSON.stringify({ status: state().status }), 'utf8');
process.stdout.write(`${state().status}\n`);

// And now: nothing. No flush, no close, no shutdown of any kind.
setInterval(() => {}, 1_000);
