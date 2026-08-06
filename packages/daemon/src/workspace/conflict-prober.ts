/**
 * KAR-07.6 — the continuous conflict probe, wired
 * (docs/09-workspace-and-safety.md §6.2, §7.3; Decision D14).
 *
 * After every write-node commit this runs `git merge-tree --write-tree`
 * between that node's branch and (a) the run's integration branch and (b)
 * every other in-flight node branch, stores each answer in `conflict_probe`
 * with both tips, and demotes the later-starting node of any pair that has
 * started to conflict. That turns conflict from a merge-time surprise into a
 * scheduling input, for milliseconds per probe.
 *
 * **Tips are an input, not a lookup.** `conflictState` takes each branch with
 * the commit the caller believes it is on, rather than resolving it itself.
 * That is what makes "a fresh row spawns no git process" true instead of
 * nearly true — a cache that has to shell out to find out whether it is a hit
 * has already paid the cost it exists to avoid. The scheduler knows those tips
 * already: it has just watched the commit that moved one of them.
 * `probeAfterCommit`, which is called from outside that knowledge, resolves
 * every branch in **one** `rev-parse` and then reuses it for all the pairs.
 *
 * **A stale row is re-probed, never repaired.** There is no attempt to reason
 * about whether the new commits could have changed the answer; the probe is
 * cheap and the reasoning is not sound.
 *
 * Verifies: EPIC-07-S25, EPIC-07-S30 · AC4, AC5, AC6
 */
import type { Clock, Db, NodeId, RunId } from '@DeFlow/core';
import {
  appendEvents,
  type ConflictProbeRow,
  canonicalPair,
  readConflictProbe,
  upsertConflictProbe,
} from '@DeFlow/ledger';
import { GitError } from '../git/git-error.ts';
import { type GitPort, mergeTree } from '../git/merge-tree.ts';
import {
  type Demotion,
  demotions,
  type InFlightBranch,
  isProbeStale,
  type ProbeVerdict,
  probeTargets,
} from './conflict-matrix.ts';

export interface ConflictProberPorts {
  readonly git: GitPort;
  readonly db: Db;
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  /** This daemon life's epoch, stamped on every event appended here. */
  readonly epoch: number;
}

/** A branch and the commit the caller believes it is on. */
export interface BranchTip {
  readonly branch: string;
  readonly commit: string;
}

export interface ProbeAfterCommitRequest {
  readonly runId: string;
  /** `DeFlow/int/<runId>`, from KAR-07.3's `integrationBranch`. */
  readonly integrationBranch: string;
  /** The node whose commit triggered this fan-out. */
  readonly subject: InFlightBranch;
  /** Every node the scheduler currently considers running, `subject` included. */
  readonly inFlight: readonly InFlightBranch[];
}

export interface ProbeReport {
  /** One row per probed pair, in the order the pairs were probed. */
  readonly probes: readonly ConflictProbeRow[];
  /** The nodes demoted by this fan-out; each has a `node.blocked` event. */
  readonly blocked: readonly Demotion[];
}

export class ConflictProber {
  readonly #ports: ConflictProberPorts;

  constructor(ports: ConflictProberPorts) {
    this.#ports = ports;
  }

  /**
   * AC5 — the stored answer for one pair when it still describes the branches
   * as they are, and a fresh probe when it does not.
   *
   * Returns the row rather than a bare verdict, because every caller that
   * cares about the answer also cares about the tips it was taken at.
   */
  async conflictState(runId: string, a: BranchTip, b: BranchTip): Promise<ConflictProbeRow> {
    const cached = readConflictProbe(this.#ports.db, runId, a.branch, b.branch);
    const tips = new Map([
      [a.branch, a.commit],
      [b.branch, b.commit],
    ]);
    if (cached !== null && !isProbeStale(cached, tips)) return cached;

    return this.#probe(runId, a, b);
  }

  /**
   * AC4, AC6 — the fan-out after `subject` commits, and the demotion any
   * conflict it finds implies.
   *
   * The `node.blocked` events are appended before this resolves, so a caller
   * that reads the ledger back sees the demotion the report describes.
   */
  async probeAfterCommit(request: ProbeAfterCommitRequest): Promise<ProbeReport> {
    const targets = probeTargets(request.subject, request.inFlight, request.integrationBranch);
    const tips = await this.#resolveTips(
      request.runId,
      [request.subject.branch, ...targets],
      request.integrationBranch,
    );

    const probes: ConflictProbeRow[] = [];
    const verdicts: ProbeVerdict[] = [];
    for (const target of targets) {
      const row = await this.conflictState(
        request.runId,
        { branch: request.subject.branch, commit: tipOf(tips, request.subject.branch) },
        { branch: target, commit: tipOf(tips, target) },
      );
      probes.push(row);
      verdicts.push(row);
    }

    const blocked = demotions(request.inFlight, verdicts);
    for (const demotion of blocked) this.#appendBlocked(request.runId, demotion);

    return { probes, blocked };
  }

  /** One real probe, canonicalised, stored, and returned as the row it wrote. */
  async #probe(runId: string, a: BranchTip, b: BranchTip): Promise<ConflictProbeRow> {
    const pair = canonicalPair(a.branch, b.branch, a.commit, b.commit);
    const result = await mergeTree(this.#ports.git, pair.branchA, pair.branchB);
    const row: ConflictProbeRow = {
      runId,
      branchA: pair.branchA,
      branchB: pair.branchB,
      probedAt: this.#ports.clock.now(),
      aCommit: pair.aValue,
      bCommit: pair.bValue,
      clean: result.clean,
      paths: result.paths,
    };
    upsertConflictProbe(this.#ports.db, row);
    return row;
  }

  /**
   * Every branch's tip in one `rev-parse`, so the fan-out's spawn count is one
   * plus the number of pairs rather than three times it. Duplicates are
   * collapsed first: `rev-parse` answers positionally, and asking twice would
   * only make the answer harder to line up.
   */
  async #resolveTips(
    runId: string,
    branches: readonly string[],
    integrationBranch: string,
  ): Promise<Map<string, string>> {
    const unique = [...new Set(branches)];
    const args = ['rev-parse', ...unique];
    const result = await this.#ports.git.run(args);
    if (result.exitCode !== 0) throw new GitError('rev-parse failed', args, result);

    const oids = result.stdout.split('\n').filter((line) => line !== '');
    if (oids.length !== unique.length) {
      throw new Error(
        `rev-parse returned ${oids.length} oids for ${unique.length} branches in run ${runId} ` +
          `(integration branch ${integrationBranch})`,
      );
    }
    return new Map(unique.map((branch, index) => [branch, oids[index] as string]));
  }

  #appendBlocked(runId: string, demotion: Demotion): void {
    appendEvents(this.#ports.db, [
      {
        runId: runId as RunId,
        ts: this.#ports.clock.now(),
        kind: 'node.blocked',
        v: 1,
        epoch: this.#ports.epoch,
        nodeId: demotion.node as NodeId,
        payload: {
          node: demotion.node,
          conflictsWith: demotion.conflictsWith,
          branch: demotion.branch,
          otherBranch: demotion.otherBranch,
          paths: [...demotion.paths],
        },
      },
    ]);
  }
}

function tipOf(tips: ReadonlyMap<string, string>, branch: string): string {
  const commit = tips.get(branch);
  if (commit === undefined) throw new Error(`no tip resolved for branch ${branch}`);
  return commit;
}
