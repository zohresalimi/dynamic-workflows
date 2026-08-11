/**
 * KAR-16.1 AC2 — the bootstrap token, end to end: a real DeFlowd serving a real
 * built SPA, opened by a real Chromium at the URL `DeFlow up` prints.
 *
 * Verifies: EPIC-16-S2 (scenarios 1, 2 and 4) · AC2, AC3
 *
 * The unit and browser specs next door assert the halves — `token.test.ts` that
 * the fragment is read and stripped, `src/app/shell-boot.test.ts` that the
 * first request carries the header. Neither can see what an *actual browser*
 * puts on the wire, and the claim AC2 makes is exactly that: **the token
 * appears in no URL the browser ever sends**. That is a statement about every
 * request a page made, including the ones nobody wrote — the document, its
 * modules, its stylesheets — and it can only be checked by watching the
 * network from outside the page.
 *
 * So this spec records every request Chromium issues and asserts over all of
 * them. It also asserts the `Referer` half of §8.1's argument: a `Referer`
 * carrying the token cannot exist, because the token was never in a URL.
 *
 * Serving is the **built** SPA, not Vite in middleware mode: production is the
 * shape where a mistake here is permanent, and the dev loop is already covered
 * end to end by `dev-loop.test.ts`.
 *
 * The build goes into `packages/daemon/src/http/ui/`, which is where
 * `server.ts` resolves `./ui/` to when the daemon is run from source — the same
 * relative path that lands on `dist/ui` in the published tarball. It is
 * git-ignored and removed afterwards; a spec that pointed somewhere else would
 * be exercising a path production does not take.
 */
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';
import {
  type DaemonProcess,
  freePort,
  makeDataDir,
  removeDataDir,
  repoRoot,
  spawnDaemon,
  waitForHealth,
} from './support/daemon.ts';

interface Sent {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly referer: string | undefined;
}

let daemon: DaemonProcess;
let dataDir: string;
let browser: Browser;
let token: string;

/** Where `packages/daemon/src/http/server.ts` resolves `./ui/` to from source. */
const UI_DIR = join(repoRoot, 'packages/daemon/src/http/ui');

function buildUi(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['node_modules/vite/bin/vite.js', 'build', '--outDir', UI_DIR, '--emptyOutDir'],
      {
        cwd: `${repoRoot}packages/web`,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`vite build exited ${code}\n${output}`)),
    );
  });
}

/** A page that records every request it makes, before any navigation. */
async function watchedPage(): Promise<{ page: Page; sent: Sent[] }> {
  const sent: Sent[] = [];
  const page = await browser.newPage();
  page.on('request', (request) => {
    const headers = request.headers();
    sent.push({
      url: request.url(),
      authorization: headers['authorization'],
      referer: headers['referer'],
    });
  });
  return { page, sent };
}

beforeAll(async () => {
  await buildUi();
  dataDir = await makeDataDir();
  daemon = spawnDaemon({ dataDir, port: await freePort() });
  await waitForHealth(daemon);
  token = daemon.token();
  browser = await chromium.launch();
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await daemon?.stop();
  if (dataDir !== undefined) await removeDataDir(dataDir);
  await rm(UI_DIR, { recursive: true, force: true });
});

suite('EPIC-16-S2 — the URL DeFlow up prints', () => {
  it('stores the token, strips the fragment, and sends it as a header', async () => {
    const { page, sent } = await watchedPage();
    try {
      await page.goto(`${daemon.origin}/#token=${token}`);

      // The tab holds it, for this tab only.
      await expect
        .poll(() => page.evaluate<string | null>("sessionStorage.getItem('DeFlow.daemonToken')"))
        .toBe(token);

      // And the address bar does not: `history.replaceState`, so it is not one
      // Back away either.
      // Evaluated as source text rather than as a closure: this file compiles
      // with Node's libs and has no DOM types, and a `// @ts-expect-error` over
      // a closure would suppress every other mistake inside it too.
      expect(await page.evaluate<string>('location.hash')).toBe('');
      expect(await page.evaluate<string>('location.href')).not.toContain(token);

      // At least one subsequent request carried it as a header. The shell's own
      // first call is GET /api/approvals.
      await expect
        .poll(() => sent.filter((one) => one.authorization === `Bearer ${token}`).length)
        .toBeGreaterThan(0);
      expect(sent.some((one) => one.url.includes('/api/approvals'))).toBe(true);
    } finally {
      await page.close();
    }
  });

  it('puts the token in no URL the browser ever sends, and in no Referer', async () => {
    const { page, sent } = await watchedPage();
    try {
      await page.goto(`${daemon.origin}/#token=${token}`);
      await expect.poll(() => sent.length).toBeGreaterThan(3);

      // Every request the page made, not only the ones the app wrote: the
      // document, its modules, its stylesheet and its API calls.
      for (const request of sent) {
        expect(request.url, `${request.url} carries the token`).not.toContain(token);
        expect(request.referer ?? '').not.toContain(token);
      }
    } finally {
      await page.close();
    }
  });

  it('leaves 127.0.0.1 for nothing at all', async () => {
    const { page, sent } = await watchedPage();
    try {
      await page.goto(`${daemon.origin}/#token=${token}`);
      await expect.poll(() => sent.length).toBeGreaterThan(3);

      for (const request of sent) {
        expect(new URL(request.url).hostname, `${request.url} left the loopback`).toBe('127.0.0.1');
      }
    } finally {
      await page.close();
    }
  });
});

suite('EPIC-16-S2 — a second tab opened without the fragment (AC3)', () => {
  it('renders the paste-the-URL state, and makes no API request to loop on', async () => {
    const { page, sent } = await watchedPage();
    try {
      await page.goto(`${daemon.origin}/`);
      await page.waitForLoadState('networkidle');

      const text = await page.textContent('body');
      expect(text).toContain('DeFlow up');
      expect(text).toMatch(/paste/i);

      // Not a spinner, not a blank page, and — the one that matters — not a
      // 401 loop: no authenticated route was called at all.
      expect(await page.locator('[role="progressbar"]').count()).toBe(0);
      const api = sent.filter(
        (one) => one.url.includes('/api/') && !one.url.includes('/api/health'),
      );
      expect(api).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
