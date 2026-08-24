/**
 * KAR-23.10 — a front DeFlow advertises is a front DeFlow serves.
 *
 * The structural anti-regression for a shape that has now bitten three times in
 * one epic. `runShimNode` was built, exported and never called (KAR-23.5). The
 * `tool` performer was built, exported and never called (KAR-23.9).
 * `acpPermissionHandlers`, `acpFsHandlers` and `acpTerminalHandlers` were built,
 * exported and never called — and that third one cost four implementation nodes
 * twenty-two minutes of `-32601` while `CLIENT_CAPABILITIES` told every agent
 * DeFlow served seven client methods.
 *
 * A complete, tested, exported module with no production caller is invisible to
 * every other kind of test in this repository: the unit suite proves the module
 * works, the integration suite proves the pieces compose, and neither of them
 * asks whether anything *ships* calling it. So the guard is mechanical, because
 * the judgement is not reliable at hour three.
 *
 * Three claims, each failing differently if it stops holding:
 *
 *  1. **Every front is composed.** A fourth front added under
 *     `services/fronts/` and left out of the composition root is the next
 *     unreachable module.
 *  2. **The composition root is called from the performer.** This is the exact
 *     regression: `runAcpNode` takes `handlers` as data, and the defect was one
 *     missing property on one object literal.
 *  3. **What the handshake promises, the handlers answer.** Asserted at
 *     runtime, by building the real map and comparing its keys against
 *     `requiredClientMethods(CLIENT_CAPABILITIES)` — no process, no ledger, no
 *     agent. This is the root of the whole defect and the only claim that
 *     catches an advertisement growing a capability nobody wired.
 *
 * Every scan is a pure function over sources handed to it, and every one has a
 * negative spec that feeds it a violating source and watches it catch it — the
 * same shape as `./one-live-chain-caller.test.ts`, and for the same reason: a
 * scan that has never failed is indistinguishable from a scan that cannot.
 *
 * Verifies: KAR-23.10
 */

import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { CLIENT_CAPABILITIES, requiredClientMethods } from '../packages/adapters/src/index.ts';
import { nodeClientHandlers } from '../packages/daemon/src/pipeline/node-mediation.ts';
import { readText } from './support/workspace.ts';

/** The composition root: the one module allowed to know all three fronts. */
const ROOT = 'packages/daemon/src/pipeline/node-mediation.ts';

/** The performer that has to call it. */
const PERFORMER = 'packages/daemon/src/pipeline/live-nodes.ts';

const FRONTS_DIR = fileURLToPath(
  new URL('../packages/daemon/src/services/fronts/', import.meta.url),
);

/**
 * Comments explain the rule; code has to implement it. Every file that
 * documents this wiring writes the names down to document it — this one
 * included.
 */
const code = (text: string): string =>
  text.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/(^|[^:])\/\/[^\n]*/g, '$1');

/** Every `acp*Handlers` factory the fronts directory exports. */
export function frontFactories(sources: readonly { path: string; text: string }[]): string[] {
  return sources
    .flatMap((source) => [...code(source.text).matchAll(/export function (acp\w*Handlers)\b/g)])
    .map((match) => match[1] ?? '')
    .toSorted();
}

/** Whether `text` calls every one of `names`. */
export function uncalled(text: string, names: readonly string[]): string[] {
  const body = code(text);
  return names.filter((name) => !new RegExp(`\\b${name}\\s*\\(`).test(body)).toSorted();
}

const frontSources = readdirSync(FRONTS_DIR)
  .filter((name) => name.startsWith('acp-'))
  .map((name) => ({
    path: `packages/daemon/src/services/fronts/${name}`,
    text: readText(`packages/daemon/src/services/fronts/${name}`),
  }));

// ── (1) every front is composed ──────────────────────────────────────────────

suite('KAR-23.10 — every ACP front has a production caller', () => {
  it('reads the fronts off disk, so an empty result would mean something', () => {
    expect(frontFactories(frontSources)).toEqual([
      'acpFsHandlers',
      'acpPermissionHandlers',
      'acpTerminalHandlers',
    ]);
  });

  it('composes all of them in the one composition root', () => {
    expect(uncalled(readText(ROOT), frontFactories(frontSources))).toEqual([]);
  });

  it('bites when a fourth front is added and left unwired', () => {
    const fourth = [
      ...frontSources,
      {
        path: 'packages/daemon/src/services/fronts/acp-mcp.ts',
        text: 'export function acpMcpHandlers(mcp: McpService) { return {}; }\n',
      },
    ];
    expect(uncalled(readText(ROOT), frontFactories(fourth))).toEqual(['acpMcpHandlers']);
  });

  it('is not fooled by a front named only in prose', () => {
    const prose = '// acpPermissionHandlers(permission) belongs here one day.\n';
    expect(uncalled(prose, ['acpPermissionHandlers'])).toEqual(['acpPermissionHandlers']);
  });
});

// ── (2) the performer passes them ────────────────────────────────────────────

suite('KAR-23.10 — the ACP performer passes handlers to runAcpNode', () => {
  const performer = code(readText(PERFORMER));

  it('calls the composition root', () => {
    expect(uncalled(readText(PERFORMER), ['nodeClientHandlers'])).toEqual([]);
    expect(performer).toContain("from './node-mediation.ts'");
  });

  it('passes the map as the `handlers` port, which is the property that was missing', () => {
    expect(performer).toMatch(/handlers:\s*nodeClientHandlers\(/);
  });

  it('does not re-declare the composition itself', () => {
    // A performer that reached for the fronts directly would satisfy nothing
    // above and would be the second wiring — the one without the escalation
    // service, the scope check, or the `permission.decided` rows.
    for (const factory of frontFactories(frontSources)) {
      expect(performer).not.toContain(`${factory}(`);
    }
  });
});

// ── (3) what was advertised is what is answered ──────────────────────────────

suite('KAR-23.10 — the handlers answer every method the handshake promised', () => {
  it('names the seven, and says which are conditional', () => {
    expect([...requiredClientMethods(CLIENT_CAPABILITIES)].toSorted()).toEqual([
      'fs/read_text_file',
      'fs/write_text_file',
      'session/request_permission',
      'terminal/create',
      'terminal/kill',
      'terminal/output',
      'terminal/release',
      'terminal/wait_for_exit',
    ]);
    // Withdraw the advertisement and the obligation goes with it, on the same
    // edit — which is what makes this a derivation rather than a second list.
    expect(requiredClientMethods({})).toEqual(['session/request_permission']);
  });

  it('builds the real map and finds no method missing from it', () => {
    const handlers = nodeClientHandlers({
      // Nothing below is touched while the map is being built: the ledger is
      // only read when a request is actually mediated, which is why this claim
      // needs no process and no database.
      db: null as never,
      runId: 'run_20260824T143505Z_3a7365' as never,
      epoch: 1,
      clock: { now: () => 0, sleep: () => Promise.resolve(), setTimer: () => ({ cancel() {} }) },
      nodeId: 'n1' as never,
      attempt: 0,
      level: 'worktree',
      worktree: '/tmp/DeFlow-fronts-are-wired/wt',
      pathScopes: ['packages/ui/src/**'],
      scrubbedEnv: [],
      childEnv: {},
    });

    const served = Object.keys(handlers).toSorted();
    const owed = [...requiredClientMethods(CLIENT_CAPABILITIES)].toSorted();
    expect(owed.filter((method) => !served.includes(method))).toEqual([]);
    // And nothing extra: a method served but never advertised is one no agent
    // will ever call, which is its own kind of dead code.
    expect(served).toEqual(owed);
  });
});
