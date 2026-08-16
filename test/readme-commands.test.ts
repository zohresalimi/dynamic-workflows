/**
 * KAR-20.3 — the README as an artefact with a build.
 *
 * The fast half of the story lives here: the shape of the install section, the
 * shape of the classification the clean room runs off, the contributor path's
 * label, and the wording guard over every command the file shows. The slow
 * half — actually running them — is `e2e/readme-first-run.test.ts`, and the two
 * share `test/support/readme.ts` so that a command the README gains is red in
 * this file within a second rather than red in a clean room in four minutes.
 *
 * Verifies: EPIC-20-S26 · EPIC-20-S27 (extraction) · EPIC-20-S28 ·
 * EPIC-20-S31 · AC1, AC2, AC3, AC4, AC8 · test plan #1, #5
 */
import { expect, it, describe as suite } from 'vitest';
import { COMMAND, PACKAGE_NAME, SHORT_ALIAS } from '../packages/cli/src/command-name.ts';
import {
  EXECUTED_COMMANDS,
  parseCommands,
  readmeText,
  SKIP_REASONS,
  SKIPPED_COMMANDS,
  staleClassifications,
  unclassifiedCommands,
} from './support/readme.ts';

const README = readmeText();
const COMMANDS = parseCommands(README);

/** The text of one `##` section, heading excluded. */
function section(heading: string): string {
  const lines = README.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) throw new Error(`README has no "## ${heading}" section`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/** Where a `##` heading starts, so two sections can be put in order. */
function headingLine(heading: string): number {
  const at = README.split('\n').findIndex((line) => line.trim() === `## ${heading}`);
  if (at < 0) throw new Error(`README has no "## ${heading}" section`);
  return at;
}

const INSTALL = 'Install it';
const FIRST_RUN = 'Your first run';
const CONTRIBUTOR = 'Building it from source — the contributor path';

suite('EPIC-20-S26 — the install section is a route that exists (AC1)', () => {
  const install = section(INSTALL);
  const installCommands = COMMANDS.filter((entry) => entry.section === INSTALL);

  /**
   * Amended by KAR-20.4. This suite used to assert that the section led with
   * `npx <package> setup`, and that assertion is what kept a command npm has
   * never been able to run pinned in place — first because nothing was
   * published, then because the published 0.1.0 cannot be installed and the
   * bare `npx` form cannot pick a bin among four. So the rule moves from *one
   * command* to *a route that ends in `setup`, run against something that
   * exists*, and `test/readme-honesty.test.ts` owns the harder half: the
   * tarball the last line installs has to be the one the pack line above it
   * writes. `pnpm build` is deliberately allowed here now — until there is a
   * release npm can install, the tarball a reader installs is one they build.
   */
  it('ends in the install KAR-20.2 ships, rather than in a build', () => {
    expect(installCommands.at(-1)?.command).toMatch(/deflow setup/);
  });

  it('starts in a clone of this repository, which is where the route can start today', () => {
    expect(installCommands[0]?.command).toBe('pnpm install');
  });

  it('names the script as the alternative for a machine with no Node', () => {
    expect(install).toContain('install.sh');
    expect(install.toLowerCase()).toContain('no node');
  });

  it('has none of the three things a reader followed to "command not found"', () => {
    // The link step, the direct call into dist, and the hand-written alias.
    // Each was true and none of them was an install. `pnpm build` was on this
    // list until KAR-20.4 — it was only ever wrong as a *substitute* for an
    // install, and it is the build of the thing being installed here.
    expect(install).not.toContain('npm link');
    expect(install).not.toContain('pnpm link');
    expect(install).not.toContain('dist/bin.mjs');
    expect(install).not.toMatch(/^\s*alias\s/m);
  });

  it('does not send a reader to the contributor path to install', () => {
    expect(install.toLowerCase()).not.toContain('from source');
  });
});

suite('EPIC-20-S28 — the contributor path survives, below and labelled (AC2)', () => {
  it('exists, and says who it is for in its first sentence', () => {
    const body = section(CONTRIBUTOR).trim();
    const first = body.split('\n\n')[0] ?? '';
    expect(first.toLowerCase()).toMatch(/contribut|work on|hack on/);
    expect(body).toContain('pnpm install');
    expect(body).toContain('pnpm build');
  });

  it('appears after the install section, not before it', () => {
    expect(headingLine(CONTRIBUTOR)).toBeGreaterThan(headingLine(INSTALL));
  });
});

suite('EPIC-20-S27 — every command is classified, and the skip list is named (AC4)', () => {
  it('found the commands at all', () => {
    // A parser that silently returned nothing would make every assertion below
    // vacuously true, which is this file's own version of the defect it exists
    // to catch.
    expect(COMMANDS.length).toBeGreaterThan(10);
  });

  it('classifies every command the README shows', () => {
    expect(unclassifiedCommands(COMMANDS)).toEqual([]);
  });

  it('carries no classification for a command the README no longer shows', () => {
    expect(staleClassifications(COMMANDS)).toEqual([]);
  });

  it('names each skipped command exactly, never as a pattern', () => {
    const patternish = SKIPPED_COMMANDS.filter((entry) => /[*?]|\.\*|\[\^?\w/.test(entry.command));
    expect(patternish.map((entry) => entry.command)).toEqual([]);
  });

  it('gives every skipped command a reason from the closed set, and a sentence', () => {
    for (const entry of SKIPPED_COMMANDS) {
      expect([entry.command, SKIP_REASONS.includes(entry.reason)]).toEqual([entry.command, true]);
      expect([entry.command, entry.why.length > 30]).toEqual([entry.command, true]);
      expect([entry.command, entry.how.length > 10]).toEqual([entry.command, true]);
    }
  });

  it('skips nothing in the first-run section, and nothing in the install route', () => {
    // KAR-20.3's rule was "the install and first-run sections may skip
    // nothing". KAR-20.4 keeps it for the first run and for everything in the
    // install section up to and including `setup` — the route itself — and
    // releases it for what comes *after*, which is where the no-Node
    // alternative now lives. That alternative reaches the same end state as the
    // route above it, so running it twice in one room would measure the first
    // run rather than the second; `e2e/setup-install.test.ts` runs it in a room
    // of its own. `test/readme-honesty.test.ts` is what makes that delegation
    // cost something: it has to name a spec file that exists.
    const skipped = new Set(SKIPPED_COMMANDS.map((entry) => entry.command));
    const installRoute = COMMANDS.filter((entry) => entry.section === INSTALL);
    const endOfRoute = installRoute.findIndex((entry) => /deflow setup/.test(entry.command));
    const unrun = [
      ...installRoute.slice(0, endOfRoute + 1),
      ...COMMANDS.filter((entry) => entry.section === FIRST_RUN),
    ].filter((entry) => skipped.has(entry.command));
    expect(unrun.map((entry) => `${entry.section}: ${entry.command}`)).toEqual([]);
  });

  it('keeps the skip list short', () => {
    expect(SKIPPED_COMMANDS.length).toBeLessThanOrEqual(12);
  });

  it('runs every command that installs or starts the tool', () => {
    const executed = new Set(EXECUTED_COMMANDS.map((entry) => entry.command));
    // The install line is matched on its shape rather than spelled out, because
    // its tarball path is the README's to choose and `installSectionProblems`
    // is what holds the path and the pack line together (KAR-20.4).
    expect(
      EXECUTED_COMMANDS.filter((entry) => /deflow setup/.test(entry.command)).map(
        (entry) => entry.where,
      ),
    ).toEqual(['clean-room']);
    for (const wanted of [
      `${COMMAND} --version`,
      `${COMMAND} doctor`,
      `${COMMAND} init`,
      `${COMMAND} up`,
      `${COMMAND} status`,
    ]) {
      expect([wanted, executed.has(wanted)]).toEqual([wanted, true]);
    }
  });
});

suite('EPIC-20-S31 — every command shown is the lowercase one (AC3)', () => {
  it('shows no capitalised command line anywhere in a fence', () => {
    const offences = COMMANDS.filter((entry) => /\bDeFlow\b/.test(entry.command));
    expect(offences.map((entry) => `${String(entry.line)}: ${entry.command}`)).toEqual([]);
  });

  it('shows no capitalised command line in an inline code span either', () => {
    const spans = [...README.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '');
    const offences = spans.filter((span) =>
      /^DeFlow(\s+(init|up|run|cancel|doctor|status|ledger|setup|answer|help)\b|\s+--)/.test(span),
    );
    expect(offences).toEqual([]);
  });

  it('shows only commands the program has', () => {
    // Not a spelling check: a fenced line naming a subcommand `deflow --help`
    // does not list is a line that exits 64 for a reader who types it.
    const known = new Set([
      'setup',
      'init',
      'up',
      'run',
      'answer',
      'cancel',
      'doctor',
      'status',
      'ledger',
      'help',
    ]);
    const wrong = COMMANDS.filter((entry) => {
      const words = entry.command.split(/\s+/);
      if (words[0] !== COMMAND && words[0] !== SHORT_ALIAS) return false;
      const subcommand = words[1];
      if (subcommand === undefined || subcommand.startsWith('-')) return false;
      return !known.has(subcommand);
    });
    expect(wrong.map((entry) => entry.command)).toEqual([]);
  });

  it('still calls the product by its own name in prose (AC9)', () => {
    expect(README).toContain('DeFlow');
  });
});

suite('AC8 — the zero-friction first run is stated, not parenthesised', () => {
  it('says a machine with no vendor CLI runs a whole plan, before the first run', () => {
    // Before, because it is the answer to "what do I need before I start" and
    // it was a parenthetical at the bottom of a list of five install lines.
    const above = README.split('\n').slice(0, headingLine(FIRST_RUN)).join('\n');
    expect(above).toContain('deflow-mock-agent');
    expect(above).toMatch(/no vendor CLI|no agent CLI/i);
    expect(above).toMatch(/whole plan/i);
  });
});
