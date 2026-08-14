/**
 * KAR-19.4 AC6 / EPIC-19-S28 — one derivation of a run's exit code, still.
 *
 * KAR-18.3 built `classifyRun` against a named red: *"exit code is derived at
 * three call sites and they disagree on `paused`."* It has held since because
 * nothing could reach a terminal state — no shipped code path executed a run at
 * all. KAR-19.4 removes that accident, and the temptation it introduces is
 * precisely the one the epic names: **the driver knows the outcome first**. A
 * run command that has just watched `run.completed` arrive with a failed gate
 * on it is one line away from answering `1` itself, and that line is the fourth
 * derivation.
 *
 * So the guard is mechanical, over sources:
 *
 *  1. **`classifyRun` has one definition**, and every module that needs a
 *     verdict imports it.
 *  2. **Nothing else in the CLI branches on `RunState.status` to pick a code.**
 *     The seven codes are a table; deciding *which* of them a run is worth is
 *     one function's job.
 *  3. **The `run` command reads the verdict rather than computing one.** Its
 *     returned code is `verdict.exitCode`, and the literals it may use are the
 *     ones that are facts about the *environment* rather than about a run — a
 *     daemon that refused to start, a machine that cannot host one, a Ctrl-C —
 *     which `./exit-codes.ts` documents as deliberately outside `classifyRun`.
 *
 * Every check is a pure function over sources handed to it, and every one has a
 * spec that feeds it a violating source and watches it catch it — the same
 * shape as `./one-live-chain-caller.test.ts` and for the same reason: a scan
 * that has never failed is indistinguishable from a scan that cannot.
 *
 * Verifies: EPIC-19-S28 · KAR-19.4 AC6 · test plan #5
 */
import { expect, it, describe as suite } from 'vitest';
import { packageProductionSources, readText } from './support/workspace.ts';

interface Source {
  readonly path: string;
  readonly text: string;
}

const CLASSIFIER = 'packages/cli/src/run/exit-codes.ts';
const COMMAND = 'packages/cli/src/run/run.ts';

/** The rule is about code, not about prose: every file that explains the
 * single derivation has to write the names down to explain it. */
function code(source: Source): Source {
  return {
    ...source,
    text: source.text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1'),
  };
}

/**
 * Every shipped CLI module that turns a run's **status** into an **exit code**.
 *
 * Both halves are required, and that is the whole of the rule. Reading
 * `state.status` is not the offence — `deflow status` reads it to list runs,
 * which is what a status command is — and neither is naming a code:
 * `RUN_EXIT_CODES.daemonRefused` is a fact about the machine. What AC6 forbids
 * is the *mapping*, the line that looks at how a run went and answers with a
 * number, anywhere but in `classifyRun`.
 *
 * Scoped to `packages/cli/src` because that is where an exit code can be
 * produced at all. The daemon reads `status` constantly and must: it is the
 * scheduler's own input.
 */
export function statusBranchers(sources: readonly Source[]): readonly string[] {
  const readsStatus = /\bstate\.status\b|\bcase '(?:completed|aborted|paused|needs-human)':/;
  // A code, either by its name in the table or as the bare number that is how
  // a fourth derivation actually gets written at 3am.
  const answersACode = /\bRUN_EXIT_CODES\b|\breturn\s+\d+\s*[;,)]/;
  return sources
    .map(code)
    .filter((source) => source.path.startsWith('packages/cli/src/'))
    .filter((source) => source.path !== CLASSIFIER)
    .filter((source) => readsStatus.test(source.text) && answersACode.test(source.text))
    .map((source) => source.path)
    .toSorted();
}

/** Every shipped module that declares a `classifyRun`. */
export function classifierDefinitions(sources: readonly Source[]): readonly string[] {
  return sources
    .map(code)
    .filter((source) => /\b(?:function|const)\s+classifyRun\b/.test(source.text))
    .map((source) => source.path)
    .toSorted();
}

const sources = packageProductionSources();

suite('AC6 — the scan covers the shipped tree, so an empty result means something', () => {
  it('reads the classifier and the command among the production sources', () => {
    const paths = sources.map((file) => file.path);
    expect(paths).toContain(CLASSIFIER);
    expect(paths).toContain(COMMAND);
  });
});

suite('AC6 — exactly one derivation', () => {
  it('declares classifyRun in exactly one shipped module', () => {
    expect(classifierDefinitions(sources)).toEqual([CLASSIFIER]);
  });

  it('leaves every other CLI module out of the business of reading a run status', () => {
    expect(statusBranchers(sources)).toEqual([]);
  });

  it('bites when the run command grows its own opinion', () => {
    const second: Source = {
      path: COMMAND,
      text: "if (state.status === 'paused') return 3;\n",
    };
    expect(statusBranchers([second])).toEqual([COMMAND]);
  });

  it('bites when a second classifier is declared', () => {
    const second: Source = {
      path: 'packages/cli/src/status.ts',
      text: 'function classifyRun(state: RunState) { return 0; }\n',
    };
    expect(classifierDefinitions([...sources, second])).toEqual([CLASSIFIER, second.path]);
  });

  it('ignores the prose that explains the rule', () => {
    const prose: Source = {
      path: COMMAND,
      text: "// The exit code is classifyRun over state.status — case 'paused': is its job.\n",
    };
    expect(statusBranchers([prose])).toEqual([]);
  });
});

suite('AC6 — the command reads the verdict rather than computing one', () => {
  const command = code({ path: COMMAND, text: readText(COMMAND) }).text;

  it('imports the classifier and returns what it answered', () => {
    expect(command).toContain('classifyRun');
    expect(command).toContain('verdict.exitCode');
  });

  it('spells no run-outcome code as a literal', () => {
    // The three the table documents as facts about the environment rather than
    // about a run are reached by name (`RUN_EXIT_CODES.interrupted`,
    // `.environmentUnusable`, `EX_ALREADY_RUNNING`), so there is no bare 0/1/3
    // to find. A `return 1` here would be the fourth derivation wearing a
    // number.
    expect(command).not.toMatch(/return\s+[013]\s*;/);
  });
});
