/**
 * KAR-11.4 AC10 — reading F2.5's rule table off disk, and pinning it into the
 * run (docs/06-planning-and-replanning.md §4.3).
 *
 * The split follows docs/16-repo-layout.md R1 exactly as `workspace-config.ts`
 * does: `@DeFlow/core` owns the shape, the comparison grammar and the hash, and
 * performs no I/O; this reads the bytes and appends the event.
 *
 * **This is the only place the file is read for policy purposes, and it happens
 * once per run.** From `policy.patch.loaded` onwards the table travels in the
 * ledger — `RunState.patchPolicy` carries the rules themselves, not merely
 * their digest — which is what makes all three of AC10's claims true at once:
 * a mid-run edit changes nothing for a live run, a replay of a finished run
 * reaches the decisions that run actually made, and a *new* run picks the edit
 * up because it pins afresh.
 *
 * The one thing the file is still consulted for afterwards is the divergence
 * report (`policy.patch.drifted`, in ../budget/patch-gate.ts), and that reads
 * the hash and never the rules — an operator has to be told their edit is not
 * in force, and telling them is not the same as acting on it.
 */
import type { Db, PatchPolicyTable, RunId } from '@DeFlow/core';
import { EVENT_CURRENT_VERSIONS, patchPolicyHash, patchPolicyOf } from '@DeFlow/core';
import { appendEvents, type EventDraft } from '@DeFlow/ledger';
import { loadWorkspaceConfig } from '../config/workspace-config.ts';

/** The rule table a workspace declares, with its digest and where it came from. */
export interface WorkspacePatchPolicy {
  readonly source: 'config' | 'default';
  readonly hash: string;
  readonly rules: PatchPolicyTable;
}

/**
 * The table `.DeFlow/config.yaml` declares under `policy.patch`, or the shipped
 * defaults, hashed.
 *
 * A malformed table throws, and names the file: a `costDeltaUsd: lots` that
 * silently fell back to the defaults would leave an operator believing a
 * threshold is in force that is not — and this table is the only control on
 * runaway cost and permission escalation.
 */
export async function workspacePatchPolicy(cwd: string): Promise<WorkspacePatchPolicy> {
  const resolved = patchPolicyOf(loadWorkspaceConfig(cwd));
  return { ...resolved, hash: await patchPolicyHash(resolved.rules) };
}

export interface PinPatchPolicyOptions {
  readonly runId: RunId;
  /** From the injected `Clock`, never `Date.now()`. */
  readonly ts: number;
  readonly epoch: number;
  readonly policy: WorkspacePatchPolicy;
}

/**
 * Appends `policy.patch.loaded`: the rules this run will be judged by, for as
 * long as it lives.
 *
 * Returns the draft rather than only appending it, so a caller that has to pin
 * the table *in the same transaction as* `run.created` — which the framing
 * interview does, because a run whose first tick could be ruled by a different
 * table than its second is exactly the state the pin exists to prevent — can
 * hand it to its own `appendEvents`.
 */
export function patchPolicyDraft(options: PinPatchPolicyOptions): EventDraft {
  return {
    runId: options.runId,
    ts: options.ts,
    kind: 'policy.patch.loaded',
    v: EVENT_CURRENT_VERSIONS['policy.patch.loaded'],
    epoch: options.epoch,
    payload: {
      source: options.policy.source,
      hash: options.policy.hash,
      rules: options.policy.rules,
    },
  } as EventDraft;
}

export function pinPatchPolicy(db: Db, options: PinPatchPolicyOptions): void {
  appendEvents(db, [patchPolicyDraft(options)]);
}
