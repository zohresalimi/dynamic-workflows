/**
 * KAR-15.2 AC9 / test plan #12 — the token never travels in a query string.
 *
 * Verifies: EPIC-15-S13 (scenarios 1 and 3) · AC9
 *
 * > A token in a URL query string ends up in shell history, terminal
 * > scrollback, browser history, the `Referer` header of any outbound link, and
 * > any access log anyone ever adds.
 *
 * A grep rather than a runtime assertion because the failure it guards is a
 * *shortcut*: the day somebody reaches for native `EventSource` — which cannot
 * send headers — the query string is where the token goes, and every runtime
 * test in this repository would still pass. The third suite is the reason that
 * shortcut stays unavailable: the dependency that makes headers possible is
 * declared, and the two libraries that would force the query string are not.
 */
import { expect, it, describe as suite } from 'vitest';
import {
  checkNoTokenInUrl,
  type Manifest,
  type PackageJson,
  describe as render,
} from './support/guards.ts';
import { allWorkspaceSources, packageDirs, parseJsonc, readText } from './support/workspace.ts';

const sources = allWorkspaceSources();

const manifests: Manifest[] = ['.', ...packageDirs()].map((dir) => ({
  path: dir === '.' ? 'package.json' : `${dir}/package.json`,
  json: parseJsonc<PackageJson>(readText(dir === '.' ? 'package.json' : `${dir}/package.json`)),
}));

suite('no source file puts a credential in a URL (AC9, scenario 1)', () => {
  it('finds no query parameter carrying a token anywhere in the workspace', () => {
    expect(sources.length).toBeGreaterThan(0);
    expect(render(checkNoTokenInUrl(sources))).toBe('');
  });

  it('would catch the query-string shortcut in each of the shapes it arrives in', () => {
    // A grep that has never matched anything passes for ever. These are the
    // three ways this actually gets written.
    const violating = [
      { path: 'a.ts', text: 'const url = `${base}/api/stream?token=${token}`;' },
      { path: 'b.ts', text: "const url = base + '/api/stream?runs=' + runs + '&t=' + token;" },
      { path: 'c.ts', text: "url.searchParams.set('access_token', token);" },
    ];
    for (const file of violating) {
      expect(checkNoTokenInUrl([file]), file.path).toHaveLength(1);
    }
  });

  it('does not object to the fragment form, which is the whole point', () => {
    // `#token=` is the handoff (AC7). Fragments are never sent to the server,
    // so a guard that banned the string "token=" outright would ban the
    // correct implementation along with the wrong one.
    expect(
      checkNoTokenInUrl([
        { path: 'ok.ts', text: 'return `http://127.0.0.1:${port}/#token=${token}`;' },
      ]),
    ).toEqual([]);
  });

  it('does not object to the query parameters the stream actually takes', () => {
    expect(
      checkNoTokenInUrl([
        { path: 'ok.ts', text: "const url = `/api/stream?runs=${ids.join(',')}&since=${seq}`;" },
      ]),
    ).toEqual([]);
  });
});

suite('the client library that makes headers possible (scenario 3)', () => {
  it('is declared, because native EventSource cannot send one', () => {
    const declared = manifests.flatMap((manifest) =>
      Object.keys({ ...manifest.json.dependencies, ...manifest.json.devDependencies }),
    );
    expect(declared).toContain('eventsource-client');
  });

  it('and neither abandoned alternative is', () => {
    for (const manifest of manifests) {
      const deps = { ...manifest.json.dependencies, ...manifest.json.devDependencies };
      // `@microsoft/fetch-event-source` was last published 2.0.1 on
      // 2021-04-25, and `eventsource` is a spec-faithful polyfill that
      // therefore *inherits* the no-headers limitation its own README points
      // at `eventsource-client` to escape.
      expect(Object.keys(deps), manifest.path).not.toContain('@microsoft/fetch-event-source');
      expect(Object.keys(deps), manifest.path).not.toContain('eventsource');
    }
  });
});

suite('the bootstrap document no longer describes the query-string handoff', () => {
  it('docs/03-local-development.md prints the fragment form', () => {
    // The architecture documents disagreed here and this story is where it was
    // resolved: §9 step 8 described a one-time `?t=` token, while
    // docs/11 §8 and docs/15 §3.2 both specify the fragment and both list "put
    // the daemon token in a query string" under what *not* to do. Until that
    // line was corrected, a reader who started from the bootstrap document
    // would have implemented the wrong one — which is why the correction is
    // asserted rather than remembered.
    const bootstrap = readText('docs/03-local-development.md');

    expect(bootstrap).toContain('#token=');
    expect(bootstrap).not.toMatch(/\?t=/);
    expect(bootstrap).not.toMatch(/\?token=/);
  });
});
