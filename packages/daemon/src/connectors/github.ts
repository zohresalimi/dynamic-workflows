/**
 * KAR-22.4 — the GitHub connector. **DeFlow holds nothing.**
 *
 * ## The credential decision, in the one file that would be tempted to break it
 *
 * DeFlow has no registered OAuth application with GitHub. A client id in this
 * repository would be either fabricated or somebody else's, so there is none,
 * and there is no token, no secret and no refresh token either. What exists is:
 *
 *  - the operator runs `gh auth login`, which is **GitHub's own device flow,
 *    against GitHub's own application, in the operator's own browser**;
 *  - `gh` writes the token into **its own** credential store — an OS keyring,
 *    or a file under its own configuration directory, whichever it chose;
 *  - DeFlow spawns `gh` and reads its stdout.
 *
 * That is ADR-0003's own decision ("the vendor's own official binary, on the
 * user's own machine, under the user's own OS account, using the credentials
 * that binary already stored for itself") applied to a second class of
 * credential rather than excepted from — see the ADR's 2026-08-16 amendment.
 * `../intake/resolve-issue.ts` has worked this way since KAR-10.1; this module
 * is the same relationship, made visible on a screen.
 *
 * **This file must never read `gh`'s credential store.** It does not know where
 * it is and does not look: `~/.config/gh/hosts.yml` appears in this file
 * exactly once, in the sentence below that tells the *operator* where their
 * token is. `packages/daemon/test/connector-credential-guard.test.ts` reads
 * this module's import graph and fails if anything in it opens that path, reads
 * a `*_TOKEN` variable, or captures a login command's output.
 *
 * ## Why the probe is `gh api -i user` and not `gh auth status`
 *
 * `gh auth status` prints prose for a human, and a parse of it breaks on a
 * release note. `gh api -i user` returns GitHub's **own response headers**, and
 * `X-OAuth-Scopes` is a documented part of GitHub's REST API rather than a
 * detail of one CLI's output formatting. The scope check is therefore a fold of
 * two lists, and "insufficient permissions" becomes "you are missing `repo`,
 * run this".
 *
 * Verifies: EPIC-22-S48, EPIC-22-S52, EPIC-22-S53, EPIC-22-S69 · AC1, AC2, AC4
 */
import { runGh } from '../gh/run-gh.ts';
import type { ConnectorIssue, ConnectorService, ConnectorState, ProbePorts } from './registry.ts';

/**
 * The one scope reading issues needs.
 *
 * `repo` rather than something narrower because a fine-grained alternative does
 * not exist for a classic OAuth token, and asking for more than is needed would
 * be worse than saying which one is missing.
 */
const REQUIRED_SCOPES = ['repo'] as const;

/** `https://github.com/<owner>/<repo>/issues/<n>` — the shape `gh` returns. */
const ISSUE_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/issues\/\d+$/;

/** `gh auth refresh` with the missing scopes spelled out — never "grant the scope". */
export function refreshCommand(missing: readonly string[]): string {
  return `gh auth refresh --hostname github.com --scopes ${missing.join(',')}`;
}

/** How many issues one search may return. A picker, not a report. */
export const ISSUE_SEARCH_LIMIT = 25;

export const GITHUB: ConnectorService = {
  id: 'github',
  label: 'GitHub',
  requiredScopes: REQUIRED_SCOPES,
  credential: {
    authorisedBy:
      "GitHub's own OAuth application — the GitHub CLI's — through `gh auth login`, which opens " +
      "GitHub's device authorisation page in your own browser. DeFlow has no registered GitHub " +
      'application and does not use one that is not its own.',
    holder:
      'The GitHub CLI. DeFlow never reads, copies or transmits the token, and there is no field ' +
      'anywhere in this product to paste one into.',
    livesIn:
      "The GitHub CLI's own credential store on this machine — an OS keyring, or a file under " +
      '`gh`’s own configuration directory, whichever it chose. DeFlow does not know which and ' +
      'never looks; run `gh auth status` and `gh` will tell you.',
    deflowStores:
      'DeFlow stores no credential: one row holding this project and the word "github", and a ' +
      'timestamp.',
    revoke: {
      command: 'gh auth logout --hostname github.com',
      affects:
        "That is your credential rather than DeFlow's, so it also signs out `gh` itself and " +
        'anything else on this machine that uses it. Removing the connector here stops DeFlow ' +
        'using `gh` for this project without touching it.',
    },
  },
  authorisation: {
    command: 'gh auth login --hostname github.com --web --scopes repo',
    url: 'https://github.com/login/device',
    whyNotOneClick:
      'Connecting takes one command rather than one button because authorising an application ' +
      'against GitHub requires a registered OAuth application, and DeFlow does not have one. ' +
      "Running the command above uses GitHub's own — the GitHub CLI's — so the token GitHub " +
      'issues is held by `gh` on this machine and never by DeFlow.',
  },

  /**
   * `gh api -i user`, read through `readGithubState`.
   *
   * `cwd` is the project's own working tree, which is how `gh` resolves *which*
   * repository without DeFlow parsing a git remote — the CLI's own inference
   * rather than a second one here, and what makes AC5's "connectors are per
   * project" true of the data rather than only of the row.
   */
  async probe(ports: ProbePorts, repoPath: string): Promise<ConnectorState> {
    return readGithubState(
      await runGh(['api', '-i', 'user'], { clock: ports.clock, cwd: repoPath }),
    );
  },

  /**
   * `gh issue list`, with the search term handed to `gh` rather than applied
   * here: a repository with three hundred issues must not become three hundred
   * rows on the wire.
   *
   * A non-zero exit *after* a `connected` probe is a repository problem — no
   * remote, or a remote that is not a GitHub repository — rather than a
   * credential one, and an empty list is the honest rendering of "there is
   * nothing here to pick from".
   */
  async listIssues(
    ports: ProbePorts,
    repoPath: string,
    query: string,
  ): Promise<readonly ConnectorIssue[]> {
    const result = await runGh(
      [
        'issue',
        'list',
        '--json',
        'number,title,state,url',
        '--state',
        'all',
        '--limit',
        String(ISSUE_SEARCH_LIMIT),
        ...(query === '' ? [] : ['--search', query]),
      ],
      { clock: ports.clock, cwd: repoPath },
    );
    return result.exitCode === 0 ? readGithubIssues(result.stdout) : [];
  },
};

/** What `gh api -i user` did, as the caller observed it. */
export interface GhProbe {
  /** `false` when there is no `gh` on `PATH` at all. */
  readonly spawned: boolean;
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The header block of an HTTP response `gh -i` echoed, as lowercase name → value. */
function headersOf(raw: string): Map<string, string> {
  const headers = new Map<string, string>();
  // Everything before the first blank line. The body is deliberately not
  // parsed for anything but `login`: a scope is a fact about the token and
  // lives in a header, and reading one out of a body would let a repository
  // called "repo" satisfy the check.
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '') break;
    const at = line.indexOf(':');
    if (at === -1) continue;
    headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return headers;
}

/** The `login` of the authenticated account, or `null` if the body did not say. */
function loginOf(raw: string): string | null {
  const blank = raw.search(/\r?\n\r?\n/);
  if (blank === -1) return null;
  try {
    const body = JSON.parse(raw.slice(blank).trim()) as { login?: unknown };
    return typeof body.login === 'string' ? body.login : null;
  } catch {
    return null;
  }
}

const splitScopes = (value: string | undefined): readonly string[] =>
  value === undefined
    ? []
    : value
        .split(',')
        .map((scope) => scope.trim())
        .filter((scope) => scope !== '');

/** The first non-empty line of `gh`'s stderr — what it actually said. */
const firstLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '') ?? '';

/**
 * What `gh` just told us about this machine's GitHub credential.
 *
 * Pure, so the six states are a table rather than an integration run. The one
 * thing it must never do is guess: an exit code it does not recognise is
 * `unreachable` with `gh`'s own sentence attached, not `not-authorised` with a
 * confident command the operator will run for nothing.
 */
export function readGithubState(probe: GhProbe): ConnectorState {
  if (!probe.spawned) {
    return {
      state: 'not-installed',
      account: null,
      scopes: [],
      missingScopes: [...REQUIRED_SCOPES],
      message:
        'The GitHub CLI (`gh`) is not on this machine’s PATH. DeFlow reaches GitHub by running ' +
        'it, so there is nothing to connect until it is installed.',
      action: 'Install the GitHub CLI from https://cli.github.com, then reload this page.',
    };
  }

  const stderr = probe.stderr;

  if (probe.exitCode !== 0) {
    if (/HTTP 401|bad credentials/i.test(stderr)) {
      return {
        state: 'expired',
        account: null,
        scopes: [],
        missingScopes: [],
        message:
          'The credential `gh` holds is no longer accepted by GitHub — it expired, or it was ' +
          'revoked. Authorising again replaces it.',
        action: GITHUB.authorisation.command,
      };
    }
    if (/gh auth login|not logged in|GH_TOKEN|authentication token/i.test(stderr)) {
      return {
        state: 'not-authorised',
        account: null,
        scopes: [],
        missingScopes: [],
        message:
          'The GitHub CLI is installed but has not been authorised on this machine. Authorising ' +
          "opens GitHub's own page in your browser; DeFlow never sees the token.",
        action: GITHUB.authorisation.command,
      };
    }
    return {
      state: 'unreachable',
      account: null,
      scopes: [],
      missingScopes: [],
      // gh's own words, because this is the branch where DeFlow genuinely does
      // not know what happened and a paraphrase would be an invention.
      message: `\`gh\` could not reach GitHub and said: ${
        firstLine(stderr) === ''
          ? `it exited ${probe.exitCode ?? 'without a code'}`
          : firstLine(stderr)
      }`,
      action: null,
    };
  }

  const scopes = splitScopes(headersOf(probe.stdout).get('x-oauth-scopes'));
  const account = loginOf(probe.stdout);
  const missing = REQUIRED_SCOPES.filter((needed) => !scopes.includes(needed));

  if (missing.length > 0) {
    return {
      state: 'missing-scope',
      account,
      scopes,
      missingScopes: missing,
      message: `The credential \`gh\` holds is missing the ${missing.join(
        ', ',
      )} scope, which is what reading this repository's issues needs.`,
      action: refreshCommand(missing),
    };
  }

  return {
    state: 'connected',
    account,
    scopes,
    missingScopes: [],
    message:
      account === null
        ? 'Connected. The token stays in the GitHub CLI’s own credential store.'
        : `Connected as ${account}. The token stays in the GitHub CLI’s own credential store.`,
    action: null,
  };
}

/**
 * `gh issue list --json number,title,state,url`'s rows, reduced to the one
 * issue vocabulary every service is rendered in (AC3).
 *
 * The key is derived from **GitHub's own url** rather than from a repository
 * name DeFlow resolved separately. That is one fewer child process, and it also
 * means the key and the reference an operator could have pasted instead cannot
 * disagree — they came out of the same field.
 *
 * A row that cannot be keyed is dropped rather than rendered half-blank: a
 * picker offering an entry with no reference is a picker that submits a run
 * against nothing.
 */
export function readGithubIssues(stdout: string): readonly ConnectorIssue[] {
  let rows: unknown;
  try {
    rows = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];

  return rows.flatMap((row): ConnectorIssue[] => {
    const entry = row as { number?: unknown; title?: unknown; state?: unknown; url?: unknown };
    if (typeof entry.number !== 'number') return [];
    if (typeof entry.title !== 'string' || typeof entry.state !== 'string') return [];
    if (typeof entry.url !== 'string') return [];
    const repo = ISSUE_URL.exec(entry.url)?.[1];
    if (repo === undefined) return [];
    return [
      {
        key: `${repo}#${entry.number}`,
        title: entry.title,
        // GitHub says OPEN/CLOSED; the screen shows what the service said,
        // lowercased, rather than an adjective DeFlow invented for it.
        state: entry.state.toLowerCase(),
        url: entry.url,
      },
    ];
  });
}
