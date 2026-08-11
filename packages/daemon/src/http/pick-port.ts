/**
 * KAR-18.2 AC4 — step 5 of the boot sequence: "7777, or the next free one via
 * `get-port`" (docs/03-local-development.md §9).
 *
 * The two halves are deliberately different, and the difference is the whole
 * story:
 *
 * - **The default drifts.** 7777 being busy is not evidence that DeFlow is
 *   running — it is evidence that something is on 7777 — so the daemon takes
 *   the next free port and says so. The lease, not the port, is what decides
 *   whether a second daemon may start (EPIC-18-S9).
 * - **A pinned port does not drift.** `--port 8080` is a human saying a tunnel,
 *   a bookmark or a reverse proxy points there. Silently choosing 8081 produces
 *   a daemon nobody can reach and no error explaining why, so an occupied
 *   pinned port is a refusal (EPIC-18-S10).
 *
 * The port chosen here is chosen **once**, and every later mention of it —
 * the printed URL, `daemon.json`, `DeFlow status`, `/api/health` — reads the
 * port that was actually bound rather than re-deriving it from the constant.
 * That re-derivation is the failure EPIC-18-S9 exists to catch: the URL says
 * one thing, the daemon file says another, and the UI cannot authenticate.
 *
 * `get-port` rather than a hand-rolled bind-and-see, for one reason a
 * hand-rolled version always misses: it keeps a short-lived lock on the port it
 * just handed out, so two daemons started microseconds apart (a supervisor, a
 * script, a test harness) are not handed the same "free" port.
 */

import { createServer } from 'node:net';
import getPort, { portNumbers } from 'get-port';
import { DEFAULT_HOSTNAME, DEFAULT_PORT } from './server.ts';

/** How far past the preferred port the search runs before giving up on the
 * range and letting the OS choose. 100 is a range a human can still recognise
 * as "near 7777" in a URL. */
const SEARCH_WINDOW = 100;

/**
 * An explicitly pinned port that something else already holds (AC4).
 *
 * The port is a field as well as a substring of the message: the CLI maps this
 * onto an exit code and a sentence, and a CLI that had to re-parse its own
 * error text would be one refactor away from printing the wrong number.
 */
export class PortInUse extends Error {
  readonly port: number;

  constructor(port: number) {
    super(
      `DeFlow up: port ${port} is already in use — stop what is listening on it, or omit ` +
        '--port and DeFlow will take the next free one',
    );
    this.name = 'PortInUse';
    this.port = port;
  }
}

export interface PickPortOptions {
  /**
   * The operator's `--port`. Refused when occupied rather than replaced.
   *
   * `0` is passed straight through: it means "any port the OS likes", which
   * cannot be in use, and it is how every spec in this repository asks for an
   * ephemeral one.
   */
  readonly requested?: number | undefined;
  /** Where the search starts when nothing was pinned. Defaults to 7777. */
  readonly preferred?: number | undefined;
  /** The interface the daemon will bind. Defaults to `127.0.0.1`. */
  readonly host?: string | undefined;
}

/**
 * Whether `port` can be bound on `host` right now — asked by binding it.
 *
 * Deliberately **not** `get-port` for the pinned case. `get-port` keeps a
 * process-wide 15-second lock on every port it hands out, so a port it picked a
 * moment ago reads as unavailable to it — correct behaviour for "find me
 * something free", and a lie when the question is "is the operator's port
 * occupied?". The answer to that one is the same bind the daemon is about to
 * perform, and nothing smaller is honest.
 */
function isFree(port: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

/** Resolves the port DeFlowd will bind, or throws `PortInUse`. */
export async function pickPort(options: PickPortOptions = {}): Promise<number> {
  const host = options.host ?? DEFAULT_HOSTNAME;
  const { requested } = options;

  if (requested !== undefined) {
    if (requested === 0) return 0;
    if (!(await isFree(requested, host))) throw new PortInUse(requested);
    return requested;
  }

  const preferred = options.preferred ?? DEFAULT_PORT;
  return getPort({ port: portNumbers(preferred, preferred + SEARCH_WINDOW), host });
}
