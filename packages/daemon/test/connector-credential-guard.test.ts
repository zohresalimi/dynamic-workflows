/**
 * KAR-22.4 test plan #2 — the AR-1 / ADR-0003 guard over the connector's own
 * import graph.
 *
 * ADR-0003's amendment of 2026-08-16 says DeFlow never possesses a credential
 * belonging to a third-party service, model provider or issue tracker. That is
 * a property of an *import graph* rather than of a file: the connector could
 * satisfy it perfectly and import a helper three modules down that reads
 * `~/.config/gh/hosts.yml` to be helpful, and the ADR would be violated by a
 * module nobody looked at.
 *
 * So this test walks the graph from `src/connectors/registry.ts` — every
 * relative import, transitively — and reads every file it reaches.
 *
 * Four things are forbidden, and each is a real thing somebody would plausibly
 * write:
 *
 *  1. **A model-provider credential store** — `~/.claude`, `~/.codex`,
 *     `~/.config/gcloud`. AR-1's original half.
 *  2. **A `*_API_KEY` / `*_TOKEN` / `*_SECRET` environment variable.** The
 *     "just read `GH_TOKEN`, it is already there" shortcut, which would make
 *     DeFlow hold a credential the moment one is exported.
 *  3. **`gh`'s own credential store.** The connector's whole design is that
 *     `gh` holds the token; a module that reads `hosts.yml` has taken it.
 *  4. **Capturing a login command's output.** `gh auth token` prints the token
 *     on stdout, and one line of code away from `gh api` it would be in this
 *     process's memory and then, plausibly, in a row.
 *
 * The guard is proved non-vacuous twice: it asserts the walk reached the
 * modules it is supposed to reach, and it runs the detector over synthetic
 * offending sources and requires each to be caught.
 *
 * **Extended by KAR-22.6 (test plan #9).** The second service is the one that
 * quietly holds a credential, because by then the rule feels settled and the
 * guard feels like somebody else's problem. Two rules were widened rather than
 * duplicated: the credential-store rule now names Atlassian's own store as well
 * as `gh`'s, and the login-capture rule matches an `auth` verb anywhere in an
 * argv array rather than only at its head — `acli`'s is `['jira', 'auth',
 * 'login']`, and the original pattern would have walked straight past it.
 *
 * Verifies: EPIC-22-S49 · KAR-22.4 AC2 · KAR-22.6 AC2
 */
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const ENTRY = resolve(SRC, 'connectors/connectors.ts');

/** Comments stripped, so a paragraph *explaining* the rule is not a breach of it. */
function codeOnly(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** Every relative import in `source`, resolved against `from`'s directory. */
function importsOf(source: string, from: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/from\s+'(\.[^']+)'/g)) {
    const specifier = match[1];
    if (specifier !== undefined) found.push(resolve(dirname(from), specifier));
  }
  return found;
}

/** The transitive closure of `entry`'s relative imports, `entry` included. */
function importGraph(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.pop();
    if (path === undefined || seen.has(path)) continue;
    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch {
      continue; // A package import that looked relative; nothing to read.
    }
    seen.set(path, source);
    queue.push(...importsOf(source, path));
  }
  return seen;
}

interface Rule {
  readonly what: string;
  readonly pattern: RegExp;
  /** A source that must be caught, so the rule cannot rot into a no-op. */
  readonly sabotage: string;
}

const RULES: readonly Rule[] = [
  {
    what: 'reads a model provider’s own credential store',
    pattern: /~\/\.claude|~\/\.codex|~\/\.config\/gcloud|\.claude\/\.credentials/,
    sabotage: "const store = join(home, '~/.claude/.credentials.json');",
  },
  {
    what: 'reads a credential out of the environment',
    pattern:
      /\benv\b[^\n]*\b[A-Z0-9_]*(?:API_KEY|_TOKEN|_SECRET)\b|process\.env\.[A-Z0-9_]*(?:API_KEY|TOKEN|SECRET)\b/,
    sabotage: 'const token = process.env.GH_TOKEN ?? "";',
  },
  {
    // The *act*, not the word. The connector's own prose tells the operator
    // where their token is — `~/.config/gh/hosts.yml` — and it has to, because
    // AC1 says the screen states where the token lives. What is forbidden is a
    // path expression that ends up in a filesystem call.
    what: 'reads a vendor CLI’s own credential store',
    pattern:
      /(?:readFile|readFileSync|open|openSync|createReadStream|join|resolve)\s*\([^)]*(?:hosts\.ya?ml|keyring|keychain|\.acli|atlassian[/\\]|credentials?\.(?:json|ya?ml))/i,
    sabotage: "readFileSync(join(configDir, 'gh', 'hosts.yml'), 'utf8');",
  },
  {
    // Again the act: `gh auth login` is *printed* by this module as the command
    // the operator runs themselves, exactly as ADR-0003 says Copilot's login is
    // surfaced. Spawning it — and therefore reading what it prints — is the
    // breach, so the pattern is the argv, not the sentence.
    what: 'captures the output of a login or token-printing command',
    pattern: /['"`]auth['"`]\s*,\s*['"`](?:token|login|refresh)['"`]|spawn\s*\([^)]*auth[^)]*token/,
    sabotage: "const out = await runGh(['auth', 'token'], options);",
  },
];

/**
 * KAR-22.6 — the same rules, run against the way *`acli`* would break them.
 *
 * A widened pattern that still only catches the `gh`-shaped violation is a
 * pattern that has been widened on paper. Each entry here is a line somebody
 * would plausibly write for the second service, and each must be caught by the
 * rule that claims to cover it.
 */
const ACLI_SABOTAGE: readonly { readonly what: string; readonly source: string }[] = [
  {
    what: 'reads a vendor CLI’s own credential store',
    source: "readFileSync(join(home, '.acli', 'credentials.json'), 'utf8');",
  },
  {
    what: 'captures the output of a login or token-printing command',
    source: "const out = await runCli('acli', ['jira', 'auth', 'login', '--token'], options);",
  },
];

const GRAPH = importGraph(ENTRY);
const display = (path: string): string => relative(SRC, path);

suite('EPIC-22-S49 — the connector’s import graph holds no credential (AC2)', () => {
  it('walked a graph that actually reaches the connector and the gh runner', () => {
    const reached = [...GRAPH.keys()].map(display).sort();

    // Not vacuous: if a refactor moved the connector out from under this entry
    // point, every rule below would pass over an empty set.
    expect(reached).toContain('connectors/registry.ts');
    expect(reached).toContain('connectors/github.ts');
    expect(reached).toContain('connectors/connectors.ts');
    expect(reached).toContain('gh/run-gh.ts');
    // KAR-22.6 — the two services added on top of the framework, and the one
    // seam both of them and `gh` spawn through. A guard that stopped at
    // `github.ts` would have let the second connector hold anything it liked.
    expect(reached).toContain('connectors/jira.ts');
    expect(reached).toContain('connectors/linear.ts');
    expect(reached).toContain('cli/run-cli.ts');
  });

  it.each(RULES)('nothing in the graph $what', (rule) => {
    const offenders = [...GRAPH.entries()]
      .filter(([, source]) => rule.pattern.test(codeOnly(source)))
      .map(([path]) => display(path));

    expect(offenders).toEqual([]);
  });

  it.each(RULES)('the rule for "$what" catches a source that does it', (rule) => {
    // A guard that cannot go red is a comment. Each pattern is run against the
    // line it exists to forbid.
    expect(rule.pattern.test(codeOnly(rule.sabotage))).toBe(true);
  });

  it.each(ACLI_SABOTAGE)('the rule for "$what" catches acli’s version of it', (entry) => {
    const rule = RULES.find((candidate) => candidate.what === entry.what);
    expect(rule, `no rule named "${entry.what}"`).toBeDefined();
    expect(rule?.pattern.test(codeOnly(entry.source))).toBe(true);
  });
});
