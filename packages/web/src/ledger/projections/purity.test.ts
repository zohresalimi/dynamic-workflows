/**
 * KAR-16.3 AC1 / EPIC-16-S15 — the projections are pure, and this is the half
 * of that claim a behaviour test cannot make.
 *
 * Verifies: EPIC-16-S15 · AC1
 *
 * The lint rule is the primary enforcement — `.oxlintrc.json` has an override
 * for `packages/web/src/ledger/projections/**` restricting `vue`, `pinia`,
 * `@vue*`, `node:*` and the DOM globals, and `pnpm lint` fails on a violation.
 * This spec exists beside it for two reasons that are not redundancy:
 *
 * 1. **It checks that the rule is still pointed at these files.** `packages/web`
 *    is in oxlint's `ignorePatterns` wholesale, and this directory is exempted
 *    from that exemption by one negation. Delete the negation and the lint rule
 *    silently stops running — passing, loudly, forever. So the config itself is
 *    asserted here.
 * 2. **It has a planted positive.** A scan whose patterns have never matched
 *    anything is indistinguishable from a scan whose patterns are wrong, so the
 *    same matcher is run against a source that *should* trip it.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';

const HERE = new URL('.', import.meta.url).pathname;
const OXLINTRC = new URL('../../../../../.oxlintrc.json', import.meta.url).pathname;

interface Source {
  readonly name: string;
  readonly text: string;
}

/** The shipped modules — specs are not the published surface. */
function projectionSources(): Source[] {
  return readdirSync(HERE)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .toSorted()
    .map((name) => ({ name, text: readFileSync(join(HERE, name), 'utf8') }));
}

/** Every `from '<module>'` in a source, import or re-export. */
const importsOf = (text: string): string[] =>
  [...text.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s+'([^']+)'/g)].map(
    (match) => match[1] ?? '',
  );

const FRAMEWORK = /^(?:vue|vue-router|pinia|@vue\/|@vue-flow\/|@vueuse\/|node:)/;

/** DOM and environment reads a projection must not perform. */
const AMBIENT = /\b(?:document|window|localStorage|sessionStorage|navigator|fetch)\s*\./g;

suite('EPIC-16-S15 — the purity rule is enforced, not documented (AC1)', () => {
  it('finds the modules at all, so a passing scan is not an empty one', () => {
    expect(projectionSources().map((source) => source.name)).toEqual([
      'blackboard.ts',
      'context.ts',
      'cost.ts',
      'exhaustive.type-test.ts',
      'gates.ts',
      'index.ts',
      'kinds.ts',
      // KAR-27.3's tenth: which pre-execution turn is in flight. It folds
      // `@DeFlow/core`'s own vocabulary rather than a browser copy of it, and
      // the purity rule is what stops it reaching for the turn's *output* —
      // which is `io_chunk`, the data plane, and belongs to the component that
      // polls it.
      'liveTurn.ts',
      // KAR-17.9's aggregation. A pure *selector* over a folded blackboard
      // rather than an eighth projection — it folds no events — but it lives
      // here for the same reason the seven do, and the same rule applies to it.
      'memory-graph.ts',
      'plan.ts',
      'planHistory.ts',
      // KAR-19.10's eighth: which agent a run was admitted onto, and by which
      // route — one event kind, one object, the same purity rule.
      'provider.ts',
      // KAR-22.2's ninth: what the run was asked to do, off its own
      // `task.submitted`. The purity rule is what stops it fetching the blob a
      // source too large to inline was spilled into.
      'submission.ts',
      'timeline.ts',
    ]);
  });

  it.each(projectionSources())('$name imports nothing from Vue, Pinia or node:', (source) => {
    const offending = importsOf(source.text).filter((specifier) => FRAMEWORK.test(specifier));

    expect(offending, `${source.name} imports ${offending.join(', ')}`).toEqual([]);
  });

  it.each(projectionSources())('$name touches no DOM global', (source) => {
    // Comments are stripped first: this file's own rule text names `document`
    // and `window`, and so do the modules' docblocks explaining why they do not
    // use them.
    const code = source.text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/[^\n]*/g, '');

    expect([...code.matchAll(AMBIENT)].map((match) => match[0])).toEqual([]);
  });

  it('has teeth: the same matchers flag a source that violates the rule', () => {
    const planted = [
      "import { ref } from 'vue';",
      "import { defineStore } from 'pinia';",
      "import { readFileSync } from 'node:fs';",
      'export const bad = () => document.querySelector("#app");',
    ].join('\n');

    expect(importsOf(planted).filter((one) => FRAMEWORK.test(one))).toEqual([
      'vue',
      'pinia',
      'node:fs',
    ]);
    expect([...planted.matchAll(AMBIENT)]).toHaveLength(1);
  });
});

suite('EPIC-16-S15 — the lint rule is still pointed at this directory', () => {
  const config = readFileSync(OXLINTRC, 'utf8');

  it('exempts this directory from the blanket packages/web exclusion', () => {
    expect(config).toContain('"!packages/web/src/ledger/projections/**"');
  });

  it('restricts the framework imports for it by name', () => {
    expect(config).toContain('"packages/web/src/ledger/projections/**/*.ts"');
    expect(config).toContain('"vue-router"');
    expect(config).toContain('"pinia"');
  });
});
