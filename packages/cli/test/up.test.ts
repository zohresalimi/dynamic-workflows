/**
 * KAR-18.2 — the parts of `DeFlow up` that are argv, wording and a `PATH`
 * lookup, and therefore have no business booting a daemon to be tested.
 *
 * The three suites are the three things an operator meets before anything is
 * running: what the flags mean, what the refusal says, and which program gets
 * handed the URL. The fourth is AR-1's grep, which is a guard rather than a
 * test of behaviour — see the comment above it.
 *
 * Verifies: EPIC-18-S7, EPIC-18-S8, EPIC-18-S10 · AC1, AC2, AC3, AC9 ·
 * test plan #8
 */
import { expect, it, describe as suite } from 'vitest';
import { checkNoCredentialReads, describe as render } from '../../../test/support/guards.ts';
import { readSources } from '../../../test/support/workspace.ts';
import { browserCommand } from '../src/open-browser.ts';
import {
  alreadyRunningMessage,
  parseUpArgs,
  renderTimings,
  UP_STEPS,
  type UpStepTiming,
} from '../src/up.ts';

suite('DeFlow up argv (AC1, AC2, AC4)', () => {
  it('defaults to the runbook behaviour: pick a port, open a browser, print no timings', () => {
    const parsed = parseUpArgs([]);

    expect(parsed).toEqual({ ok: true, args: { port: null, timings: false, open: true } });
  });

  it('takes --port in both spellings', () => {
    expect(parseUpArgs(['--port', '8080'])).toEqual({
      ok: true,
      args: { port: 8080, timings: false, open: true },
    });
    expect(parseUpArgs(['--port=8080'])).toEqual({
      ok: true,
      args: { port: 8080, timings: false, open: true },
    });
  });

  it('takes --timings and --no-open', () => {
    expect(parseUpArgs(['--timings', '--no-open'])).toEqual({
      ok: true,
      args: { port: null, timings: true, open: false },
    });
  });

  it('refuses a --port that is not a port, naming what it got', () => {
    for (const bad of ['abc', '-1', '70000', '']) {
      const parsed = parseUpArgs(['--port', bad]);
      expect(parsed.ok, bad).toBe(false);
      if (!parsed.ok) expect(parsed.message).toContain('--port');
    }
  });

  it('refuses an unknown flag rather than ignoring it', () => {
    const parsed = parseUpArgs(['--detach']);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toContain('--detach');
  });
});

suite('the eight boot steps --timings reports (AC2)', () => {
  it('are eight, because §9 of the runbook has eight and the budget is per step', () => {
    expect(UP_STEPS).toHaveLength(8);
    expect(new Set(UP_STEPS).size).toBe(8);
  });

  it('renders one line per step plus a total, in milliseconds', () => {
    const timings: UpStepTiming[] = UP_STEPS.map((step, index) => ({ step, ms: index }));

    const rendered = renderTimings(timings, 1234);

    for (const step of UP_STEPS)
      expect(rendered).toMatch(new RegExp(`^\\s+${step}\\s+\\d+ ms$`, 'm'));
    expect(rendered).toMatch(/^\s+total\s+1234 ms$/m);
  });
});

suite('the second DeFlow up refusal (AC3, EPIC-18-S8)', () => {
  it('names the live pid and port, the URL to open, and the command to run', () => {
    expect(alreadyRunningMessage({ pid: 4711, port: 7777 })).toBe(
      'DeFlow up: another DeFlowd is already running (pid 4711, port 7777) — open ' +
        "http://127.0.0.1:7777 or run 'DeFlow status'",
    );
  });

  it('carries no token, because the URL a refusal prints goes into scrollback', () => {
    expect(alreadyRunningMessage({ pid: 4711, port: 7777 })).not.toContain('#token=');
  });

  it('degrades honestly when the daemon file says nothing about the port', () => {
    const message = alreadyRunningMessage({ pid: 4711, port: null });

    expect(message).toContain('pid 4711');
    expect(message).toContain("run 'DeFlow status'");
    // No invented URL: a port nobody read is not a port anyone can open.
    expect(message).not.toContain('http://127.0.0.1:null');
  });
});

suite('which program gets the URL (AC1)', () => {
  const url = 'http://127.0.0.1:7777/#token=abc';

  it('is the platform opener on each platform', () => {
    expect(browserCommand(url, { platform: 'darwin', env: {} })).toEqual({
      command: 'open',
      args: [url],
    });
    expect(browserCommand(url, { platform: 'linux', env: {} })).toEqual({
      command: 'xdg-open',
      args: [url],
    });
    expect(browserCommand(url, { platform: 'win32', env: {} })).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', url],
    });
  });

  it('is $BROWSER when the operator set one, on any platform', () => {
    expect(
      browserCommand(url, { platform: 'darwin', env: { BROWSER: '/usr/bin/firefox' } }),
    ).toEqual({ command: '/usr/bin/firefox', args: [url] });
  });

  it('is nothing at all when $BROWSER is the conventional "do not open"', () => {
    expect(browserCommand(url, { platform: 'linux', env: { BROWSER: 'none' } })).toBeNull();
  });
});

/**
 * AR-1 (AC9), test plan #8 — a grep rather than a runtime assertion, because
 * the failure it guards is a *shortcut*: somebody forwards `ANTHROPIC_API_KEY`
 * into the daemon's own environment "so agents inherit it", or reads
 * `~/.claude/.credentials.json` to show a nicer status line. Every runtime test
 * in this repository would still pass.
 *
 * The file list is explicit rather than an import-graph walk. `boot()` reaches
 * the whole daemon through `./http/api.ts`, and modules that legitimately
 * *detect* a shadowing credential without reading it (KAR-08.8's
 * `proc/auth-shadow.ts`) live down there; a transitive scan would either flag
 * them or be softened until it flagged nothing. These are the modules
 * `DeFlow up` is assembled from — the ones this story wrote or changed — and
 * they are the ones where the shortcut would be taken.
 *
 * The runtime half is in `e2e/up.test.ts`: a credentials file at mode 000 that
 * a booting daemon must not trip over.
 */
suite('DeFlow up reads no credential (AC9, test plan #8)', () => {
  const BOOT_MODULES = [
    'packages/cli/src/up.ts',
    'packages/cli/src/open-browser.ts',
    'packages/cli/src/bin.ts',
    'packages/daemon/src/boot.ts',
    'packages/daemon/src/http/pick-port.ts',
    'packages/daemon/src/providers/boot-probe.ts',
    'packages/daemon/src/providers/detect.ts',
    'packages/daemon/src/daemon-file.ts',
    'packages/daemon/src/data-dir.ts',
  ];

  it('opens no credential file and forwards no provider key', () => {
    const sources = readSources(BOOT_MODULES);

    expect(sources).toHaveLength(BOOT_MODULES.length);
    expect(render(checkNoCredentialReads(sources))).toBe('');
  });

  it('would catch each of the shapes the shortcut arrives in', () => {
    const violating = [
      { path: 'a.ts', text: 'const key = process.env.ANTHROPIC_API_KEY;' },
      { path: 'b.ts', text: 'env: { ...process.env, OPENAI_API_KEY: key },' },
      { path: 'c.ts', text: "readFileSync(join(homedir(), '.claude', '.credentials.json'))" },
      { path: 'd.ts', text: "const authed = readFileSync(`${home}/.codex/auth.json`, 'utf8');" },
      { path: 'e.ts', text: "const gh = process.env.GITHUB_TOKEN ?? '';" },
    ];

    for (const file of violating) {
      expect(checkNoCredentialReads([file]), file.path).toHaveLength(1);
    }
  });

  it("does not object to DeFlow's own daemon token, which is not a vendor credential", () => {
    expect(
      checkNoCredentialReads([
        { path: 'ok.ts', text: 'const token = mintDaemonToken();\nreturn `#token=${token}`;' },
      ]),
    ).toEqual([]);
  });
});
