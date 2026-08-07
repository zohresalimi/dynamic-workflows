/**
 * KAR-10.1 — resolving `{ kind: 'issue' }` by shelling out to `gh`.
 *
 * The epic's own risk note explains the shape: *"Shelling out to an
 * already-authenticated `gh issue view --json` is the shape most consistent
 * with AR-1's logic (the vendor's own tool, the user's own credentials)."*
 * This uses `gh api` rather than `gh issue view` for one reason: AC2 asks for
 * an HTTP status in provenance, and `gh api` talks to the REST endpoint
 * directly, so its failure text names the status a plain `issue view` does
 * not surface. A GET that exits 0 is always a 2xx; `gh` does not print the
 * status of a success, so `200` is recorded for one — the honest answer given
 * `gh` never actually shows a different one on this path.
 *
 * Only `github.com` issue URLs are resolved. The epic's own notes flag a
 * plain-HTTPS fallback for non-GitHub hosts as a `should`, not a `must`, and
 * NF1 ("no network beyond what the provider CLIs themselves need") is exactly
 * why this stays narrow rather than growing a second, DeFlowd-initiated HTTP
 * client for hosts nobody has asked for yet.
 *
 * `node:child_process.spawn` rather than `execa`: `packages/daemon/test/
 * spawn-chokepoint.test.ts` (KAR-07.1, docs/09-workspace-and-safety.md §1.1)
 * enforces `execa` as `git/run-git.ts`'s alone, the same way probing a vendor
 * agent binary (../../../adapters/src/probe.ts) uses raw `spawn` rather than
 * growing a second `execa` call site.
 *
 * The timeout is `clock.setTimer`, never a raw `setTimeout`:
 * `packages/daemon/test/no-timer-waits.test.ts` (KAR-06.6 AC1) allowlists
 * exactly one file — `../clock.ts` — as the one place a timer global may be
 * named, so a grace window anywhere else in the daemon goes through the
 * injected `Clock` (NF9) like every other wait in the system.
 *
 * A wedged `gh` is signalled through `killTree`, never `child.kill()`:
 * `test/one-kill-site.test.ts` (KAR-08.6 AC1) enforces exactly one process-kill
 * seam across the whole runtime tree, because `child.kill()` is execa's own
 * documented non-answer for a detached group — it signals the direct
 * subprocess only, leaving anything `gh` itself spawned running. `gh` is
 * spawned `detached: true` for the same reason every other daemon-spawned
 * child is: `killTree`'s negated-pid signal reaches a process's *group*, which
 * is only correct when that process leads its own.
 */
import { killTree } from '@DeFlow/adapters';
import type { Clock } from '@DeFlow/core';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { text } from 'node:stream/consumers';

/** Which resolver answered — carried in `task.submitted.provenance.resolver`. */
export const GH_RESOLVER = 'gh';

const GITHUB_ISSUE_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/;

export interface IssueResolution {
  readonly raw: string;
  readonly httpStatus: number;
  readonly resolver: string;
}

/**
 * A URL intake could not turn into a `task.submitted` payload — not
 * recognised, unreachable, or `gh` refused it. Names the URL and the resolver
 * so the operator's next move (paste the text instead) is one message away.
 */
export class IssueResolutionFailed extends Error {
  readonly url: string;
  readonly resolver: string;

  constructor(url: string, resolver: string, detail: string) {
    super(
      `could not resolve issue ${url} via ${resolver}: ${detail}. You may submit the issue text ` +
        "directly instead, as { kind: 'text' }.",
    );
    this.name = 'IssueResolutionFailed';
    this.url = url;
    this.resolver = resolver;
  }
}

export interface ResolveIssueOptions {
  /** Time enters here and nowhere else (NF9) — the grace window before a
   * wedged `gh` is signalled. */
  readonly clock: Clock;
  /** The full child environment — `PATH` above all. Defaults to the daemon's
   * own; a hermetic test overrides it to find a fake `gh` on a temp PATH. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}

/** `gh: <message> (HTTP <code>)` — the shape `gh api` actually reports a
 * REST failure in, on stderr. */
function httpStatusFrom(stderr: string): number | null {
  const match = /HTTP (\d+)/.exec(stderr);
  return match?.[1] === undefined ? null : Number(match[1]);
}

function describeFailure(exitCode: number | null, signal: string | null, stderr: string): string {
  const trimmed = stderr.trim();
  const status = httpStatusFrom(trimmed);
  if (status !== null) return `gh reported HTTP ${status}`;
  if (trimmed !== '') return trimmed;
  if (signal !== null) return `gh was killed by ${signal} (timed out)`;
  return `gh exited ${exitCode ?? 'null'}`;
}

interface GhInvocation {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function runGh(
  args: readonly string[],
  options: Required<Pick<ResolveIssueOptions, 'clock' | 'timeoutMs'>> &
    Pick<ResolveIssueOptions, 'env'>,
): Promise<GhInvocation> {
  const child = spawn('gh', [...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so the timeout below can negate its pid safely —
    // see the header note on killTree.
    detached: true,
    env: options.env ?? process.env,
  });

  const started = new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  // Registered at spawn time, not awaited until the end: an exit landing
  // before then must still be observed (the same reason
  // ../../../adapters/src/probe.ts registers its own the same way).
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });

  const timer = options.clock.setTimer(options.timeoutMs, () => {
    const pid = child.pid;
    if (pid === undefined) return; // Not spawned yet; nothing to signal.
    try {
      killTree(pid, 'SIGKILL');
    } catch {
      // Already gone, or unsignalable — either way there is nothing more to
      // do here; `exited` resolves from the child's own 'exit' event.
    }
  });

  try {
    await started;
    // Drained to the end of the *stream*, not to 'exit': a CLI that calls
    // process.exit right after writing can leave bytes in the pipe that
    // 'exit' wins the race against if nothing is already consuming them.
    const [stdout, stderr] = await Promise.all([text(child.stdout), text(child.stderr)]);
    const { code, signal } = await exited;
    return { exitCode: code, signal, stdout, stderr };
  } finally {
    timer.cancel();
  }
}

/**
 * Resolves a `github.com` issue URL to its raw REST body.
 *
 * Throws `IssueResolutionFailed` for anything that is not a clean success:
 * a URL this resolver does not recognise, `gh` missing or unauthenticated, a
 * 404, or the network being unreachable. Never returns a partial or invented
 * answer.
 */
export async function resolveIssue(
  url: string,
  options: ResolveIssueOptions,
): Promise<IssueResolution> {
  const match = GITHUB_ISSUE_URL.exec(url);
  if (match === null) {
    throw new IssueResolutionFailed(
      url,
      GH_RESOLVER,
      'not a recognised https://github.com/<owner>/<repo>/issues/<n> URL',
    );
  }
  const [, owner, repo, number] = match;

  let result: GhInvocation;
  try {
    result = await runGh(['api', `repos/${owner}/${repo}/issues/${number}`], {
      clock: options.clock,
      ...(options.env === undefined ? {} : { env: options.env }),
      timeoutMs: options.timeoutMs ?? 15_000,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new IssueResolutionFailed(url, GH_RESOLVER, `gh could not be started: ${detail}`);
  }

  if (result.exitCode !== 0) {
    throw new IssueResolutionFailed(
      url,
      GH_RESOLVER,
      describeFailure(result.exitCode, result.signal, result.stderr),
    );
  }

  return { raw: result.stdout.replace(/\n$/, ''), httpStatus: 200, resolver: GH_RESOLVER };
}
