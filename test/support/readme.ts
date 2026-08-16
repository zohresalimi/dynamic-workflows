/**
 * KAR-20.3 — the root README, parsed.
 *
 * The README stopped being prose somebody maintains by memory on 2026-08-13,
 * when a reader followed its install section top to bottom and reached
 * `command not found`. Every sentence in it was true; the sequence was not an
 * install. Nothing mechanical could have caught that, because nothing
 * mechanical had ever read the file.
 *
 * This module is what reads it. It is deliberately dumb — it extracts, it does
 * not judge — so that the judging lives in the specs, where a failure names an
 * acceptance criterion. Four things come out of it:
 *
 *   * **the commands** (`parseCommands`), one per fenced shell line, which
 *     `test/readme-commands.test.ts` classifies and `e2e/readme-first-run.test.ts`
 *     runs in a clean room;
 *   * **the flags** (`parseFlags`), cross-checked against `deflow --help` in
 *     both directions;
 *   * **the agent-package table** (`parseAgentPackages`), resolved against the
 *     provider registry, because the block it replaces claimed that installing
 *     an ACP adapter gave you the vendor CLI;
 *   * **the two claim tables** (`parseExitCodes`, `parsePermissionLevels`),
 *     compared with `RUN_EXIT_CODES` and `PERMISSION_LEVELS`.
 *
 * The comparison functions at the bottom are pure and take their inputs rather
 * than reading them, which is what lets EPIC-20-S32's sabotage table drive the
 * *same* code the real specs use with a mutated input. A sabotage suite that
 * exercised a private copy would prove nothing about the checks that ship.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const README_PATH = fileURLToPath(new URL('../../README.md', import.meta.url));

export function readmeText(): string {
  return readFileSync(README_PATH, 'utf8');
}

/** The languages a fence has to carry for its lines to count as commands. */
const SHELL_FENCES = new Set(['bash', 'sh', 'shell', 'console', 'zsh']);

export interface ReadmeCommand {
  /** The command with any trailing `# comment` removed, trimmed. */
  readonly command: string;
  /**
   * The nearest heading above it, at any level, without the hashes.
   *
   * Any level rather than `##` alone, so that a subsection can hold the
   * commands a subsection is about. `## Install it` is then exactly the three
   * lines a reader types to install, which is what makes "nothing in the
   * install section may be skipped" a rule with teeth rather than one with a
   * carve-out for the no-Node bootstrap underneath it.
   */
  readonly section: string;
  /** 1-based, so a failure can be opened straight at the line. */
  readonly line: number;
}

/**
 * The comment a README line carries, removed — but only where a `#` is really
 * a comment.
 *
 * `deflow run "add rate limiting to the public API"` has no comment and
 * `deflow run --issue owner/repo#42` has a `#` that is part of an argument, so
 * this tracks quoting and requires whitespace in front. Getting it wrong in
 * either direction is silent: a stripped `#42` turns a real command into a
 * different one, and an unstripped comment makes every command unique to its
 * annotation.
 */
function withoutComment(line: string): string {
  let quote: string | null = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '#' && index > 0 && /\s/.test(line[index - 1] ?? '')) {
      return line.slice(0, index).trimEnd();
    }
  }
  return line.trimEnd();
}

/** Every fenced shell line in the README, in the order a reader meets them. */
export function parseCommands(text: string): readonly ReadmeCommand[] {
  const found: ReadmeCommand[] = [];
  let section = '';
  let fence: string | null = null;

  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trimEnd();
    const opening = /^```(\w*)/.exec(line);
    if (opening !== null) {
      fence = fence === null ? (opening[1] ?? '') : null;
      continue;
    }
    if (fence === null) {
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      if (heading !== null) section = (heading[1] ?? '').trim();
      continue;
    }
    if (!SHELL_FENCES.has(fence)) continue;

    const command = withoutComment(line.trim());
    if (command === '' || command.startsWith('#')) continue;
    found.push({ command, section, line: index + 1 });
  }

  return found;
}

/** The commands this project puts on `PATH` — whose flags `deflow --help` owns. */
const OWN_COMMANDS = new Set(['deflow', 'dfl', 'DeFlow']);

/**
 * The part of one shell line whose flags belong to **this project's** command,
 * or `''` when none of it does (KAR-20.4, EPIC-20-S40).
 *
 * KAR-20.3 read every `--flag` in the file, which was right while every fenced
 * line in the README was a `deflow` line. KAR-20.4's honest install route is
 * not: it has to say `pnpm --filter … pack --out …` and `npx --package=… --
 * deflow setup`, and `--filter`, `--out` and `--package` belong to pnpm and npx.
 * Scraping them into the cross-check reports them as flags `deflow`'s parser has
 * dropped, and the only ways to clear that without this function are an
 * allow-list — which goes blind to a flag somebody really does delete — or
 * deleting the build line, which is the defect this story exists to fix.
 *
 * The `--` case is the one worth stating: `npx` takes its own flags, then `--`,
 * then the **bin** and the bin's flags. So the separator is exactly where one
 * program's command line ends and the other's begins, which is why the split is
 * on the separator rather than on a list of known tools.
 */
function ownFlagPortion(command: string): string {
  const words = command.split(/\s+/).filter((word) => word !== '');
  // `DEFLOW_PACKAGE=… sh install.sh` — leading assignments are not the program.
  let start = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start] ?? '')) start += 1;

  if (OWN_COMMANDS.has(words[start] ?? '')) return words.slice(start).join(' ');

  const separator = words.indexOf('--', start);
  if (separator !== -1 && OWN_COMMANDS.has(words[separator + 1] ?? '')) {
    return words.slice(separator + 1).join(' ');
  }
  return '';
}

/**
 * Every long flag the README shows **for this project's command**, wherever it
 * shows one — prose, tables, inline code spans and fenced blocks alike.
 *
 * Everywhere, because a flag documented only in a table is still a flag a reader
 * will type, and a flag shown only in an example is still one the program has to
 * accept; the cross-check is worth nothing if it reads half the file. Shell
 * fences are the one place a flag can belong to somebody else, so they are the
 * one place attribution is applied — see {@link ownFlagPortion}. Everything
 * else, including non-shell fences, is read whole as before.
 */
export function parseFlags(text: string): readonly string[] {
  const readable: string[] = [];
  let fence: string | null = null;

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const opening = /^```(\w*)/.exec(line);
    if (opening !== null) {
      fence = fence === null ? (opening[1] ?? '') : null;
      continue;
    }
    if (fence !== null && SHELL_FENCES.has(fence)) {
      readable.push(ownFlagPortion(withoutComment(line.trim())));
      continue;
    }
    readable.push(line);
  }

  return [...new Set(readable.join('\n').match(/--[a-z][a-z0-9-]*/g) ?? [])].sort();
}

/** One row of the README's agent-package table. */
export interface AgentPackageRow {
  /** The provider id in the first column. */
  readonly provider: string;
  /** The npm package the row tells the reader to install. */
  readonly npmPackage: string;
  /** The binary that package puts on `PATH`. */
  readonly installs: string;
  /** The role, verbatim: the words before the em dash in the last column. */
  readonly role: string;
  readonly line: number;
}

/** The three roles a row is allowed to claim. Anything else is a typo. */
export const AGENT_ROLES = ['the vendor CLI', 'the ACP adapter', 'the bundled agent'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

const CODE_SPAN = /`([^`]+)`/;

/**
 * The agent-package table: one row per **package**, not per provider.
 *
 * Per package because two of the five vendors need two of them, and the block
 * this replaces had one line each and told the reader that the line installed
 * the vendor CLI. It did not. A shape that cannot express "this provider needs
 * two packages, and they are different things" is how that sentence survived
 * five stories.
 */
export function parseAgentPackages(text: string): readonly AgentPackageRow[] {
  const rows: AgentPackageRow[] = [];
  for (const [index, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== 4) continue;

    const [provider, npmPackage, installs, what] = cells;
    if (provider === undefined || npmPackage === undefined || installs === undefined) continue;
    if (what === undefined || !what.includes(' — ')) continue;

    const providerCode = CODE_SPAN.exec(provider);
    const packageCode = CODE_SPAN.exec(npmPackage);
    const installsCode = CODE_SPAN.exec(installs);
    if (providerCode === null || packageCode === null || installsCode === null) continue;

    const role = what.split(' — ')[0]?.trim() ?? '';
    if (!AGENT_ROLES.some((known) => known === role)) continue;

    rows.push({
      provider: providerCode[1] ?? '',
      npmPackage: packageCode[1] ?? '',
      installs: installsCode[1] ?? '',
      role,
      line: index + 1,
    });
  }
  return rows;
}

/** The exit codes the README's `run` table claims, code to meaning. */
export function parseExitCodes(text: string): ReadonlyMap<number, string> {
  const codes = new Map<number, string>();
  for (const raw of text.split('\n')) {
    // `[^|]*` and not `.+?`: a four-column row whose first cell is a number
    // would otherwise match with the middle two columns swallowed into the
    // second group, and this table would silently gain rows from another one.
    const row = /^\|\s*(\d+)\s*\|\s*([^|]*?)\s*\|$/.exec(raw.trim());
    if (row === null) continue;
    codes.set(Number(row[1]), row[2] ?? '');
  }
  return codes;
}

/** The permission levels the README's ladder table names, in table order. */
export function parsePermissionLevels(text: string): readonly string[] {
  const levels: string[] = [];
  for (const raw of text.split('\n')) {
    const row = /^\|\s*`([a-z+]+)`\s*\|\s*([^|]*?)\s*\|$/.exec(raw.trim());
    if (row === null) continue;
    const level = row[1];
    if (level !== undefined) levels.push(level);
  }
  return levels;
}

// ─── the classification: what the clean room runs, and what it cannot ────────

/**
 * Where a README command runs (KAR-20.4).
 *
 * Added because the honest install section is no longer one `npx` line. Until
 * there is a release npm can install, the tarball a reader installs is one they
 * build, so the section's first lines operate on **a clone of this repository**
 * and only its last line operates on a machine with nothing on it. Both are
 * executed; they cannot be executed in the same place.
 */
export const WHERE = ['checkout', 'clean-room'] as const;
export type Where = (typeof WHERE)[number];

export interface ExecutedCommand {
  /** Verbatim, as the README shows it. */
  readonly command: string;
  /**
   * The exit codes the README claims for it. More than one only where the
   * README itself says more than one — `doctor` is documented as 0 or 5.
   */
  readonly exits: readonly number[];
  /** A clone of this repository, or the clean room the install leaves behind. */
  readonly where: Where;
  /** What the spec actually runs, where it cannot run the line verbatim. */
  readonly substitution?: string;
}

/** Why a command cannot be run unattended. A closed set, on purpose. */
export const SKIP_REASONS = ['needs-the-network-or-a-vendor-login', 'runs-a-whole-run'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface SkippedCommand {
  /** Verbatim, as the README shows it. An exact string — never a pattern. */
  readonly command: string;
  readonly reason: SkipReason;
  /** The sentence a reader of a failure needs. */
  readonly why: string;
  /**
   * The spec that does run this, so the skip is a delegation and not a hole —
   * a **repo-relative path**, asserted to exist on disk (KAR-20.4).
   *
   * A path rather than the sentence this used to be. Two entries said
   * `"CI's own build job runs it on every push"`, which reads like coverage,
   * names nothing this repository can open, and was wrong: no CI job ran the
   * README's build line, which is why the install section could point at a
   * package npm has never been able to install and stay green.
   */
  readonly spec: string;
  /** What that spec does with it. */
  readonly how: string;
}

/**
 * The commands the specs run, in the order the README presents them.
 *
 * The first three are the README's **own** build and pack lines, run in a clone
 * of this repository, and the fourth installs the tarball they produced. That
 * is the correction KAR-20.4 made: KAR-20.3's spec packed a tarball of its own
 * and then ran `setup` against it, so the README's line was never executed and
 * could have said anything — which is exactly what it did say. Everything after
 * the install is the real installed binary, found on the `PATH` the install
 * left behind.
 *
 * The one substitution left is the tarball's destination. The README names a
 * fixed path under `/tmp` because a reader needs a string they can copy; a spec
 * that wrote there would collide with anything else running beside it.
 */
export const EXECUTED_COMMANDS: readonly ExecutedCommand[] = [
  { command: 'pnpm install', exits: [0], where: 'checkout' },
  { command: 'pnpm build', exits: [0], where: 'checkout' },
  {
    command: 'pnpm --filter deflowai pack --out /tmp/deflow.tgz',
    exits: [0],
    where: 'checkout',
    substitution: 'the same line with --out pointing into the spec’s own temp directory',
  },
  {
    command: 'npx --yes --package=/tmp/deflow.tgz -- deflow setup --from /tmp/deflow.tgz',
    exits: [0],
    where: 'clean-room',
    substitution:
      'the same line against the tarball the pack line above wrote, plus --yes --json so an unattended room neither prompts nor has to be screen-scraped',
  },
  { command: 'deflow --version', exits: [0], where: 'clean-room' },
  // 0 when every check is ok or warn, 5 when any fails — both are outcomes the
  // README documents, and a clean room with no vendor CLI can land on either.
  { command: 'deflow doctor', exits: [0, 5], where: 'clean-room' },
  { command: 'deflow doctor --fix', exits: [0, 5], where: 'clean-room' },
  { command: 'deflow init', exits: [0], where: 'clean-room' },
  {
    command: 'deflow up',
    exits: [0],
    where: 'clean-room',
    substitution: 'started, read for its URL, then stopped',
  },
  { command: 'deflow status', exits: [0], where: 'clean-room' },
  { command: 'deflow --help', exits: [0], where: 'clean-room' },
];

/**
 * The commands the clean room does not run, each with the spec that does.
 *
 * The list is the part of this story most likely to rot: a skip list that grows
 * to cover the interesting half turns the execution test into decoration
 * (AC4). Three rules hold it in place, and all three are asserted in
 * `test/readme-commands.test.ts` rather than described here — every entry is an
 * **exact command string** that must still be in the README, every entry names
 * one of two reasons, and **nothing in the install or first-run sections may
 * appear here at all**.
 */
export const SKIPPED_COMMANDS: readonly SkippedCommand[] = [
  {
    command: 'DEFLOW_PACKAGE=/tmp/deflow.tgz sh scripts/install.sh',
    reason: 'needs-the-network-or-a-vendor-login',
    why: 'reaches the same end state as the install above, and a second full install in one clean room would be measuring the first one',
    spec: 'e2e/setup-install.test.ts',
    how: 'runs scripts/install.sh against a packed tarball, in a room of its own',
  },
  {
    command: 'npm install -g @anthropic-ai/claude-code',
    reason: 'needs-the-network-or-a-vendor-login',
    why: 'installs a vendor CLI from npm, which then needs an interactive vendor login',
    spec: 'test/integration/readme-contract.test.ts',
    how: 'resolves the name against the provider registry and the verified-versions table',
  },
  {
    command: 'deflow run "add rate limiting to the public API"',
    reason: 'runs-a-whole-run',
    why: 'starts a real run against a real repository and does not return until it ends',
    spec: 'e2e/mock-only-run.test.ts',
    how: 'runs a whole plan on the bundled agent',
  },
  {
    command: 'deflow run --provider gemini "add rate limiting to the public API"',
    reason: 'runs-a-whole-run',
    why: 'the same run, pinned to a vendor CLI that is not installed in a clean room',
    spec: 'e2e/provider-selection.test.ts',
    how: 'drives --provider end to end',
  },
  {
    command: 'deflow run "refactor the auth module" --permission read',
    reason: 'runs-a-whole-run',
    why: 'the same run again, at the bottom of the permission ladder',
    spec: 'e2e/gate-ladder.test.ts',
    how: 'drives the ladder end to end',
  },
  {
    command: 'deflow ledger snapshot <runId> --out bug.db',
    reason: 'runs-a-whole-run',
    why: 'needs a run that already exists, and a clean room has none',
    spec: 'packages/cli/src/ledger-snapshot.test.ts',
    how: 'drives snapshot against a ledger it built',
  },
];

// ─── the comparisons, pure, so EPIC-20-S32 can sabotage their inputs ─────────

/** README commands that are on neither list — the extractor's own red. */
export function unclassifiedCommands(
  commands: readonly ReadmeCommand[],
  executed: readonly ExecutedCommand[] = EXECUTED_COMMANDS,
  skipped: readonly SkippedCommand[] = SKIPPED_COMMANDS,
): readonly string[] {
  const known = new Set([
    ...executed.map((entry) => entry.command),
    ...skipped.map((entry) => entry.command),
  ]);
  return commands.filter((entry) => !known.has(entry.command)).map((entry) => entry.command);
}

/** Classified commands the README no longer shows — a list gone stale. */
export function staleClassifications(
  commands: readonly ReadmeCommand[],
  executed: readonly ExecutedCommand[] = EXECUTED_COMMANDS,
  skipped: readonly SkippedCommand[] = SKIPPED_COMMANDS,
): readonly string[] {
  const shown = new Set(commands.map((entry) => entry.command));
  return [...executed.map((entry) => entry.command), ...skipped.map((entry) => entry.command)]
    .filter((command) => !shown.has(command))
    .sort();
}

/** README flags the program does not accept, judged from `--help` alone. */
export function flagsMissingFromHelp(
  flags: readonly string[],
  helpText: string,
): readonly string[] {
  return flags.filter((flag) => !new RegExp(`${flag}\\b`).test(helpText));
}

/** Flags a first run needs that the README does not show. */
export function flagsMissingFromReadme(
  required: readonly string[],
  flags: readonly string[],
): readonly string[] {
  const shown = new Set(flags);
  return required.filter((flag) => !shown.has(flag));
}

/** Exit codes the README and the program disagree about, either direction. */
export function exitCodeMismatches(
  documented: ReadonlyMap<number, string>,
  actual: readonly number[],
): readonly string[] {
  const shown = [...documented.keys()].sort((left, right) => left - right);
  const real = [...actual].sort((left, right) => left - right);
  const missing = real.filter((code) => !documented.has(code));
  const invented = shown.filter((code) => !real.includes(code));
  return [
    ...missing.map((code) => `the README does not document exit ${String(code)}`),
    ...invented.map((code) => `the README documents exit ${String(code)}, which run never exits`),
  ];
}

/** What one provider's registry entry says about the two names in a row. */
export interface RegistryFacts {
  readonly kind: 'native' | 'adapter';
  readonly bundled: boolean;
  /** The package that carries the binary DeFlow spawns. */
  readonly npmPackage: string;
  /** The binary DeFlow spawns. */
  readonly bin: string;
  /** The vendor CLI underneath — the same as `bin` for a native provider. */
  readonly vendorBin: string;
}

/**
 * Every way the README's agent table can disagree with the registry.
 *
 * The one that matters is the last: a row whose package is an **adapter's**
 * package and whose `installs` cell is the **vendor's** binary is the exact
 * sentence this story deleted, and it read as helpful for five stories.
 */
export function agentPackageMismatches(
  rows: readonly AgentPackageRow[],
  registry: ReadonlyMap<string, RegistryFacts>,
): readonly string[] {
  const problems: string[] = [];
  const adapterPackages = new Map<string, RegistryFacts>();
  for (const facts of registry.values()) adapterPackages.set(facts.npmPackage, facts);

  for (const row of rows) {
    const facts = registry.get(row.provider);
    const at = `README:${String(row.line)} ${row.provider}/${row.npmPackage}`;
    if (facts === undefined) {
      problems.push(`${at} names a provider the registry does not have`);
      continue;
    }

    const claimedAdapter = adapterPackages.get(row.npmPackage);
    if (claimedAdapter !== undefined && claimedAdapter.bin !== row.installs) {
      problems.push(`${at} claims it installs "${row.installs}", not "${claimedAdapter.bin}"`);
      continue;
    }

    if (row.npmPackage === facts.npmPackage) {
      const expected = facts.bundled
        ? 'the bundled agent'
        : facts.kind === 'adapter'
          ? 'the ACP adapter'
          : 'the vendor CLI';
      if (row.role !== expected)
        problems.push(`${at} is ${expected}, and the row says "${row.role}"`);
      if (row.installs !== facts.bin) {
        problems.push(`${at} installs "${facts.bin}", and the row says "${row.installs}"`);
      }
      continue;
    }

    // Not the registry's package. That is only ever legitimate for an
    // **adapter** provider, where the registry names the bridge and the vendor
    // CLI underneath it is a package DeFlow never installs. A native provider
    // has one package and the registry has it, so a second name here is a
    // second name — which is what a package rename in the registry looks like
    // from the README's side, and what EPIC-20-S32's third row sabotages.
    if (facts.kind !== 'adapter') {
      problems.push(`${at} is not "${facts.npmPackage}", which is the only package it has`);
      continue;
    }

    if (row.installs !== facts.vendorBin) {
      problems.push(`${at} is neither the ACP package nor the "${facts.vendorBin}" vendor CLI`);
      continue;
    }
    if (row.role !== 'the vendor CLI') {
      problems.push(`${at} is the vendor CLI, and the row says "${row.role}"`);
    }
  }

  for (const [provider, facts] of registry) {
    const forProvider = rows.filter((row) => row.provider === provider);
    const wanted = facts.kind === 'adapter' ? 2 : 1;
    if (forProvider.length !== wanted) {
      problems.push(
        `${provider} needs ${String(wanted)} row(s) and the README has ${String(forProvider.length)}`,
      );
    }
  }

  return problems;
}

// ─── KAR-20.4 — what this repository cannot yet send a reader to ─────────────

/**
 * A name the README is not allowed to hand a reader, and the evidence.
 *
 * Both entries carry the command they were checked with and the date, because
 * the thing that went wrong here was a claim nobody re-ran: the install section
 * was written the day before a release, in the tense of a release that had
 * happened, and the release then happened without making it true. An entry
 * whose evidence is a sentence rather than a command is how that repeats.
 */
export interface UnavailableTarget {
  /** The literal a reader would follow. */
  readonly name: string;
  readonly kind: 'host' | 'package';
  /** The command it was checked with, and when. */
  readonly checked: string;
  /** What happens to the reader who follows it. */
  readonly what: string;
}

export const UNAVAILABLE_TARGETS: readonly UnavailableTarget[] = [
  {
    name: 'deflow.dev',
    kind: 'host',
    checked: '`curl -fsSL https://deflow.dev/install.sh` and `dig +short A deflow.dev`, 2026-08-16',
    what: 'the name resolves — 162.255.119.85, on a registrar’s parking nameservers — and serves nothing: the connection times out rather than answering 404. This repository does not publish to that host and never has, so the line told a reader to pipe a file out of somewhere the project does not control',
  },
  {
    name: 'deflowai',
    kind: 'package',
    checked: '`npx --yes --package=deflowai -- deflow --version`, 2026-08-16',
    what: 'published as 0.1.0 and not installable: the manifest went up with `"better-sqlite3": "catalog:"`, pnpm’s workspace-catalog protocol left unresolved by `npm publish`, and npm refuses it with EUNSUPPORTEDPROTOCOL. `pnpm pack` resolves the same field to 13.0.2, which is why the local route works and the registry one does not',
  },
];

/** One shell line, split into tokens, with quotes and `--flag=` prefixes removed. */
function specifiers(command: string): readonly string[] {
  return command.split(/\s+/).map((token) => {
    const value = token.includes('=') ? (token.split('=').at(-1) ?? '') : token;
    return value.replace(/^["']|["']$/g, '');
  });
}

/** Commands whose first word makes a package manager fetch, without qualification. */
const ALWAYS_FETCHES = new Set(['npx', 'bunx', 'pnpx']);
/** Package managers that fetch only for some subcommands. */
const FETCHES_WHEN = new Map<string, ReadonlySet<string>>([
  ['npm', new Set(['install', 'i', 'add', 'exec', 'create'])],
  ['pnpm', new Set(['install', 'i', 'add', 'dlx', 'exec', 'create'])],
  ['yarn', new Set(['add', 'dlx', 'create'])],
  ['bun', new Set(['add', 'install', 'create', 'x'])],
]);

/**
 * Whether this line makes a package manager resolve names against a registry.
 *
 * The subcommand is the first word after the program that is neither a flag nor
 * a flag's argument-looking neighbour — `pnpm --filter deflowai pack` has to
 * read as `pack`, which does not fetch, and not as `--filter`. Taking the first
 * *matching* word rather than the first word is what allows that, and it is
 * safe in the fetch direction: a line containing `add` or `install` as a word
 * of its own is fetching whatever else is on it.
 */
function fetchesFromRegistry(command: string): boolean {
  const words = command.split(/\s+/).filter((word) => word !== '');
  const first = words[0];
  if (first === undefined) return false;
  if (ALWAYS_FETCHES.has(first)) return true;
  const subcommands = FETCHES_WHEN.get(first);
  if (subcommands === undefined) return false;
  return words.slice(1).some((word) => subcommands.has(word));
}

/** Whether `token` asks a registry for `name`, at any version. */
function isRegistrySpecifier(token: string, name: string): boolean {
  return token === name || token.startsWith(`${name}@`);
}

/**
 * Fenced commands that would fetch `name` from a registry.
 *
 * **Registry lookups, not characters.** `deflowai` is a legitimate string in a
 * packed tarball's filename, in a `pnpm --filter`, and as `scripts/install.sh`'s
 * `DEFLOW_PACKAGE` default — where it is the fallback for the day the package
 * installs, not a promise made to anybody today. A guard that banned the
 * characters could only be satisfied by deleting the publish path, which is the
 * opposite of what AC5 asks for. So a line is refused when its *command* is one
 * that resolves names against a registry **and** one of its specifiers is this
 * name; `/tmp/deflow.tgz` is a path and `--filter deflowai` does not fetch.
 */
export function registryFetches(
  commands: readonly ReadmeCommand[],
  name: string,
): readonly string[] {
  return commands
    .filter(
      (entry) =>
        fetchesFromRegistry(entry.command) &&
        specifiers(entry.command).some((token) => isRegistrySpecifier(token, name)),
    )
    .map((entry) => `${String(entry.line)}: ${entry.command}`);
}

/**
 * Fenced commands using the bare `npx <package>` form, which cannot work here.
 *
 * Permanent, and independent of whether anything is published. `npx <name>`
 * resolves a package and then has to pick a **bin**, which it can only do for a
 * package declaring one bin or a bin named after the package. This one declares
 * four — `deflow`, `dfl`, `deflow-mcp`, `deflow-mock-agent` — and matches none,
 * deliberately, because KAR-20.1 moved the package name off the command name to
 * get onto npm at all. npm answers `could not determine executable to run`.
 *
 * So this is not the same check as {@link registryFetches} and does not expire
 * with it: on the day a registry install works, the line the README shows is
 * `npx --package=<name> -- deflow setup`, and the bare form is still wrong.
 */
export function bareNpxForms(commands: readonly ReadmeCommand[], name: string): readonly string[] {
  return commands
    .filter((entry) => {
      const words = entry.command.split(/\s+/).filter((word) => word !== '');
      if (words[0] !== 'npx' && words[0] !== 'bunx') return false;
      const target = words.slice(1).find((word) => !word.startsWith('-'));
      return target !== undefined && isRegistrySpecifier(target, name);
    })
    .map((entry) => `${String(entry.line)}: ${entry.command}`);
}

/** One file, read, for the host sweep. */
export interface ScannedFile {
  readonly path: string;
  readonly text: string;
}

/** Every line in `files` naming `host`, as `path:line text`. */
export function hostReferences(files: readonly ScannedFile[], host: string): readonly string[] {
  return files.flatMap((file) =>
    file.text
      .split('\n')
      .flatMap((line, index) =>
        line.includes(host) ? [`${file.path}:${String(index + 1)} ${line.trim()}`] : [],
      ),
  );
}

/** The `--out`, `--package=` or `--from` path a command names, if it names one. */
function argumentAfter(command: string, flag: string): string | undefined {
  const words = command.split(/\s+/).filter((word) => word !== '');
  for (const [index, word] of words.entries()) {
    if (word === flag) return words[index + 1];
    if (word.startsWith(`${flag}=`)) return word.slice(flag.length + 1);
  }
  return undefined;
}

/**
 * Everything wrong with the install section, judged against one fact: whether a
 * reader can install this from a registry today (KAR-20.4 AC1, AC5).
 *
 * Takes that fact as an argument rather than importing it, so the spec can run
 * the check against the flag **and** against the flag inverted and require the
 * second to fail. That is what makes release day a failing build instead of a
 * thing somebody has to remember — the shape `ALIAS_REMOVED_IN` uses for the
 * deprecated alias.
 *
 * The interesting rule is the last one. It is not enough that the section shows
 * a pack line and an install line; the tarball the install line names has to be
 * *the one the pack line writes*. Otherwise the section is two correct halves
 * that do not compose, which — with the destination substituted in the spec —
 * is precisely how KAR-20.3's suite stayed green over a README pointing at a
 * package npm could not install.
 */
export function installSectionProblems(
  install: readonly ReadmeCommand[],
  registryInstallWorks: boolean,
  names: { readonly package: string; readonly oneCommand: string },
): readonly string[] {
  const problems: string[] = [];
  const commands = install.map((entry) => entry.command);
  const first = commands[0];

  if (registryInstallWorks) {
    if (first !== names.oneCommand) {
      problems.push(
        `a registry install works, so the section must lead with "${names.oneCommand}" and it leads with "${first ?? '<nothing>'}"`,
      );
    }
    if (commands.includes('pnpm build')) {
      problems.push('a registry install works, so the section must not build anything');
    }
    return problems;
  }

  for (const found of registryFetches(install, names.package)) {
    problems.push(`no registry install works, and this line fetches from one — ${found}`);
  }
  if (first !== 'pnpm install') {
    problems.push(
      `no registry install works, so the section must start in a clone of this repository and it starts with "${first ?? '<nothing>'}"`,
    );
  }

  const packed = commands.filter((command) => command.includes(' pack '));
  const installed = commands.filter((command) => command.includes('deflow setup'));
  if (packed.length !== 1 || installed.length !== 1) {
    problems.push(
      `the section needs one pack line and one setup line, and has ${String(packed.length)} and ${String(installed.length)}`,
    );
    return problems;
  }

  const [packLine] = packed;
  const [setupLine] = installed;
  if (packLine === undefined || setupLine === undefined) return problems;
  if (commands.indexOf(packLine) > commands.indexOf(setupLine)) {
    problems.push('the section packs the tarball after installing it');
  }

  const built = argumentAfter(packLine, '--out');
  for (const flag of ['--package', '--from']) {
    const used = argumentAfter(setupLine, flag);
    if (used !== built) {
      problems.push(
        `the pack line writes "${built ?? '<nothing>'}" and the setup line's ${flag} names "${used ?? '<nothing>'}"`,
      );
    }
  }

  return problems;
}
