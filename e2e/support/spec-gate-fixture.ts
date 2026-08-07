/**
 * A data directory holding one run parked at the F1.3 approval gate, seeded
 * before any daemon is started over it (KAR-10.3, EPIC-10-S18).
 *
 * The run is seeded rather than driven through a real framing interview because
 * what EPIC-10-S18 is about is the *approval*, not how the spec got there:
 * driving framing would need a real vendor CLI on this machine, and the
 * interview has its own suite against a real spawned agent
 * (`packages/daemon/test/integration/framing-*.test.ts`). Everything after this
 * point is real — a real DeFlowd process, a real HTTP request, the real CLI
 * client — which is the part two surfaces can disagree about.
 *
 * The write happens with no daemon running, and the connection is closed before
 * one is spawned: `boot()` takes an exclusive lease on the directory, and two
 * writers is the failure EPIC-03-S21 exists to prevent, not one to reproduce
 * here by accident.
 */
import type { TaskSpecDraft } from '@DeFlow/core';
import {
  NO_DEADLINE_WAKE_AT,
  RunIdSchema,
  renderSpecForReview,
  SPEC_APPROVAL_OPTIONS,
  SPEC_GATE_NODE,
  sealTaskSpec,
} from '@DeFlow/core';
import { appendEvents, openLedger, scheduleWake } from '@DeFlow/ledger';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SPEC_RUN = RunIdSchema.parse('run_20260807T113000Z_c92a17');

const T0 = 1_754_561_400_000;

const FRAMED = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../packages/core/test/fixtures/specs/vue3-migration.framed.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as TaskSpecDraft;

/** Seeds `dataDir` and closes the connection again. */
export async function seedRunAtSpecGate(dataDir: string): Promise<string> {
  const spec = await sealTaskSpec(structuredClone(FRAMED));
  const db = openLedger(dataDir);
  try {
    appendEvents(db, [
      {
        runId: SPEC_RUN,
        ts: T0,
        kind: 'task.submitted',
        v: 1,
        epoch: 1,
        payload: {
          sha256: 'a'.repeat(64),
          raw: 'Migrate the checkout module from Vue 2 to Vue 3.',
          provenance: { kind: 'text', by: 'cli', submittedAt: T0 },
        },
      },
      {
        runId: SPEC_RUN,
        ts: T0,
        kind: 'run.created',
        v: 1,
        epoch: 1,
        payload: { spec, cwd: '/tmp/repo', repo: { head: 'e83c516', branch: 'main' } },
      },
    ]);
    // The gate itself, spelled out rather than imported: R2 keeps
    // `@DeFlow/daemon` a leaf that only `packages/cli` may depend on, and this
    // is a fixture rather than the thing under test. If it ever drifts from
    // `openSpecApprovalGate`, the spec fails loudly with `gate_not_open` on the
    // very first request rather than passing against the wrong shape.
    db.transaction(() => {
      appendEvents(db, [
        {
          runId: SPEC_RUN,
          ts: T0,
          kind: 'human.requested',
          v: 1,
          epoch: 1,
          nodeId: SPEC_GATE_NODE,
          payload: {
            node: SPEC_GATE_NODE,
            prompt: renderSpecForReview(structuredClone(FRAMED)),
            options: SPEC_APPROVAL_OPTIONS.map((option) => ({ ...option })),
          },
        },
      ]);
      scheduleWake(db, {
        runId: SPEC_RUN,
        nodeId: SPEC_GATE_NODE,
        wakeAt: NO_DEADLINE_WAKE_AT,
        reason: 'human_gate',
      });
    });
    return spec.specHash;
  } finally {
    db.close();
  }
}
