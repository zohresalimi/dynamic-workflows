/**
 * KAR-25.2 — `/settings`, in a real Chromium.
 *
 * Verifies: EPIC-25-S08, EPIC-25-S10, EPIC-25-S11 · AC1, AC2, AC3
 *
 * Modelled on `../app/frame.test.ts` and `../app/nav-scope.test.ts`:
 * `mountShell` assembles the one real application, and the client is a small
 * fixed daemon (`settingsDaemon` below) rather than `fetch` monkey-patched —
 * several of these specs assert *which request the view made and with what
 * body*, and the typed client is the thing that decides that.
 *
 * EPIC-25-S09's own scenario — "the settings view's source is read" — is a
 * claim about what the file imports and calls, not about what renders, and is
 * asserted against the source text instead, in
 * `/test/settings-view-no-projectid.test.ts`: this package's own browser
 * project has no `node:fs`, so a source-reading spec belongs in the `unit`
 * project the way `/test/no-workspace-word.test.ts` already does for the same
 * reason.
 */
import { afterEach, expect, it, describe as suite } from 'vitest';
import { userEvent } from 'vitest/browser';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import { createClient } from '../api/client.ts';

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly createdAt: string;
  readonly health: { readonly state: string; readonly message: string | null };
  readonly lastRun: null;
}

const PROJECT_A: ProjectRow = {
  id: 'prj_20260815T101112Z_a1b2c3',
  name: 'checkout',
  path: '/repos/checkout',
  createdAt: '2026-08-15T10:11:12.000Z',
  health: { state: 'ok', message: null },
  lastRun: null,
};

const PROJECT_B: ProjectRow = {
  id: 'prj_20260816T101112Z_b2c3d4',
  name: 'billing',
  path: '/repos/billing',
  createdAt: '2026-08-16T10:11:12.000Z',
  health: { state: 'ok', message: null },
  lastRun: null,
};

/** `checkout`'s `.DeFlow/config.yaml`: a mix of present and absent fields on
 *  purpose, so EPIC-25-S10 has both to assert on in one fixture. `gpt` has
 *  `pinReinjectTurns` and nothing else — the case that catches a panel that
 *  renders a field because *some* provider has it rather than because *this*
 *  provider's own entry does. */
const CONFIG_CHECKOUT = {
  providers: {
    claude: { pinReinjectTurns: 8, autocompactPct: 70, disableAutoCompact: false },
    gpt: { pinReinjectTurns: 4 },
  },
  context: { inlineThresholdBytes: 4096 },
  budget: { run: { costUsd: 5, wallclockMs: 600_000 }, node: { costUsd: 1 } },
  policy: { patch: { rules: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }, { id: 'r4' }] } },
  constraints: [{ form: 'allow-only' }, { form: 'allow-only' }, { form: 'allow-only' }],
};

interface Recorded {
  readonly patches: { cwd: string; body: unknown }[];
}

/**
 * Every path the frame's own pieces and this view reach, answered from one
 * fixed daemon — `../app/frame.test.ts`'s own `frameDaemon`, extended with
 * `GET`/`PATCH /api/config`. `configStore` is a mutable map so a `PATCH` in
 * one test step is visible to the `GET` the panel's own `refetch()` makes
 * right after (EPIC-25-S11's "re-opening /settings ... shows the new value",
 * proven here as "refetching without a reload shows it").
 */
function settingsDaemon(options: {
  readonly projects?: readonly ProjectRow[];
  readonly configStore?: Record<string, Record<string, unknown>>;
  readonly knownCwds?: readonly string[];
  readonly recorded?: Recorded;
  /** Refuses a patch whose body matches, the way a schema violation would. */
  readonly refusePatch?: (cwd: string, body: Record<string, unknown>) => boolean;
}) {
  const configStore = options.configStore ?? {};
  const known = new Set(options.knownCwds ?? Object.keys(configStore));

  const json = (status: number, body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );

  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();

    if (url.includes('/config')) {
      const cwd = new URL(url).searchParams.get('cwd') ?? '';

      if (method === 'PATCH') {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        options.recorded?.patches.push({ cwd, body });
        if (!known.has(cwd)) {
          return json(400, {
            error: {
              code: 'invalid_request',
              message: 'cwd is not a repository this daemon holds a run for',
              detail: { field: 'cwd' },
              retryable: false,
            },
          });
        }
        if (options.refusePatch?.(cwd, body) === true) {
          return json(422, {
            error: {
              code: 'schema_violation',
              message: 'that is not a valid .DeFlow/config.yaml',
              detail: { reason: 'inlineThresholdBytes must be a positive integer' },
              retryable: false,
            },
          });
        }
        configStore[cwd] = { ...configStore[cwd], ...body };
        return json(200, { cwd, config: configStore[cwd] });
      }

      // GET
      if (!known.has(cwd)) {
        return json(400, {
          error: {
            code: 'invalid_request',
            message: 'cwd is not a repository this daemon holds a run for',
            detail: { field: 'cwd' },
            retryable: false,
          },
        });
      }
      return json(200, { cwd, config: configStore[cwd] ?? {} });
    }

    if (url.includes('/providers')) return json(200, []);
    if (/\/api\/projects\/[^/?]+\/runs$/.test(url)) return json(200, { runs: [] });
    if (url.includes('/projects')) return json(200, { projects: options.projects ?? [] });
    if (url.includes('/approvals'))
      return json(200, { items: [], counts: { total: 0 }, headSeq: 1 });
    return json(404, { error: { message: 'not found' } });
  };
}

function client(options: Parameters<typeof settingsDaemon>[0]) {
  return createClient({
    baseUrl: 'http://127.0.0.1:7777/api',
    fetch: settingsDaemon(options),
    token: () => 'test-token-Aa0_-Bb1',
  });
}

function panelTitles(shell: MountedShell): string[] {
  return [...shell.container.querySelectorAll<HTMLElement>('[data-panel]')].map(
    (panel) => panel.querySelector('.ui-panel__title')?.textContent?.trim() ?? '',
  );
}

let shell: MountedShell;

afterEach(() => {
  shell?.unmount();
});

suite('EPIC-25-S08 — one settings page, whatever project is open (AC1, AC2)', () => {
  it('renders the three panels, in the blueprint’s order, with no project open', async () => {
    shell = await mountShell({
      at: '/settings',
      client: client({ projects: [PROJECT_A] }),
    });

    expect(panelTitles(shell)).toEqual([
      'Providers & runtimes',
      'Issue tracker',
      'Execution defaults',
    ]);
    expect(shell.container.querySelector('[data-settings]')).not.toBeNull();
  });

  it('renders the same three panels, with the same values, once a project is open', async () => {
    shell = await mountShell({
      at: { name: 'project-workflows', params: { projectId: PROJECT_A.id } },
      client: client({ projects: [PROJECT_A] }),
    });

    await shell.router.push('/settings');

    expect(panelTitles(shell)).toEqual([
      'Providers & runtimes',
      'Issue tracker',
      'Execution defaults',
    ]);
    // AC1 — identically: the picker starts unchosen either way, because
    // nothing about this page's own state came from the route.
    const picker = shell.container.querySelector<HTMLSelectElement>('[data-settings-workspace]');
    expect(picker?.value).toBe('');
    expect(shell.container.querySelector('[data-config-error]')).toBeNull();
  });
});

suite('EPIC-25-S10 — Execution defaults renders only what the daemon has a home for (AC3)', () => {
  it('renders a control per present field, and no control for an absent one', async () => {
    shell = await mountShell({
      at: '/settings',
      client: client({
        projects: [PROJECT_A],
        configStore: { [PROJECT_A.path]: structuredClone(CONFIG_CHECKOUT) },
        knownCwds: [PROJECT_A.path],
      }),
    });

    const picker = shell.container.querySelector<HTMLSelectElement>('[data-settings-workspace]');
    await userEvent.selectOptions(picker as HTMLSelectElement, PROJECT_A.path);

    await expect
      .poll(() =>
        shell.container.querySelector('[data-field="context.inlineThresholdBytes"] input'),
      )
      .not.toBeNull();

    const panel = shell.container.querySelector('[data-panel="execution-defaults"]') as HTMLElement;

    // Present, and rendered.
    expect(panel.querySelector('[data-field="context.inlineThresholdBytes"] input')).not.toBeNull();
    expect(panel.querySelector('[data-field="budget.run.costUsd"] input')).not.toBeNull();
    expect(panel.querySelector('[data-field="budget.run.wallclockMs"] input')).not.toBeNull();
    expect(panel.querySelector('[data-field="budget.node.costUsd"] input')).not.toBeNull();
    expect(
      panel.querySelector('[data-field="providers.claude.pinReinjectTurns"] input'),
    ).not.toBeNull();
    expect(
      panel.querySelector('[data-field="providers.claude.autocompactPct"] input'),
    ).not.toBeNull();
    expect(panel.querySelector('[data-provider-group="claude"] [role="switch"]')).not.toBeNull();
    expect(
      panel.querySelector('[data-field="providers.gpt.pinReinjectTurns"] input'),
    ).not.toBeNull();
    expect(panel.textContent).toContain('3 declared');
    expect(panel.textContent).toContain('4 rules');

    // Absent from the response — absent from the panel, not disabled.
    expect(panel.querySelector('[data-field="budget.node.wallclockMs"]')).toBeNull();
    expect(panel.querySelector('[data-field="providers.gpt.autocompactPct"]')).toBeNull();
    expect(panel.querySelector('[data-provider-group="gpt"] [role="switch"]')).toBeNull();

    // No control this schema has never had a home for.
    expect(panel.textContent).not.toMatch(/temperature/i);
    expect(panel.textContent).not.toMatch(/max steps/i);
    expect(panel.textContent).not.toMatch(/parallel nodes/i);
    expect(panel.textContent).not.toMatch(/require approval/i);
  });

  it('shows an explanatory empty state for an unconfigured workspace, not blank controls', async () => {
    shell = await mountShell({
      at: '/settings',
      client: client({
        projects: [PROJECT_B],
        configStore: { [PROJECT_B.path]: {} },
        knownCwds: [PROJECT_B.path],
      }),
    });

    const picker = shell.container.querySelector<HTMLSelectElement>('[data-settings-workspace]');
    await userEvent.selectOptions(picker as HTMLSelectElement, PROJECT_B.path);

    const panel = () =>
      shell.container.querySelector('[data-panel="execution-defaults"]') as HTMLElement;
    await expect.poll(() => panel().querySelectorAll('input, [role="switch"]').length).toBe(0);
    expect(panel().textContent).toMatch(/no .*config\.yaml/i);
  });
});

suite('EPIC-25-S11 — a changed default persists through the daemon’s own config route', () => {
  it('sends the whole providers record, preserving a sibling provider untouched', async () => {
    const recorded: Recorded = { patches: [] };
    shell = await mountShell({
      at: '/settings',
      client: client({
        projects: [PROJECT_A],
        configStore: { [PROJECT_A.path]: structuredClone(CONFIG_CHECKOUT) },
        knownCwds: [PROJECT_A.path],
        recorded,
      }),
    });

    const picker = shell.container.querySelector<HTMLSelectElement>('[data-settings-workspace]');
    await userEvent.selectOptions(picker as HTMLSelectElement, PROJECT_A.path);

    const input = () =>
      shell.container.querySelector<HTMLInputElement>(
        '[data-field="providers.claude.pinReinjectTurns"] input',
      );
    await expect.poll(() => input()).not.toBeNull();

    await userEvent.fill(input() as HTMLInputElement, '12');
    (input() as HTMLInputElement).blur();

    await expect.poll(() => recorded.patches.length).toBe(1);
    const sent = recorded.patches[0] as {
      cwd: string;
      body: { providers: Record<string, unknown> };
    };
    expect(sent.cwd).toBe(PROJECT_A.path);
    expect(sent.body.providers['claude']).toEqual({
      pinReinjectTurns: 12,
      autocompactPct: 70,
      disableAutoCompact: false,
    });
    // The sibling provider survives the shallow merge because this view sent
    // its own last-known value rather than leaving it out.
    expect(sent.body.providers['gpt']).toEqual({ pinReinjectTurns: 4 });

    // The panel re-reads rather than trusting local state (EPIC-25-S11's
    // "re-opening /settings ... shows the new value").
    await expect.poll(() => input()?.value).toBe('12');
  });

  it('renders a refusal in the daemon’s own words, including the schema reason', async () => {
    shell = await mountShell({
      at: '/settings',
      client: client({
        projects: [PROJECT_A],
        configStore: { [PROJECT_A.path]: structuredClone(CONFIG_CHECKOUT) },
        knownCwds: [PROJECT_A.path],
        refusePatch: () => true,
      }),
    });

    const picker = shell.container.querySelector<HTMLSelectElement>('[data-settings-workspace]');
    await userEvent.selectOptions(picker as HTMLSelectElement, PROJECT_A.path);

    const input = () =>
      shell.container.querySelector<HTMLInputElement>(
        '[data-field="context.inlineThresholdBytes"] input',
      );
    await expect.poll(() => input()).not.toBeNull();

    await userEvent.fill(input() as HTMLInputElement, '9000');
    (input() as HTMLInputElement).blur();

    const refusal = () => shell.container.querySelector('[data-config-error]');
    await expect
      .poll(() => refusal()?.textContent)
      .toContain('that is not a valid .DeFlow/config.yaml');
    expect(refusal()?.textContent).toContain('inlineThresholdBytes must be a positive integer');
  });
});
