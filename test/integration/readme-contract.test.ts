/**
 * KAR-20.3 — the three claims in the README that a program can answer.
 *
 * Every assertion here compares the document against something executable: the
 * flags against a real `deflow --help`, the agent packages against the provider
 * registry, the exit-code and permission tables against the two constants the
 * program derives them from. None of it is a spelling check — each one is a
 * claim a reader acts on, and each one was wrong in the file this story found:
 *
 *   * `--provider` existed and was documented in neither the usage block nor
 *     the README (KAR-19.10 added it because an operator tried it and got
 *     `unknown option`);
 *   * the agent-CLI block told a reader that `@agentclientprotocol/claude-agent-acp`
 *     installs `claude`, which is the ACP bridge and not the vendor CLI;
 *   * the permission table named `repo` and `system`, and the ladder has never
 *     had either — `--permission repo` exits 64.
 *
 * Integration rather than unit because it spawns the CLI. `packages/cli/src/bin.ts`
 * directly, not the built `dist/bin.mjs`: the usage text is the same string
 * either way and this spec then does not depend on a build having happened.
 *
 * Verifies: EPIC-20-S29 · EPIC-20-S30 · AC5, AC6, AC7 · test plan #3, #4
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import process from 'node:process';
import { expect, it, describe as suite } from 'vitest';
import { PROVIDER_SPECS } from '../../packages/adapters/src/provider-registry.ts';
import { RUN_EXIT_CODES } from '../../packages/cli/src/run/exit-codes.ts';
import { PERMISSION_LEVELS } from '../../packages/core/src/plan-graph.ts';
import {
  agentPackageMismatches,
  exitCodeMismatches,
  flagsMissingFromHelp,
  flagsMissingFromReadme,
  parseAgentPackages,
  parseExitCodes,
  parseFlags,
  parsePermissionLevels,
  type RegistryFacts,
  readmeText,
} from '../support/readme.ts';
import { readText, repoRoot } from '../support/workspace.ts';

const README = readmeText();

/** `deflow --help`, from a real process. */
const HELP = execFileSync(process.execPath, [join(repoRoot, 'packages/cli/src/bin.ts'), '--help'], {
  encoding: 'utf8',
  env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NO_COLOR: '1' },
});

/**
 * The registry, reduced to the four facts a README row can get wrong.
 *
 * `vendorBin` is `shim.bin`: the binary the *operator* installs and logs into,
 * which for a native provider is the same binary DeFlow spawns and for an
 * adapter is the one underneath the bridge. That equality is the whole
 * distinction KAR-18.8 draws in `doctor`, arriving in the document a reader
 * meets before `doctor` exists on their machine.
 */
function registryFacts(): ReadonlyMap<string, RegistryFacts> {
  const facts = new Map<string, RegistryFacts>();
  for (const [id, spec] of Object.entries(PROVIDER_SPECS)) {
    facts.set(id, {
      kind: spec.kind,
      bundled: spec.bundled === true,
      npmPackage: spec.package,
      bin: spec.bin,
      vendorBin: spec.shim.bin,
    });
  }
  return facts;
}

suite('EPIC-20-S29 — the flags in the docs and the flags in the program (AC5)', () => {
  it('spawned a real usage block', () => {
    expect(HELP).toContain('Usage: deflow <command> [options]');
  });

  it('shows no flag the program does not accept', () => {
    expect(flagsMissingFromHelp(parseFlags(README), HELP)).toEqual([]);
  });

  it('shows every flag a first run needs, --provider included', () => {
    // Named rather than derived: `--help` lists flags for eight commands and a
    // README that showed all of them would be a second usage block. These four
    // are the ones a first run reaches for, and `--provider` is the one that
    // was in neither document.
    expect(
      flagsMissingFromReadme(
        ['--provider', '--permission', '--json', '--no-wait'],
        parseFlags(README),
      ),
    ).toEqual([]);
  });

  it('documents --provider in the usage block too, with what it takes', () => {
    expect(HELP).toMatch(/--provider\s+<\w+>/);
    for (const id of Object.keys(PROVIDER_SPECS)) {
      expect([id, HELP.includes(id)]).toEqual([id, true]);
    }
  });

  it('would notice a flag that vanished from the parser', () => {
    // The sabotage EPIC-20-S32 names, run against the same function the
    // assertion above uses rather than against a private copy of it.
    const withoutProvider = HELP.replaceAll('--provider', '--gone');
    expect(flagsMissingFromHelp(['--provider'], withoutProvider)).toEqual(['--provider']);
  });
});

suite('EPIC-20-S30 — each package installs what the row says it installs (AC6)', () => {
  const rows = parseAgentPackages(README);

  it('found the table', () => {
    expect(rows.length).toBeGreaterThanOrEqual(Object.keys(PROVIDER_SPECS).length);
  });

  it('agrees with the registry, row by row', () => {
    expect(agentPackageMismatches(rows, registryFacts())).toEqual([]);
  });

  it('never presents an ACP adapter as the way to install the vendor CLI', () => {
    // The two lines that were wrong, asserted as a property rather than as two
    // strings: no row may name an adapter's package and claim it puts the
    // vendor's binary on PATH.
    const adapters = Object.values(PROVIDER_SPECS).filter((spec) => spec.kind === 'adapter');
    expect(adapters.length).toBeGreaterThan(0);
    for (const spec of adapters) {
      const claiming = rows.filter(
        (row) => row.npmPackage === spec.package && row.installs === spec.shim.bin,
      );
      expect([spec.package, claiming.length]).toEqual([spec.package, 0]);
    }
  });

  it('names a vendor CLI package this repository has actually measured', () => {
    // A row's vendor package is the one name in the table the registry cannot
    // confirm — it is a package DeFlow never installs. docs/02-tech-stack.md's
    // verified-versions table is where this repository writes down the ones it
    // has run, so a name invented here is red rather than plausible.
    const stack = readText('docs/02-tech-stack.md');
    const known = new Set(Object.values(PROVIDER_SPECS).map((spec) => spec.package));
    for (const row of rows) {
      if (known.has(row.npmPackage)) continue;
      expect([row.npmPackage, stack.includes(row.npmPackage)]).toEqual([row.npmPackage, true]);
    }
  });

  it('would notice a package name that changed in the registry', () => {
    const sabotaged = new Map(registryFacts());
    const claude = sabotaged.get('claude');
    if (claude === undefined) throw new Error('no claude in the registry');
    sabotaged.set('claude', { ...claude, npmPackage: '@agentclientprotocol/claude-agent-acp-2' });
    expect(agentPackageMismatches(rows, sabotaged).length).toBeGreaterThan(0);
  });
});

suite("AC7 — the first-run section's claims match the program", () => {
  it("documents run's exit codes, all of them and only them", () => {
    expect(exitCodeMismatches(parseExitCodes(README), Object.values(RUN_EXIT_CODES))).toEqual([]);
  });

  it('would notice an exit code that changed in the program', () => {
    const moved = Object.values(RUN_EXIT_CODES).map((code) => (code === 3 ? 6 : code));
    expect(exitCodeMismatches(parseExitCodes(README), moved).length).toBeGreaterThan(0);
  });

  it("names the ladder's four levels, in the ladder's order", () => {
    expect(parsePermissionLevels(README)).toEqual([...PERMISSION_LEVELS]);
  });

  it('offers no level the parser refuses, which is what "repo" and "system" were', () => {
    // The two names the README carried are not a wording slip: `deflow run
    // --permission repo` exits 64 with the parser's own list, so a reader who
    // copied the table got a usage error from the document that taught it.
    for (const level of ['repo', 'system']) {
      const refused = spawnSync(
        process.execPath,
        [join(repoRoot, 'packages/cli/src/bin.ts'), 'run', '--permission', level, 'a task'],
        {
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NO_COLOR: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      expect([level, refused.status]).toEqual([level, 64]);
      expect([level, parsePermissionLevels(README).includes(level)]).toEqual([level, false]);
    }
  });

  it('describes the URL and the token the daemon really prints', () => {
    // `packages/daemon/src/daemon-file.ts` builds
    // `http://127.0.0.1:<port>/#token=<token>`, and the README's claim about
    // the address bar is a claim about that fragment.
    expect(README).toContain('http://127.0.0.1:7777');
    expect(README).toContain('#token=');
  });
});
