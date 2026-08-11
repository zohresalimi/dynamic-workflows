/**
 * EPIC-17-S35 — the scripted six-checkpoint diagnosis walk, and the timing of
 * it. `pnpm measure:diagnosis`.
 *
 * > _"Median time-to-diagnose a failed run under five minutes"_ — PRD §12, and
 * > PRD §13's mitigation for *"the visualisation is pretty but not
 * > diagnostic"*: **measure it. If it doesn't drop, the views are wrong.**
 *
 * The scenario is the epic's Definition of Done rather than an illustration, so
 * this file is written to be the thing that decides it. It drives a **real
 * headless Chromium** against a **real `DeFlow replay` daemon** — the same
 * `startReplay` every other spec in this directory uses, serving the shipped
 * source through Vite exactly as `pnpm dev:replay` does — through the seven
 * navigations the scenario names, in the order it names them:
 *
 * | # | Stop           | The question it answers                    |
 * | - | -------------- | ------------------------------------------ |
 * | 1 | plan graph     | which node failed                          |
 * | 2 | criteria board | what it failed, and against which gate     |
 * | 3 | diff line      | where, exactly                             |
 * | 4 | node inspector | what the agent was given, and by whom      |
 * | 5 | context budget | what was deleted from it, and was it pinned|
 * | 6 | plan scrubber  | why the node exists, and why this provider |
 * | 7 | timeline       | what it cost, and where the time went      |
 *
 * ## What is timed, and what that does and does not prove
 *
 * **Timed:** wall-clock from the moment the run is opened to the moment the
 * last checkpoint has the evidence on screen — the daemon's response time, the
 * projection fold, the render, and the navigation between views. This is the
 * part of an operator's five minutes that *this codebase controls*.
 *
 * **Not timed, and not proven:** the human half. A person reading a stack chart
 * and forming a hypothesis is not in this number, and no amount of scripting
 * makes it so. The scenario is explicit that it is automated *"at e2e + timed
 * manual"*; this is the e2e half, and the measurement document says so in as
 * many words rather than letting a very small number imply a claim it cannot
 * support. What the walk **does** prove is the property PRD §13 actually
 * doubts: that the evidence is *reachable* — that six views in sequence, with
 * no other tool and no log grepping, carry an operator from "the run is red" to
 * the sentence that names the defect, and that each stop hands the next one the
 * thing it needs.
 *
 * ## The control
 *
 * A timing budget with no control is a statement about the laptop. The control
 * here is the **same seven navigations over `happy-path-12`** — a run with
 * nothing wrong with it — taken on the same machine, in the same browser,
 * seconds later. A regression in a view moves the diagnosis walk and not the
 * control; a loaded box moves both. This is the shape EPIC-05 used for its two
 * timing budgets and `measure-graph.ts` uses for its frame budgets.
 *
 * ## The fixtures
 *
 * Three, with genuinely different root causes, because *"the measurement is
 * repeated, not anecdotal"* is its own scenario. They are **not** picked to
 * flatter the number: `five-minute-diagnosis` is the scenario's own 22-node
 * run, and the other two are the only remaining fixtures in the corpus that can
 * be diagnosed at all — `compaction` is three events with no `run.created`, so
 * it has no plan, no criteria and nothing to orient on, and
 * `crash-resume-seq-gap` is a seq-hole fixture with no failure in it.
 * `./diagnosis-walk`'s own e2e asserts both of those exclusions rather than
 * asserting them in prose.
 *
 * Every `page.evaluate` body is passed as **source text** rather than as a
 * closure, the convention this whole directory uses: the slice compiles with
 * Node's libs and no DOM, so a closure mentioning `document` would not
 * type-check.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { type Browser, chromium, type Page } from 'playwright';
import { type ReplayHarness, startReplay } from '../../packages/daemon/src/replay/harness.ts';
import { parseSpeed } from '../../packages/daemon/src/replay/speed.ts';
import {
  materialiseMigrationRepo,
  materialiseReviewRepo,
} from '../../packages/web/scripts/build-diff-fixture.ts';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

export const MEASUREMENT_MD = 'docs/measurements/five-minute-diagnosis.md';
export const MEASUREMENT_JSON = 'docs/measurements/five-minute-diagnosis.json';

/** The command this file's own output tells a reader to run. */
export const REPRODUCE = 'pnpm measure:diagnosis';

/**
 * PRD §12's target, in milliseconds. **Not a number this file chose** — it is
 * the published M1 metric, and it is stated here once so that no assertion
 * anywhere can quietly move it after seeing a result.
 */
export const TARGET_MS = 5 * 60_000;

/** The seven stops, in the order the scenario walks them. */
export const CHECKPOINTS = [
  'plan-graph',
  'criteria-board',
  'diff-line',
  'node-inspector',
  'context-budget',
  'plan-scrubber',
  'timeline',
] as const;

export type CheckpointName = (typeof CHECKPOINTS)[number];

/** What one fixture's diagnosis is, and where each stop's evidence lives. */
export interface DiagnosisCase {
  readonly fixture: string;
  /** One line, for the measurement document. */
  readonly rootCause: string;
  /** The repository the recording is rehomed onto, so the diff is a real one. */
  readonly repo: 'migration' | 'review';
  /** How many nodes the plan graph must have drawn before stop 1 is answered. */
  readonly planNodes: number;
  /** The node the run failed on — stop 1's answer. */
  readonly failedNode: string;
  /** The criterion the gate spoke to, or `null` when no gate ever spoke. */
  readonly criterion: string | null;
  readonly gate: string | null;
  /** The finding stop 3 lands on, or `null` when the run produced none. */
  readonly finding: string | null;
  readonly file: string | null;
  readonly line: number | null;
  /**
   * Which link the operator follows to reach the line.
   *
   * Both are links the application mints and both are one click from a view
   * already open, so the two are comparable — but they are not the same link,
   * and which one a fixture offers is a property of the recording. A finding
   * the gate never tagged with a criterion (`gate-failure-repair`'s
   * `65207341fbd9` carries no `criterion` field) does not appear under any row
   * of the criteria board, so the operator follows the failing verdict chip on
   * the plan graph instead — which is EPIC-17-S24's own journey.
   */
  readonly diffFrom: 'board' | 'verdict-chip' | null;
  /** The node with a context packet, or `null` when none was ever built. */
  readonly packetNode: string | null;
  /** How many attempts that node made. */
  readonly attempts: number;
  /** Whether a `context.compacted` sits between two of them. */
  readonly compaction: boolean;
  /** The plan version that introduced the failed node, or `null`. */
  readonly splitVersion: number | null;
}

export interface CheckpointResult {
  readonly name: CheckpointName;
  readonly route: string;
  readonly ms: number;
  /**
   * Whether the stop produced the evidence the diagnosis needs.
   *
   * `false` is a legitimate outcome and is **not** a failure: a fixture whose
   * run never built a context packet has an honest nothing to show at stop 4,
   * and the view saying so is the correct behaviour. What matters is that it
   * is recorded per fixture, so the measurement document can state which stops
   * each walk actually answered instead of implying all of them did.
   */
  readonly answered: boolean;
  readonly readout: Readonly<Record<string, unknown>>;
}

export interface Walk {
  readonly fixture: string;
  readonly rootCause: string;
  readonly runId: string;
  /** Open the run → the last checkpoint's evidence on screen. */
  readonly totalMs: number;
  readonly answered: number;
  readonly checkpoints: readonly CheckpointResult[];
}

export interface DiagnosisMeasurement {
  readonly takenAt: string;
  readonly machine: {
    readonly platform: string;
    readonly arch: string;
    readonly release: string;
    readonly cpu: string;
    readonly cores: number;
    readonly memoryGiB: number;
    readonly node: string;
  };
  readonly chromium: string;
  /** The three diagnosis walks, in the order they were taken. */
  readonly walks: readonly Walk[];
  /** The same seven navigations over a run with nothing wrong with it. */
  readonly control: Walk;
  readonly medianMs: number;
  readonly targetMs: number;
}

/** The committed budget, and the tolerance a re-run is allowed. */
export interface DiagnosisBudget {
  /** The median the recorded run measured. */
  readonly medianMs: number;
  /** Multiple of it a re-run may reach before it is a regression. */
  readonly tolerance: number;
  /** Never assert tighter than this, however fast the recording machine was. */
  readonly floorMs: number;
  /** Multiple of the same run's own control walk. */
  readonly controlRatio: number;
  /** PRD §12, carried into the file so the gate is legible without the code. */
  readonly targetMs: number;
}

/**
 * The three fixtures the median is taken over.
 *
 * `five-minute-diagnosis` is the scenario's own run. The other two are the
 * corpus's remaining diagnosable failures, and their root causes are genuinely
 * different: one is a deterministic gate catching a type error and a repair
 * loop fixing it, the other is a retry ladder ending on a schema contract
 * violation with no gate involved at all.
 */
export const CASES: readonly DiagnosisCase[] = [
  {
    fixture: 'five-minute-diagnosis',
    rootCause:
      'the import-policy fact the node needed was compacted out of its packet — the fact was ' +
      'never pinned, which is a plan defect in the node’s reads declaration',
    repo: 'migration',
    planNodes: 22,
    failedNode: 'n-impl-3',
    criterion: 'ac-3',
    gate: 'import-boundary',
    finding: 'f-import-boundary-1',
    file: 'packages/ui/src/Button.vue',
    line: 42,
    diffFrom: 'board',
    packetNode: 'n-impl-3',
    attempts: 3,
    compaction: true,
    splitVersion: 2,
  },
  {
    fixture: 'gate-failure-repair',
    rootCause:
      'the implementation returned a Date where a number was declared; the deterministic ' +
      'typecheck gate caught it and the repair loop fixed it',
    repo: 'review',
    planNodes: 4,
    failedNode: 'impl-1',
    criterion: 'ac-1',
    gate: 'typecheck',
    finding: '65207341fbd9',
    file: 'src/date-picker.ts',
    line: 2,
    diffFrom: 'verdict-chip',
    packetNode: null,
    attempts: 0,
    compaction: false,
    splitVersion: null,
  },
  {
    fixture: 'repair-attempts',
    rootCause:
      'three attempts ending on contract.schema-invalid, the last two built from an identical ' +
      'packet — a repair that changed nothing',
    repo: 'review',
    planNodes: 3,
    failedNode: 'impl-oauth',
    criterion: null,
    gate: null,
    finding: null,
    file: null,
    line: null,
    diffFrom: null,
    packetNode: 'impl-oauth',
    attempts: 3,
    compaction: false,
    splitVersion: null,
  },
];

/**
 * The control: the identical walk over a run that succeeded.
 *
 * Twelve nodes, a gate that passed, a gate that asked for a human, a context
 * packet and a plan with one version — so every stop has something on it and
 * the walk is the same shape. Its cost is what the seven views cost when there
 * is nothing to diagnose.
 */
export const CONTROL_CASE: DiagnosisCase = {
  fixture: 'happy-path-12',
  rootCause: 'nothing — the control: a run that reached every display state and completed',
  repo: 'review',
  planNodes: 12,
  failedNode: 'impl-login',
  criterion: 'no-v-model-regression',
  gate: 'contract',
  finding: 'f-contract-1',
  file: 'src/api/contract.ts',
  line: 31,
  diffFrom: 'board',
  packetNode: 'impl-signup',
  attempts: 1,
  compaction: false,
  splitVersion: null,
};

// ── the browser side ─────────────────────────────────────────────────────────

async function waitFor(
  page: Page,
  expression: string,
  what: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await page.evaluate<boolean>(expression)) return;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Every plan node the graph drew, with the state it drew it in. */
const PLAN_STATES = `Array.from(document.querySelectorAll('[data-plan-node]')).map((body) => ({
  id: body.getAttribute('data-plan-node'),
  state: body.getAttribute('data-state'),
}))`;

const CRITERIA_READ = (criterion: string) => `(() => {
  const row = document.querySelector('[data-criterion-row="${criterion}"]');
  const detail = document.querySelector('[data-criterion-detail="${criterion}"]');
  const evidence = Array.from(detail?.querySelectorAll('[data-criterion-evidence]') ?? []).map(
    (article) => ({
      gate: article.getAttribute('data-gate'),
      outcome: article.getAttribute('data-outcome'),
      summary: article.querySelector('[data-evidence-summary]')?.textContent?.trim() ?? '',
      findings: Array.from(article.querySelectorAll('[data-evidence-finding]')).map((item) => ({
        id: item.getAttribute('data-finding-id'),
        message: item.querySelector('[data-finding-message]')?.textContent?.trim() ?? '',
        diffHref: item.querySelector('[data-diff-link]')?.getAttribute('href') ?? '',
      })),
    }),
  );
  return {
    status: row?.querySelector('[data-status]')?.getAttribute('data-status') ?? 'absent',
    statement: row?.children[1]?.textContent?.trim() ?? '',
    evidence,
    noEvidence: detail?.querySelector('[data-no-evidence]') !== null &&
      detail?.querySelector('[data-no-evidence]') !== undefined,
  };
})()`;

/*
 * `extendsTheLine` is asked in **document order** rather than by walking to a
 * `<tr>` and reading its previous sibling, which is what
 * `../diff-review.test.ts` does. Not a weaker assertion — a stricter-scoped
 * one: it says the widget sits after the gutter cell for the line it names and
 * before the next line's, which is precisely what *"renders inline at that
 * line"* means, and it says it without asserting which element
 * `@git-diff-view` chose to wrap the extend slot in. That choice varies with
 * the render mode, and a spec that pinned it would fail on a wider window for
 * a reason that has nothing to do with the finding being in the right place.
 */
const DIFF_READ = (finding: string, file: string, line: number) => `(() => {
  // Scoped to the diff panel. The same finding is *also* rendered in the
  // repair-move aside above the patch, and an unscoped selector matches that
  // one first — which would assert that a widget exists somewhere on the page
  // rather than that the verdict is attached to the line.
  const widget = document.querySelector('[data-diff-file] [data-review-finding="${finding}"]');
  const panel = document.querySelector('[data-diff-file="${file}"]');
  if (widget === null) {
    return { present: false, file: panel === null ? 'absent' : '${file}' };
  }
  const at = document.querySelector('[data-line-new-num="${String(line)}"]');
  const next = document.querySelector('[data-line-new-num="${String(line + 1)}"]');
  const after = (anchor) =>
    anchor !== null &&
    (anchor.compareDocumentPosition(widget) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  const box = widget.getBoundingClientRect();
  return {
    present: true,
    file: '${file}',
    severity: widget.getAttribute('data-severity') ?? '',
    message: widget.querySelector('[data-finding-message]')?.textContent?.trim() ?? '',
    extendsTheLine: after(at) && !after(next),
    onScreen: box.top >= 0 && box.bottom <= window.innerHeight,
  };
})()`;

const INSPECTOR_READ = `(() => {
  const packet = document.querySelector('[data-packet]');
  return {
    open: document.querySelector('[data-overlay="inspector"]') !== null,
    status: packet?.getAttribute('data-status') ?? 'absent',
    total: Number(document.querySelector('[data-packet-total]')?.getAttribute('data-packet-total') ?? -1),
    segmentTokens: Array.from(document.querySelectorAll('[data-segment-tokens]')).map((cell) =>
      Number(cell.getAttribute('data-segment-tokens')),
    ),
    attempts: Array.from(document.querySelectorAll('[data-attempt-tab]')).map((tab) =>
      tab.getAttribute('data-attempt-tab'),
    ),
    provenance: Array.from(document.querySelectorAll('[data-provenance-row]')).map((row) => ({
      key: row.querySelector('[data-fact-key]')?.textContent?.trim() ?? '',
      writer: row.querySelector('[data-fact-writer]')?.textContent?.trim() ?? '',
      confidence: row.querySelector('[data-fact-confidence]')?.textContent?.trim() ?? '',
    })),
    failureReason:
      document.querySelector('[data-failure-reason]')?.textContent?.trim() ?? '',
  };
})()`;

const BUDGET_READ = `(() => {
  const bars = Array.from(document.querySelectorAll('[data-budget-bar]')).map((bar) =>
    bar.getAttribute('data-budget-bar'),
  );
  const marks = Array.from(document.querySelectorAll('[data-compaction]')).map((section) => ({
    seq: section.getAttribute('data-compaction'),
    scope: section.getAttribute('data-scope'),
    fidelity: section.getAttribute('data-fidelity'),
    dropped: Array.from(section.querySelectorAll('[data-dropped]')).map(
      (item) => item.getAttribute('data-segment') ?? item.textContent?.trim() ?? '',
    ),
    pinnedKept: section.querySelectorAll('[data-pinned-kept] [data-digest]').length,
  }));
  return { bars, marks };
})()`;

const SCRUBBER_READ = `(() => ({
  version: document.querySelector('[data-scrub-version]')?.getAttribute('data-scrub-version') ?? '',
  rail: Array.from(document.querySelectorAll('[data-rail-version]')).map((mark) =>
    mark.getAttribute('data-rail-version'),
  ),
  reason: (document.querySelector('[data-reason-panel]')?.textContent ?? '')
    .replace(/\\s+/g, ' ')
    .trim(),
}))()`;

const PATCH_READ = `(() => {
  const panel = document.querySelector('[data-patch-panel]');
  return {
    node: panel?.getAttribute('data-patch-node') ?? '',
    ops: Array.from(panel?.querySelectorAll('[data-patch-op]') ?? [], (op) => op.textContent ?? '')
      .join(' ')
      .replace(/\\s+/g, ' '),
  };
})()`;

const TIMELINE_READ = (node: string) => `(() => {
  const bars = Array.from(document.querySelectorAll('[data-bar]')).map((bar) => ({
    key: bar.getAttribute('data-bar'),
    attempt: bar.getAttribute('data-attempt'),
    state: bar.getAttribute('data-state'),
  }));
  return {
    lanes: document.querySelectorAll('[data-lane]').length,
    bars: bars.length,
    nodeBars: bars.filter((bar) => (bar.key ?? '').startsWith('${node}')).length,
    costLines: document.querySelectorAll('[data-cost-line]').length,
  };
})()`;

// ── one walk ─────────────────────────────────────────────────────────────────

/**
 * The recording, pointed at a repository that exists on this machine.
 *
 * One field, in one event — `run.created.cwd`, which is what `RunState.repoRoot`
 * is folded from. Without it stop 3 ends at an honest refusal from the daemon
 * rather than at a line of code, and what would be measured is a fixture's
 * portability rather than a diff surface. Identical in kind to the rehoming
 * `../diff-review.test.ts` does, and for the same reason.
 */
async function rehome(fixture: string, repo: string, into: string): Promise<string> {
  const source = await readFile(fixture, 'utf8');
  const rehomed = source
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const event = JSON.parse(line) as { kind: string; payload: Record<string, unknown> };
      if (event.kind !== 'run.created') return line;
      return JSON.stringify({ ...event, payload: { ...event.payload, cwd: repo } });
    });
  const path = join(into, 'events.jsonl');
  await writeFile(path, `${rehomed.join('\n')}\n`, 'utf8');
  return path;
}

interface Stopwatch {
  readonly split: () => number;
}

function stopwatch(): Stopwatch {
  let last = Date.now();
  return {
    split: () => {
      const now = Date.now();
      const elapsed = now - last;
      last = now;
      return elapsed;
    },
  };
}

/**
 * One fixture, walked end to end.
 *
 * The browser and the daemon are handed in already warm — Vite has transformed
 * every route once against a throwaway page before the stopwatch starts, so
 * what is timed is the application and not the bundler's first compile. That
 * exclusion is stated in the measurement document; it is the difference between
 * measuring the views and measuring `esbuild`.
 */
async function walkOnce(
  page: Page,
  origin: string,
  token: string,
  runId: string,
  one: DiagnosisCase,
): Promise<Walk> {
  const checkpoints: CheckpointResult[] = [];
  const clock = stopwatch();
  const started = Date.now();
  const open = (path: string) => page.goto(`${origin}${path}#token=${token}`);

  const record = (
    name: CheckpointName,
    route: string,
    answered: boolean,
    readout: Record<string, unknown>,
  ): void => {
    checkpoints.push({ name, route, ms: clock.split(), answered, readout });
  };

  // ── 1 · orientation ────────────────────────────────────────────────────────
  const planRoute = `/runs/${runId}`;
  await open(planRoute);
  await waitFor(
    page,
    `document.querySelectorAll('[data-plan-node]').length >= ${String(one.planNodes)}`,
    `${one.fixture}: the plan graph drew its ${String(one.planNodes)} nodes`,
  );
  const drawn = await page.evaluate<{ id: string; state: string }[]>(PLAN_STATES);
  const states: Record<string, number> = {};
  for (const node of drawn) states[node.state] = (states[node.state] ?? 0) + 1;
  const failedState = drawn.find((node) => node.id === one.failedNode)?.state ?? 'absent';
  record('plan-graph', planRoute, failedState !== 'absent', {
    nodes: drawn.length,
    states,
    failedNode: one.failedNode,
    failedState,
  });

  // ── 2 · what failed, and against what ──────────────────────────────────────
  const criteriaRoute = `/runs/${runId}/criteria`;
  await open(criteriaRoute);
  await waitFor(page, `document.querySelector('[data-criteria-table]') !== null`, 'the board drew');
  let board: Record<string, unknown> = { criterion: null };
  if (one.criterion !== null) {
    await page.click(`[data-criterion-toggle="${one.criterion}"]`);
    await waitFor(
      page,
      `document.querySelector('[data-criterion-detail="${one.criterion}"]') !== null`,
      'the criterion expanded',
    );
    board = {
      criterion: one.criterion,
      ...(await page.evaluate<Record<string, unknown>>(CRITERIA_READ(one.criterion))),
    };
  }
  // Answered only when the gate the case names is the one on the row: a board
  // that expanded and showed nothing is a stop the operator left empty-handed.
  const spoke =
    one.gate !== null &&
    (board.evidence as { gate: string }[] | undefined)?.some((entry) => entry.gate === one.gate) ===
      true;
  record('criteria-board', criteriaRoute, spoke, board);

  // ── 3 · where, exactly ─────────────────────────────────────────────────────
  //
  // Reached by **clicking the finding**, which is the scenario's own wording
  // and the only stop the application itself links: the board mints the deep
  // link that carries the file *and* the line, and a walk that typed the URL
  // would not be testing the thing the diff surface exists for.
  const diffRoute = `/runs/${runId}/diff`;
  let diff: Record<string, unknown> = { present: false };
  if (one.finding !== null && one.file !== null && one.line !== null) {
    if (one.diffFrom === 'board') {
      await page.click(`[data-finding-id="${one.finding}"] [data-diff-link]`);
    } else {
      // Back to the graph, and out along the failing verdict chip — the other
      // link the application mints, and the one EPIC-17-S24 follows.
      await open(`${planRoute}?node=${one.failedNode}`);
      await waitFor(
        page,
        `document.querySelector('[data-plan-node="${one.failedNode}"] [data-slot="verdict"]') !== null`,
        `${one.fixture}: the failing verdict chip drew`,
      );
      await page.click(`[data-plan-node="${one.failedNode}"] [data-slot="verdict"]`);
    }
    await waitFor(
      page,
      `location.pathname === ${JSON.stringify(diffRoute)}`,
      'the diff route opened',
    );
    await waitFor(
      page,
      `document.querySelector('[data-diff-file] [data-review-finding="${one.finding}"]') !== null`,
      `${one.fixture}: the finding rendered on the diff`,
    );
    // The scroll happens after the renderer has drawn the hunk, so the readout
    // is re-taken until it settles rather than sampled once and asserted.
    let report = await page.evaluate<Record<string, unknown>>(
      DIFF_READ(one.finding, one.file, one.line),
    );
    for (let attempt = 0; attempt < 40 && report.onScreen !== true; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      report = await page.evaluate<Record<string, unknown>>(
        DIFF_READ(one.finding, one.file, one.line),
      );
    }
    diff = report;
  } else {
    // A run with no finding still costs the operator this stop: they open the
    // per-node diff and read that there is nothing attached to it. Navigated
    // rather than skipped, so all four walks are the same seven navigations
    // and the median is over comparable journeys.
    await open(`${diffRoute}?scope=node&node=${one.failedNode}`);
    await waitFor(
      page,
      `document.querySelector('[data-review-scope]') !== null || ` +
        `document.querySelector('[data-diff-error]') !== null`,
      `${one.fixture}: the diff surface answered`,
    );
    diff = {
      present: false,
      files: await page.evaluate<number>(`document.querySelectorAll('[data-diff-file]').length`),
      findings: await page.evaluate<number>(
        `document.querySelectorAll('[data-review-finding]').length`,
      ),
    };
  }
  record('diff-line', diffRoute, diff.present === true, diff);

  // ── 4 · what the agent was given, and by whom ──────────────────────────────
  //
  // Selected through `?node=` and opened with `Enter`, rather than by clicking
  // the body on the canvas. Not a shortcut: at twenty-two nodes in a
  // laptop-sized window the neighbouring node's subtree intercepts the pointer,
  // and a spec that fought the layout would be measuring Vue Flow's hit
  // testing. `?node=` is the graph's own selection contract — it is what
  // `../diff-review.test.ts`'s round trip asserts, and what makes a position
  // shareable, which is half of what a five-minute diagnosis is for.
  const inspected = one.packetNode ?? one.failedNode;
  await open(`${planRoute}?node=${inspected}`);
  await waitFor(
    page,
    `document.querySelector('[data-plan-node="${inspected}"]')` +
      `?.getAttribute('data-selected') === 'true'`,
    `${one.fixture}: the graph selected ${inspected}`,
  );
  await page.keyboard.press('Enter');
  await waitFor(
    page,
    `document.querySelector('[data-overlay="inspector"]') !== null`,
    'the inspector opened',
  );
  // The packet section is mounted before the packet has arrived, so `status`
  // passes through `absent` on its way to `built` or `none`. Waiting for it to
  // settle is the difference between timing the inspector and timing the
  // overlay's fade-in — bounded, so a node that genuinely never had one still
  // records its honest `none` instead of a timeout.
  await waitFor(
    page,
    `['built', 'none'].includes(` +
      `document.querySelector('[data-packet]')?.getAttribute('data-status') ?? 'absent')`,
    `${one.fixture}: the inspector said what packet it has`,
    20_000,
  ).catch(() => undefined);
  const inspector = await page.evaluate<Record<string, unknown>>(INSPECTOR_READ);
  record('node-inspector', planRoute, inspector.status === 'built', inspector);

  // ── 5 · what compaction did to it ──────────────────────────────────────────
  const contextRoute = `/runs/${runId}/context`;
  await open(contextRoute);
  const budget = one.packetNode === null ? { bars: [], marks: [] } : await readBudget(page);
  const bars = Array.isArray(budget.bars) ? (budget.bars as unknown[]).length : 0;
  const marks = Array.isArray(budget.marks) ? (budget.marks as unknown[]).length : 0;
  // A fixture that recorded a compaction has to *show* it here; one that did
  // not is answered by the bars alone.
  record('context-budget', contextRoute, bars > 0 && (!one.compaction || marks > 0), budget);

  // ── 6 · why the node is here at all ────────────────────────────────────────
  const scrubRoute = `/runs/${runId}/evolution`;
  await open(scrubRoute);
  await waitFor(
    page,
    `document.querySelectorAll('[data-rail-version]').length > 0`,
    'the version rail drew',
  );
  let scrub: Record<string, unknown> = {};
  if (one.splitVersion !== null) {
    await page.click(`[data-rail-version="${String(one.splitVersion)}"]`);
    await waitFor(
      page,
      `document.querySelector('[data-scrub-version]')?.getAttribute('data-scrub-version') === ` +
        `${JSON.stringify(String(one.splitVersion))}`,
      'the scrubber settled on the version that introduced the node',
    );
    scrub = await page.evaluate<Record<string, unknown>>(SCRUBBER_READ);
    // The next version's patch: the provider re-route, as RFC 6902.
    await page.keyboard.press('ArrowRight');
    await waitFor(
      page,
      `document.querySelector('[data-scrub-version]')?.getAttribute('data-scrub-version') === ` +
        `${JSON.stringify(String(one.splitVersion + 1))}`,
      'the scrubber stepped to the re-route',
    );
    await page.click(`[data-diff-node="${one.failedNode}"] button[data-diff-open]`);
    await waitFor(
      page,
      `document.querySelector('[data-patch-panel]') !== null`,
      'the patch opened',
    );
    scrub = { ...scrub, patch: await page.evaluate<Record<string, unknown>>(PATCH_READ) };
  } else {
    scrub = await page.evaluate<Record<string, unknown>>(SCRUBBER_READ);
  }
  record('plan-scrubber', scrubRoute, one.splitVersion !== null, scrub);

  // ── 7 · what it cost, and where the time went ──────────────────────────────
  const timelineRoute = `/runs/${runId}/timeline`;
  await open(timelineRoute);
  // Waited on the *bars* rather than on the `<figure>`: the chart element is in
  // the DOM before the projection has anything to draw in it, and a walk that
  // stopped at the container would record a stop that had not happened yet.
  // Bounded, so a run with no bars at all reports an honest empty rather than
  // burning the timeout into the number.
  await waitFor(
    page,
    `document.querySelectorAll('[data-bar]').length > 0 || ` +
      `document.querySelector('[data-timeline-empty]') !== null`,
    `${one.fixture}: the timeline drew its bars`,
    20_000,
  ).catch(() => undefined);
  const timeline = await page.evaluate<Record<string, unknown>>(
    TIMELINE_READ(one.packetNode ?? one.failedNode),
  );
  // Every attempt the case declares has to be a bar of its own: *"the failed
  // node's three attempts are visible as three bars"* is the clause, and a
  // timeline that drew one bar for a node that ran three times has lost the
  // thing the operator came here for.
  record(
    'timeline',
    timelineRoute,
    (timeline.nodeBars as number) >= Math.max(1, one.attempts),
    timeline,
  );

  return {
    fixture: one.fixture,
    rootCause: one.rootCause,
    runId,
    totalMs: Date.now() - started,
    answered: checkpoints.filter((point) => point.answered).length,
    checkpoints,
  };
}

async function readBudget(page: Page): Promise<Record<string, unknown>> {
  try {
    await waitFor(
      page,
      `document.querySelectorAll('[data-budget-bar]').length > 0`,
      'the budget chart drew a bar',
      20_000,
    );
  } catch {
    // A run that never built a packet has an honest nothing here.
    return { bars: [], marks: [] };
  }
  return page.evaluate<Record<string, unknown>>(BUDGET_READ);
}

/**
 * Warms Vite's module graph for every route this walk touches.
 *
 * On a throwaway page, before any stopwatch runs. Without it the first walk
 * pays for transforming the whole application on demand and the last walk does
 * not, and the median would be a statement about which fixture happened to go
 * first.
 */
async function warm(page: Page, origin: string, token: string, runId: string): Promise<void> {
  for (const path of ['', '/criteria', '/diff', '/context', '/evolution', '/timeline']) {
    await page.goto(`${origin}/runs/${runId}${path}#token=${token}`);
    // `domcontentloaded` and a fixed settle, **never** `networkidle`: every
    // route holds an SSE stream open for the life of the page, so the network
    // is idle exactly never and `waitForLoadState('networkidle')` spends its
    // whole timeout on every navigation. A warm-up that takes twelve minutes
    // is a warm-up nobody runs.
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Boots a daemon over `one`'s recording, walks it, and tears everything down. */
export async function walkFixture(browser: Browser, one: DiagnosisCase): Promise<Walk> {
  const workDir = await mkdtemp(join(tmpdir(), `DeFlow-diagnosis-${one.fixture}-`));
  const repo = join(workDir, 'repo');
  if (one.repo === 'migration') await materialiseMigrationRepo(repo);
  else await materialiseReviewRepo(repo);

  let harness: ReplayHarness | undefined;
  let warmPage: Page | undefined;
  let page: Page | undefined;
  try {
    harness = await startReplay({
      fixture: await rehome(
        join(repoRoot, 'test/fixtures/runs', one.fixture, 'events.jsonl'),
        repo,
        workDir,
      ),
      // The whole recording before the browser opens: a diagnosis starts from a
      // run that has already gone red.
      speed: parseSpeed('max'),
      port: 0,
      dev: true,
    });
    await harness.played();
    const runId = harness.runIds[0] as string;

    warmPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await warm(warmPage, harness.origin, harness.token, runId);
    await warmPage.close();
    warmPage = undefined;

    // Deliberately short of a laptop's window, for the reason
    // `../diff-review.test.ts` gives: the scroll clause at stop 3 only claims
    // anything if the line is below the fold before the view acts on it.
    page = await browser.newPage({ viewport: { width: 1000, height: 620 } });
    return await walkOnce(page, harness.origin, harness.token, runId, one);
  } finally {
    await warmPage?.close();
    await page?.close();
    await harness?.close();
    await rm(workDir, { recursive: true, force: true });
  }
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : Math.round(((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
};

/** Runs the whole measurement and returns it. Nothing is written to the repo. */
export async function measureDiagnosis(): Promise<DiagnosisMeasurement> {
  const browser = await chromium.launch();
  try {
    const walks: Walk[] = [];
    for (const one of CASES) walks.push(await walkFixture(browser, one));
    // The control last, so a machine that started thrashing halfway through
    // shows up in the control rather than hiding under it.
    const control = await walkFixture(browser, CONTROL_CASE);

    return {
      takenAt: new Date().toISOString().slice(0, 10),
      machine: {
        platform: platform(),
        arch: arch(),
        release: release(),
        cpu: cpus()[0]?.model ?? 'unknown',
        cores: cpus().length,
        memoryGiB: Math.round(totalmem() / 1024 ** 3),
        node: process.version,
      },
      chromium: browser.version(),
      walks,
      control,
      medianMs: median(walks.map((walk) => walk.totalMs)),
      targetMs: TARGET_MS,
    };
  } finally {
    await browser.close();
  }
}

/**
 * The budget a fresh measurement writes.
 *
 * Every constant here is declared **before** any number is taken, and is a
 * shape rather than a value: `e2e/five-minute-diagnosis.test.ts` recomputes it
 * from the committed measurement and fails if the committed budget is not
 * exactly what this function would have produced — so a hand-edited ceiling,
 * the tempting fix for a red build, does not survive.
 */
export function budgetOf(measurement: DiagnosisMeasurement): DiagnosisBudget {
  return {
    medianMs: measurement.medianMs,
    // A doubling of the walk is not jitter.
    tolerance: 2,
    // Sixty seconds. Below this the assertion would be about how fast the
    // recording machine was rather than about whether the views are diagnostic,
    // and PRD §12's target is five minutes — a regression gate an order of
    // magnitude tighter than the metric it protects is a flake generator.
    floorMs: 60_000,
    // Diagnosing a failure may cost three times what walking the same seven
    // views over a run with nothing wrong with it costs. Same shape as
    // `measure-graph.ts`'s idle-frame control, and the same multiple.
    controlRatio: 3,
    targetMs: TARGET_MS,
  };
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/** The committed markdown, generated so it cannot drift from the numbers. */
export function renderMeasurement(
  measurement: DiagnosisMeasurement,
  budget: DiagnosisBudget,
): string {
  const row = (walk: Walk): string =>
    `| \`${walk.fixture}\` | ${seconds(walk.totalMs)} | ${String(walk.answered)} / 7 | ` +
    `${walk.rootCause} |`;

  const perCheckpoint = (walk: Walk): string =>
    `| \`${walk.fixture}\` | ` +
    CHECKPOINTS.map((name) => {
      const point = walk.checkpoints.find((one) => one.name === name);
      if (point === undefined) return '—';
      return `${seconds(point.ms)}${point.answered ? '' : ' ·∅'}`;
    }).join(' | ') +
    ' |';

  const passes = measurement.medianMs < measurement.targetMs;
  const verdict = passes
    ? `**The median is ${seconds(measurement.medianMs)}, against PRD §12's five-minute target.** ` +
      'The evidence a diagnosis needs is reachable in seven navigations, and every stop hands the ' +
      'next one the fact it needs. See “What this number is not” before quoting it.'
    : `**The median is ${seconds(measurement.medianMs)}, which exceeds PRD §12's five-minute ` +
      'target.** PRD §13 is explicit about what that means: the conclusion is that THE VIEWS ARE ' +
      'WRONG, not that the operator was slow, and **EPIC-17 is not Done**. The per-checkpoint ' +
      'table below names the stop that consumed the time, and that stop is the view to fix.';

  const slowest = measurement.walks
    .flatMap((walk) => walk.checkpoints.map((point) => ({ walk: walk.fixture, point })))
    .toSorted((left, right) => right.point.ms - left.point.ms)[0];

  return `<!--
  GENERATED by \`${REPRODUCE}\` (e2e/support/diagnosis-walk.ts).
  Edit the script or re-run the command; hand edits are lost on the next run.
-->

# The five-minute diagnosis — the measurement

> EPIC-17's Definition of Done, and PRD §12's *median time-to-diagnose a failed run < 5 min*.
> Scenario: [EPIC-17-S35](../delivery/flows/EPIC-17-p0-views-flows.md#epic-17-s35--the-five-minute-diagnosis-end-to-end).

**Reproduce:** \`${REPRODUCE}\`
**Enforced by:** \`e2e/five-minute-diagnosis.test.ts\`, against \`${MEASUREMENT_JSON}\`

**Date:** ${measurement.takenAt}. **Machine:** ${measurement.machine.platform}/${measurement.machine.arch} ${measurement.machine.release}, ${measurement.machine.cpu} × ${String(measurement.machine.cores)}, ${String(measurement.machine.memoryGiB)} GiB, Node ${measurement.machine.node}. **Browser:** Chromium ${measurement.chromium} (headless, 1000×620, via playwright).

## The verdict

${verdict}

## What was timed

A scripted walk through the seven views EPIC-17-S35 names, in the order it names them — plan graph,
acceptance-criteria board, diff line, node inspector, context budget, plan scrubber, timeline —
driven by a real headless Chromium against a real \`DeFlow replay\` daemon serving the shipped
source through Vite, exactly as \`pnpm dev:replay\` does. Nothing is stubbed: the plan comes from
\`GET /api/runs/:id/plans\`, the verdict from \`gate.evaluated\` over SSE, and the patch at stop 3
from the daemon shelling out to a real \`git diff\` in a repository this measurement builds and
leaves dirty.

The clock starts when the run is opened and stops when the last checkpoint has its evidence on
screen. Each stop asserts the specific fact the *next* stop needs, so a walk that completes is a
walk in which the evidence chain held.

## What this number is **not**

Stated plainly, because the number is small and it would be easy to read a claim into it that it
cannot support.

- **It is not a human diagnosis time.** A person reading a stack chart and forming a hypothesis is
  not in this figure and cannot be scripted into it. EPIC-17-S35 is automated *"at e2e + timed
  manual"*; this is the e2e half. The manual half — an operator who has not seen the fixture,
  with a stopwatch — is still owed, and this file does not discharge it.
- **It is not a first-load time.** Vite's module graph is warmed on a throwaway page before the
  stopwatch starts, so what is measured is the application rather than \`esbuild\`'s first compile.
- **It is a lower bound on the software's contribution**, and an upper bound on nothing. What it
  does establish is the property PRD §13 actually doubts: that the evidence is *reachable* — that
  six views in sequence carry an operator from "the run is red" to the sentence naming the defect,
  with no log grepping and no second tool.

## The walks

| fixture | elapsed | stops answered | root cause |
| ------- | ------- | -------------- | ---------- |
${measurement.walks.map(row).join('\n')}

**Median: ${seconds(measurement.medianMs)}.** Target: ${seconds(measurement.targetMs)} (PRD §12).

Three fixtures with three different root causes, because *"the measurement is repeated, not
anecdotal"* is its own scenario. They are not picked to flatter the number: \`five-minute-diagnosis\`
is the scenario's own 22-node run, and the other two are the only remaining recordings in the corpus
that can be diagnosed at all. \`compaction\` is three events with no \`run.created\` — no plan, no
criteria, nothing to orient on — and \`crash-resume-seq-gap\` records a sequence hole rather than a
failure. Both exclusions are asserted by the e2e spec rather than claimed here.

A stop marked \`∅\` below is one the fixture had an honest nothing to show at, which is a property of
the recording and not of the view: \`gate-failure-repair\` never built a context packet, and
\`repair-attempts\` has no gate verdict, so neither can answer all seven. Only
\`five-minute-diagnosis\` carries the whole chain, which is why it exists.

## Where the time went

| fixture | ${CHECKPOINTS.join(' | ')} |
| ------- | ${CHECKPOINTS.map(() => '---').join(' | ')} |
${measurement.walks.map(perCheckpoint).join('\n')}
${perCheckpoint(measurement.control)}

The slowest single stop in this run was **${slowest?.point.name ?? 'none'}** on
\`${slowest?.walk ?? 'none'}\` at ${seconds(slowest?.point.ms ?? 0)}. EPIC-17-S35's third scenario
says what that column is for: *"the specific step that consumed the time identifies which view to
fix"*.

## The control

The identical seven navigations over \`${measurement.control.fixture}\` — a run with nothing wrong
with it — taken on the same machine, in the same browser, in the same process:
**${seconds(measurement.control.totalMs)}**, ${String(measurement.control.answered)} of 7 stops
answered. A timing budget with no control is a statement about the laptop. A regression in a view
moves the diagnosis walks and not this figure; a loaded box moves both.

## The budget this enforces

\`${MEASUREMENT_JSON}\` holds \`medianMs: ${String(budget.medianMs)}\`, a tolerance of
×${String(budget.tolerance)}, a floor of ${seconds(budget.floorMs)} and a control ratio of
×${String(budget.controlRatio)}. \`e2e/five-minute-diagnosis.test.ts\` re-walks all four fixtures and
fails if the median exceeds either:

1. **PRD §12's ${seconds(budget.targetMs)}** — the metric itself, which is a gate on the epic and
   not a report on it; or
2. the *widest* of the recorded median × the tolerance, the floor, and this run's own control walk
   × the control ratio — the regression gate, which catches a view that got slower without failing
   on a laptop that is busy.

## Re-run this when

A view on the walk changes shape, a route becomes lazy that was not, or the daemon's read path
moves. And before EPIC-17 is called Done: the number in this file is the Definition of Done, not a
report attached to it.
`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const measurement = await measureDiagnosis();
  const budget = budgetOf(measurement);

  await writeFile(
    join(repoRoot, MEASUREMENT_JSON),
    `${JSON.stringify({ budget, measurement }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(join(repoRoot, MEASUREMENT_MD), renderMeasurement(measurement, budget), 'utf8');
  process.stdout.write(`${MEASUREMENT_MD} and ${MEASUREMENT_JSON} written\n`);
}
