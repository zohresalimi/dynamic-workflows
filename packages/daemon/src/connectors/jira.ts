/**
 * KAR-22.6 — the Jira connector. **DeFlow holds nothing here either.**
 *
 * ## The credential decision, unchanged from KAR-22.4's
 *
 * Atlassian publishes its own command-line tool, `acli`, and it has exactly the
 * shape `gh` has:
 *
 *  - the operator runs `acli jira auth login … --web`, which authorises against
 *    **Atlassian's own application, in the operator's own browser**;
 *  - `acli` writes the credential into **its own** store;
 *  - DeFlow spawns `acli` and reads its stdout.
 *
 * That is ADR-0003's own decision applied to a third credential rather than
 * excepted from — see the ADR's amendments of 2026-08-16. There is no token in
 * this file, no client id, and no read of `acli`'s store: it does not know
 * where that store is and does not look.
 * `packages/daemon/test/connector-credential-guard.test.ts` walks this module's
 * import graph and fails if that changes.
 *
 * ## Where this is less certain than `github.ts`, said out loud
 *
 * `gh api -i user` returns GitHub's own HTTP headers, and `X-OAuth-Scopes` is a
 * documented part of GitHub's REST API. `acli jira auth status` publishes **no
 * documented machine-readable output**, and `--json`'s exact shape is not
 * specified for `workitem search` either. Two consequences, both deliberate:
 *
 *  - **The state parse is exit-code-first and message-second, and its default
 *    is `unreachable` carrying `acli`'s own sentence.** An unrecognised failure
 *    is never diagnosed confidently, because the cost of a wrong confident
 *    diagnosis is an operator running a login command about a network cable.
 *  - **The issue parse accepts either plausible `--json` shape** — a bare array
 *    or Jira's REST `{ issues: [...] }` envelope, nested `fields` or flattened
 *    — and drops any row it cannot key, because an entry with no reference is
 *    an entry that submits a run against nothing.
 *
 * ## What Jira does not get, and why
 *
 * `gh` infers *which repository* from the directory it runs in, which is what
 * makes GitHub's list this project's own. `acli` has no equivalent: nothing
 * ties a directory on disk to a Jira project, and DeFlow stores no Jira project
 * key. So this list is every work item the operator's own account can see, most
 * recently updated first, narrowed by what they type — and `credential`'s
 * prose says so on the screen rather than leaving it to be discovered. The
 * per-project isolation AC4 asks for is unmodified where it is asserted: the
 * connector row is per project, and an unconnected project's search is refused.
 *
 * Verifies: EPIC-22-S70, EPIC-22-S72, EPIC-22-S73 · KAR-22.6 AC2, AC3, AC4
 */
import { type CliInvocation, firstLine, runCli } from '../cli/run-cli.ts';
import type { ConnectorIssue, ConnectorService, ConnectorState, ProbePorts } from './registry.ts';
import { ISSUE_SEARCH_LIMIT } from './registry.ts';

/** Atlassian's own published install guide. Not a package-manager guess. */
const INSTALL_PAGE = 'https://developer.atlassian.com/cloud/acli/guides/install-acli/';

/** The documented login, with Atlassian's own flag names and obvious placeholders. */
const LOGIN_COMMAND =
  'acli jira auth login --site <your-site>.atlassian.net --email <your-atlassian-email> --web';

/** `acli`'s message for a credential the site rejected outright. */
const EXPIRED = /\b401\b|unauthori[sz]ed|invalid credential|invalid.{0,20}token|expired/i;

/** `acli`'s message for a machine nobody has logged in on. */
const NOT_AUTHORISED = /not logged in|no active account|not authenticated|auth login|no account/i;

/** The account `acli auth status` named, when its prose named one. */
const ACCOUNT = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;

export const JIRA: ConnectorService = {
  id: 'jira',
  label: 'Jira',
  /**
   * None, and this is a statement rather than an omission.
   *
   * Atlassian's credentials are not scoped the way a GitHub OAuth token is:
   * what governs whether an account may read a work item is that account's own
   * Jira project permissions, which `acli` reports as an ordinary failure and
   * not as a named scope. Declaring a scope here would put a name on the screen
   * that nothing on this machine can confirm or deny, which is the opposite of
   * what AC4's missing-scope rule is for.
   */
  requiredScopes: [],
  credential: {
    authorisedBy:
      'Atlassian’s own application — the Atlassian CLI’s — through `acli jira auth login`, which ' +
      'opens Atlassian’s own sign-in page in your browser. DeFlow has no registered Atlassian ' +
      'application and does not use one that is not its own.',
    holder:
      'The Atlassian CLI (`acli`). DeFlow never reads, copies or transmits the credential, and ' +
      'there is no field anywhere in this product to paste one into.',
    livesIn:
      'The Atlassian CLI’s own credential store on this machine. DeFlow does not know where that ' +
      'is and never looks; run `acli jira auth status` and `acli` will tell you.',
    deflowStores:
      'DeFlow stores no credential: one row holding this project and the word "jira", and a ' +
      'timestamp. It stores no Jira site and no project key either — which is why this list is ' +
      'every work item your own Jira account can see, most recently updated first, rather than ' +
      'one Jira project’s.',
    revoke: {
      command: 'acli jira auth logout',
      affects:
        'That is your credential rather than DeFlow’s, so it also signs out `acli` itself and ' +
        'anything else on this machine that uses it for Jira. Removing the connector here stops ' +
        'DeFlow using `acli` for this project without touching it.',
    },
  },
  authorisation: {
    kind: 'command',
    command: LOGIN_COMMAND,
    // `--web` opens Atlassian's own consent page, and DeFlow is not part of
    // that conversation: it does not know the address, so it does not print
    // one. A guessed link that 404s is worse than no link.
    url: null,
    whyNotOneClick:
      'Connecting takes one command rather than one button because authorising an application ' +
      'against Atlassian requires a registered application, and DeFlow does not have one. ' +
      'Running the command above uses Atlassian’s own — the Atlassian CLI’s — so the credential ' +
      'Atlassian issues is held by `acli` on this machine and never by DeFlow. `acli --help` ' +
      'will tell you which of `--site` and `--email` your own instance needs.',
  },

  /**
   * `acli jira auth status`, read through `readJiraState`.
   *
   * `cwd` is passed for symmetry with GitHub's probe and for nothing else:
   * `acli` infers no Jira project from a directory, which is exactly the
   * limitation `credential.deflowStores` states on the screen.
   */
  async probe(ports: ProbePorts, repoPath: string): Promise<ConnectorState> {
    return readJiraState(
      await runCli('acli', ['jira', 'auth', 'status'], { clock: ports.clock, cwd: repoPath }),
    );
  },

  /**
   * `acli jira workitem search`, with the term handed to `acli` as JQL rather
   * than applied as a filter here: a Jira instance with three hundred work
   * items must not become three hundred rows on the wire.
   *
   * A non-zero exit *after* a `connected` probe is a query or permission
   * problem rather than a credential one, and an empty list is the honest
   * rendering of "there is nothing here to pick from".
   */
  async listIssues(
    ports: ProbePorts,
    repoPath: string,
    query: string,
  ): Promise<readonly ConnectorIssue[]> {
    const result = await runCli(
      'acli',
      [
        'jira',
        'workitem',
        'search',
        '--jql',
        jqlFor(query),
        '--fields',
        'key,summary,status',
        '--limit',
        String(ISSUE_SEARCH_LIMIT),
        '--json',
      ],
      { clock: ports.clock, cwd: repoPath },
    );
    return result.exitCode === 0 ? readJiraIssues(result.stdout) : [];
  },
};

/**
 * `query` as JQL.
 *
 * An empty term is an ordering rather than a filter, so an operator who has
 * typed nothing yet still sees something to pick from. A term becomes a `text ~`
 * match, with the two characters that can end a JQL string literal escaped —
 * argv goes straight to the child with no shell in between, so this is about
 * JQL's own quoting rules and nothing else.
 */
function jqlFor(query: string): string {
  const term = query.trim();
  if (term === '') return 'ORDER BY updated DESC';
  const quoted = term.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `text ~ "${quoted}" ORDER BY updated DESC`;
}

/**
 * What `acli` just told us about this machine's Jira credential.
 *
 * Pure, so the states are a table rather than an integration run, and
 * deliberately unwilling to guess: an exit code whose message this does not
 * recognise is `unreachable` with `acli`'s own sentence attached, never
 * `not-authorised` with a confident command the operator will run for nothing.
 */
export function readJiraState(
  probe: Pick<CliInvocation, 'spawned' | 'exitCode' | 'stdout' | 'stderr'>,
): ConnectorState {
  if (!probe.spawned) {
    return {
      state: 'not-installed',
      account: null,
      scopes: [],
      missingScopes: [],
      message:
        'The Atlassian CLI (`acli`) is not on this machine’s PATH. DeFlow reaches Jira by running ' +
        'it, so there is nothing to connect until it is installed.',
      action: `Install the Atlassian CLI from ${INSTALL_PAGE}, then reload this page.`,
    };
  }

  const said = probe.stderr === '' ? probe.stdout : probe.stderr;

  if (probe.exitCode !== 0) {
    if (EXPIRED.test(said)) {
      return {
        state: 'expired',
        account: null,
        scopes: [],
        missingScopes: [],
        message:
          'The credential `acli` holds is no longer accepted by Atlassian — it expired, or it was ' +
          'revoked. Authorising again replaces it.',
        action: LOGIN_COMMAND,
      };
    }
    if (NOT_AUTHORISED.test(said)) {
      return {
        state: 'not-authorised',
        account: null,
        scopes: [],
        missingScopes: [],
        message:
          'The Atlassian CLI is installed but has not been authorised on this machine. ' +
          'Authorising opens Atlassian’s own page in your browser; DeFlow never sees the ' +
          'credential.',
        action: LOGIN_COMMAND,
      };
    }
    return {
      state: 'unreachable',
      account: null,
      scopes: [],
      missingScopes: [],
      // `acli`'s own words, because this is the branch where DeFlow genuinely
      // does not know what happened and a paraphrase would be an invention.
      message: `\`acli\` could not reach Jira and said: ${
        firstLine(said) === '' ? `it exited ${probe.exitCode ?? 'without a code'}` : firstLine(said)
      }`,
      action: null,
    };
  }

  return {
    state: 'connected',
    account: ACCOUNT.exec(probe.stdout)?.[0] ?? null,
    scopes: [],
    missingScopes: [],
    message: 'Connected. The credential stays in the Atlassian CLI’s own store.',
    action: null,
  };
}

/** One row of `acli`'s `--json`, in whichever of its plausible shapes it came. */
interface JiraRow {
  readonly key?: unknown;
  readonly self?: unknown;
  readonly summary?: unknown;
  readonly status?: unknown;
  readonly fields?: { readonly summary?: unknown; readonly status?: unknown };
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** `status` as Jira sent it — a bare string, or an object with a `name`. */
function statusName(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    return asString((value as { name?: unknown }).name);
  }
  return null;
}

/**
 * `https://<site>/browse/<KEY>` from the `self` link Jira's REST rows carry.
 *
 * Derived from **Jira's own url** rather than from a site DeFlow stored
 * separately, for `readGithubIssues`'s reason: the key and the reference an
 * operator could have pasted instead cannot disagree, because they came out of
 * the same field. A row with no `self` is dropped rather than rendered with a
 * reference DeFlow guessed.
 */
function browseUrl(self: string | null, key: string): string | null {
  if (self === null) return null;
  try {
    return `${new URL(self).origin}/browse/${key}`;
  } catch {
    return null;
  }
}

/**
 * `acli jira workitem search --json`'s rows, reduced to the one issue
 * vocabulary every service is rendered in (AC3).
 *
 * Tolerant of shape because `acli`'s `--json` is documented to exist and not
 * documented to have a particular structure — see this module's header. A row
 * that cannot be keyed, or whose reference cannot be derived, is dropped rather
 * than rendered half-blank: a picker offering an entry with no reference is a
 * picker that submits a run against nothing.
 */
export function readJiraIssues(stdout: string): readonly ConnectorIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : typeof parsed === 'object' &&
        parsed !== null &&
        Array.isArray((parsed as { issues?: unknown }).issues)
      ? (parsed as { issues: unknown[] }).issues
      : [];

  return rows.flatMap((row): ConnectorIssue[] => {
    const entry = row as JiraRow;
    const key = asString(entry.key);
    if (key === null) return [];

    const title = asString(entry.fields?.summary) ?? asString(entry.summary);
    const state = statusName(entry.fields?.status) ?? statusName(entry.status);
    if (title === null || state === null) return [];

    const url = browseUrl(asString(entry.self), key);
    if (url === null) return [];

    // Jira says "In Progress"; the screen shows what the service said,
    // lowercased, rather than an adjective DeFlow invented for it — the same
    // rule `readGithubIssues` follows for OPEN/CLOSED.
    return [{ key, title, state: state.toLowerCase(), url }];
  });
}
