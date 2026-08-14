/**
 * KAR-16.5 AC8 — `pnpm dev:replay`, and the entry point `deflow replay` will
 * call once EPIC-18 owns the binary.
 *
 * Run directly, as TypeScript, by `node` — the same way `../main.ts` is, and
 * for the same reason: `packages/*`'s `exports` point at `./src/index.ts`, so
 * there is no build step between a save and a running daemon
 * (docs/03-local-development.md §5). Under `node --watch` every save kills and
 * restarts this process; the browser reconnects over the SSE `retry: 2000` it
 * was given at open, and the recording plays again from the top into a fresh
 * data directory. **The browser session survives; the daemon does not, and is
 * not meant to.**
 *
 * Two lines on stdout and nothing else: the handoff URL (token in the fragment,
 * never in a log line) and what is being replayed. Everything else is the
 * daemon's own structured log.
 */
import process from 'node:process';
import { systemClock } from '../clock.ts';
import { log } from '../logging.ts';
import { BadReplayArgv, parseReplayArgv, resolveFixture } from './cli.ts';
import { type ReplayHarness, startReplay } from './harness.ts';
import { BadSpeed } from './speed.ts';

const replay = log.child({ mod: 'replay' });

let command;
try {
  command = parseReplayArgv(process.argv.slice(2));
} catch (error) {
  if (error instanceof BadReplayArgv || error instanceof BadSpeed) {
    process.stderr.write(`${error.message}\n`);
    process.exit(64); // EX_USAGE
  }
  throw error;
}

let fixture: string;
try {
  fixture = resolveFixture(command.fixture);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(66); // EX_NOINPUT
}

const harness: ReplayHarness = await startReplay({
  fixture,
  speed: command.speed,
  port: command.port,
  dev: command.dev,
  startPaused: command.paused,
  ...(command.dataDir === undefined ? {} : { dataDir: command.dataDir }),
});

process.stdout.write(`${harness.url}\n`);
process.stdout.write(
  `replaying ${fixture} — ${String(harness.recorded)} events, ` +
    `${String(harness.runIds.length)} run(s), head seq ${String(harness.headSeq)}\n`,
);

// Not awaited: the recording plays while the process serves, and a fixture that
// has been played out is a daemon that goes on answering — which is the whole
// point of `--speed max` for styling a finished state.
void harness
  .played()
  .then(() => replay.info({ headSeq: harness.headSeq }, 'the recording has been played out'))
  .catch((error: unknown) => replay.error({ err: error }, 'playback stopped early'));

let stopping = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  replay.info({ signal }, 'deflow replay stopping');

  // `node --watch` spawns the replacement as soon as this process is gone, so
  // the port has to be released promptly or the next life fails with
  // EADDRINUSE. Through the Clock port rather than a bare setTimeout, as
  // ../main.ts does (KAR-06.6 AC1).
  systemClock.setTimer(2_000, () => process.exit(0));

  await harness.close();
  process.exit(0);
}

process.on('SIGTERM', (signal) => void shutdown(signal));
process.on('SIGINT', (signal) => void shutdown(signal));
