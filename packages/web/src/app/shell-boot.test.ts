/**
 * KAR-16.1 — what the shell does on the first frame of an authenticated tab.
 *
 * Verifies: EPIC-16-S2 (scenario 1, the "subsequent authenticated request"
 * line) · AC2
 *
 * The shell makes exactly one request of its own, and it is
 * `GET /api/approvals` — *"everything waiting on the Operator, across every
 * run, in one call"*. That endpoint's own reason for existing is the shell's:
 * **"I never discover a nine-hour run that has been blocked since hour two
 * because I was looking at a different tab"**, which is a claim about the
 * chrome around the views rather than about any one of them.
 *
 * It is also the request AC2 hangs off: the fragment handoff is only proved
 * end to end by a *subsequent* call carrying `Authorization: Bearer <t>`, and a
 * shell that made none would leave that clause with no subject. The full
 * end-to-end version, against a real daemon and a real browser, is
 * `e2e/ui-bootstrap.test.ts`; this file asserts the client half.
 */
import { afterEach, expect, it, describe as suite } from 'vitest';
import { type MountedShell, mountShell, TEST_TOKEN } from '../../test/shell.ts';
import { createClient } from '../api/client.ts';

interface Sent {
  readonly url: string;
  readonly authorization: string | null;
}

let shell: MountedShell;

/** A `fetch` that answers the approvals queue and records what it was sent. */
function approvalsDaemon(sent: Sent[], items: number) {
  return (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers(init?.headers ?? {});
    sent.push({ url, authorization: headers.get('authorization') });

    if (url.includes('/approvals')) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            items: Array.from({ length: items }, (_unused, index) => ({
              runId: `run_${index}`,
              kind: 'human',
              seq: index + 1,
            })),
            counts: { total: items },
            headSeq: 42,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  };
}

afterEach(() => shell?.unmount());

suite('AC2 — the first authenticated request carries the bearer token', () => {
  it('asks for the approval queue, with the header and never with a query parameter', async () => {
    const sent: Sent[] = [];
    shell = await mountShell({
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: approvalsDaemon(sent, 2),
        token: () => TEST_TOKEN,
      }),
    });

    await expect.poll(() => sent.length).toBeGreaterThan(0);

    const approvals = sent.filter((one) => one.url.includes('/approvals'));
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    // The whole reason `eventsource-client` is a dependency and the handoff is
    // a fragment: the token is a header, and appears in no URL at all.
    expect(sent.every((one) => !one.url.includes(TEST_TOKEN))).toBe(true);
  });

  it('renders how many things are waiting on the operator', async () => {
    const sent: Sent[] = [];
    shell = await mountShell({
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: approvalsDaemon(sent, 3),
        token: () => TEST_TOKEN,
      }),
    });

    const badge = () => shell.container.querySelector('[data-approvals]');
    await expect.poll(() => badge()?.getAttribute('data-approvals')).toBe('3');
    expect(badge()?.textContent).toMatch(/3/);
    // Named, not just numbered: a bare "3" in a toolbar tells a screen reader
    // nothing and an operator not much more.
    expect(badge()?.getAttribute('aria-label')).toMatch(/waiting/i);
  });

  it('says nothing at all when nothing is waiting', async () => {
    const sent: Sent[] = [];
    shell = await mountShell({
      client: createClient({
        baseUrl: 'http://127.0.0.1:7777/api',
        fetch: approvalsDaemon(sent, 0),
        token: () => TEST_TOKEN,
      }),
    });

    await expect.poll(() => sent.length).toBeGreaterThan(0);
    expect(shell.container.querySelector('[data-approvals]')).toBeNull();
  });
});
