/**
 * `DeFlow status` (KAR-18.7) — what is running, answered from evidence.
 *
 * The troubleshooting table in
 * [docs/03-local-development.md §13](../../../docs/03-local-development.md)
 * sends an operator to read `.DeFlow/daemon.json` by hand, and the lease
 * refusal KAR-18.2 prints sends them here. Both questions are the same one:
 * *is there a daemon, and is it the one this file describes?*
 *
 * Three decisions, and each of them is an acceptance criterion.
 *
 * **A pid is not evidence.** `daemon.json` records the OS's own start time for
 * its pid, and this command compares that string for equality before it will
 * call anything running (AC4). Pids are recycled within hours on a busy
 * machine and from the first boot after a restart, so a `status` that trusted
 * the number would eventually report somebody's editor as DeFlowd — and then
 * the operator kills it. This is the same `(pid, process_start_time)`
 * discipline the boot reaper applies (`packages/daemon/src/reaper.ts`), which
 * is why a mismatch and a missing record are the same answer here as there:
 * say so, and touch nothing.
 *
 * **Nothing is signalled.** Not even `kill(pid, 0)`, the "is it alive?" idiom
 * — reading the start time answers liveness *and* identity in one syscall,
 * and a signal would answer only the half that is not the interesting one.
 * `packages/cli/test/status-no-signal.test.ts` keeps it that way.
 *
 * **Exit 0, always** (AC5). `status` is a query, not an assertion: a non-zero
 * exit for "nothing is running" breaks the first shell wrapper anybody writes
 * around it, and "nothing is running" is the most ordinary answer there is.
 *
 * The run lines come from the ledger through a **read-only** connection and
 * the shipped projection (`replayRun`), not from the daemon's HTTP API: there
 * is no run-list route to be a client of (docs/11 §6 — the run summary is a
 * resource per run, deliberately), and a command that has to work when the
 * daemon is *dead* cannot depend on one being alive to answer.
 */

import { processStartTime } from '@DeFlow/adapters';
import type { Clock, NodeStatus, PendingGate, RunId, RunStatus } from '@DeFlow/core';
import { pendingGate, pendingGateSummary, runStatusLabel } from '@DeFlow/core';
import { type DaemonFile, daemonFilePath, resolveDataDir, systemClock } from '@DeFlow/daemon';
import { listRunIds, openRead, readEpoch, replayRun } from '@DeFlow/ledger';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { type Report, type ReportSection, renderReport } from './render/report.ts';
import { plainStyle, type Style } from './render/style.ts';

/** What `DeFlow status`'s flags mean, once parsed. */
export interface StatusArgs {
  readonly json: boolean;
}

export type ParsedStatusArgs =
  | { readonly ok: true; readonly args: StatusArgs }
  | { readonly ok: false; readonly message: string };

/**
 * `status`'s argv. One flag, and an unknown one is a refusal rather than
 * noise — the same rule `DeFlow up` follows, for the same reason.
 */
export function parseStatusArgs(argv: readonly string[]): ParsedStatusArgs {
  let json = false;
  for (const argument of argv) {
    // KAR-18.9 AC7 — accepted and *consumed* here, never acted on: the styling
    // decision is `bin.ts`'s, computed once for the whole process. A parser
    // that refused this flag would make "--no-color works everywhere" false
    // for four of the five commands.
    if (argument === '--no-color') continue;

    if (argument === '--json') {
      json = true;
      continue;
    }
    return { ok: false, message: `DeFlow status: unknown option ${JSON.stringify(argument)}` };
  }
  return { ok: true, args: { json } };
}

/** One line of AC3's per-run summary. */
export interface ActiveRun {
  readonly runId: string;
  readonly status: RunStatus;
  /**
   * KAR-19.1 AC6 — the sentence, from `runStatusLabel` in `@DeFlow/core`.
   *
   * Carried beside the machine value rather than derived at render time,
   * because the render is where the second wording got in last time: this
   * command printed `created — no nodes yet` while the CLI's attached view
   * printed `task submitted` and the UI printed `No plan yet`, about one run at
   * one instant, and each was locally defensible.
   */
  readonly label: string;
  /** Node ids grouped by status, with the empty statuses left out. */
  readonly nodeCounts: Readonly<Partial<Record<NodeStatus, number>>>;
  /**
   * KAR-19.12 AC5 — the gate this run has stopped on, or `null`.
   *
   * Beside the label rather than folded into it, because they answer different
   * questions and only one of them is a *status*: a run whose status is
   * `running` can be blocked on a `human` node, and `running` is then true,
   * useless, and exactly the sentence that sends an operator to read the
   * ledger. `runStatusLabel` gains no fourth spelling (KAR-19.1 AC6);
   * `pendingGate` supplies this.
   */
  readonly gate: PendingGate | null;
}

/** Why the recorded daemon is not the daemon. @see the module note. */
export type StaleReason =
  /** The OS has no process with that pid. */
  | 'pid-gone'
  /** There is one, and it started at a different time: not ours. */
  | 'pid-recycled'
  /** The file recorded no start time, so nothing could be verified. */
  | 'unverifiable'
  /** The file is there and is not a `daemon.json`. */
  | 'unreadable';

export interface RunningStatus {
  readonly kind: 'running';
  readonly dataDir: string;
  readonly daemonFile: string;
  readonly pid: number;
  readonly port: number;
  /** `daemon_epoch` out of the ledger, or `null` when it could not be read. */
  readonly epoch: number | null;
  readonly startedAt: number;
  readonly uptimeMs: number;
  /**
   * KAR-19.1 AC2 — the interval of the ticker this daemon life started, as
   * `daemon.json` recorded it; `null` for a file written before this story.
   *
   * Reported because a daemon that never started its loop is indistinguishable
   * from a healthy one from out here — which is exactly how five of
   * `RECOVERY_STEPS`' eight passed for all of them.
   */
  readonly tickIntervalMs: number | null;
  readonly runs: readonly ActiveRun[];
  /** Why the run list is empty, when it is empty because of a failure. */
  readonly ledgerError: string | null;
}

export interface StaleStatus {
  readonly kind: 'stale';
  readonly dataDir: string;
  readonly daemonFile: string;
  readonly reason: StaleReason;
  readonly pid: number | null;
  readonly port: number | null;
  readonly recordedStartTime: string | null;
  readonly observedStartTime: string | null;
}

export interface NoStatus {
  readonly kind: 'none';
  readonly dataDir: string;
  readonly daemonFile: string;
}

export type DaemonStatus = RunningStatus | StaleStatus | NoStatus;

/**
 * The run statuses `status` does not list.
 *
 * Everything else is "active" — including `paused` and `needs-human`, which
 * are precisely the runs an operator is asking about when they type this.
 */
const FINISHED: readonly RunStatus[] = ['completed', 'aborted'];

/** `<n>h <m>m`, `<m>m <s>s` or `<s>s`. Two units is as much as anyone reads. */
export function formatUptime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** `daemon.json`, or `null` when there is none. Throws nothing but ENOENT. */
function readDaemonFile(path: string): DaemonFile | 'absent' | 'unreadable' {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return 'absent';
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const { pid, port, startedAt, processStartedAt, tickIntervalMs } =
      parsed as Partial<DaemonFile>;
    if (typeof pid !== 'number' || typeof port !== 'number' || typeof startedAt !== 'number') {
      return 'unreadable';
    }
    return {
      pid,
      port,
      token: '',
      startedAt,
      processStartedAt: typeof processStartedAt === 'string' ? processStartedAt : null,
      tickIntervalMs: typeof tickIntervalMs === 'number' ? tickIntervalMs : null,
    };
  } catch {
    return 'unreadable';
  }
}

/**
 * Whether the pid in `file` is still the daemon that wrote it.
 *
 * Pure, and takes the observed start time rather than reading it, so the whole
 * of the decision is testable without a process — and so that the one place
 * that touches the OS is the caller.
 */
export function classifyDaemonFile(
  file: DaemonFile,
  observed: string | null,
): { readonly kind: 'running' } | { readonly kind: 'stale'; readonly reason: StaleReason } {
  if (observed === null) return { kind: 'stale', reason: 'pid-gone' };
  if (file.processStartedAt === null) return { kind: 'stale', reason: 'unverifiable' };
  return file.processStartedAt === observed
    ? { kind: 'running' }
    : { kind: 'stale', reason: 'pid-recycled' };
}

/** Every run in `dataDir` that has not finished, oldest first. */
function activeRuns(dataDir: string): {
  runs: ActiveRun[];
  epoch: number | null;
  error: string | null;
} {
  let db: ReturnType<typeof openRead> | undefined;
  try {
    db = openRead(join(dataDir, 'ledger.db'));
    const epoch = readEpoch(db);
    const runs: ActiveRun[] = [];
    for (const runId of listRunIds(db)) {
      const { state } = replayRun(db, runId as RunId);
      if (FINISHED.includes(state.status)) continue;
      const nodeCounts: Partial<Record<NodeStatus, number>> = {};
      for (const node of Object.values(state.nodes)) {
        nodeCounts[node.status] = (nodeCounts[node.status] ?? 0) + 1;
      }
      runs.push({
        runId,
        status: state.status,
        label: runStatusLabel(state),
        nodeCounts,
        gate: pendingGate(state),
      });
    }
    return { runs, epoch, error: null };
  } catch (error) {
    return { runs: [], epoch: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

export interface StatusOptions {
  /** Defaults to `process.env`. `DeFlow_DATA_DIR` and `XDG_DATA_HOME` are read
   * from here and nowhere else. */
  readonly env?: NodeJS.ProcessEnv;
  /** Time enters here and nowhere else (NF9) — uptime is a subtraction. */
  readonly clock?: Clock;
}

/** What this machine's `daemon.json` says, and whether to believe it. */
export function readStatus(options: StatusOptions = {}): DaemonStatus {
  const env = options.env ?? process.env;
  const clock = options.clock ?? systemClock;
  const dataDir = resolveDataDir(env);
  const daemonFile = daemonFilePath(dataDir);

  const file = readDaemonFile(daemonFile);
  if (file === 'absent') return { kind: 'none', dataDir, daemonFile };
  if (file === 'unreadable') {
    return {
      kind: 'stale',
      dataDir,
      daemonFile,
      reason: 'unreadable',
      pid: null,
      port: null,
      recordedStartTime: null,
      observedStartTime: null,
    };
  }

  // The one syscall this command makes, and it is a read: `/proc/<pid>/stat`
  // on Linux, `ps -o lstart=` on macOS. @see the module note.
  let observed: string | null;
  try {
    observed = processStartTime(file.pid);
  } catch {
    observed = null;
  }

  const verdict = classifyDaemonFile(file, observed);
  if (verdict.kind === 'stale') {
    return {
      kind: 'stale',
      dataDir,
      daemonFile,
      reason: verdict.reason,
      pid: file.pid,
      port: file.port,
      recordedStartTime: file.processStartedAt,
      observedStartTime: observed,
    };
  }

  const ledger = activeRuns(dataDir);
  return {
    kind: 'running',
    dataDir,
    daemonFile,
    pid: file.pid,
    port: file.port,
    epoch: ledger.epoch,
    startedAt: file.startedAt,
    uptimeMs: Math.max(0, clock.now() - file.startedAt),
    tickIntervalMs: file.tickIntervalMs,
    runs: ledger.runs,
    ledgerError: ledger.error,
  };
}

/**
 * `2 completed, 1 running`, or the empty string for a run with no nodes.
 *
 * Empty rather than a sentence of its own: the run's *status* is already on the
 * line, from `runStatusLabel`, and a second clause explaining the same fact in
 * different words is how `created — no nodes yet` came to disagree with
 * `task submitted` and `No plan yet` about one run (KAR-19.1 AC6).
 */
function renderNodeCounts(counts: Readonly<Partial<Record<NodeStatus, number>>>): string {
  return Object.entries(counts)
    .map(([status, count]) => `${count} ${status}`)
    .join(', ');
}

/** Why a stale record is stale, as the sentence an operator reads. */
function staleDetail(status: StaleStatus): string {
  if (status.reason === 'unreadable') {
    return `${status.daemonFile} is not a daemon.json this build can read`;
  }
  if (status.reason === 'pid-gone') {
    return `${status.daemonFile} records pid ${status.pid}, and no such process is running`;
  }
  if (status.reason === 'pid-recycled') {
    return (
      `${status.daemonFile} records pid ${status.pid}, but that pid now belongs to a different ` +
      `process — recorded start time ${JSON.stringify(status.recordedStartTime)}, the OS ` +
      `reports ${JSON.stringify(status.observedStartTime)}`
    );
  }
  return `${status.daemonFile} records pid ${status.pid} with no start time, so it cannot be verified`;
}

/** The runs section, which exists even when it is empty — a heading with
 * nothing under it reads as "I did not look" (KAR-18.4 AC1's rule, here too). */
function runsSection(status: RunningStatus): ReportSection {
  if (status.ledgerError !== null) {
    return {
      title: 'Runs',
      rows: [
        {
          id: 'ledger',
          state: 'warn',
          detail: `the ledger could not be read: ${status.ledgerError}`,
          action: `run 'DeFlow doctor' — it reports why ${status.dataDir} cannot be read`,
        },
      ],
    };
  }
  if (status.runs.length === 0) {
    return { title: 'Runs', rows: [{ id: 'runs', state: 'ok', detail: 'no active runs' }] };
  }
  return {
    title: 'Runs',
    rows: status.runs.map((run) => ({
      id: run.runId,
      // AC5 — a run that is waiting on a person is an outstanding fact, and an
      // `ok` row is one an operator stops reading.
      state: run.gate === null ? ('ok' as const) : ('warn' as const),
      detail: [run.label, renderNodeCounts(run.nodeCounts)]
        .filter((part) => part !== '')
        .join(' — '),
      ...(run.gate === null
        ? {}
        : {
            action: `${pendingGateSummary(run.gate)}; answer it with 'deflow answer ${run.runId} --gate ${run.gate.node} --option ${run.gate.options[0]?.id ?? '<option>'}'`,
          }),
    })),
  };
}

/** `status`'s three answers, as the presentation layer's model (KAR-18.9 AC1). */
export function toReport(status: DaemonStatus): Report {
  if (status.kind === 'none') {
    return {
      title: 'DeFlow status',
      sections: [
        {
          title: 'Daemon',
          rows: [
            {
              id: 'daemon',
              state: 'skipped',
              detail: `no daemon is running: there is no ${status.daemonFile}`,
              action: "run 'DeFlow up' to start one",
            },
          ],
        },
      ],
    };
  }

  if (status.kind === 'stale') {
    return {
      title: 'DeFlow status',
      sections: [
        {
          title: 'Daemon',
          rows: [
            {
              id: 'daemon',
              state: 'warn',
              detail: `stale — ${staleDetail(status)}`,
              action: "run 'DeFlow up' — it will take over cleanly",
            },
            {
              id: 'signal',
              state: 'ok',
              detail: 'no signal was sent to that pid, and none should be',
            },
          ],
        },
      ],
    };
  }

  return {
    title: 'DeFlow status',
    sections: [
      {
        title: 'Daemon',
        rows: [
          { id: 'state', state: 'ok', detail: 'running' },
          { id: 'pid', state: 'ok', detail: String(status.pid) },
          { id: 'port', state: 'ok', detail: String(status.port) },
          {
            id: 'daemon_epoch',
            state: 'ok',
            detail: status.epoch === null ? 'unknown' : String(status.epoch),
          },
          { id: 'uptime', state: 'ok', detail: formatUptime(status.uptimeMs) },
          {
            id: 'ticker',
            state: 'ok',
            detail:
              status.tickIntervalMs === null
                ? 'unknown — this daemon.json records no ticker interval'
                : `running, every ${status.tickIntervalMs} ms`,
          },
          { id: 'data dir', state: 'ok', detail: status.dataDir },
          { id: 'url', state: 'ok', detail: `http://127.0.0.1:${status.port}` },
        ],
      },
      runsSection(status),
    ],
  };
}

/** The report an operator reads. @see renderStatusJson for the same values. */
export function renderStatusText(status: DaemonStatus, style: Style = plainStyle()): string {
  return renderReport(toReport(status), style);
}

/** The same values as `renderStatusText`, in one document (AC3). */
export function renderStatusJson(status: DaemonStatus): string {
  const document =
    status.kind === 'running'
      ? {
          status: 'running',
          dataDir: status.dataDir,
          daemonFile: status.daemonFile,
          pid: status.pid,
          port: status.port,
          daemonEpoch: status.epoch,
          startedAt: status.startedAt,
          uptimeMs: status.uptimeMs,
          tickIntervalMs: status.tickIntervalMs,
          runs: status.runs.map((run) => ({
            runId: run.runId,
            status: run.status,
            label: run.label,
            nodeCounts: run.nodeCounts,
            gate: run.gate,
          })),
        }
      : status.kind === 'stale'
        ? {
            status: 'stale',
            reason: status.reason,
            dataDir: status.dataDir,
            daemonFile: status.daemonFile,
            pid: status.pid,
            port: status.port,
            recordedStartTime: status.recordedStartTime,
            observedStartTime: status.observedStartTime,
          }
        : { status: 'none', dataDir: status.dataDir, daemonFile: status.daemonFile };

  return `${JSON.stringify(document, null, 2)}\n`;
}

export interface StatusResult {
  /** Always 0. @see the module note. */
  readonly exitCode: 0;
  readonly stdout: string;
  readonly stderr: '';
}

/** `DeFlow status` — the whole command, minus the process it runs in. */
export function runStatus(
  options: StatusOptions & { readonly json?: boolean; readonly style?: Style } = {},
): StatusResult {
  const status = readStatus(options);
  return {
    exitCode: 0,
    stdout:
      options.json === true
        ? renderStatusJson(status)
        : renderStatusText(status, options.style ?? plainStyle()),
    stderr: '',
  };
}
