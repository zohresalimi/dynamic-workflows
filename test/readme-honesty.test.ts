/**
 * KAR-20.4 — the README, checked against what exists.
 *
 * KAR-20.3 made the README an artefact with a build: every fenced command is
 * extracted, classified and executed. It went green over a README whose **first
 * command has never worked**, and the reason is worth keeping in front of
 * whoever edits this file next. The clean-room spec ran `setup` against a
 * tarball **it packed itself**, and recorded the outcome under the README's
 * text. So the document and the thing being executed were joined by a string
 * literal and nothing else, and the literal could say anything at all.
 *
 * It said `npx deflowai setup`. On 2026-08-15 that 404d, because nothing had
 * been published. On 2026-08-16, with `deflowai@0.1.0` on the registry, it
 * still fails — twice over, and the two failures are why this file exists:
 *
 *   * `npx <name>` resolves a package and then has to choose a **bin**, which
 *     it can only do for a package declaring one bin or a bin named after the
 *     package. This one declares four and matches none, on purpose (KAR-20.1
 *     moved the package name off the command name). npm answers `could not
 *     determine executable to run`, and always would have.
 *   * The published 0.1.0 carries `"better-sqlite3": "catalog:"` — pnpm's
 *     workspace-catalog protocol, which `pnpm pack` resolves and `npm publish`
 *     does not — so npm refuses the package with EUNSUPPORTEDPROTOCOL.
 *
 * Being *published*, then, is not the property the README depends on; being
 * *installable* is, and 0.1.0 is the counterexample proving they differ. Hence
 * `REGISTRY_INSTALL_WORKS` rather than a `published` flag, and hence every
 * check below is against a command that was run rather than a name that was
 * read.
 *
 * The slow half — the section's own build, pack and install lines, executed in
 * that order — is `e2e/readme-first-run.test.ts`.
 *
 * Verifies: EPIC-20-S35 · EPIC-20-S36 · EPIC-20-S37 · EPIC-20-S39 · EPIC-20-S40 ·
 * AC1, AC2, AC3, AC4, AC5 · test plan #1, #2, #3, #5, #6
 */
import { expect, it, describe as suite } from 'vitest';
import {
  PACKAGE_NAME,
  REGISTRY_INSTALL_COMMAND,
  REGISTRY_INSTALL_WORKS,
} from '../packages/cli/src/command-name.ts';
import {
  bareNpxForms,
  EXECUTED_COMMANDS,
  flagsMissingFromHelp,
  hostReferences,
  installSectionProblems,
  parseCommands,
  parseFlags,
  readmeText,
  registryFetches,
  type ScannedFile,
  SKIPPED_COMMANDS,
  UNAVAILABLE_TARGETS,
  WHERE,
} from './support/readme.ts';
import { docFiles, exists, readText } from './support/workspace.ts';

const README = readmeText();
const COMMANDS = parseCommands(README);
const INSTALL = 'Install it';
const INSTALL_COMMANDS = COMMANDS.filter((entry) => entry.section === INSTALL);

const INSTALL_SCRIPT = 'scripts/install.sh';
const SCRIPT = readText(INSTALL_SCRIPT);

/** The one host and the one package, pulled out by kind so a typo is red. */
function target(kind: 'host' | 'package'): string {
  const found = UNAVAILABLE_TARGETS.find((entry) => entry.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} in UNAVAILABLE_TARGETS`);
  return found.name;
}

const HOST = target('host');

/**
 * The files a reader is expected to read: the README, the install script and
 * everything under `docs/`.
 *
 * The two EPIC-20 delivery files are exempt **by name**, not by pattern. They
 * are the record of why the reference was deleted, and a record that cannot
 * quote the thing it is about is not a record. Exempting the directory would
 * have exempted every other epic's prose with it.
 */
const RECORD_OF_THE_DECISION = new Set([
  'docs/delivery/epics/EPIC-20-install-and-naming.md',
  'docs/delivery/flows/EPIC-20-install-and-naming-flows.md',
]);

function userFacingFiles(): readonly ScannedFile[] {
  const paths = ['README.md', INSTALL_SCRIPT, ...docFiles()].filter(
    (path) => !RECORD_OF_THE_DECISION.has(path),
  );
  return paths.map((path) => ({ path, text: readText(path) }));
}

suite('EPIC-20-S36 — nothing the README shows is unserved or un-installable (AC2, AC4)', () => {
  it('carries evidence rather than an opinion, for each name', () => {
    // The failure this story is fixing is a claim nobody re-ran. An entry whose
    // "checked" is a sentence rather than a command is that claim again.
    expect(UNAVAILABLE_TARGETS.length).toBeGreaterThan(0);
    for (const entry of UNAVAILABLE_TARGETS) {
      expect([entry.name, /`.+`/.test(entry.checked)]).toEqual([entry.name, true]);
      expect([entry.name, /20\d\d-\d\d-\d\d/.test(entry.checked)]).toEqual([entry.name, true]);
      expect([entry.name, entry.what.length > 40]).toEqual([entry.name, true]);
    }
  });

  it('is about this repository’s own package, not a name somebody typed', () => {
    expect(target('package')).toBe(PACKAGE_NAME);
  });

  it('shows no fenced command that fetches the package from a registry', () => {
    expect(registryFetches(COMMANDS, PACKAGE_NAME)).toEqual([]);
  });

  it('shows no bare "npx <package>" form, which npm cannot resolve a bin for', () => {
    expect(bareNpxForms(COMMANDS, PACKAGE_NAME)).toEqual([]);
  });

  it('names the host in no file a reader is sent to', () => {
    expect(hostReferences(userFacingFiles(), HOST)).toEqual([]);
  });

  it('would catch a restoration of either', () => {
    // Sabotage, against the same functions the assertions above use — a private
    // copy would prove nothing about the checks that ship.
    const restored = parseCommands(['```bash', `npx ${PACKAGE_NAME} setup`, '```'].join('\n'));
    expect(registryFetches(restored, PACKAGE_NAME).length).toBe(1);
    expect(bareNpxForms(restored, PACKAGE_NAME).length).toBe(1);
    expect(
      hostReferences([{ path: 'x', text: `curl -fsSL https://${HOST}/install.sh` }], HOST).length,
    ).toBe(1);
  });

  it('is about registry lookups and not about characters', () => {
    // The whole design of the guard. Banning the string could only have been
    // paid for by deleting the publish path — the tarball's filename, the
    // workspace filter and the script's DEFLOW_PACKAGE default all contain it
    // legitimately, and none of them asks a registry for anything.
    const legal = parseCommands(
      [
        '```bash',
        `pnpm --filter ${PACKAGE_NAME} pack --out /tmp/deflow.tgz`,
        'npx --yes --package=/tmp/deflow.tgz -- deflow setup --from /tmp/deflow.tgz',
        `PACKAGE="\${DEFLOW_PACKAGE:-${PACKAGE_NAME}}"`,
        '```',
      ].join('\n'),
    );
    expect(registryFetches(legal, PACKAGE_NAME)).toEqual([]);
    expect(bareNpxForms(legal, PACKAGE_NAME)).toEqual([]);

    const illegal = parseCommands(
      ['```bash', `npx --yes --package=${PACKAGE_NAME} -- deflow setup`, '```'].join('\n'),
    );
    expect(registryFetches(illegal, PACKAGE_NAME).length).toBe(1);
    // ...and that one is *not* a bare form, so the two checks are independent.
    expect(bareNpxForms(illegal, PACKAGE_NAME)).toEqual([]);
  });
});

suite('EPIC-20-S35 — the install section is a route a reader can walk today (AC1)', () => {
  it('found an install section with commands in it', () => {
    expect(INSTALL_COMMANDS.length).toBeGreaterThan(2);
  });

  it('is a route this repository can answer, end to end', () => {
    expect(
      installSectionProblems(INSTALL_COMMANDS, REGISTRY_INSTALL_WORKS, {
        package: PACKAGE_NAME,
        oneCommand: REGISTRY_INSTALL_COMMAND,
      }),
    ).toEqual([]);
  });

  it('says a shell opened afterwards finds the command', () => {
    // The claim `setup` actually makes, and the one that was false in the
    // README this epic started from.
    expect(README).toMatch(/new terminal|new shell|next terminal|shell you open/i);
  });

  it('runs or delegates every install-section command, and never silently drops one', () => {
    const executed = new Set(EXECUTED_COMMANDS.map((entry) => entry.command));
    const delegated = new Set(SKIPPED_COMMANDS.map((entry) => entry.command));
    const orphans = INSTALL_COMMANDS.filter(
      (entry) => !executed.has(entry.command) && !delegated.has(entry.command),
    );
    expect(orphans.map((entry) => entry.command)).toEqual([]);
  });

  it('gives every executed command a place to run', () => {
    for (const entry of EXECUTED_COMMANDS) {
      expect([entry.command, WHERE.includes(entry.where)]).toEqual([entry.command, true]);
    }
  });

  it('delegates only to spec files that exist on disk', () => {
    // KAR-20.3's rule was "the install section may skip nothing", which an
    // honest section with a build in it cannot satisfy. This replaces it and is
    // stronger: two entries used to read "CI's own build job runs it on every
    // push", which names nothing this repository can open — and no CI job ran
    // the README's build line, which is how the 404 survived a green suite.
    for (const entry of SKIPPED_COMMANDS) {
      expect([entry.command, entry.spec, exists(entry.spec)]).toEqual([
        entry.command,
        entry.spec,
        true,
      ]);
      expect([entry.command, /\.test\.ts$/.test(entry.spec)]).toEqual([entry.command, true]);
    }
  });
});

suite('EPIC-20-S37 — the promise expires by going red (AC5)', () => {
  it('is false today, because the published package cannot be installed', () => {
    expect(REGISTRY_INSTALL_WORKS).toBe(false);
  });

  it('is named for the property the README depends on, not for the event', () => {
    // 0.1.0 is published *and* uninstallable, so "published" would have been a
    // flag that flips on a day the README still could not be flipped with it.
    const source = readText('packages/cli/src/command-name.ts');
    expect(source).toContain('REGISTRY_INSTALL_WORKS');
    expect(source).toContain('EUNSUPPORTEDPROTOCOL');
    expect(source).toMatch(/could not determine executable/);
  });

  it('names a one-command install npx can actually run', () => {
    // Not `npx <package> setup`. That form has never worked and does not start
    // working on release day, so the flag governs *whether* a registry install
    // is shown and never *which shape* it takes.
    expect(REGISTRY_INSTALL_COMMAND).toContain(`--package=${PACKAGE_NAME}`);
    expect(REGISTRY_INSTALL_COMMAND).toMatch(/--\s+deflow setup/);
    expect(
      bareNpxForms(
        parseCommands(['```bash', REGISTRY_INSTALL_COMMAND, '```'].join('\n')),
        PACKAGE_NAME,
      ),
    ).toEqual([]);
  });

  it('goes red against the flag inverted, in whichever direction it is wrong', () => {
    // The mechanism AC5 asks for. Flipping the constant without editing the
    // README — or editing the README without flipping the constant — is a
    // failing build rather than something to remember.
    const problems = installSectionProblems(INSTALL_COMMANDS, !REGISTRY_INSTALL_WORKS, {
      package: PACKAGE_NAME,
      oneCommand: REGISTRY_INSTALL_COMMAND,
    });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toContain(REGISTRY_INSTALL_COMMAND);
  });
});

suite('EPIC-20-S40 — a flag belongs to the program whose command line it sits on', () => {
  // The one place the honest route collides with a guarantee KAR-20.3 already
  // shipped. That route has to name `pnpm` and `npx`, and their flags are not
  // `deflow`'s — so a check that scraped `--[a-z]+` out of the whole file
  // started reporting `--filter` as a flag the parser had dropped. The two
  // wrong ways out were an allow-list, which goes blind to a flag somebody
  // really does delete, and deleting the build line, which is this story's own
  // defect pointing the other way.
  const PACK = 'pnpm --filter deflowai pack --out /tmp/deflow.tgz';
  const INSTALL_LINE = 'npx --yes --package=/tmp/deflow.tgz -- deflow setup --from /tmp/deflow.tgz';

  it('does not read another program’s flags as deflow’s', () => {
    const flags = parseFlags(['```bash', PACK, '```'].join('\n'));
    expect(flags).toEqual([]);
  });

  it('tells the tool’s half of an npx line from the program’s half', () => {
    const flags = parseFlags(['```bash', INSTALL_LINE, '```'].join('\n'));
    expect(flags).toContain('--from');
    expect(flags).not.toContain('--package');
    expect(flags).not.toContain('--yes');
  });

  it('still collects a flag the README documents in prose rather than in a fence', () => {
    // The reason this cannot be "only parse fenced deflow lines": a flag in a
    // table is still one a reader will type.
    expect(parseFlags('Pass `--json` to get machine-readable output.')).toEqual(['--json']);
  });

  it('feeds a check that is still fully red against a help text listing nothing', () => {
    // What stops the fix from being a weakening.
    const flags = parseFlags(README);
    expect(flags.length).toBeGreaterThan(0);
    expect(flagsMissingFromHelp(flags, '')).toEqual(flags);
  });

  it('leaves the real README with no flag that belongs to pnpm or npx', () => {
    const flags = parseFlags(README);
    for (const foreign of ['--filter', '--package']) {
      expect([foreign, flags.includes(foreign)]).toEqual([foreign, false]);
    }
  });
});

suite('EPIC-20-S39 — the install script names the route it supports (AC3)', () => {
  it('names neither the host nor a registry fetch of the package', () => {
    expect(SCRIPT).not.toContain(HOST);
    expect(SCRIPT).not.toMatch(/curl[^\n]*install\.sh/);
  });

  it('documents the route that works today, in its header', () => {
    const header = SCRIPT.split('\nset -eu')[0] ?? '';
    expect(header).toContain('DEFLOW_PACKAGE');
    expect(header).toContain('.tgz');
    expect(header).toMatch(/not (yet )?(available|installable|published)|no release yet/i);
  });

  it('still hands over the way it always did, which is the form the README moves towards', () => {
    // The one line in this repository that was right all along: the package
    // goes to npx as `--package`, and the **bin** is named after `--`. No
    // behaviour change was needed here, and none was made.
    expect(SCRIPT).toContain('--package="${PACKAGE}"');
    expect(SCRIPT).toMatch(/--\s+deflow setup/);
    expect(SCRIPT).toContain('DEFLOW_PACKAGE:-');
  });
});
