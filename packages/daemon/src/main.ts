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

import { DEFAULT_HOSTNAME, DEFAULT_PORT, startHttp } from './http/server.ts';
import { log } from './logging.ts';
import { BOOT_ID, BUILD } from './meta.ts';

const daemon = log.child({ mod: 'daemon' });

function port(): number {
  const configured = Number(process.env.DeFlow_PORT);
  return Number.isInteger(configured) && configured >= 0 ? configured : DEFAULT_PORT;
}

const started = await startHttp({
  port: port(),
  hostname: process.env.DeFlow_HOST ?? DEFAULT_HOSTNAME,
});

daemon.info({ bootId: BOOT_ID, build: BUILD, pid: process.pid }, 'DeFlowd up');

let stopping = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  daemon.info({ signal }, 'DeFlowd stopping');

  // node --watch spawns the replacement as soon as this process is gone, so the
  // port has to be released promptly or the next life fails with EADDRINUSE.
  const hardExit = setTimeout(() => process.exit(0), 2_000);
  hardExit.unref();

  await started.close();
  process.exit(0);
}

process.on('SIGTERM', (signal) => void shutdown(signal));
process.on('SIGINT', (signal) => void shutdown(signal));
