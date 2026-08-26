/**
 * KAR-28.7 AC2, AC3 — `packages/web` has **one** answer to *"what status is
 * this run in"*, and that answer is total over the kinds the reducer changes a
 * status on.
 *
 * Verifies: EPIC-28-S29 · AC2, AC3 · test plan #4, #8
 *
 * The defect this guards against has already happened once, which is the only
 * reason a scan of the tree is worth its weight. On 2026-08-26 the web kept a
 * sticky per-kind status table of its own covering **eight** of the ten kinds
 * `reduce()` moves a run's status on. The two it did not cover were
 * `run.spec.approved` and `human.responded` — precisely the two a run appends
 * between an operator approving a spec and the planner starting — so a pill
 * that had latched on `human.requested` read *needs a decision* for the rest of
 * the run, while every daemon endpoint answered `spec-approved` correctly.
 *
 * A convention did not prevent that and will not prevent the next one. Two
 * scans instead:
 *
 *  1. **Totality.** Every `case` arm in `packages/core/src/reduce.ts` that
 *     changes the *run's* status has an entry in the web's table, and the
 *     failure names the kinds that do not. A kind added to the reducer without
 *     an answer here is the same bug for a different gate a year from now.
 *  2. **Singleness.** Exactly one shipped module under `packages/web` maps a
 *     run state to a status word, and no view indexes `RUN_STATUS_LABELS`
 *     itself — which is how the pill came to be unable to print KAR-27.3's
 *     composed sentence at all.
 *
 * Reading the reducer as text rather than exercising it is deliberate: a
 * behavioural probe would have to invent a well-formed payload for every one of
 * the ~70 event kinds, and the sixty-odd that cannot touch a run's status are
 * exactly the ones whose payloads are most expensive to build. The rule below
 * is tied to two conventions the file actually keeps — `withStatus`/`endRun`
 * for run transitions, and a `(current) => …` callback for the node patches
 * `withNode` applies — so a new arm that changes a status by some third route
 * fails the *other* guard (the table would be missing it) rather than passing
 * both.
 */
import { expect, it, describe as suite } from 'vitest';
import { RUN_STATUSES } from '../packages/core/src/run-state.ts';
import { packageProductionSources, readText } from './support/workspace.ts';

/** The one module in `packages/web` allowed to answer "what status is this". */
const WEB_SEAM = 'packages/web/src/lib/run-status.ts';

const REDUCER = 'packages/core/src/reduce.ts';

interface Arm {
  readonly kinds: readonly string[];
  readonly body: readonly string[];
}

/** The `case` arms of `reduce.ts`'s `project()`, each with the lines under it. */
function projectArms(): readonly Arm[] {
  const text = readText(REDUCER);
  const start = text.indexOf('function project(');
  expect(start, `${REDUCER} no longer has a project() to read`).toBeGreaterThan(0);

  const arms: { kinds: string[]; body: string[] }[] = [];
  let open: { kinds: string[]; body: string[] } | null = null;
  for (const line of text.slice(start).split('\n')) {
    const matched = /^\s*case '([a-z0-9_.]+)':/.exec(line);
    if (matched?.[1] !== undefined) {
      // `case 'a': case 'b':` with no body between them is one arm.
      if (open !== null && open.body.length === 0) {
        open.kinds.push(matched[1]);
        continue;
      }
      open = { kinds: [matched[1]], body: [] };
      arms.push(open);
      continue;
    }
    // The switch's own `default:` ends the last arm; everything after it is
    // helper functions, not transitions.
    if (/^\s{4}default:/.test(line)) open = null;
    if (open !== null) open.body.push(line);
  }
  return arms;
}

/**
 * The arm's lines with `withNode`'s node patches taken out.
 *
 * A node's status and a run's share a vocabulary — `running` and `completed`
 * are both — so `status: 'running'` inside a `(current) => ({ … })` callback is
 * a *node* moving and must not be read as a run moving. `current` is the name
 * that callback's parameter has throughout the file.
 */
function runLevelLines(arm: Arm): readonly string[] {
  const kept: string[] = [];
  let inNodePatch = false;
  for (const line of arm.body) {
    if (/\(current\) => \(\{/.test(line)) {
      inNodePatch = true;
      continue;
    }
    if (inNodePatch) {
      if (/^\s*\}\)/.test(line)) inNodePatch = false;
      continue;
    }
    if (line.includes('...current')) continue;
    kept.push(line);
  }
  return kept;
}

/** Every event kind `reduce()` can change a run's status on. */
function statusChangingKinds(): readonly string[] {
  const found: string[] = [];
  for (const arm of projectArms()) {
    const body = runLevelLines(arm).join('\n');
    const changes =
      body.includes('withStatus(') ||
      body.includes('endRun(') ||
      RUN_STATUSES.some((status) => body.includes(`status: '${status}'`));
    if (changes) found.push(...arm.kinds);
  }
  return found;
}

/** The keys of the web seam's own kind table, read as text. */
function tableKeys(): readonly string[] {
  const text = readText(WEB_SEAM);
  const start = text.indexOf('RUN_STATUS_BY_KIND');
  expect(start, `${WEB_SEAM} no longer declares RUN_STATUS_BY_KIND`).toBeGreaterThan(-1);
  const body = text.slice(start, text.indexOf('};', start));
  return [...body.matchAll(/'([a-z0-9_.]+)':/g)].map((match) => match[1] ?? '');
}

const sources = packageProductionSources().filter((file) => !file.path.endsWith('.test.ts'));

suite('AC3 — the web’s status table is total over the reducer’s transitions', () => {
  it('finds transitions at all, so a passing totality check is not a check of nothing', () => {
    // Ten on the day this was written. A floor rather than an equality: adding
    // a transition is allowed, losing the ability to *see* them is not.
    expect(statusChangingKinds().length).toBeGreaterThanOrEqual(10);
    expect(statusChangingKinds()).toContain('run.spec.approved');
    expect(statusChangingKinds()).toContain('human.requested');
  });

  it('answers every kind the reducer moves a run’s status on', () => {
    const answered = new Set(tableKeys());
    const missing = statusChangingKinds().filter((kind) => !answered.has(kind));

    expect(
      missing,
      `${WEB_SEAM} has no status for: ${missing.join(', ')} — a run that appends one of these ` +
        'would keep whatever word the surface last latched onto',
    ).toEqual([]);
  });

  it('answers the gate response too, which changes no status and still ends a wait', () => {
    // `human.responded` is not a `RunStatus` — the reducer leaves the run
    // exactly where it was and resumes the node — so it is not in the table
    // above and is handled by name in the fold beside it. That is the kind
    // whose absence produced the report, so its handling is asserted rather
    // than assumed.
    expect(readText(WEB_SEAM)).toContain("'human.responded'");
  });
});

suite('AC2 — one mapping from a run to a status word in packages/web', () => {
  const web = sources.filter((file) => file.path.startsWith('packages/web/src/'));

  it('scans a web tree that actually has sources in it', () => {
    expect(web.length).toBeGreaterThan(50);
    expect(web.map((file) => file.path)).toContain(WEB_SEAM);
  });

  it('declares a run-status table in exactly one module', () => {
    const declaring = web
      .filter((file) => /Record<string, RunStatus>/.test(file.text))
      .map((file) => file.path);

    expect(declaring, 'a second status table is how the first one drifts').toEqual([WEB_SEAM]);
  });

  it('has no surface indexing RUN_STATUS_LABELS for itself', () => {
    // The pill did exactly this, and that is why KAR-27.3's composed
    // pre-execution sentence could never appear on the frame: a table lookup
    // has no way to express *"planner — running · attempt 1 of 3"*. The seam
    // reaches the vocabulary through `runStatusLabel`, which does.
    const indexing = web
      .filter((file) => /RUN_STATUS_LABELS\[/.test(file.text))
      .map((file) => file.path);

    expect(indexing, 'a view that indexes the table cannot render a composed label').toEqual([]);
  });
});
