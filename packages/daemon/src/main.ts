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
import { type Booted, boot, EX_ALREADY_RUNNING } from './boot.ts';
import { DEFAULT_PORT } from './http/server.ts';
import { log } from './logging.ts';
import { BOOT_ID, BUILD } from './meta.ts';
import { checkSchemaRegistry, EX_CONFIG } from './preflight.ts';

const daemon = log.child({ mod: 'daemon' });

function port(): number {
  const configured = Number(process.env.DeFlow_PORT);
  return Number.isInteger(configured) && configured >= 0 ? configured : DEFAULT_PORT;
}

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

let started: Booted;
try {
  started = await boot({
    port: port(),
    ...(process.env.DeFlow_HOST === undefined ? {} : { hostname: process.env.DeFlow_HOST }),
  });
} catch (error) {
  if (error instanceof DaemonAlreadyRunning) {
    // One sentence on stderr, and nothing else: this is the "I ran `DeFlow up`
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

let stopping = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  daemon.info({ signal }, 'DeFlowd stopping');

  // node --watch spawns the replacement as soon as this process is gone, so the
  // port has to be released promptly or the next life fails with EADDRINUSE.
  const hardExit = setTimeout(() => process.exit(0), 2_000);
  hardExit.unref();

  // Port, then ledger, then lease: the next daemon may only get in once this
  // one has stopped writing.
  await started.shutdown();
  process.exit(0);
}

process.on('SIGTERM', (signal) => void shutdown(signal));
process.on('SIGINT', (signal) => void shutdown(signal));
