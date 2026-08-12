/**
 * KAR-19.3 AC7 / EPIC-19-S23 — one implementation per step: no second planner,
 * no second interview.
 *
 * The pressure this file exists to resist is named in the epic and is entirely
 * reasonable in the moment: *"the temptation to write a small local planner
 * just to see a graph arrives at about hour three."* It is also exactly how a
 * codebase acquires two answers to the same question, one of which is tested
 * and one of which ships. So the guard is mechanical, because the judgement is
 * not reliable at hour three.
 *
 * Three claims, and each fails differently if it stops holding:
 *
 *  1. **Exactly one shipped module calls each step.** A second caller of
 *     `runFramingInterview` is a second scheduling policy; a second caller of
 *     `compilePlanV1` is a second answer to "when is a plan compiled".
 *  2. **Nothing outside the plan package produces a `PlanGraph`.** A function
 *     returning one from anywhere else is a planner whatever it is called, and
 *     it is the one that ships without EPIC-11's validation in front of it.
 *  3. **The caller imports rather than re-declares.** A module that reached for
 *     the names and got them from a local copy would satisfy (1) and (2) and
 *     still be the rewrite this criterion forbids.
 *
 * Every check is a pure function over sources handed to it, and every one has a
 * spec that feeds it a violating source and watches it catch it — the same
 * shape as `test/no-gap-detection.test.ts` and for the same reason: a scan that
 * has never failed is indistinguishable from a scan that cannot.
 *
 * Verifies: EPIC-19-S23 · KAR-19.3 AC7 · test plan #7
 */
import { expect, it, describe as suite } from 'vitest';
import { packageProductionSources, readText } from './support/workspace.ts';

interface Source {
  readonly path: string;
  readonly text: string;
}

/** The one shipped module this epic added, and the only one allowed to call
 * any of the three steps. */
const CALLER = 'packages/daemon/src/pipeline/run-chain.ts';

/**
 * Each step, with the file that defines it — which is allowed to contain its
 * own name followed by a paren and is not a "caller".
 */
const STEPS: readonly (readonly [name: string, definedIn: string, caller: string])[] = [
  ['runFramingInterview', 'packages/daemon/src/framing/interview.ts', CALLER],
  ['compilePlanV1', 'packages/daemon/src/plan/compile.ts', CALLER],
  ['runReconNode', 'packages/daemon/src/recon/recon.ts', CALLER],
  // The validator's one caller is the compiler, not the chain, and that is the
  // stronger arrangement: `compilePlanV1` cannot persist a version without
  // running it (`test/one-plan-write-site.test.ts` asserts the other half), so
  // a chain that "forgot" to validate is not a state that can be expressed.
  [
    'validatePlanVersion',
    'packages/daemon/src/plan/validate.ts',
    'packages/daemon/src/plan/compile.ts',
  ],
];

/**
 * The rule is about call sites, not about prose.
 *
 * Every file that explains the wiring has to write the names down to explain it
 * — this one included — and a comment naming `compilePlanV1` compiles nothing.
 */
function code(source: Source): Source {
  return {
    ...source,
    text: source.text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1'),
  };
}

/** Every shipped call site of `name`, outside the file that defines it. */
export function callersOf(
  sources: readonly Source[],
  name: string,
  definedIn: string,
): readonly string[] {
  return sources
    .map(code)
    .filter(
      (source) => source.path !== definedIn && new RegExp(`\\b${name}\\s*\\(`).test(source.text),
    )
    .map((source) => source.path)
    .toSorted();
}

/**
 * Every shipped module outside `@DeFlow/daemon`'s plan package that declares a
 * function whose **return type** is a `PlanGraph`.
 *
 * The annotation is what is scanned, and that is the point: a second planner is
 * recognisable by what it promises to produce, whatever it is named and however
 * it produces it. Parameters and fields are deliberately not matched — half the
 * daemon takes a `PlanGraph` and that is what a compiled plan being useful
 * looks like.
 *
 * `PlanGraph | null` is excluded, and the exclusion is the honest one rather
 * than a loophole: a function that can answer *"there is no plan"* is reading a
 * stored document (`ledger-view.planVersion`, `restore.planDocOf`), and a
 * planner that could return `null` for the plan it was asked to produce is not
 * a planner. The one-caller suites above are what stop a producer that hid
 * behind the union.
 */
export function planGraphProducers(sources: readonly Source[]): readonly string[] {
  const returnsPlanGraph = /\)\s*:\s*(?:Promise<\s*)?PlanGraph\b(?!\s*\|)/;
  return sources
    .map(code)
    .filter((source) => !source.path.startsWith('packages/daemon/src/plan/'))
    .filter((source) => !source.path.startsWith('packages/core/src/'))
    .filter((source) => returnsPlanGraph.test(source.text))
    .map((source) => source.path)
    .toSorted();
}

const sources = packageProductionSources();

suite('AC7 — the scan covers the shipped tree, so an empty result means something', () => {
  it('reads every production source and finds the caller among them', () => {
    expect(sources.length).toBeGreaterThan(80);
    expect(sources.map((file) => file.path)).toContain(CALLER);
    for (const [, definedIn] of STEPS) {
      expect(sources.map((file) => file.path)).toContain(definedIn);
    }
  });
});

suite('AC7 — exactly one shipped module calls each step', () => {
  for (const [name, definedIn, caller] of STEPS) {
    it(`names ${caller} and nothing else for ${name}`, () => {
      expect(callersOf(sources, name, definedIn)).toEqual([caller]);
    });
  }

  it('bites when a second module reaches for one of them', () => {
    const second: Source = {
      path: 'packages/daemon/src/services/supervisor.ts',
      text: 'const plan = await compilePlanV1(options);\n',
    };
    expect(callersOf([...sources, second], 'compilePlanV1', STEPS[1]?.[1] ?? '')).toEqual([
      CALLER,
      second.path,
    ]);
  });

  it('ignores the definition itself and the prose that explains it', () => {
    const definition: Source = {
      path: 'packages/daemon/src/plan/compile.ts',
      text: 'export async function compilePlanV1(options: CompilePlanOptions) {}',
    };
    const prose: Source = {
      path: 'packages/daemon/src/boot.ts',
      text: '// Nothing here calls compilePlanV1(...) — the chain does.\n',
    };
    expect(callersOf([definition, prose], 'compilePlanV1', definition.path)).toEqual([]);
  });
});

suite('AC7 — nothing outside the plan package produces a PlanGraph', () => {
  it('finds no second producer anywhere in the shipped tree', () => {
    expect(planGraphProducers(sources)).toEqual([]);
  });

  it('bites when a module quietly grows one', () => {
    const inline: Source = {
      path: 'packages/daemon/src/pipeline/quick-planner.ts',
      text: 'function simplePlan(spec: TaskSpec): PlanGraph {\n  return { nodes: [] };\n}\n',
    };
    expect(planGraphProducers([inline])).toEqual([inline.path]);
  });

  it('catches the asynchronous form too, which is the one that gets written', () => {
    const inline: Source = {
      path: 'packages/daemon/src/pipeline/quick-planner.ts',
      text: 'async function plan(spec: TaskSpec): Promise<PlanGraph> {\n  return graph;\n}\n',
    };
    expect(planGraphProducers([inline])).toEqual([inline.path]);
  });
});

suite('AC7 — the caller imports the steps rather than re-declaring them', () => {
  const caller = readText(CALLER);

  it('imports each step from the module that owns it', () => {
    expect(caller).toContain("from '../framing/interview.ts'");
    expect(caller).toContain("from '../plan/compile.ts'");
    expect(caller).toContain("from '../recon/recon.ts'");
  });

  it('declares none of them itself', () => {
    for (const [name] of STEPS) {
      expect(caller).not.toContain(`function ${name}`);
      expect(caller).not.toContain(`const ${name} =`);
    }
  });
});
