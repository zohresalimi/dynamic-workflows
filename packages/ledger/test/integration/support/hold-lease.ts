/**
 * A real second process that holds the single-instance lease and sits there.
 *
 * A real process, not a second `acquireLease` in the test's own process: the
 * lease is a lock the operating system holds on a file descriptor, and the
 * whole claim under test — that the kernel drops it when the holder dies, with
 * no cleanup and no stale pid file — is one a same-process test cannot make.
 *
 * argv[2] is the data directory. It reports its pid over the fork IPC channel
 * once the lease is held, then waits to be killed. The timer is a backstop so
 * an abandoned child cannot outlive the suite.
 */
import { acquireLease } from '../../../src/index.ts';

const dataDir = process.argv[2];
if (dataDir === undefined) throw new Error('usage: hold-lease.ts <dataDir>');

const lease = acquireLease(dataDir);
process.send?.({ pid: lease.pid, file: lease.file });

// Never reached in a passing run — the parent kills this process. 60 s is
// twice the integration slice's timeout, so it cannot mask a hang either.
setTimeout(() => {
  lease.release();
}, 60_000);
