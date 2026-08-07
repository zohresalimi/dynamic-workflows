/**
 * A run parked at the F1.3 approval gate, as a real ledger on disk (KAR-10.3).
 *
 * Shared by the spec and by the child process it `SIGKILL`s, so the run the
 * parent makes assertions about and the run the child wrote cannot drift apart
 * — the same arrangement `./gate-run.ts` uses for EPIC-06-S22.
 *
 * The framed document is the committed `vue3-migration.framed.json` fixture, so
 * what the operator reviews here is what the framing interview's own suite
 * produces.
 */
import type { TaskSpec, TaskSpecDraft } from '@DeFlow/core';
import { sealTaskSpec } from '@DeFlow/core';
import type { Db, EventDraft } from '@DeFlow/ledger';
import { appendEvents } from '@DeFlow/ledger';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openSpecApprovalGate } from '../../../src/spec/gate.ts';

export const SPEC_RUN = 'run_20260807T090000Z_b17c4e';

/** The node the framing interview ran as, and the one node AC3 permits a
 * `node.scheduled` for before the spec is approved. */
export const FRAMING_NODE = 'framing';

export const REPO = '/home/u/proj';

/** The instant every fixture in this file is anchored to. */
export const T0 = 1_754_553_600_000;

export const minutes = (count: number): number => count * 60_000;
export const hours = (count: number): number => count * 3_600_000;

export const FRAMED: TaskSpecDraft = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../../core/test/fixtures/specs/vue3-migration.framed.json', import.meta.url),
    ),
    'utf8',
  ),
) as TaskSpecDraft;

/** A fresh deep copy, so one case's edit cannot leak into the next. */
export const framed = (): TaskSpecDraft => structuredClone(FRAMED);

export const draft = (
  kind: string,
  payload: unknown,
  extra: Partial<EventDraft> = {},
): EventDraft => ({
  runId: SPEC_RUN,
  ts: T0,
  kind,
  v: 1,
  epoch: 1,
  payload,
  ...extra,
});

/**
 * The ledger up to the instant the gate opens: intake, the framing node, the
 * `run.created` framing appended, and the blocking `human` node.
 *
 * `node.scheduled` for the framing node is deliberately in here. AC3's
 * assertion is *"no `node.scheduled` event for any node **other than** the
 * framing and recon nodes"*, and a fixture with none at all would make that
 * assertion vacuous.
 */
export async function seedSpecGateRun(db: Db): Promise<TaskSpec> {
  const spec = await sealTaskSpec(framed());

  appendEvents(db, [
    draft('task.submitted', {
      sha256: 'a'.repeat(64),
      raw: 'Migrate the checkout module from Vue 2 to Vue 3.',
      provenance: { kind: 'text', by: 'cli', submittedAt: T0 },
    }),
    draft(
      'node.scheduled',
      { node: FRAMING_NODE, provider: 'claude-code', permission: 'read' },
      { nodeId: FRAMING_NODE },
    ),
    draft(
      'node.started',
      {
        node: FRAMING_NODE,
        attempt: 0,
        ikey: `${SPEC_RUN}/${FRAMING_NODE}/0/0`,
      },
      { nodeId: FRAMING_NODE, attempt: 0 },
    ),
    draft('run.created', {
      spec,
      cwd: REPO,
      repo: { head: 'e83c516', branch: 'main' },
    }),
  ]);

  openSpecApprovalGate({
    db,
    runId: SPEC_RUN,
    epoch: 1,
    ts: T0,
    document: framed(),
  });

  return spec;
}
