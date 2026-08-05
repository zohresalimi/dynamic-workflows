/**
 * A process that takes the lease and then deliberately drops every reference
 * to it, keeping only the pid — then runs the garbage collector on request.
 *
 * This is not a contrived caller. `boot()` returns a `Booted` object and the
 * daemon's own shutdown path is the only thing holding the `Lease`; anything
 * that stores `lease.pid` for a log line and lets the object go, or a future
 * refactor that returns `{ pid, file }` instead of the lease itself, produces
 * exactly this shape. If the kernel lock lives only as long as a JavaScript
 * object stays reachable, the lease is not held "for the lifetime of the
 * process" (AC1) — it is held until V8 next feels like collecting.
 *
 * argv[2] is the data directory. Requires `--expose-gc`.
 */
import { acquireLease } from '../../../src/index.ts';

const dataDir = process.argv[2];
if (dataDir === undefined) throw new Error('usage: drop-lease.ts <dataDir>');

// The returned Lease is unreferenced from here on, on purpose.
const pid = acquireLease(dataDir).pid;
process.send?.({ pid });

process.on('message', (message) => {
  if (message !== 'collect') return;
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc === undefined) throw new Error('drop-lease.ts needs --expose-gc');
  // Twice, with a turn of the loop between: a napi finalizer is queued by the
  // collection that finds the object, not run inside it.
  gc();
  setTimeout(() => {
    gc();
    setTimeout(() => process.send?.('collected'), 50);
  }, 50);
});

// Backstop, so an abandoned child cannot outlive the suite.
setTimeout(() => process.exit(9), 60_000);
