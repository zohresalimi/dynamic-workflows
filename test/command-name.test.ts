/**
 * KAR-20.1 — the command is `deflow`, and the boundary of that rename is a
 * decision rather than a `sed` that ran until it stopped matching.
 *
 * Three guards live here, and each one exists because of a failure that is
 * silent on the author's machine:
 *
 *   * **The source guard** (EPIC-20-S7). 468 tracked files carried a
 *     `DeFlow `-prefixed command literal; a find-and-replace fixes every one
 *     of them and then a report tells the reader to type a command that no
 *     longer exists. The guard is a list of **named** patterns rather than one
 *     `grep DeFlow`, because AC9 keeps the product's own spelling in prose —
 *     "DeFlow spawns claude-agent-acp" is correct and must stay correct.
 *   * **The case guard** (EPIC-20-S6). This checkout has
 *     `core.ignorecase = true`, so a case-only path pair merges into one entry
 *     here and arrives as two files on `ubuntu-26.04`.
 *   * **The non-rename guard** (EPIC-20-S8). `.DeFlow/`, `$XDG_DATA_HOME/DeFlow`,
 *     the `DeFlow_*` environment variables, the `@DeFlow/*` workspace scope and
 *     the `DeFlow/<runId>__<nodeId>` branch prefix are **not** renamed, each for
 *     its own reason. Without a guard, "the rename is finished" and "the rename
 *     ate the state directory" look identical from here.
 *
 * Verifies: EPIC-20-S6 · EPIC-20-S7 · EPIC-20-S8 · the registry half of
 * EPIC-20-S10 · AC2, AC3, AC6, AC8
 */
import { execFileSync } from 'node:child_process';
import { expect, it, describe as suite } from 'vitest';
import { PROVIDER_SPECS } from '../packages/adapters/src/provider-registry.ts';
import { COMMAND, DEPRECATED_COMMAND, NOT_RENAMED } from '../packages/cli/src/command-name.ts';
import { DATA_DIR_ENV, resolveDataDir } from '../packages/daemon/src/data-dir.ts';
import { nodeBranch } from '../packages/daemon/src/git/branch-name.ts';
import { readText, repoRoot } from './support/workspace.ts';

/** Every path git tracks, which is exactly the set that reaches a CI runner. */
function trackedPaths(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter((path) => path !== '');
}

/**
 * The text files the source guard reads.
 *
 * Extension-driven rather than "everything git tracks": the repository carries
 * PNG fixtures and a SQLite golden or two, and a byte that happens to spell
 * `DeFlow up` inside a blob is not a shipped string.
 */
const TEXT_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.vue',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.md',
  '.yml',
  '.yaml',
  '.snap',
  '.sh',
  '.html',
  '.css',
  '.txt',
];

/**
 * The two files allowed to spell the old name as a command.
 *
 * `command-name.ts` **is** the alias — it cannot name the thing it deprecates
 * without spelling it — and this file is the guard, which has to carry the
 * pattern it looks for.
 */
const ALIAS_MODULE = 'packages/cli/src/command-name.ts';
const GUARD_FILES = new Set([
  ALIAS_MODULE,
  'test/command-name.test.ts',
  'packages/cli/test/command-name.test.ts',
  'packages/cli/test/integration/deprecated-alias.test.ts',
  // The story and its scenarios quote the old name on purpose: they are the
  // record of what was renamed and why.
  'docs/delivery/epics/EPIC-20-install-and-naming.md',
  'docs/delivery/flows/EPIC-20-install-and-naming-flows.md',
]);

/**
 * `packages/ledger/src/migrations/` — exempt, and the reason is a stronger
 * rule than this one.
 *
 * A shipped migration is **append-only and content-hashed**
 * (`packages/ledger/test/migrations-content-hash.test.ts`): editing one, even
 * to correct a word in a comment, changes a hash that pins what already ran
 * against users' databases. Two of them mention the old command in prose about
 * *why* the migration exists. Nothing in a migration is a user-visible string —
 * they are comments — so the cost of the exemption is a stale sentence in a
 * file nobody reads at a prompt, against the cost of breaking the append-only
 * guarantee, which is the ledger's whole argument.
 */
const EXEMPT_PREFIXES = ['packages/ledger/src/migrations/'];

interface Pattern {
  /** What this pattern means, printed in the failure. */
  readonly what: string;
  readonly re: RegExp;
}

/**
 * A command literal is the capitalised name in a position where a **shell**
 * would read it, or where npm would resolve it as a package name. Prose is not
 * one of those positions (AC9), which is why this is a list rather than
 * `/DeFlow/`.
 */
const COMMAND_LITERALS: readonly Pattern[] = [
  { what: 'a companion bin name', re: /\bDeFlow-(?:mcp|mock-agent)\b/g },
  {
    // `(?![-\w=])` and not `\b`: `git worktree add --reason "DeFlow run=<runId>"`
    // (docs/09 §3) is a *reason string* written into the worktree metadata, not
    // a command line, and `\b` matches happily before the `=`.
    what: 'a command line',
    re: /\bDeFlow(?=\s+(?:init|up|run|cancel|doctor|status|ledger|replay|setup|help)(?![-\w=]))/g,
  },
  { what: 'the command with a flag', re: /\bDeFlow(?=\s+--?[a-zA-Z])/g },
  // `Usage: DeFlow <command> [options]` — the line AC2 names first, and the one
  // a `\b`-based sweep walks straight past because the next character is `<`.
  { what: 'a usage line with a placeholder', re: /\bDeFlow(?=\s+<)/g },
  { what: 'npx with the old name', re: /\bnpx\s+DeFlow\b/g },
  { what: 'a pnpm filter on the package name', re: /--filter['",\s]+DeFlow\b/g },
  { what: 'an import of the published package', re: /(?:from|import)\s*\(?\s*(['"])DeFlow\1/g },
  { what: 'a bin selector', re: /\bbin:\s*(['"])DeFlow\1/g },
  { what: 'a package selector', re: /\bpackage:\s*(['"])DeFlow\1/g },
  { what: 'a dependency on the published package', re: /^\s*"DeFlow":/gm },
];

interface Offence {
  readonly path: string;
  readonly line: number;
  readonly what: string;
  readonly text: string;
}

function offencesIn(path: string): Offence[] {
  const lines = readText(path).split('\n');
  const found: Offence[] = [];
  for (const [index, line] of lines.entries()) {
    for (const pattern of COMMAND_LITERALS) {
      pattern.re.lastIndex = 0;
      if (pattern.re.test(line)) {
        found.push({ path, line: index + 1, what: pattern.what, text: line.trim() });
      }
    }
  }
  return found;
}

suite('the source guard: no shipped string names the capitalised command (AC2, EPIC-20-S7)', () => {
  const scanned = trackedPaths().filter(
    (path) =>
      !GUARD_FILES.has(path) &&
      !EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
      TEXT_EXTENSIONS.some((extension) => path.endsWith(extension)),
  );

  it('has something to scan', () => {
    // A guard whose input silently became empty is a guard that passes forever.
    expect(scanned.length).toBeGreaterThan(500);
  });

  it('finds no command literal anywhere outside the alias module', () => {
    const offences = scanned.flatMap((path) => offencesIn(path));
    expect(
      offences.map(({ path, line, what, text }) => `${path}:${String(line)} (${what}) ${text}`),
    ).toEqual([]);
  });

  it('would catch a command literal if one appeared', () => {
    // The guard's own red. Every pattern is exercised, so a typo that makes one
    // of them match nothing cannot hide behind the other nine.
    const samples = [
      'run DeFlow-mcp to serve the tools',
      "then 'DeFlow doctor' reports it",
      'DeFlow --version prints it',
      'Usage: DeFlow <command> [options]',
      'npx DeFlow setup',
      'pnpm --filter DeFlow exec publint',
      "import { approveSpec } from 'DeFlow';",
      "  bin: 'DeFlow',",
      "  package: 'DeFlow',",
      '    "DeFlow": "workspace:*",',
    ];
    expect(samples.length).toBe(COMMAND_LITERALS.length);
    for (const [index, sample] of samples.entries()) {
      const pattern = COMMAND_LITERALS[index];
      if (pattern === undefined) throw new Error('pattern missing');
      pattern.re.lastIndex = 0;
      expect([pattern.what, pattern.re.test(sample)]).toEqual([pattern.what, true]);
    }
  });

  it('leaves the product name in prose alone (AC9)', () => {
    const prose = [
      'DeFlow spawns "claude-agent-acp" from @agentclientprotocol/claude-agent-acp',
      'the agent bundled with DeFlow',
      'DeFlow is not published to npm yet',
      'X-DeFlow-Submitted-By',
      'DeFlowd holds the lease',
      'a DeFlow/<runId>__<nodeId> branch',
    ];
    for (const line of prose) {
      for (const pattern of COMMAND_LITERALS) {
        pattern.re.lastIndex = 0;
        expect([line, pattern.what, pattern.re.test(line)]).toEqual([line, pattern.what, false]);
      }
    }
  });
});

suite('the case guard: a rename that only works on a Mac is not done (AC6, EPIC-20-S6)', () => {
  it('tracks no two paths that differ only by case', () => {
    const byLowercase = new Map<string, string[]>();
    for (const path of trackedPaths()) {
      const key = path.toLowerCase();
      byLowercase.set(key, [...(byLowercase.get(key) ?? []), path]);
    }
    const collisions = [...byLowercase.values()].filter((paths) => paths.length > 1);
    expect(collisions).toEqual([]);
  });

  it('ships no build step that renames a path to itself in a different case', () => {
    const scripts = trackedPaths().filter(
      (path) => /(?:^|\/)scripts\//.test(path) && path.endsWith('.ts'),
    );
    expect(scripts.length).toBeGreaterThan(0);

    const renames = /(?:renameSync|rename)\(\s*(['"`])([^'"`]+)\1\s*,\s*(['"`])([^'"`]+)\3\s*\)/g;
    const caseOnly: string[] = [];
    for (const path of scripts) {
      const text = readText(path);
      for (const match of text.matchAll(renames)) {
        const [, , from, , to] = match;
        if (from === undefined || to === undefined) continue;
        if (from !== to && from.toLowerCase() === to.toLowerCase()) {
          caseOnly.push(`${path}: ${from} -> ${to}`);
        }
      }
    }
    expect(caseOnly).toEqual([]);
  });
});

suite('the non-rename guard: the five names that keep their spelling (AC8, EPIC-20-S8)', () => {
  it('enumerates the boundary in the code, with a reason each', () => {
    // In the code as well as in the epic file: a boundary that lives only in a
    // document is one the next sweep does not read.
    expect(NOT_RENAMED.map(({ name }) => name)).toEqual([
      '.DeFlow/',
      '$XDG_DATA_HOME/DeFlow',
      'DeFlow_*',
      '@DeFlow/*',
      'DeFlow/<runId>__<nodeId>',
      'DeFlowd, and the product name in prose',
    ]);
    for (const entry of NOT_RENAMED) {
      expect([entry.name, entry.why.length > 40]).toEqual([entry.name, true]);
    }
  });

  it('keeps the repo-local state directory as .DeFlow/', () => {
    // Renaming it orphans every already-initialised repository's committed
    // config and every .gitignore entry `init` wrote, for no ergonomic gain —
    // nobody types a directory name at a prompt.
    expect(readText('packages/daemon/src/init/workspace-init.ts')).toContain("'.DeFlow'");
    expect(readText('.gitignore')).toContain('.DeFlow/');
  });

  it('keeps the global state directory as $XDG_DATA_HOME/DeFlow', () => {
    expect(resolveDataDir({ XDG_DATA_HOME: '/xdg' })).toBe('/xdg/DeFlow');
  });

  it('keeps the DeFlow_* environment variables', () => {
    // A second deprecation window with two spellings live at once, in exchange
    // for nothing a user notices.
    expect(DATA_DIR_ENV).toBe('DeFlow_DATA_DIR');
    const envNames = new Set<string>();
    for (const path of trackedPaths().filter((candidate) => candidate.endsWith('.ts'))) {
      for (const match of readText(path).matchAll(/\bDeFlow_[A-Z][A-Z0-9_]*/g)) {
        envNames.add(match[0]);
      }
    }
    expect(envNames.has('DeFlow_KEEP_TMP')).toBe(true);
    expect(envNames.size).toBeGreaterThan(20);
  });

  it('keeps the @DeFlow/* workspace scope', () => {
    // None of it is published (docs/16-repo-layout.md §2), so it is invisible
    // outside this repository.
    expect(readText('packages/daemon/package.json')).toContain('"@DeFlow/core"');
    expect(readText('packages/cli/package.json')).toContain('"@DeFlow/daemon"');
  });

  it('keeps the DeFlow/<runId>__<nodeId> branch prefix', () => {
    // Renaming it strands in-flight worktrees and branches in repositories
    // DeFlow has already touched.
    expect(nodeBranch('r-2026', 'impl')).toBe('DeFlow/r-2026__impl');
  });

  it('keeps DeFlowd, the daemon, spelled as it was', () => {
    expect(readText('packages/cli/src/run/daemon.ts')).toContain("'DeFlowd.log'");
  });
});

suite('the bundled agent is deflow-mock-agent (AC3, EPIC-20-S10)', () => {
  it('names the lowercase binary in the registry entry', () => {
    expect(PROVIDER_SPECS.mock.bin).toBe('deflow-mock-agent');
    expect(PROVIDER_SPECS.mock.shim.bin).toBe('deflow-mock-agent');
  });

  it('names the published package by its publishable name', () => {
    expect(PROVIDER_SPECS.mock.package).toBe(COMMAND);
  });
});

suite('the names themselves', () => {
  it('is lowercase, and the old one is not', () => {
    expect(COMMAND).toBe('deflow');
    expect(DEPRECATED_COMMAND).toBe('DeFlow');
    expect(COMMAND).toBe(DEPRECATED_COMMAND.toLowerCase());
  });
});
