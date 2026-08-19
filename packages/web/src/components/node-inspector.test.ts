/**
 * KAR-17.3 test plan rows 5, 6 and 7 — the node inspector, mounted in the real
 * shell over real recordings.
 *
 * Verifies: EPIC-17-S12, EPIC-17-S13, EPIC-17-S14, EPIC-17-S15, EPIC-17-S16 ·
 * AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8, AC9, AC10, AC11
 *
 * The joins are asserted next door in `../lib/node-inspector.test.ts`, over the
 * same recordings and without a browser. What is asserted **here** is what only
 * a real DOM can say: that the panel renders the absence rather than nothing,
 * that the attempt selector actually re-renders the packet, that a click on a
 * number reaches the debug ring, and that the sparkline is a `<path>` rather
 * than a canvas somebody drew into.
 *
 * The inspector is an overlay hosted by `../App.vue`, so it portals to
 * `document.body` and is queried from `document` rather than from the mounted
 * container — the same way `../views/plan-graph.test.ts` reaches it.
 */
import {
  EVENT_SCHEMAS,
  type Event,
  gateAnswerRequest,
  parseEvent,
  SPEC_APPROVAL_OPTIONS,
  SPEC_GATE_NODE,
} from '@DeFlow/core';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { userEvent } from 'vitest/browser';
import {
  HAPPY_PATH_RUN,
  happyPath12,
  REPAIR_ATTEMPTS_RUN,
  repairAttempts,
} from '../../test/fixture-events.ts';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import { createClient } from '../api/client.ts';

/** KAR-25.1 — the run views are project-scoped now; the value is never
 * asserted on, only threaded through so the named route resolves. */
const PROJECT_ID = 'prj_test';

import { useRunStore } from '../stores/useRunStore.ts';

let shell: MountedShell;

const one = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);

const all = (selector: string): HTMLElement[] => [
  ...document.querySelectorAll<HTMLElement>(selector),
];

const panel = (): HTMLElement => one('[data-overlay="inspector"]') as HTMLElement;

/**
 * Scoped to the inspector's own subtree — needed once KAR-25.7's gate section
 * exists, because `App.vue`'s shell band renders `RunGateBanner` for the
 * run's own open gate at the same time this panel is open, and it uses the
 * same `[data-gate-option]` markup (both mount `../gate/GateOptions.vue`).
 * The global `one`/`all` above would find both.
 */
const inGate = (selector: string): HTMLElement | null =>
  panel().querySelector<HTMLElement>(`[data-inspector-gate] ${selector}`);
const allInGate = (selector: string): HTMLElement[] => [
  ...panel().querySelectorAll<HTMLElement>(`[data-inspector-gate] ${selector}`),
];

/**
 * Folds a recording through the store and opens the inspector on `nodeId`.
 *
 * Driven through the store and the UI store rather than by clicking a node in
 * the graph: what is under test is the inspector, and routing the setup through
 * a 12-node ELK layout would make every assertion below wait on a worker.
 */
async function openInspector(
  run: 'repair' | 'happy',
  nodeId: string,
  attempt?: number,
): Promise<void> {
  const runId = run === 'repair' ? REPAIR_ATTEMPTS_RUN : HAPPY_PATH_RUN;
  const events = run === 'repair' ? repairAttempts() : happyPath12();

  shell = await mountShell({ at: { name: 'run-plan', params: { projectId: PROJECT_ID, runId } } });
  setActivePinia(shell.pinia);
  const store = useRunStore(shell.pinia);
  for (const event of events) store.applyEvent(event);

  shell.ui.setNodes(
    [...store.plan.nodes.values()].map((node) => ({
      id: node.id,
      title: node.title,
      status: node.status,
    })),
  );
  shell.ui.selectNode(nodeId);
  shell.ui.inspectSelected('inspector');
  if (attempt !== undefined) shell.ui.inspectAttempt(attempt);

  await expect.poll(() => one('[data-overlay="inspector"]')).not.toBeNull();
}

beforeEach(() => {
  setActivePinia(undefined as never);
});

afterEach(() => {
  shell?.unmount();
});

/**
 * Row 5 — *"mount for a failed-before-packet node; assert the typed failure
 * renders and no packet section is fabricated"*. Red when the panel renders
 * blank.
 *
 * `probe-oauth-tokens` died at `adapter.spawn-failed` before context assembly
 * ever ran, which is AC9's first named case.
 */
suite('KAR-17.3 row 5 — a node that failed before a packet existed (AC9)', () => {
  it('states that no packet was built, rather than showing an empty one', async () => {
    await openInspector('repair', 'probe-oauth-tokens');

    const packet = one('[data-packet]');
    expect(packet?.dataset['status']).toBe('none');
    expect(packet?.textContent).toContain('No context packet was built');
    // Not a total of zero — there is no packet to have a total.
    expect(one('[data-packet-total]')).toBeNull();
    expect(all('[data-segment-group]')).toEqual([]);
  });

  it('renders the typed NodeFailure that explains the absence', async () => {
    await openInspector('repair', 'probe-oauth-tokens');

    const absence = one('[data-packet-absence]');
    expect(absence?.querySelector('[data-failure-reason]')?.textContent).toBe(
      'adapter.spawn-failed',
    );
    expect(absence?.querySelector('[data-failure-class]')?.textContent).toBe('permanent');
    expect(absence?.querySelector('[data-failure-message]')?.textContent).toContain('ENOENT');
    expect(absence?.querySelectorAll('[data-evidence]')).toHaveLength(1);
  });

  it('is not a blank panel — the header and the attempt row are still there', async () => {
    // The failure mode AC9 names explicitly. A packet section that renders
    // nothing at all and a panel that failed to mount look identical.
    await openInspector('repair', 'probe-oauth-tokens');

    expect(panel().textContent).toContain('probe-oauth-tokens');
    expect(all('[data-attempt-row]')).toHaveLength(1);
    expect(panel().textContent?.trim().length).toBeGreaterThan(80);
  });
});

/**
 * Row 6 — *"attempt selector switches and the side-by-side comparison renders
 * both packets"*. Red when only the latest attempt is fetched.
 */
suite('KAR-17.3 row 6 — the attempt selector and the side-by-side (AC6)', () => {
  it('offers one tab per attempt and opens on the one asked for', async () => {
    await openInspector('repair', 'impl-oauth', 0);

    expect(all('[data-attempt-tab]').map((tab) => tab.dataset['attemptTab'])).toEqual([
      '0',
      '1',
      '2',
    ]);
    expect(one('[data-attempt-tab="0"]')?.getAttribute('aria-selected')).toBe('true');
    expect(one('[data-packet-total]')?.textContent).toContain('262');
  });

  it('re-renders the packet when the operator switches attempt', async () => {
    await openInspector('repair', 'impl-oauth', 0);

    // Attempt 0 has nine segments and no history summary; attempt 1 has eleven
    // and gained one. A selector that only ever showed the latest attempt would
    // pass the first assertion and fail this one.
    expect(all('[data-segment]')).toHaveLength(9);

    await userEvent.click(one('[data-attempt-tab="1"]') as HTMLElement);

    await expect.poll(() => all('[data-segment]').length).toBe(11);
    expect(one('[data-packet-total]')?.textContent).toContain('290');
    expect(one('[data-segment="history-summary"]')).not.toBeNull();
  });

  it('renders both packets side by side, diffed segment by segment', async () => {
    await openInspector('repair', 'impl-oauth', 1);

    await userEvent.selectOptions(one('[data-compare-with]') as HTMLSelectElement, '0');

    await expect.poll(() => one('[data-packet-diff]')).not.toBeNull();
    const added = all('[data-diff-row][data-change="removed"]').map(
      (row) => row.dataset['diffRow'],
    );
    // Attempt 1 against attempt 0: the summary and the tool output are in the
    // left packet and not the right one.
    expect(added).toEqual(['history-summary', 'tool-output']);
  });

  it('names a repair that changed nothing as the no-op it is', async () => {
    // EPIC-17-S13. Attempts 1 and 2 have byte-identical packets, and an empty
    // list of changed rows is indistinguishable from a diff that never ran.
    await openInspector('repair', 'impl-oauth', 2);

    await userEvent.selectOptions(one('[data-compare-with]') as HTMLSelectElement, '1');

    await expect.poll(() => one('[data-diff-identical]')).not.toBeNull();
    expect(one('[data-diff-identical]')?.textContent).toContain('identical');
    expect(all('[data-diff-row][data-change="changed"]')).toEqual([]);
  });

  it('lists every attempt with its outcome, reason, duration and cost (AC1)', async () => {
    await openInspector('repair', 'impl-oauth', 2);

    const rows = all('[data-attempt-row]');
    expect(rows.map((row) => row.dataset['attemptRow'])).toEqual([
      'impl-oauth#0',
      'impl-oauth#1',
      'impl-oauth#2',
    ]);
    expect(rows[2]?.querySelector('[data-failure-reason]')?.textContent).toBe(
      'contract.schema-invalid',
    );
    expect(rows[2]?.querySelector('[data-duration]')?.textContent).toContain('4');
    expect(rows[2]?.querySelector('[data-cost]')?.textContent).toContain('0.096');
  });
});

/**
 * Row 7 — *"provenance table over `happy-path-12`: reads, writers, evidence,
 * invalidation flag"*. Red when provenance is inferred from the graph rather
 * than from `fact.read`.
 */
suite('KAR-17.3 row 7 — the provenance table (AC8)', () => {
  it('lists the fact this node read, with writer, evidence and confidence', async () => {
    await openInspector('happy', 'impl-login');

    const rows = all('[data-provenance-row]');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector('[data-fact-key]')?.textContent).toBe(
      'decision/router-guard-shape',
    );
    expect(rows[0]?.querySelector('[data-fact-writer]')?.textContent).toBe('plan-migration');
    expect(rows[0]?.querySelector('[data-fact-confidence]')?.textContent).toBe('asserted');
    expect(rows[0]?.querySelectorAll('[data-evidence]').length).toBeGreaterThan(0);
    expect(rows[0]?.querySelector('[data-fact-at]')?.textContent).toBeTruthy();
  });

  it('marks a fact that was later invalidated, and taints the node', async () => {
    await openInspector('happy', 'impl-login');

    const row = one('[data-provenance-row]');
    expect(row?.dataset['invalidated']).toBe('true');
    expect(row?.querySelector('[data-invalidated-by]')?.textContent).toBe('review-security');
    expect(row?.textContent).toContain('guard shape changed');
    expect(one('[data-tainted]')).not.toBeNull();
  });

  it('reads the consumer set from fact.read and not from the plan’s edges', async () => {
    // `recon-auth-surface` *wrote* a fact and read none. A table built from
    // declared data edges would list what a node could have read; this one
    // lists what it did.
    await openInspector('happy', 'recon-auth-surface');

    expect(all('[data-provenance-row]')).toEqual([]);
    expect(one('[data-provenance-empty]')?.textContent).toContain('read no facts');
    expect(one('[data-tainted]')).toBeNull();
  });

  it('links each row to the writing node’s own inspector', async () => {
    await openInspector('happy', 'impl-login');

    await userEvent.click(one('[data-open-node="plan-migration"]') as HTMLElement);

    await expect.poll(() => shell.ui.inspectedNodeId).toBe('plan-migration');
  });
});

/**
 * AC2 and AC3 in a real DOM — the nine groups, and the sum the header claims.
 */
suite('KAR-17.3 — the packet, grouped and reconciled (AC2, AC3)', () => {
  it('renders all nine kinds, pinned first, even the empty ones', async () => {
    await openInspector('repair', 'impl-oauth', 0);

    const groups = all('[data-segment-group]').map((group) => group.dataset['segmentGroup']);
    expect(groups).toEqual([
      'pinned.constraints',
      'pinned.spec',
      'pinned.pathscope',
      'task.brief',
      'fact',
      'artifact.handle',
      'retrieved',
      'history.summary',
      'tool.output',
    ]);
    // Attempt 0 carried no tool output. The row says so rather than vanishing.
    expect(one('[data-segment-group="tool.output"]')?.dataset['empty']).toBe('true');
  });

  it('shows each segment’s kind, tokens, pinned flag and sourceEvent', async () => {
    await openInspector('repair', 'impl-oauth', 1);

    const segment = one('[data-segment="pinned-spec-goal"]');
    expect(segment?.dataset['pinned']).toBe('true');
    expect(segment?.querySelector('[data-segment-tokens]')?.textContent).toContain('46');
    expect(segment?.querySelector('[data-seq-link]')?.getAttribute('data-seq-link')).toBe('4');
  });

  it('sums the rendered per-segment counts to the rendered header total', async () => {
    // Playwright smoke #3's assertion, made against the DOM rather than against
    // the view model: this is the one that would catch a template that rendered
    // a different number from the one it summed.
    await openInspector('repair', 'impl-oauth', 1);

    const counts = all('[data-segment-tokens]').map((cell) =>
      Number(cell.getAttribute('data-segment-tokens')),
    );
    const summed = counts.reduce((total, count) => total + count, 0);

    expect(counts).toHaveLength(11);
    expect(Number(one('[data-packet-total]')?.getAttribute('data-packet-total'))).toBe(summed);
  });
});

/**
 * AC4 — the prompt, and the fact that it is derived.
 */
suite('KAR-17.3 — the rendered prompt is shown, and labelled derived (AC4)', () => {
  it('offers the prompt from its artifact handle', async () => {
    await openInspector('repair', 'impl-oauth', 1);

    expect(one('[data-prompt-handle]')?.getAttribute('data-prompt-handle')).toMatch(
      /^artifact:\/\//,
    );
  });

  it('says in words that the manifest above it is the authoritative one', async () => {
    // Without this the rendered prompt silently wins any argument with the
    // manifest, and the manifest is what the daemon actually assembled.
    await openInspector('repair', 'impl-oauth', 1);

    const note = one('[data-prompt-derived]');
    expect(note?.textContent).toContain('derived');
    expect(note?.textContent).toContain('manifest is authoritative');
  });
});

/**
 * AC5 — output, twice, and the validator's own words.
 */
suite('KAR-17.3 — raw and normalised output, separately (AC5)', () => {
  it('shows the Ajv errors beside the output that failed them', async () => {
    await openInspector('repair', 'impl-oauth', 2);

    const errors = all('[data-schema-error]');
    expect(errors).toHaveLength(2);
    expect(errors[0]?.querySelector('[data-instance-path]')?.textContent).toBe(
      '/findings/0/severity',
    );
    expect(errors[0]?.textContent).toContain('enum');
    expect(one('[data-schema-id]')?.textContent).toBe('DeFlow.verdict.v4');
  });

  it('keeps the raw output and the normalised output in separate panes', async () => {
    await openInspector('happy', 'recon-auth-surface');

    expect(one('[data-output="normalised"]')?.textContent).toContain('auth verifies a JWT');
    // Two panes, and the raw one is honest about having nothing: this node
    // produced no artifacts, and an empty pane that looked like the normalised
    // output would be the fabrication AC5 separates them to prevent.
    expect(one('[data-output="raw"]')?.textContent).toContain('No raw transcript');
    expect(one('[data-output="raw"]')?.textContent).not.toContain('auth verifies a JWT');
  });

  it('offers the raw output as a handle, never as inlined bytes', async () => {
    // `impl-oauth`'s third attempt failed with evidence attached, which is
    // where a raw transcript actually lives.
    await openInspector('repair', 'impl-oauth', 2);

    expect(one('[data-output="raw"] [data-evidence]')?.textContent).toMatch(/^artifact:\/\//);
  });
});

/**
 * AC7 — NF10 made visible. The link from a number to the envelope behind it.
 */
suite('KAR-17.3 — every value links to its seq (AC7)', () => {
  it('selects the producing event in the debug ring and shows its envelope', async () => {
    await openInspector('repair', 'impl-oauth', 1);

    // A segment's token count is produced by the `context.built` at seq 16.
    await userEvent.click(one('[data-seq-link="16"]') as HTMLElement);

    await expect.poll(() => one('[data-ring-envelope]')).not.toBeNull();
    expect(one('[data-ring-envelope]')?.dataset['ringEnvelope']).toBe('16');
    expect(one('[data-ring-envelope]')?.textContent).toContain('context.built');
    // The envelope, not a summary of it.
    expect(one('[data-ring-envelope]')?.textContent).toContain('"seq"');
  });

  it('links the cost figure to the budget.consumed that produced it', async () => {
    await openInspector('repair', 'impl-oauth', 1);

    const link = one('[data-attempt-row="impl-oauth#1"] [data-cost] [data-seq-link]');
    expect(link?.getAttribute('data-seq-link')).toBe('18');

    await userEvent.click(link as HTMLElement);
    await expect.poll(() => one('[data-ring-envelope]')?.textContent).toContain('budget.consumed');
  });

  it('links the state transition to the lifecycle event that made it', async () => {
    await openInspector('repair', 'impl-oauth', 1);

    const link = one('[data-attempt-row="impl-oauth#1"] [data-outcome] [data-seq-link]');
    expect(link?.getAttribute('data-seq-link')).toBe('19');

    await userEvent.click(link as HTMLElement);
    await expect.poll(() => one('[data-ring-envelope]')?.textContent).toContain('node.failed');
  });

  it('links a fact in the provenance table to its fact.written', async () => {
    await openInspector('happy', 'impl-login');

    const link = one('[data-provenance-row] [data-seq-link]');
    expect(link?.getAttribute('data-seq-link')).toBe('16');

    await userEvent.click(link as HTMLElement);
    await expect.poll(() => one('[data-ring-envelope]')?.textContent).toContain('fact.written');
  });
});

/**
 * AC10 and AC11 — the absence stated as an absence, and the sparkline's shape.
 */
suite('KAR-17.3 — an unpriced provider, and the sparkline (AC10, AC11)', () => {
  it('names a provider that reports no token accounting rather than showing zero', async () => {
    await openInspector('happy', 'impl-signup');

    const cost = one('[data-attempt-row="impl-signup#0"] [data-cost]');
    expect(cost?.querySelector('[data-unaccounted]')?.textContent).toContain('gemini-cli');
    expect(cost?.querySelector('[data-unaccounted]')?.textContent).not.toContain('$0.00');
  });

  it('draws the token sparkline as a raw path, not into a canvas', async () => {
    // AC11. The `d3-selection` half is enforced repo-wide by
    // `test/no-d3-selection-in-web.test.ts`; what this asserts is the other
    // half — that the shape is a `<path>` this component rendered itself.
    await openInspector('repair', 'impl-oauth', 2);

    const spark = one('[data-sparkline]');
    expect(spark?.tagName.toLowerCase()).toBe('svg');
    expect(spark?.querySelector('canvas')).toBeNull();
    expect(spark?.querySelector('path')?.getAttribute('d')).toMatch(/^M/);
  });
});

/**
 * AC1 — the header. Identity, provider, model, binary, permission, scopes and
 * worktree, in one place.
 */
suite('KAR-17.3 — the header identifies what actually ran (AC1)', () => {
  it('shows the CLI version and the binary sha256 that produced this work', async () => {
    await openInspector('repair', 'impl-oauth', 0);

    // KAR-24.6 AC3 — binary version/sha256 moved from the header into the
    // config tab, so the scope this test reads them from moved with it.
    // `unmount-on-hide="false"` keeps the tab's markup in the DOM whether or
    // not it is the active tab, so this needs no click on the config tab.
    const config = one('[data-inspector-config]');
    expect(config?.querySelector('[data-field="binary-version"]')?.textContent).toBe('2.1.220');
    expect(config?.querySelector('[data-field="binary-sha256"]')?.textContent).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it('shows the permission level and the path scopes the plan gave it', async () => {
    await openInspector('happy', 'impl-signup');

    // KAR-24.6 AC3 — same move as above: permission and path scopes are now
    // config-tab fields.
    const config = one('[data-inspector-config]');
    expect(config?.querySelector('[data-field="permission"]')?.textContent).toBeTruthy();
    expect(config?.querySelector('[data-field="path-scopes"]')?.textContent).toContain('src/**');
  });
});

/**
 * KAR-25.7 AC4, AC6, AC7, EPIC-25-S46, EPIC-25-S47 — the canvas stops being a
 * dead end for a node waiting on a human decision.
 *
 * Built from hand-written events rather than a fixture recording: what is
 * under test is a node suspended on the F1.3 spec gate, which is the one
 * waiting node whose options include the unsubmittable `edit` — exactly
 * `RunGateBanner.vue`'s own KAR-22.5 AC4 case, on a third surface.
 */
const T0 = 1_786_800_000_000;

function gateFrame(kind: string, seq: number, payload: unknown): Event {
  const result = parseEvent({
    seq,
    runId: HAPPY_PATH_RUN,
    ts: T0,
    kind,
    v: (EVENT_SCHEMAS as Record<string, { v: number }>)[kind]?.v ?? 1,
    epoch: 1,
    payload,
  });
  if (result.status !== 'ok') {
    throw new Error(`the spec built an envelope this build cannot read: ${JSON.stringify(result)}`);
  }
  return result.event;
}

/** Opens the inspector on the F1.3 spec gate node, waiting with the daemon's
 * own four options. Not part of `openInspector` above: that helper folds a
 * whole recording, and this needs exactly the two events that put a node on
 * an open gate — `node.suspended` (so the node exists on the canvas at all,
 * KAR-19.12's own reason the spec-approval node appears in no compiled plan)
 * and `human.requested`. */
async function openWaitingInspector(): Promise<{ store: ReturnType<typeof useRunStore> }> {
  shell = await mountShell({
    at: { name: 'run-plan', params: { projectId: PROJECT_ID, runId: HAPPY_PATH_RUN } },
  });
  setActivePinia(shell.pinia);
  const store = useRunStore(shell.pinia);

  store.applyEvent(
    gateFrame('node.suspended', 1, { node: SPEC_GATE_NODE, until: { kind: 'human' } }),
  );
  store.applyEvent(
    gateFrame('human.requested', 2, {
      node: SPEC_GATE_NODE,
      prompt: 'The change is ready. Ship it?',
      options: SPEC_APPROVAL_OPTIONS.map((option) => ({ ...option })),
    }),
  );

  shell.ui.setNodes(
    [...store.plan.nodes.values()].map((node) => ({
      id: node.id,
      title: node.title,
      status: node.status,
    })),
  );
  shell.ui.selectNode(SPEC_GATE_NODE);
  shell.ui.inspectSelected('inspector');

  await expect.poll(() => one('[data-overlay="inspector"]')).not.toBeNull();
  return { store };
}

suite('EPIC-25-S46 — a waiting node is answerable from the inspector', () => {
  it('offers the gate section for the selected node, once it is waiting', async () => {
    await openWaitingInspector();

    expect(one('[data-inspector-gate]')).not.toBeNull();
    expect(allInGate('[data-gate-option]').map((button) => button.dataset.gateOption)).toEqual(
      SPEC_APPROVAL_OPTIONS.map((option) => option.id),
    );
  });

  it('answers through gateAnswerRequest, the same route deflow answer uses', async () => {
    const sent: { pathname: string; body: unknown }[] = [];
    shell?.unmount();
    shell = await mountShell({
      at: { name: 'run-plan', params: { projectId: PROJECT_ID, runId: HAPPY_PATH_RUN } },
      client: createClient({
        baseUrl: 'http://daemon.test/api',
        token: () => 'test-token-Aa0_-Bb1',
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(typeof input === 'string' ? input : String(input));
          // `AppRail`/`ProjectSwitcher` fetch on mount regardless of route
          // (their own docblocks) — only the POST this test presses a button
          // for is what it means by "sent".
          if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
            const raw = init?.body;
            sent.push({
              pathname: url.pathname,
              body: typeof raw === 'string' && raw !== '' ? JSON.parse(raw) : null,
            });
          }
          if (url.pathname === '/api/providers') {
            return new Response(JSON.stringify([]), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (url.pathname === '/api/projects') {
            return new Response(JSON.stringify({ projects: [] }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        },
      }),
    });
    setActivePinia(shell.pinia);
    const store = useRunStore(shell.pinia);
    store.applyEvent(
      gateFrame('node.suspended', 1, { node: SPEC_GATE_NODE, until: { kind: 'human' } }),
    );
    store.applyEvent(
      gateFrame('human.requested', 2, {
        node: SPEC_GATE_NODE,
        prompt: 'The change is ready. Ship it?',
        options: SPEC_APPROVAL_OPTIONS.map((option) => ({ ...option })),
      }),
    );
    shell.ui.setNodes(
      [...store.plan.nodes.values()].map((node) => ({
        id: node.id,
        title: node.title,
        status: node.status,
      })),
    );
    shell.ui.selectNode(SPEC_GATE_NODE);
    shell.ui.inspectSelected('inspector');
    await expect.poll(() => one('[data-overlay="inspector"]')).not.toBeNull();

    const expected = gateAnswerRequest({
      runId: HAPPY_PATH_RUN,
      gate: SPEC_GATE_NODE,
      optionId: 'approve',
    });
    await userEvent.click(inGate('[data-gate-option="approve"]') as HTMLElement);
    await expect.poll(() => sent.length).toBe(1);
    expect(sent[0]?.pathname).toBe(expected?.path);
    expect(sent[0]?.body).toEqual(expected?.body);
  });
});

suite(
  'EPIC-25-S47 — an option no surface can submit is shown unsubmittable, with its reason',
  () => {
    it('shows all four options and disables edit, with the daemon’s own sentence', async () => {
      await openWaitingInspector();

      expect(allInGate('[data-gate-option]')).toHaveLength(4);
      const edit = inGate('[data-gate-option="edit"]') as HTMLButtonElement;
      expect(edit.disabled).toBe(true);
      expect(inGate('[data-gate-option-reason="edit"]')?.textContent).toContain(
        'DeFlow.taskspecdraft.v1',
      );
    });
  },
);

suite('KAR-25.7 AC7 — answering twice is not possible, from the ledger, not a local flag', () => {
  it('removes the gate section once human.responded arrives, with no flag on this panel', async () => {
    const { store } = await openWaitingInspector();
    expect(one('[data-inspector-gate]')).not.toBeNull();

    store.applyEvent(
      gateFrame('human.responded', 3, {
        node: SPEC_GATE_NODE,
        optionId: 'approve',
        at: new Date(T0 + 60_000).toISOString(),
        by: 'operator',
      }),
    );

    await expect.poll(() => one('[data-inspector-gate]')).toBeNull();
  });
});
