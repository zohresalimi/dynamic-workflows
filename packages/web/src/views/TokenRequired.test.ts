/**
 * KAR-16.1 — the tab that arrived without a token.
 *
 * Verifies: EPIC-16-S2 (scenario 3) · AC3
 *
 * `sessionStorage` is **per tab**, so this is not a corner case: it is what the
 * operator's second tab, and every bookmark of `http://127.0.0.1:7777/`, looks
 * like every single time.
 *
 * AC3 names three things it must not be, and all three are asserted as
 * negatives here because all three *look* like a broken daemon and get a
 * working daemon restarted:
 *
 * - not a spinner — no `progressbar`, no `aria-busy`;
 * - not a blank page — the instruction naming `deflow up` is on screen;
 * - not a 401 loop — **no request is made at all**, which is the only version
 *   of "no loop" that cannot be satisfied by retrying slowly.
 */
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { type MountedShell, mountShell } from '../../test/shell.ts';
import { readToken, TOKEN_STORAGE_KEY } from '../api/token.ts';

let shell: MountedShell;
let requested: string[];
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  requested = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    requested.push(typeof input === 'string' ? input : input.toString());
    return realFetch(input as RequestInfo, init);
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  shell?.unmount();
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
});

suite('AC3 — a tokenless tab says what to do about it', () => {
  beforeEach(async () => {
    shell = await mountShell({ anonymous: true });
  });

  it('names the command that prints the URL', () => {
    const text = shell.container.textContent ?? '';

    expect(text).toContain('deflow up');
    expect(text).toMatch(/paste/i);
    expect(text).toContain('#token=');
  });

  it('renders no spinner and no busy state', () => {
    expect(shell.container.querySelector('[role="progressbar"]')).toBeNull();
    expect(shell.container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('is not a blank page', () => {
    expect((shell.container.textContent ?? '').trim().length).toBeGreaterThan(40);
    expect(shell.container.querySelector('h1')).not.toBeNull();
  });

  it('makes no request at all, so there is nothing to loop on', async () => {
    // Give anything that was going to fire a turn to fire in.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(requested).toEqual([]);
  });

  it('mounts no view behind the gate', () => {
    // The router is on the landing route; the plan graph is deliberately not
    // rendered, because a view that mounted here would be the thing issuing the
    // request the previous assertion just banned.
    expect(shell.container.querySelector('[aria-label="Plan graph"]')).toBeNull();
  });
});

suite('AC3 — pasting the URL is the way out, and it never leaves the tab', () => {
  beforeEach(async () => {
    shell = await mountShell({ anonymous: true });
  });

  it('takes the token out of a pasted handoff URL and renders the app', async () => {
    const field = shell.container.querySelector<HTMLInputElement>('#token-required-url');
    const form = shell.container.querySelector('form');
    if (field === null || form === null) throw new Error('the paste form must exist');

    field.value = 'http://127.0.0.1:7777/#token=Ab0_-cd12';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(readToken()).toBe('Ab0_-cd12');
    // KAR-19.1 AC5 — the root route is the run list now, not a plan graph with
    // no run. What this line asserts is unchanged: the token got the operator
    // out of the gate and into the application.
    expect(shell.container.querySelector('[data-run-list]')).not.toBeNull();

    // The pasted URL is read, never requested: a fragment is not sent to a
    // server, and this one must not become the first one that is.
    expect(requested.some((url) => url.includes('token'))).toBe(false);
  });

  it('says so when the pasted URL carries no token', async () => {
    const field = shell.container.querySelector<HTMLInputElement>('#token-required-url');
    const form = shell.container.querySelector('form');
    if (field === null || form === null) throw new Error('the paste form must exist');

    field.value = 'http://127.0.0.1:7777/';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(shell.container.querySelector('[role="alert"]')?.textContent).toContain('#token=');
    expect(readToken()).toBeNull();
  });
});
