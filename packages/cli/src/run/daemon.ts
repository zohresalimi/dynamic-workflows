/**
 * KAR-18.3 AC1, AC2, AC4 — finding a daemon, or starting one that outlives you.
 *
 * Three decisions live here, and each of them is an acceptance criterion.
 *
 * **Health is polled unauthenticated.** `GET /api/health` is the one public
 * route (KAR-15.2), and it has to be: the token does not exist until the daemon
 * has written `daemon.json`, so a client that sent a bearer header while
 * waiting for the daemon to come up would be sending an empty one and 401ing
 * itself. That is this story's named red for the happy path.
 *
 * **Attach before autostart.** A daemon that answers `/api/health` is the
 * daemon; nothing is spawned, `daemon_epoch` does not move and the lease is
 * never contended (AC2). An autostart that ran unconditionally would trip the
 * lease and exit 2, which looks like a CLI bug and is a design bug.
 *
 * **The daemon is spawned `detached`.** That single option is the whole of AC4:
 * `setsid` puts DeFlowd in its own process group, so a Ctrl-C at the terminal —
 * which the tty delivers to the *foreground process group* — never reaches it,
 * and a `SIGKILL` of the CLI leaves it and every agent it owns running. Its
 * output goes to a file in the data directory rather than to an inherited pipe,
 * because a pipe whose reader exits turns the daemon's next log line into
 * `EPIPE` hours later.
 */
import { daemonFilePath } from '@DeFlow/daemon';
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

/** Where a live daemon is, and what it will accept. */
export interface DaemonEndpoint {
  readonly baseUrl: string;
  readonly token: string;
  readonly pid: number;
  /** True when this process started it (AC1) rather than found it (AC2). */
  readonly autostarted: boolean;
}

export type DaemonLookup =
  | { readonly kind: 'attached'; readonly endpoint: DaemonEndpoint }
  | { readonly kind: 'refused'; readonly message: string };

/** The daemon's own log, so an autostarted DeFlowd is not a silent one. */
export const DAEMON_LOG_NAME = 'DeFlowd.log';

interface DaemonFileShape {
  readonly pid: number;
  readonly port: number;
  readonly token: string;
}

/** `daemon.json`, or `null` when there is none or it is not readable. */
function readDaemonFile(dataDir: string): DaemonFileShape | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(daemonFilePath(dataDir), 'utf8'));
    const { pid, port, token } = parsed as Partial<DaemonFileShape>;
    if (typeof pid !== 'number' || typeof port !== 'number' || typeof token !== 'string') {
      return null;
    }
    return { pid, port, token };
  } catch {
    return null;
  }
}

/** `GET /api/health`, with no `Authorization` header — see the module note. */
async function healthy(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2_000) });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The daemon this machine is already running, or `null`.
 *
 * `null` covers all three of "no file", "a file left by a daemon that died"
 * and "a file naming a port somebody else took" — from a client's side they
 * are the same fact, which is that nothing there answers.
 */
export async function findDaemon(dataDir: string): Promise<DaemonEndpoint | null> {
  const file = readDaemonFile(dataDir);
  if (file === null) return null;
  const baseUrl = `http://127.0.0.1:${file.port}`;
  if (!(await healthy(baseUrl))) return null;
  return { baseUrl, token: file.token, pid: file.pid, autostarted: false };
}

export interface EnsureDaemonOptions {
  readonly dataDir: string;
  readonly env: NodeJS.ProcessEnv;
  /** The node binary to re-exec. Defaults to this process's own. */
  readonly execPath?: string;
  /** This CLI's entry file — `src/bin.ts` in the workspace, `dist/bin.mjs`
   * installed. Defaults to `process.argv[1]`, which is right in both. */
  readonly binPath?: string;
  /** How long to wait for `/api/health` after spawning. */
  readonly timeoutMs?: number;
  /** Resolves after `ms`. Injected so a spec need not wait in real time. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  // A ref'd timer, deliberately: while this is the only thing outstanding, the
  // unref'd default would let Node decide the process had finished and exit
  // between two polls.
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Attaches to the running daemon, or starts one detached and waits for it.
 *
 * The spawned command is `DeFlow up --no-open`: there is no second way to boot
 * a daemon, which is what keeps the eight-step sequence, the lease and the
 * token file identical whether an operator typed `up` or `run`.
 */
export async function ensureDaemon(options: EnsureDaemonOptions): Promise<DaemonLookup> {
  const attached = await findDaemon(options.dataDir);
  if (attached !== null) return { kind: 'attached', endpoint: attached };

  const sleep = options.sleep ?? defaultSleep;
  const logPath = join(options.dataDir, DAEMON_LOG_NAME);
  let log: number;
  try {
    // The very first `DeFlow run` on a machine is the first thing to touch the
    // data directory at all — `DeFlow up` creates it during boot, and here the
    // log is opened *before* that boot has started.
    mkdirSync(options.dataDir, { recursive: true });
    log = openSync(logPath, 'a');
  } catch (error) {
    return {
      kind: 'refused',
      message:
        `DeFlow run: cannot write ${logPath} (${error instanceof Error ? error.message : String(error)}) — ` +
        "run 'DeFlow doctor' to see which state directories are usable",
    };
  }

  const child = spawn(
    options.execPath ?? process.execPath,
    [options.binPath ?? process.argv[1] ?? '', 'up', '--no-open'],
    {
      // AC4, and it is this option and nothing else: its own process group,
      // no controlling terminal, and no handle on this process's stdio.
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...options.env },
    },
  );

  // A holder rather than a bare `let`: the only assignment is inside the
  // callback, so control-flow analysis would narrow a `let` to `null` for ever
  // and the check below would become dead code the compiler agreed with.
  const departed: { happened: boolean; code: number | null } = { happened: false, code: null };
  child.once('exit', (code) => {
    departed.happened = true;
    departed.code = code;
  });
  // Nothing here waits on the child. It is the daemon now.
  child.unref();

  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  while (Date.now() < deadline) {
    const endpoint = await findDaemon(options.dataDir);
    if (endpoint !== null)
      return { kind: 'attached', endpoint: { ...endpoint, autostarted: true } };

    // A refusal we can name: `DeFlow up` exits 2 for a lease it could not take
    // or a port it could not have, and its own sentence is already in the log.
    if (departed.happened) {
      return {
        kind: 'refused',
        message:
          `DeFlow run: the daemon exited with ${departed.code ?? 'a signal'} before it was ready — ` +
          `see ${logPath}`,
      };
    }
    await sleep(50);
  }

  return {
    kind: 'refused',
    message:
      `DeFlow run: no daemon answered /api/health within ${options.timeoutMs ?? 30_000} ms — ` +
      `see ${logPath}`,
  };
}
