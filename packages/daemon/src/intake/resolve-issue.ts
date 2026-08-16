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
 * **How the child is spawned lives in `../gh/run-gh.ts`**, not here. KAR-22.4
 * needed a `gh` for a second reason — the connectors screen — and a second
 * `spawn('gh')` would have been a second door past the process-group, timeout
 * and kill-seam rules this module was careful about. It is also what makes
 * ADR-0003's "DeFlow never captures a login command's output" checkable: there
 * is one call site to check.
 */
import type { Clock } from '@DeFlow/core';
import { GH_TIMEOUT_MS, type GhInvocation, runGh } from '../gh/run-gh.ts';

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

  const result: GhInvocation = await runGh(['api', `repos/${owner}/${repo}/issues/${number}`], {
    clock: options.clock,
    ...(options.env === undefined ? {} : { env: options.env }),
    timeoutMs: options.timeoutMs ?? GH_TIMEOUT_MS,
  });

  // A missing `gh` is a refusal here, unlike on the connectors screen where it
  // is a state with an install link: an operator who pasted an issue URL asked
  // a question, and the honest answer is that it could not be answered.
  if (!result.spawned) {
    throw new IssueResolutionFailed(
      url,
      GH_RESOLVER,
      `gh could not be started: ${result.spawnError ?? 'unknown reason'}`,
    );
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
