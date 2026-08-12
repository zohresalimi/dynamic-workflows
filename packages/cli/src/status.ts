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
import type { Clock, NodeStatus, RunId, RunStatus } from '@DeFlow/core';
import { type DaemonFile, daemonFilePath, resolveDataDir, systemClock } from '@DeFlow/daemon';
import { listRunIds, openRead, readEpoch, replayRun } from '@DeFlow/ledger';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

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
  /** Node ids grouped by status, with the empty statuses left out. */
  readonly nodeCounts: Readonly<Partial<Record<NodeStatus, number>>>;
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
    const { pid, port, startedAt, processStartedAt } = parsed as Partial<DaemonFile>;
    if (typeof pid !== 'number' || typeof port !== 'number' || typeof startedAt !== 'number') {
      return 'unreadable';
    }
    return {
      pid,
      port,
      token: '',
      startedAt,
      processStartedAt: typeof processStartedAt === 'string' ? processStartedAt : null,
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
      runs.push({ runId, status: state.status, nodeCounts });
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
    runs: ledger.runs,
    ledgerError: ledger.error,
  };
}

/** `2 completed, 1 running`, or `no nodes yet`. */
function renderNodeCounts(counts: Readonly<Partial<Record<NodeStatus, number>>>): string {
  const parts = Object.entries(counts).map(([status, count]) => `${count} ${status}`);
  return parts.length === 0 ? 'no nodes yet' : parts.join(', ');
}

const LABEL = 14;
const field = (name: string, value: string): string => `  ${name.padEnd(LABEL)}${value}`;

/** The report an operator reads. @see renderStatusJson for the same values. */
export function renderStatusText(status: DaemonStatus): string {
  if (status.kind === 'none') {
    return [
      'DeFlow status: no daemon is running',
      `  there is no ${status.daemonFile}`,
      "  run 'DeFlow up' to start one",
      '',
    ].join('\n');
  }

  if (status.kind === 'stale') {
    const lines = ['DeFlow status: stale'];
    if (status.reason === 'unreadable') {
      lines.push(`  ${status.daemonFile} is not a daemon.json this build can read`);
    } else if (status.reason === 'pid-gone') {
      lines.push(
        `  ${status.daemonFile} records pid ${status.pid}, and no such process is running`,
      );
    } else if (status.reason === 'pid-recycled') {
      lines.push(
        `  ${status.daemonFile} records pid ${status.pid}, but that pid now belongs to a ` +
          'different process',
        `  recorded start time ${JSON.stringify(status.recordedStartTime)}, the OS reports ` +
          `${JSON.stringify(status.observedStartTime)}`,
      );
    } else {
      lines.push(
        `  ${status.daemonFile} records pid ${status.pid} with no start time, so it cannot be ` +
          'verified',
      );
    }
    lines.push(
      '  no signal was sent to that pid, and none should be',
      "  run 'DeFlow up' — it will take over cleanly",
      '',
    );
    return lines.join('\n');
  }

  const lines = [
    'DeFlow status: running',
    field('pid', String(status.pid)),
    field('port', String(status.port)),
    field('daemon_epoch', status.epoch === null ? 'unknown' : String(status.epoch)),
    field('uptime', formatUptime(status.uptimeMs)),
    field('data dir', status.dataDir),
    field('url', `http://127.0.0.1:${status.port}`),
  ];

  if (status.ledgerError !== null) {
    lines.push(`  the ledger could not be read: ${status.ledgerError}`);
  } else if (status.runs.length === 0) {
    lines.push('  no active runs');
  } else {
    lines.push(`  ${status.runs.length} active run${status.runs.length === 1 ? '' : 's'}`);
    const width = Math.max(...status.runs.map((run) => run.status.length));
    for (const run of status.runs) {
      lines.push(
        `    ${run.runId}  ${run.status.padEnd(width)}  ${renderNodeCounts(run.nodeCounts)}`,
      );
    }
  }

  lines.push('');
  return lines.join('\n');
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
          runs: status.runs.map((run) => ({
            runId: run.runId,
            status: run.status,
            nodeCounts: run.nodeCounts,
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
export function runStatus(options: StatusOptions & { readonly json?: boolean } = {}): StatusResult {
  const status = readStatus(options);
  return {
    exitCode: 0,
    stdout: options.json === true ? renderStatusJson(status) : renderStatusText(status),
    stderr: '',
  };
}
