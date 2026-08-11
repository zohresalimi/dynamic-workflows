/**
 * KAR-16.4 AC10 — the query half of the state split
 * (docs/12-frontend-architecture.md §3.4).
 *
 * Verifies: EPIC-16-S25 (the boundary), KAR-16.4 AC10
 *
 * > If the answer changes because an event was appended, it is a **projection**;
 * > if it changes because a file on disk changed, it is a **query**.
 *
 * Three endpoints are on the query side of that line in this build, and each
 * one is the same shape of fact: what this machine *has*. Which provider
 * binaries are installed and what they can do. What the workspace config file
 * says. The bytes behind a content-addressed artifact — which cannot change at
 * all, because the address is the hash of the content.
 *
 * The tests below are about the **keys and the fetchers**, not about Colada:
 * caching, staleness and refetching are the library's, they are tested by the
 * library, and a spec that re-proved them here would be asserting a
 * dependency's behaviour through two layers of indirection. What is ours is
 * which URL each key resolves to, that an artifact's key includes its sha (or
 * two artifacts share a cache entry), and that the key namespace contains
 * nothing whose answer an appended event would change.
 */
import { expect, it, describe as suite } from 'vitest';
import { API_BASE, type Asked } from '../../test/three-patches.ts';
import { createClient } from './client.ts';
import {
  artifactQuery,
  configQuery,
  providersQuery,
  QUERY_KEY_ROOTS,
  SANCTIONED_QUERY_PATHS,
} from './queries.ts';

/** A `fetch` that records the URL and answers with a stated body. */
function recordingFetch(asked: string[], body: unknown, contentType = 'application/json') {
  return (input: string | URL | Request): Promise<Response> => {
    asked.push(typeof input === 'string' ? input : input.toString());
    const text = contentType === 'application/json' ? JSON.stringify(body) : String(body);
    return Promise.resolve(
      new Response(text, { status: 200, headers: { 'content-type': contentType } }),
    );
  };
}

const clientOver = (asked: string[], body: unknown, contentType?: string) =>
  createClient({ baseUrl: API_BASE, fetch: recordingFetch(asked, body, contentType) });

suite('AC10 — the three file-shaped reads are queries', () => {
  it('asks /providers, under a key that names it', async () => {
    const asked: string[] = [];
    const query = providersQuery(clientOver(asked, [{ provider: 'claude', installed: true }]));

    const answer = await query.query();

    expect(query.key).toEqual(['providers']);
    expect(asked).toEqual([`${API_BASE}/providers`]);
    expect(answer).toEqual([{ provider: 'claude', installed: true }]);
  });

  it('asks /config for a named workspace, and keys on the workspace', async () => {
    const asked: string[] = [];
    const query = configQuery(clientOver(asked, { cwd: '/w', config: {} }), '/w');

    await query.query();

    expect(query.key).toEqual(['config', '/w']);
    expect(asked[0]).toContain('/config?cwd=%2Fw');
  });

  it('keys an artifact on its sha, so two artifacts are two cache entries', async () => {
    const asked: string[] = [];
    const sha = 'a'.repeat(64);
    const other = 'b'.repeat(64);

    const query = artifactQuery(clientOver(asked, 'hello', 'text/plain'), sha);
    const answer = await query.query();

    expect(query.key).toEqual(['artifacts', sha]);
    expect(artifactQuery(clientOver([], '', 'text/plain'), other).key).toEqual([
      'artifacts',
      other,
    ]);
    expect(asked).toEqual([`${API_BASE}/artifacts/${sha}`]);
    expect(answer).toBe('hello');
  });

  it('reports a failure rather than caching an error body as an answer', async () => {
    const client = createClient({
      baseUrl: API_BASE,
      fetch: () => Promise.resolve(new Response('nope', { status: 503 })),
    });

    await expect(providersQuery(client).query()).rejects.toThrow(/503/);
  });
});

suite('AC10 — and nothing whose answer an appended event changes is one', () => {
  it('namespaces every key under a sanctioned root', () => {
    const roots = [
      providersQuery(clientOver([], [])).key[0],
      configQuery(clientOver([], {}), '/w').key[0],
      artifactQuery(clientOver([], ''), 'c'.repeat(64)).key[0],
    ];

    for (const root of roots) expect(QUERY_KEY_ROOTS).toContain(root);
  });

  it('sanctions only paths that change because a file changed', () => {
    // The list is the rule's own data, and `test/ui-foundation.test.ts` is what
    // enforces it across the package. Asserted here too so that adding a root
    // is a deliberate two-file edit rather than a quiet one.
    expect([...SANCTIONED_QUERY_PATHS].toSorted()).toEqual([
      '/api/artifacts/:sha',
      '/api/config',
      '/api/providers',
      '/api/runs',
    ]);
    expect(QUERY_KEY_ROOTS).not.toContain('events');
    expect(QUERY_KEY_ROOTS).not.toContain('snapshot');
    expect(QUERY_KEY_ROOTS).not.toContain('plans');
  });
});
