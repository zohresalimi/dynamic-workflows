/**
 * KAR-25.3 — the *Providers & runtimes* panel, in a real Chromium, mounted
 * through `/settings` the way an operator actually reaches it.
 *
 * Verifies: EPIC-25-S14, EPIC-25-S15, EPIC-25-S16, EPIC-25-S20, EPIC-25-S21 ·
 * AC1, AC2, AC3, AC4, AC7
 *
 * Modelled on `../../views/settings.test.ts` and `./connectors-panel.test.ts`:
 * a small fixed daemon rather than `fetch` monkey-patched, because several of
 * these specs assert *which request was made, how many times, and with what
 * body*. `providersDaemon` below is **stateful** — a `PATCH` changes what the
 * next `GET /providers` and `GET /providers/routes` answer — because AC3's
 * whole claim is that the two routes and the toggle read one fact, and a
 * fixture that answered every `GET` the same way regardless of the `PATCH`
 * before it would not be able to tell a real join from a lucky coincidence.
 */
import { afterEach, expect, it, describe as suite } from 'vitest';
import { commands, userEvent } from 'vitest/browser';
import { type MountedShell, mountShell } from '../../../test/shell.ts';
import { createClient } from '../../api/client.ts';

interface RuntimeFixture {
  provider: string;
  installed: boolean;
  version: string | null;
  binaryPath: string | null;
  enabled: boolean;
  action: string | null;
  /** `routes.acp` for this row's route report — defaults to `'missing'`,
   *  matching the original fixture's shape. */
  acp?: string;
}

interface Calls {
  providersGet: number;
  routesGet: number;
  doctorPost: number;
  patches: { provider: string; enabled: boolean }[];
}

/**
 * A doctor response the test holds open until it releases it.
 *
 * The daemon's own single-flight collapses the *work*, but the claim under
 * test here is the client-side guard (AC2's header comment) — and a fixture
 * that answered `POST /providers/doctor` instantly would let the first
 * click's whole round trip finish before a second `userEvent.click()` ever
 * reaches the button, which proves nothing about a double click. Holding the
 * response open is what makes "one request is in flight" a real state a test
 * can click into.
 */
function doctorGate(): { readonly wait: Promise<void>; readonly release: () => void } {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

function json(status: number, body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
}

/** One `mock`, healthy and enabled, and one not-yet-installed `codex` with an
 *  install command — enough to exercise every branch this panel has. */
function defaultRows(): RuntimeFixture[] {
  return [
    {
      provider: 'mock',
      installed: true,
      version: 'deflow-mock-agent 1.0.0',
      binaryPath: '/opt/bin/deflow-mock-agent',
      enabled: true,
      action: null,
    },
    {
      provider: 'codex',
      installed: false,
      version: null,
      binaryPath: null,
      enabled: true,
      action: 'npm install -g @openai/codex',
    },
  ];
}

function providersDaemon(
  rows: RuntimeFixture[],
  calls: Calls,
  options: {
    readonly holdDoctorUntil?: Promise<void>;
    readonly routesKnown?: boolean;
    /** `GET /providers/routes` answers this status instead of a report —
     *  the daemon still starting (503) or refusing (500). */
    readonly routesStatus?: number;
    /** `GET /providers/routes` rejects outright — the request never got an
     *  HTTP answer at all (daemon gone, network refused). */
    readonly routesReject?: boolean;
  } = {},
) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();

    const patched = /\/api\/providers\/([^/?]+)$/.exec(url);
    if (method === 'PATCH' && patched?.[1] !== undefined) {
      const provider = patched[1];
      const body = JSON.parse(String(init?.body ?? '{}')) as { enabled: boolean };
      calls.patches.push({ provider, enabled: body.enabled });
      const row = rows.find((entry) => entry.provider === provider);
      if (row) row.enabled = body.enabled;
      return json(200, { provider, enabled: body.enabled });
    }

    if (method === 'POST' && url.includes('/providers/doctor')) {
      calls.doctorPost += 1;
      if (options.holdDoctorUntil) await options.holdDoctorUntil;
      return json(200, { probedAt: 0, runId: 'run_doctor', providers: [] });
    }

    // KAR-26.4 — a route report that never arrives: the daemon answered with
    // an error, or the request never resolved at all. Neither is a report.
    if (options.routesReject === true && url.includes('/providers/routes')) {
      calls.routesGet += 1;
      throw new TypeError('Failed to fetch');
    }
    if (options.routesStatus !== undefined && url.includes('/providers/routes')) {
      calls.routesGet += 1;
      return json(options.routesStatus, { error: { message: 'daemon_starting' } });
    }

    // KAR-25.3 AC1 — `boot()` with no `providerRoots`, exactly what
    // `packages/daemon/src/main.ts` does: no row carries a verdict, and the
    // route says so with `known: false` rather than an empty list.
    if (options.routesKnown === false && url.includes('/providers/routes')) {
      calls.routesGet += 1;
      return json(200, { known: false, providers: [] });
    }

    if (url.includes('/providers/routes')) {
      calls.routesGet += 1;
      return json(200, {
        known: true,
        providers: rows.map((row) => ({
          id: row.provider,
          available: row.enabled && row.installed,
          route: row.enabled && row.installed ? 'shim' : null,
          routes: { acp: row.acp ?? 'missing', shim: 'missing' },
          reason: !row.enabled
            ? `${row.provider} is disabled in Settings — enable it there to let DeFlow use it.`
            : row.installed
              ? `"${row.provider}" resolves and answered the handshake.`
              : `${row.provider} is not installed here.`,
          action: !row.enabled ? null : row.action,
          limitation: null,
        })),
      });
    }

    if (url.includes('/providers')) {
      calls.providersGet += 1;
      return json(
        200,
        rows.map((row) => ({
          provider: row.provider,
          installed: row.installed,
          version: row.version,
          binarySha256: null,
          probedAt: null,
          capabilities: null,
          enabled: row.enabled,
          source: 'detected',
          binaryPath: row.binaryPath,
        })),
      );
    }

    if (url.includes('/config')) return json(200, { cwd: '', config: {} });
    if (url.includes('/approvals'))
      return json(200, { items: [], counts: { total: 0 }, headSeq: 1 });
    if (url.includes('/projects')) return json(200, { projects: [] });
    return json(404, { error: { message: 'not found' } });
  };
}

function client(
  rows: RuntimeFixture[],
  calls: Calls,
  options?: Parameters<typeof providersDaemon>[2],
) {
  return createClient({
    baseUrl: 'http://127.0.0.1:7777/api',
    fetch: providersDaemon(rows, calls, options),
    token: () => 'test-token-Aa0_-Bb1',
  });
}

function newCalls(): Calls {
  return { providersGet: 0, routesGet: 0, doctorPost: 0, patches: [] };
}

let shell: MountedShell;

afterEach(() => {
  shell?.unmount();
});

function one<T extends Element = Element>(selector: string): T | null {
  return shell.container.querySelector<T>(selector);
}
function all<T extends Element = Element>(selector: string): T[] {
  return [...shell.container.querySelectorAll<T>(selector)];
}

/** Opens one row's disclosure — KAR-26.4 demoted the health sentence, the
 *  caveat and the install block behind it. */
async function openRowDisclosure(provider: string): Promise<void> {
  const trigger = one(`[data-runtime-row="${provider}"] .ui-disclosure__trigger`);
  await userEvent.click(trigger as HTMLElement);
}

/**
 * A custom property's resolved colour, round-tripped through a probe element —
 * `../ui/variants.test.ts`'s own `tokenColour()` helper, copied per that
 * file's stated pattern (comparing declared text to computed style fails for
 * a formatting reason and teaches nobody anything).
 */
function tokenColour(name: string): string {
  const probe = document.createElement('span');
  probe.style.color = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  document.body.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return resolved;
}

suite('AC1 — each row is the daemon’s own fields, nothing computed here', () => {
  it('shows the name, the resolved binary path, the health sentence, and a toggle', async () => {
    const rows = defaultRows();
    shell = await mountShell({ at: '/settings', client: client(rows, newCalls()) });

    await expect.poll(() => one('[data-runtime-row="mock"]')).not.toBeNull();
    const row = one('[data-runtime-row="mock"]') as HTMLElement;
    expect(row.textContent).toContain('mock');
    expect(row.textContent).toContain('/opt/bin/deflow-mock-agent');
    // The daemon's own sentence — `providerVerdict`'s, read off
    // `GET /providers/routes`, never composed by this file.
    await expect.poll(() => row.textContent).toContain('resolves and answered the handshake');
    // KAR-26.4 tightened this spec's meaning back to what its name claims:
    // the disclosure keeps closed content in `textContent`, so the poll above
    // alone would stay green even if the sentence could never be shown.
    // Opening the disclosure and asserting visibility is what makes "shows"
    // a rendering claim again, not a document one.
    await openRowDisclosure('mock');
    const health = row.querySelector('[data-runtime-available]') as HTMLElement;
    await expect.poll(() => health.checkVisibility()).toBe(true);
    expect(row.querySelector('[data-runtime-toggle]')).not.toBeNull();
  });

  it('renders a dash rather than inventing an endpoint for a resolution-less row', async () => {
    const rows = defaultRows();
    rows[1]!.binaryPath = null;
    shell = await mountShell({ at: '/settings', client: client(rows, newCalls()) });

    await expect.poll(() => one('[data-runtime-row="codex"]')).not.toBeNull();
    expect(one('[data-runtime-row="codex"]')?.textContent).toContain('—');
  });
});

suite('AC1 — known: false is rendered as what it is, never as a composed verdict', () => {
  it('never renders the literal "not installed" when the daemon has no route report', async () => {
    const rows = defaultRows();
    shell = await mountShell({
      at: '/settings',
      client: client(rows, newCalls(), { routesKnown: false }),
    });

    await expect.poll(() => one('[data-runtime-row="mock"]')).not.toBeNull();
    await expect
      .poll(() => one('[data-runtime-row="mock"]')?.querySelector('[data-runtime-routes-unknown]'))
      .not.toBeNull();

    for (const row of all<HTMLElement>('[data-panel="providers"] [data-runtime-row]')) {
      // The exact bug this AC forbids: a browser-composed "not installed"
      // standing in for a verdict the daemon never gave.
      expect(row.textContent).not.toContain('not installed');
      expect(row.querySelector('[data-runtime-routes-unknown]')).not.toBeNull();
    }

    // KAR-26.4 — presence in the document is not reachability: the sentence
    // has to actually render once the row's disclosure opens, or the spec
    // above proves only that the words exist somewhere in the DOM.
    await openRowDisclosure('mock');
    const sentence = one('[data-runtime-row="mock"] [data-runtime-routes-unknown]') as HTMLElement;
    await expect.poll(() => sentence.checkVisibility()).toBe(true);
  });

  it('still reads the daemon’s installed/enabled fields honestly from GET /providers', async () => {
    const rows = defaultRows();
    shell = await mountShell({
      at: '/settings',
      client: client(rows, newCalls(), { routesKnown: false }),
    });

    // `GET /providers` is a different producer (`provider_capabilities`) and
    // is unaffected by the boot-time `providerRoots` gap — the mock row is
    // still reported installed and enabled by that route, and the panel still
    // shows its name, path and toggle.
    await expect.poll(() => one('[data-runtime-row="mock"]')).not.toBeNull();
    const row = one('[data-runtime-row="mock"]') as HTMLElement;
    expect(row.textContent).toContain('/opt/bin/deflow-mock-agent');
    expect(row.getAttribute('data-runtime-enabled')).toBe('true');
  });
});

suite('KAR-26.4 — a route report that never arrived is an absence, not a status (AC1)', () => {
  it('renders "unknown", a reason, and no PATH sentence when GET /providers/routes errors', async () => {
    const rows = defaultRows();
    // The daemon answering 503 `daemon_starting` — no report exists, and
    // nothing about this machine's providers has been claimed by anyone.
    shell = await mountShell({
      at: '/settings',
      client: client(rows, newCalls(), { routesStatus: 503 }),
    });

    await expect.poll(() => one('[data-runtime-row="mock"]')).not.toBeNull();
    const chip = () =>
      one('[data-panel="providers"] [data-runtime-row="mock"] .ui-chip') as HTMLElement | null;
    // Never "unreported" — that word is documented as "the report carried no
    // row for this provider", a claim about a report that does not exist
    // here. "unknown" is the honest absence.
    await expect.poll(() => chip()?.textContent?.trim()).toBe('unknown');

    // The known:false sentence claims the daemon booted without PATH — a
    // different fact nobody checked. It must not render for a failed fetch.
    expect(one('[data-runtime-routes-unknown]')).toBeNull();

    // The failure itself is surfaced, not swallowed.
    const alert = one('[data-panel="providers"] [data-runtime-routes-error]') as HTMLElement;
    expect(alert).not.toBeNull();
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('503');

    // And the disclosure carries a sentence backing the chip's word.
    await openRowDisclosure('mock');
    const absence = one(
      '[data-runtime-row="mock"] [data-runtime-routes-unavailable]',
    ) as HTMLElement;
    expect(absence).not.toBeNull();
    await expect.poll(() => absence.checkVisibility()).toBe(true);
  });

  it('handles a rejected fetch the same way, with no unhandled rejection', async () => {
    const rows = defaultRows();
    const rejections: PromiseRejectionEvent[] = [];
    const record = (event: PromiseRejectionEvent) => rejections.push(event);
    window.addEventListener('unhandledrejection', record);
    try {
      shell = await mountShell({
        at: '/settings',
        client: client(rows, newCalls(), { routesReject: true }),
      });

      await expect.poll(() => one('[data-runtime-row="mock"]')).not.toBeNull();
      const chip = () =>
        one('[data-panel="providers"] [data-runtime-row="mock"] .ui-chip') as HTMLElement | null;
      await expect.poll(() => chip()?.textContent?.trim()).toBe('unknown');
      expect(one('[data-runtime-routes-unknown]')).toBeNull();
      expect(one('[data-panel="providers"] [data-runtime-routes-error]')).not.toBeNull();

      // Give any stray rejection a macrotask to reach the listener.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rejections).toHaveLength(0);
    } finally {
      window.removeEventListener('unhandledrejection', record);
    }
  });
});

suite('AC2 — Rescan calls the daemon’s doctor and re-renders from its result, once', () => {
  it('does not start a second request while one is in flight', async () => {
    const rows = defaultRows();
    const calls = newCalls();
    const gate = doctorGate();
    shell = await mountShell({
      at: '/settings',
      client: client(rows, calls, { holdDoctorUntil: gate.wait }),
    });
    await expect.poll(() => one('[data-runtime-rescan]')).not.toBeNull();

    const button = one('[data-runtime-rescan]') as HTMLButtonElement;
    // The first, real user click, with the request left open.
    await userEvent.click(button);
    await expect.poll(() => calls.doctorPost).toBe(1);

    // The second, while the first is in flight: a real `<button disabled>`
    // refuses a simulated user gesture outright (Playwright will not click an
    // inert element), which is `rescanning`'s guard doing its job one layer
    // down from the assertion below — so this reaches for the DOM's own
    // `.click()`, the same call a stray double-fired event handler or a
    // synthetic re-dispatch would make, to prove the *component* refuses the
    // second call rather than relying on the browser refusing the gesture.
    button.click();

    gate.release();
    await expect.poll(() => button.disabled).toBe(false);
    // Still one — the second click never left this tab.
    expect(calls.doctorPost).toBe(1);

    // A settled third click, after the first round-trip, is a second rescan —
    // never folded into the first, and never blocked forever either.
    await userEvent.click(button);
    await expect.poll(() => calls.doctorPost).toBe(2);
  });

  it('is disabled while the request is outstanding', async () => {
    const rows = defaultRows();
    const gate = doctorGate();
    shell = await mountShell({
      at: '/settings',
      client: client(rows, newCalls(), { holdDoctorUntil: gate.wait }),
    });
    await expect.poll(() => one('[data-runtime-rescan]')).not.toBeNull();

    const button = one('[data-runtime-rescan]') as HTMLButtonElement;
    await userEvent.click(button);
    await expect.poll(() => button.disabled || button.textContent?.includes('…')).toBeTruthy();
    gate.release();
  });
});

suite('AC3 — disabling is one fact both the toggle and the health line move with', () => {
  it('re-reads the shared manifest and the routes sentence after a toggle', async () => {
    const rows = defaultRows();
    const calls = newCalls();
    shell = await mountShell({ at: '/settings', client: client(rows, calls) });

    await expect.poll(() => one('[data-runtime-row="mock"] [data-runtime-toggle]')).not.toBeNull();
    const toggle = one('[data-runtime-row="mock"] [data-runtime-toggle]') as HTMLElement;
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    await userEvent.click(toggle);

    await expect.poll(() => calls.patches).toEqual([{ provider: 'mock', enabled: false }]);
    // AC3 — the same one fact, read back two ways: the toggle itself, and the
    // health sentence `providerVerdict`'s new disabled branch composes.
    await expect
      .poll(() =>
        one('[data-runtime-row="mock"] [data-runtime-toggle]')?.getAttribute('aria-checked'),
      )
      .toBe('false');
    await expect
      .poll(() => one('[data-runtime-row="mock"]')?.textContent)
      .toContain('disabled in Settings');
    expect(one('[data-runtime-row="mock"]')?.getAttribute('data-runtime-enabled')).toBe('false');
  });
});

suite('AC4 — a detected runtime cannot be removed', () => {
  it('offers disable only, and says why in one sentence, on every row', async () => {
    const rows = defaultRows();
    shell = await mountShell({ at: '/settings', client: client(rows, newCalls()) });

    // Scoped to the panel: `AppRail.vue`'s own RUNTIMES glance uses the same
    // `data-runtime-row` attribute (as a bare boolean) for its unrelated
    // read-only list, so an unscoped query over the whole shell would count
    // both.
    const panel = '[data-panel="providers"]';
    await expect.poll(() => all(`${panel} [data-runtime-row]`).length).toBe(2);
    for (const row of all<HTMLElement>(`${panel} [data-runtime-row]`)) {
      expect(row.querySelector('[data-runtime-cannot-remove]')).not.toBeNull();
    }
    // No remove control anywhere on the panel — there is nothing here that
    // could ever be `source: 'added'` (see the panel's own header comment).
    expect(one(`${panel} [data-runtime-remove]`)).toBeNull();
    const remover = all(`${panel} button`).find((button) =>
      /remove|delete/i.test(button.textContent ?? ''),
    );
    expect(remover).toBeUndefined();
  });
});

suite(
  'AC7 — a not-installed runtime shows the install command, never a button that runs it',
  () => {
    it('renders the command verbatim with a copy control', async () => {
      const rows = defaultRows();
      shell = await mountShell({ at: '/settings', client: client(rows, newCalls()) });

      await expect
        .poll(() => one('[data-runtime-row="codex"] [data-runtime-install]'))
        .not.toBeNull();
      const install = one('[data-runtime-row="codex"] [data-runtime-install]') as HTMLElement;
      expect(install.querySelector('code')?.textContent).toBe('npm install -g @openai/codex');
      expect(install.querySelector('[data-runtime-copy-install]')).not.toBeNull();
    });

    it('copies the daemon’s own command, unmodified, to the clipboard', async () => {
      await commands.grantClipboard();
      const rows = defaultRows();
      shell = await mountShell({ at: '/settings', client: client(rows, newCalls()) });

      await expect.poll(() => one('[data-runtime-copy-install]')).not.toBeNull();
      // KAR-26.4 — updated step, named for the story notes: the install block
      // lives in the row's disclosure now, so the disclosure is opened before
      // the copy control is clicked. The clipboard assertion itself is
      // unchanged.
      await openRowDisclosure('codex');
      await userEvent.click(one('[data-runtime-copy-install]') as HTMLElement);

      await expect.poll(() => navigator.clipboard.readText()).toBe('npm install -g @openai/codex');
    });

    it('paints the command chip on a surface distinct from the disclosure body, both themes', async () => {
      // KAR-26.4 — the disclosure body is `--surface-inset`; a command chip
      // that paints the same token on it stops being an inset chip and reads
      // as a bare outline. The claim is a computed one: the two backgrounds
      // must actually differ once the disclosure is open.
      const rows = defaultRows();
      shell = await mountShell({ at: '/settings', client: client(rows, newCalls()) });

      await expect
        .poll(() => one('[data-runtime-row="codex"] [data-runtime-install]'))
        .not.toBeNull();
      await openRowDisclosure('codex');

      const command = one('[data-runtime-row="codex"] .runtime__command') as HTMLElement;
      const body = command.closest('.ui-disclosure__body') as HTMLElement;
      await expect.poll(() => command.checkVisibility()).toBe(true);
      try {
        for (const theme of ['light', 'dark'] as const) {
          document.documentElement.classList.toggle('dark', theme === 'dark');
          expect(getComputedStyle(command).backgroundColor, theme).not.toBe(
            getComputedStyle(body).backgroundColor,
          );
        }
      } finally {
        document.documentElement.classList.remove('dark');
      }
    });

    it('has no button on the whole settings page that would run an install', async () => {
      const rows = defaultRows();
      shell = await mountShell({ at: '/settings', client: client(rows, newCalls()) });

      await expect
        .poll(() => one('[data-runtime-row="codex"] [data-runtime-install]'))
        .not.toBeNull();

      // Assert the absence over the whole page, the way `connectors.test.ts`
      // asserts the absence of a token field — not just inside this one row.
      const labels = all('button').map((button) => button.textContent?.trim().toLowerCase() ?? '');
      expect(labels.some((label) => label === 'install' || label === 'run')).toBe(false);
      expect(labels.every((label) => label !== 'npm install -g @openai/codex')).toBe(true);
    });
  },
);

suite('KAR-26.4 / EPIC-26-S23 — a runtime row is one row', () => {
  it('shows tile, name, mono subline, status chip and toggle in the row, with no visible prose', async () => {
    const rows = defaultRows();
    shell = await mountShell({ at: '/settings', client: client(rows, newCalls()) });

    await expect.poll(() => one('[data-runtime-row="mock"]')).not.toBeNull();
    const row = one('[data-runtime-row="mock"]') as HTMLElement;

    // The row's five cells.
    expect(row.querySelector('.ui-icon-tile')).not.toBeNull();
    expect(row.querySelector('h3')?.textContent).toBe('mock');
    expect(row.querySelector('[data-runtime-subline]')?.textContent).toContain(
      '/opt/bin/deflow-mock-agent',
    );
    expect(row.querySelectorAll('.ui-chip')).toHaveLength(1);
    expect(row.querySelector('[data-runtime-toggle]')).not.toBeNull();
    expect(row.querySelector('.ui-disclosure__trigger')).not.toBeNull();

    // The demoted prose is in the document (the facts never leave it) but not
    // rendered while the disclosure is closed.
    await expect.poll(() => row.querySelector('[data-runtime-available]')).not.toBeNull();
    const health = row.querySelector('[data-runtime-available]') as HTMLElement;
    expect(health.checkVisibility()).toBe(false);
    const caveat = row.querySelector('[data-runtime-cannot-remove]') as HTMLElement;
    expect(caveat.checkVisibility()).toBe(false);
  });
});

suite('KAR-26.4 / EPIC-26-S24 — the full health sentence is one disclosure away, verbatim', () => {
  it('opens to the daemon’s own sentence, word for word', async () => {
    const rows = defaultRows();
    shell = await mountShell({ at: '/settings', client: client(rows, newCalls()) });

    await expect
      .poll(() => one('[data-runtime-row="mock"] [data-runtime-available]'))
      .not.toBeNull();
    await openRowDisclosure('mock');

    const health = one('[data-runtime-row="mock"] [data-runtime-available]') as HTMLElement;
    await expect.poll(() => health.checkVisibility()).toBe(true);
    // The fixture's exact string — not a substring of it.
    expect(health.textContent?.trim()).toBe('"mock" resolves and answered the handshake.');
  });
});

suite('KAR-26.4 / EPIC-26-S25 — the state word renders, painted by the token it claims', () => {
  /** Word → the token `runtime-state.ts` maps its tone to. */
  const EXPECTED: readonly { provider: string; word: string; token: string }[] = [
    { provider: 'mock', word: 'ready', token: '--state-passed' },
    { provider: 'gemini', word: 'partial', token: '--state-blocked' },
    { provider: 'codex', word: 'unusable', token: '--state-blocked' },
    { provider: 'claude', word: 'disabled', token: '--ink-muted' },
  ];

  function wordRows(): RuntimeFixture[] {
    return [
      {
        provider: 'mock',
        installed: true,
        version: '1.0.0',
        binaryPath: '/opt/bin/mock',
        enabled: true,
        action: null,
        acp: 'available',
      },
      {
        provider: 'gemini',
        installed: true,
        version: '2.0.0',
        binaryPath: '/opt/bin/gemini',
        enabled: true,
        action: null,
        acp: 'missing',
      },
      {
        provider: 'codex',
        installed: false,
        version: null,
        binaryPath: null,
        enabled: true,
        action: 'npm install -g @openai/codex',
      },
      {
        provider: 'claude',
        installed: true,
        version: '3.0.0',
        binaryPath: '/opt/bin/claude',
        enabled: false,
        action: null,
      },
    ];
  }

  it('maps ready / partial / unusable / disabled from the daemon’s own fields, in both themes', async () => {
    shell = await mountShell({ at: '/settings', client: client(wordRows(), newCalls()) });

    const chip = (provider: string) =>
      one(`[data-panel="providers"] [data-runtime-row="${provider}"] .ui-chip`) as HTMLElement;

    await expect.poll(() => chip('mock')).not.toBeNull();
    try {
      for (const theme of ['light', 'dark'] as const) {
        document.documentElement.classList.toggle('dark', theme === 'dark');
        for (const { provider, word, token } of EXPECTED) {
          expect(chip(provider).textContent?.trim(), `${provider} in ${theme}`).toBe(word);
          expect(chip(provider).getAttribute('data-runtime-state')).toBe(word);
          // EPIC-26-S30 — the chip resolves, through the live cascade, to the
          // token its tone claims, rather than to a second hard-coded value.
          expect(getComputedStyle(chip(provider)).color, `${provider} in ${theme}`).toBe(
            tokenColour(token),
          );
        }
      }
    } finally {
      document.documentElement.classList.remove('dark');
    }
  });

  it('renders "unknown" — never a verdict — when the daemon has no route report at all', async () => {
    shell = await mountShell({
      at: '/settings',
      client: client(defaultRows(), newCalls(), { routesKnown: false }),
    });

    const chip = () =>
      one('[data-panel="providers"] [data-runtime-row="mock"] .ui-chip') as HTMLElement | null;
    await expect.poll(() => chip()?.textContent?.trim()).toBe('unknown');
    expect(getComputedStyle(chip() as HTMLElement).color).toBe(tokenColour('--ink-muted'));
  });
});

suite('KAR-26.4 / EPIC-26-S26 — detected-cannot-be-removed lives in the disclosure', () => {
  it('is not rendered closed, and is rendered verbatim open', async () => {
    const rows = defaultRows();
    shell = await mountShell({ at: '/settings', client: client(rows, newCalls()) });

    await expect
      .poll(() => one('[data-runtime-row="mock"] [data-runtime-cannot-remove]'))
      .not.toBeNull();
    const caveat = one('[data-runtime-row="mock"] [data-runtime-cannot-remove]') as HTMLElement;

    expect(caveat.checkVisibility()).toBe(false);

    await openRowDisclosure('mock');
    await expect.poll(() => caveat.checkVisibility()).toBe(true);
    expect(caveat.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Detected on this machine — DeFlow can disable it here but not remove it. Removing a ' +
        'runtime DeFlow can still see installed would misreport what is actually on this machine.',
    );
  });
});
