/**
 * KAR-18.2 AC1, step 8 of the runbook — "then open the browser"
 * (docs/03-local-development.md §9).
 *
 * A spawned platform opener rather than a dependency. `open` the npm package
 * carries a per-platform binary shim and a WSL branch DeFlow does not use, and
 * the whole of what is needed here is one child process that is handed a URL
 * and forgotten about. That also keeps this testable the way everything else
 * that spawns is tested (docs/14 §3.3): a fake `$BROWSER` on a temp PATH, not a
 * mocked `child_process`.
 *
 * `$BROWSER` wins on every platform, because it is the convention every other
 * tool that opens a URL already honours, and `BROWSER=none` is how a headless
 * machine says "print it, do not launch anything" — the same answer as
 * `--no-open`, arrived at from the environment rather than from argv.
 *
 * **The URL carries the token in its fragment**, and that is what makes this
 * safe to hand to another program at all: a fragment is not sent to the server,
 * so it cannot reach an access log — but it *is* visible to the process being
 * spawned, which is why the program spawned is the operator's own browser and
 * never a vendor CLI or a shell.
 */
import { spawn } from 'node:child_process';

/** What to run, and with what. `null` means "the operator asked for nothing". */
export interface BrowserLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

export interface BrowserContext {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
}

/** The conventional `$BROWSER` value meaning "do not open anything". */
const NO_BROWSER = 'none';

/**
 * The program that gets the URL on this platform, or `null` when the
 * environment says not to open one.
 *
 * Pure, so the platform matrix is a unit test rather than a thing you find out
 * about on someone else's laptop.
 */
export function browserCommand(url: string, context: BrowserContext): BrowserLaunch | null {
  const configured = context.env.BROWSER;
  if (configured !== undefined && configured !== '') {
    return configured === NO_BROWSER ? null : { command: configured, args: [url] };
  }

  if (context.platform === 'darwin') return { command: 'open', args: [url] };
  // `start` is a cmd builtin, not a program, and its first quoted argument is
  // the window title — omitting the empty one makes a quoted URL become the
  // title and opens nothing.
  if (context.platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

/**
 * Hands `url` to the platform's browser and returns what it spawned, or `null`
 * when it spawned nothing.
 *
 * Detached, with every stream ignored, and unreferenced: the browser outlives
 * `deflow up` by design, and a daemon whose event loop is held open by a
 * browser it launched is a daemon that will not exit when the browser does not.
 * A failure to spawn is swallowed by the caller's `onError` rather than thrown
 * — a machine with no `xdg-open` is a machine where the operator clicks the URL
 * themselves, which is not a boot failure.
 */
export function openBrowser(
  url: string,
  context: BrowserContext,
  onError?: (error: Error) => void,
): BrowserLaunch | null {
  const launch = browserCommand(url, context);
  if (launch === null) return null;

  const child = spawn(launch.command, [...launch.args], {
    detached: true,
    stdio: 'ignore',
    env: context.env,
  });
  child.once('error', (error: Error) => onError?.(error));
  child.unref();
  return launch;
}
