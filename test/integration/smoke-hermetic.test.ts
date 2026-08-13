/**
 * KAR-19.5 AC3 / EPIC-19-S35 — the smoke scenario's child environment, asserted
 * rather than trusted.
 *
 * A smoke test that quietly depends on the developer's machine is a smoke test
 * that goes red for the first colleague and is then disabled, which is a slower
 * version of not having one. So the environment is asserted against **the same
 * function the scenario runs with** — `smokeChildEnv` — rather than against a
 * copy of it here, and the `*_API_KEY` / `*_TOKEN` clause is checked as a
 * *shape* over every entry rather than as a list of names somebody has to
 * remember to extend.
 *
 * The one clause that cannot be settled from an object is *"no outbound socket
 * is opened"*, and it is not asserted here by inspection: `smokeChildEnv` puts
 * a `--import` hook on `NODE_OPTIONS` that refuses and records any connection
 * to a non-loopback address, and the smoke scenario itself asserts the
 * recording is empty. What this spec adds is that the hook is *wired* — an
 * assertion that would fail the day someone removes it and leaves the empty
 * array passing vacuously.
 *
 * Verifies: EPIC-19-S35 · KAR-19.5 AC3 · test plan #3
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import { GIT_DIR, smokeChildEnv, smokePath } from '../../e2e/smoke/support/harness.ts';
import { PROVIDER_SPECS } from '../../packages/adapters/src/index.ts';

const TMP = '/tmp/DeFlow-smoke-fixture';
const BIN = join(TMP, 'bin');

const env = smokeChildEnv({
  tmp: TMP,
  binDir: BIN,
  netLog: join(TMP, 'outbound.log'),
  netGuard: join(TMP, 'net-guard.mjs'),
});

/** Every binary the registry names for a provider that is not bundled — the
 * vendor CLI and its ACP bridge alike, read out of `PROVIDER_SPECS` rather
 * than written down, so a provider added later is covered. */
function vendorBinaries(): readonly string[] {
  const names = new Set<string>();
  for (const spec of Object.values(PROVIDER_SPECS)) {
    if (spec.bundled === true) continue;
    names.add(spec.bin);
    names.add(spec.shim.bin);
  }
  return [...names].toSorted();
}

suite('EPIC-19-S35 — no vendor CLI, no credential, no network, no home touched', () => {
  it('carries no credential-shaped variable of any kind', () => {
    const credentials = Object.keys(env).filter(
      (name) => name.endsWith('_API_KEY') || name.endsWith('_TOKEN') || name.endsWith('_KEY'),
    );
    expect(credentials).toEqual([]);
  });

  it('is built from nothing rather than from the developer’s own environment', () => {
    // The allowlist is the whole set, so a variable nobody thought of cannot be
    // inherited. Stated as a bound on the *size* as well as the shape: an
    // environment that had quietly grown a spread of `process.env` would pass
    // every name-based check above and fail here.
    expect(Object.keys(env).length).toBeLessThan(20);
    expect(env.PATH).toBe(smokePath(BIN));
  });

  it('resolves its data directory inside the scenario’s own tmpdir', () => {
    // `resolveDataDir` answers `$XDG_DATA_HOME/DeFlow`, so this is the clause
    // that keeps the run's ledger out of `~/.DeFlow` — and `HOME` is inside the
    // tmpdir too, so even a component that ignored XDG cannot reach the
    // developer's home directory.
    expect(env.XDG_DATA_HOME).toBe(join(TMP, 'xdg'));
    expect(env.HOME).toBe(join(TMP, 'home'));
    expect(env.TMPDIR).toBe(join(TMP, 'tmp'));
    expect(env.DeFlow_DATA_DIR).toBeUndefined();
  });

  it('gives git /dev/null configuration and a forced identity', () => {
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null');
    expect(env.GIT_AUTHOR_NAME).toBe('DeFlow smoke');
    expect(env.GIT_AUTHOR_EMAIL).toBe('smoke@example.com');
    expect(env.GIT_COMMITTER_NAME).toBe('DeFlow smoke');
    expect(env.GIT_COMMITTER_EMAIL).toBe('smoke@example.com');
  });

  it('puts the bundled agent, node and git on PATH and nothing else', () => {
    const dirs = smokePath(BIN).split(':');
    expect(dirs[0]).toBe(BIN);
    expect(dirs).toHaveLength(3);
    expect(dirs).toContain(GIT_DIR);

    // The clause that carries the scenario: no vendor CLI resolves anywhere on
    // it. Asserted against the machine this is running on, so a laptop with a
    // real adapter installed cannot make the smoke test pass for that
    // adapter's reason instead of this story's.
    const found = dirs.flatMap((dir) =>
      vendorBinaries()
        .filter((bin) => existsSync(join(dir, bin)))
        .map((bin) => join(dir, bin)),
    );
    expect(found, 'a vendor agent CLI resolves on the smoke PATH').toEqual([]);
  });

  it('wires the network guard that makes “no outbound socket” a test', () => {
    // The scenario asserts the guard's log is empty; this asserts the guard is
    // there, so the empty log cannot be empty because nothing was watching.
    expect(env.NODE_OPTIONS).toBe(`--import ${join(TMP, 'net-guard.mjs')}`);
    expect(env.DeFlow_SMOKE_NETLOG).toBe(join(TMP, 'outbound.log'));
  });
});
