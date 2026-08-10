/**
 * KAR-15.2 test plan #9 — the browser half of the first-run handoff.
 *
 * Verifies: EPIC-15-S12 (scenario 3) · AC8
 *
 * Browser, in a real Chromium, because the three things being asserted are
 * three real browser objects: `location.hash`, `sessionStorage` and the
 * history entry `history.replaceState` rewrites. A jsdom stand-in would agree
 * with an implementation that never touched any of them.
 */
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { createClient } from './client.ts';
import { acquireToken, clearToken, readToken, TOKEN_STORAGE_KEY } from './token.ts';

const TOKEN = 'CFqL3n_Ov6dRk8QpYt2wZs1xJ4mHb7uE9aTgN0cVpRs';

beforeEach(() => {
  clearToken();
  history.replaceState(null, '', location.pathname + location.search);
});

afterEach(() => {
  clearToken();
  history.replaceState(null, '', location.pathname + location.search);
});

suite('the UI exchanges the fragment once (AC8)', () => {
  it('reads #token= into sessionStorage and leaves the address bar clean', () => {
    history.replaceState(null, '', `${location.pathname}#token=${TOKEN}`);
    expect(location.hash).not.toBe('');

    const acquired = acquireToken();

    expect(acquired).toBe(TOKEN);
    expect(sessionStorage.getItem(TOKEN_STORAGE_KEY)).toBe(TOKEN);
    // The address bar no longer carries it, so it is not in the history entry,
    // not in a bookmark, and not in whatever the user pastes into a bug report.
    expect(location.hash).toBe('');
    expect(location.href).not.toContain(TOKEN);
  });

  it('keeps working after the fragment is gone, which is every request after the first', () => {
    history.replaceState(null, '', `${location.pathname}#token=${TOKEN}`);
    acquireToken();

    // A reload, a route change, a second component asking: the fragment was
    // consumed, and `sessionStorage` is what answers from here on.
    expect(acquireToken()).toBe(TOKEN);
    expect(readToken()).toBe(TOKEN);
  });

  it('is sessionStorage rather than localStorage, so the token dies with the tab', () => {
    history.replaceState(null, '', `${location.pathname}#token=${TOKEN}`);
    acquireToken();

    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('answers null when there is neither a fragment nor a stored token', () => {
    expect(acquireToken()).toBeNull();
    expect(readToken()).toBeNull();
  });

  it('ignores a fragment that is not a token, and does not clobber a stored one', () => {
    history.replaceState(null, '', `${location.pathname}#token=${TOKEN}`);
    acquireToken();

    history.replaceState(null, '', `${location.pathname}#/runs/r_01JXQ`);
    expect(acquireToken()).toBe(TOKEN);
    // A route fragment is the UI's own, and consuming it would break routing.
    expect(location.hash).toBe('#/runs/r_01JXQ');
  });
});

suite('what the client does with it (AC8)', () => {
  it('sends it as an Authorization header, and never in the URL', async () => {
    history.replaceState(null, '', `${location.pathname}#token=${TOKEN}`);
    acquireToken();

    const calls: { url: string; headers: Headers }[] = [];
    const rpc = createClient({
      baseUrl: 'http://127.0.0.1:7777/api',
      token: readToken,
      fetch: (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: typeof input === 'string' ? input : input.toString(),
          headers: new Headers(init?.headers),
        });
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
    });

    await rpc.health.$get();

    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.url).not.toContain(TOKEN);
    expect(calls[0]?.url).not.toContain('token=');
  });
});
