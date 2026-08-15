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

/**
 * Every long flag the README shows, anywhere it shows one — fenced blocks and
 * inline code spans alike.
 *
 * Both, because a flag documented only in a table is still a flag a reader will
 * type, and a flag shown only in an example is still one the program has to
 * accept. The cross-check is worth nothing if it reads half the file.
 */
export function parseFlags(text: string): readonly string[] {
  return [...new Set(text.match(/--[a-z][a-z0-9-]*/g) ?? [])].sort();
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

export interface ExecutedCommand {
  /** Verbatim, as the README shows it. */
  readonly command: string;
  /**
   * The exit codes the README claims for it. More than one only where the
   * README itself says more than one — `doctor` is documented as 0 or 5.
   */
  readonly exits: readonly number[];
  /** What the clean room actually runs, where it cannot run the line verbatim. */
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
  /** The spec that does run this, so the skip is a delegation, not a hole. */
  readonly covered: string;
}

/**
 * The commands the clean room runs, in the order the README presents them.
 *
 * `npx deflowai setup` is run against a **packed tarball** rather than against
 * the registry, which is the same code path with a different specifier and the
 * only one available before a first publish — `e2e/setup-install.test.ts` makes
 * the same substitution for the same reason. Everything after it is the real
 * installed binary, found on the `PATH` the install left behind.
 */
export const EXECUTED_COMMANDS: readonly ExecutedCommand[] = [
  {
    command: 'npx deflowai setup',
    exits: [0],
    substitution: 'npx --package=<packed tarball> -- deflow setup --json --yes --from <tarball>',
  },
  { command: 'deflow --version', exits: [0] },
  // 0 when every check is ok or warn, 5 when any fails — both are outcomes the
  // README documents, and a clean room with no vendor CLI can land on either.
  { command: 'deflow doctor', exits: [0, 5] },
  { command: 'deflow doctor --fix', exits: [0, 5] },
  { command: 'deflow init', exits: [0] },
  { command: 'deflow up', exits: [0], substitution: 'started, read for its URL, then stopped' },
  { command: 'deflow status', exits: [0] },
  { command: 'deflow --help', exits: [0] },
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
    command: 'curl -fsSL https://deflow.dev/install.sh -o install.sh',
    reason: 'needs-the-network-or-a-vendor-login',
    why: 'fetches over the network from a host this repository does not serve in a test',
    covered: 'test/install-script.test.ts reads the script this downloads',
  },
  {
    command: 'sh install.sh',
    reason: 'needs-the-network-or-a-vendor-login',
    why: 'the script it runs is the one the line above downloads, over the network',
    covered: 'e2e/setup-install.test.ts runs scripts/install.sh against a packed tarball',
  },
  {
    command: 'npm install -g @anthropic-ai/claude-code',
    reason: 'needs-the-network-or-a-vendor-login',
    why: 'installs a vendor CLI from npm, which then needs an interactive vendor login',
    covered: 'test/integration/readme-contract.test.ts resolves the name against the registry',
  },
  {
    command: 'deflow run "add rate limiting to the public API"',
    reason: 'runs-a-whole-run',
    why: 'starts a real run against a real repository and does not return until it ends',
    covered: 'e2e/mock-only-run.test.ts runs a whole plan on the bundled agent',
  },
  {
    command: 'deflow run --provider gemini "add rate limiting to the public API"',
    reason: 'runs-a-whole-run',
    why: 'the same run, pinned to a vendor CLI that is not installed in a clean room',
    covered: 'e2e/provider-selection.test.ts drives --provider end to end',
  },
  {
    command: 'deflow run "refactor the auth module" --permission read',
    reason: 'runs-a-whole-run',
    why: 'the same run again, at the bottom of the permission ladder',
    covered: 'e2e/gate-ladder.test.ts drives the ladder end to end',
  },
  {
    command: 'deflow ledger snapshot <runId> --out bug.db',
    reason: 'runs-a-whole-run',
    why: 'needs a run that already exists, and a clean room has none',
    covered: 'packages/cli/src/ledger-snapshot.test.ts',
  },
  {
    command: 'pnpm install',
    reason: 'needs-the-network-or-a-vendor-login',
    why: 'the contributor path operates on a clone of this repository, not on an install',
    covered: "CI's own build job runs it on every push",
  },
  {
    command: 'pnpm build',
    reason: 'needs-the-network-or-a-vendor-login',
    why: 'the same clone, and the same build CI already runs',
    covered: "CI's own build job runs it on every push",
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
