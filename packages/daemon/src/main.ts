/**
 * DeFlowd's entry point — run directly, as TypeScript, by `node`.
 *
 * There is no build step in the dev loop: `packages/*`'s `exports` point at
 * `./src/index.ts`, so `node packages/daemon/src/main.ts` resolves live source
 * across package boundaries. That is only possible because `erasableSyntaxOnly`
 * bans every construct that would need a runtime emit (D4).
 *
 * `pnpm dev` runs this under `node --watch`, so every save kills and restarts
 * it. That is the point, not a nuisance: it is free, continuous, adversarial
 * testing of F4.2 crash-resume. Do not "fix" it with a reloader that preserves
 * process state — see docs/03-local-development.md §5.
 */

import { DaemonAlreadyRunning } from '@DeFlow/ledger';
import { randomBytes } from 'node:crypto';
import { type Booted, boot, EX_ALREADY_RUNNING } from './boot.ts';
import { systemClock } from './clock.ts';
import { resolveDataDir } from './data-dir.ts';
import { NonLoopbackBindRefused } from './http/auth.ts';
import { DEFAULT_PORT } from './http/server.ts';
import { log } from './logging.ts';
import { BOOT_ID, BUILD } from './meta.ts';
import { createLiveRunChain } from './pipeline/live-chain.ts';
import { createLiveRunExecution } from './pipeline/live-nodes.ts';
import { checkSchemaRegistry, EX_CONFIG } from './preflight.ts';
import { probeProvidersOnBoot } from './providers/boot-probe.ts';
import { pathRoots } from './providers/detect.ts';

const daemon = log.child({ mod: 'daemon' });

function port(): number {
  const configured = Number(process.env.DeFlow_PORT);
  return Number.isInteger(configured) && configured >= 0 ? configured : DEFAULT_PORT;
}

/** Six lowercase hex characters for the boot probe's synthetic run id — the
 * same source `boot.ts` and `up.ts` use, for the same reason: unique, never
 * reproducible. */
const randomHex = (): string => randomBytes(3).toString('hex');

/**
 * This process's environment, which under `pnpm dev` is the developer's own —
 * read here and handed down, never re-derived deeper in (§4.3).
 *
 * Bound once rather than written at each call site because a bare
 * `env: process.env` inside `packages/daemon/src` is the shape
 * `packages/daemon/test/no-inline-child-env.test.ts` forbids, and it is right
 * to forbid it: the daemon's own environment reaching a child is a decision,
 * and a composition root is the only place it may be taken. `up.ts` names it
 * the same way for the same reason.
 */
const daemonEnv = process.env;

// Before anything binds and long before a ledger is opened: an event kind
// whose upcaster chain has a hole cannot be read at all, and finding that out
// mid-replay is finding it out at the worst possible moment (EPIC-02-S21).
// It reads a static table in memory — it opens nothing, spawns nothing and
// binds nothing, so it does not belong inside the lease.
const schemas = checkSchemaRegistry();
if (!schemas.ok) {
  daemon.error(
    { kind: schemas.kind, version: schemas.version },
    `DeFlowd cannot start: ${schemas.message}`,
  );
  process.exit(EX_CONFIG);
}

// KAR-19.3 — the chain, bound in the second composition root.
//
// `deflow up` is the production one and binds the same two ports; this is the
// daemon `pnpm dev` runs under `node --watch`, and a dev daemon whose runs park
// at the framing wake is a dev loop that cannot see the bug this epic exists to
// remove. It runs in the developer's own terminal, so reading their `PATH` here
// is correct for exactly the reason it is correct in `up.ts` — and nowhere
// else.
//
// KAR-26.2 — which is the same argument `boot()`'s own `providerRoots` and
// `probeProviders` are ports for, so this file answers those too, below. It
// held for the chain and not for the boot options for one release, and the
// daemon a developer actually runs was the one daemon that could not say what
// the machine has: `known: false` on the picker, no `admit` on intake, and a
// composer telling its author to start the daemon they were already running.
// `test/machine-identity-boot-options.test.ts` is what keeps the two roots
// answering the same set.

// Handed the environment rather than letting it default to `process.env`
// inside: same answer, but re-deriving it deeper in is the thing §4.3 and the
// note on `daemonEnv` above both rule out, and `up.ts` already passes its own.
const dataDir = resolveDataDir(daemonEnv);
const chain = createLiveRunChain({
  dataDir,
  clock: systemClock,
  providerRoots: pathRoots(daemonEnv),
  daemonEnv,
});
const execution = createLiveRunExecution({
  dataDir,
  clock: systemClock,
  providerRoots: pathRoots(daemonEnv),
  daemonEnv,
});

let started: Booted;
try {
  started = await boot({
    dataDir,
    port: port(),
    runFraming: chain.runFraming,
    advanceRun: chain.advanceRun,
    executeNodes: execution.executeNodes,
    // KAR-26.2 AC1 — the machine, told to `boot()` the way `up.ts` tells it:
    // the roots admission resolves against, and the probe that fills the
    // manifest the picker and the settings rows read. Both are built from this
    // process's own environment on the strength of the paragraph above, and on
    // nothing else.
    //
    // One artifact to expect on a cold data directory: `probeProvidersOnBoot`
    // mints a synthetic run id for its ledger sink, and that projects as a run
    // parked at "submitted — waiting to be framed" which never advances — there
    // is no `node_wake` behind it. `deflow up` has always produced it; wiring
    // the probe here is what makes it visible to a developer who only runs
    // `pnpm dev`. It is not the framing bug this epic exists to remove, and it
    // is the row most likely to be mistaken for it.
    providerRoots: pathRoots(daemonEnv),
    probeProviders: ({ db, dataDir: dir }) =>
      probeProvidersOnBoot({
        db,
        clock: systemClock,
        dataDir: dir,
        env: daemonEnv,
        randomHex,
      }),
    ...(process.env.DeFlow_HOST === undefined ? {} : { hostname: process.env.DeFlow_HOST }),
    // KAR-15.2 AC12 — the explicit flag, and the only way past loopback.
    // `DeFlow_HOST` on its own is not enough on purpose: naming an address is
    // not the same as accepting what serving the control plane on it means
    // (docs/15-security-model.md §3.3).
    allowNonLoopback: process.env.DeFlow_ALLOW_NON_LOOPBACK === '1',
  });
} catch (error) {
  if (error instanceof NonLoopbackBindRefused) {
    process.stderr.write(`${error.message}\n`);
    process.exit(EX_CONFIG);
  }
  if (error instanceof DaemonAlreadyRunning) {
    // One sentence on stderr, and nothing else: this is the "I ran `deflow up`
    // in two terminals" case (KAR-03.7 AC2), and a stack trace here is the
    // failure. It is written directly rather than logged because a JSON log
    // line is not what a user reads in a terminal.
    process.stderr.write(`${error.message}\n`);
    process.exit(EX_ALREADY_RUNNING);
  }
  throw error;
}

daemon.info(
  { bootId: BOOT_ID, build: BUILD, pid: process.pid, epoch: started.epoch },
  'DeFlowd up',
);

// KAR-15.2 AC7 — the first-run handoff, on stdout rather than through the
// logger, for the same reason `DaemonAlreadyRunning` is: this is the one line
// a human reads and clicks, and a JSON log line is not that. The token is in
// the **fragment**, so navigating it sends nothing to the server — and it must
// never be logged, because a log line is exactly the place §8.1 exists to keep
// it out of.
process.stdout.write(`${started.url}\n`);

let stopping = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  daemon.info({ signal }, 'DeFlowd stopping');

  // node --watch spawns the replacement as soon as this process is gone, so the
  // port has to be released promptly or the next life fails with EADDRINUSE.
  //
  // Through the Clock port rather than a bare `setTimeout` (KAR-06.6 AC1): the
  // daemon owns exactly one timer, in clock.ts, and everything that waits goes
  // through it or is a `node_wake` row. `systemClock.setTimer` already
  // `unref()`s, so this deadline cannot be the reason DeFlowd stays alive.
  systemClock.setTimer(2_000, () => process.exit(0));

  // Port, then ledger, then lease: the next daemon may only get in once this
  // one has stopped writing.
  await started.shutdown();
  process.exit(0);
}

process.on('SIGTERM', (signal) => void shutdown(signal));
process.on('SIGINT', (signal) => void shutdown(signal));
