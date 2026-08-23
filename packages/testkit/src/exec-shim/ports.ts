/**
 * The real ports: everything `runExecShim` does to the world outside itself.
 *
 * Kept apart from the runner so the runner can be read as a sequence of
 * decisions, and so the two pieces of process behaviour that are easy to get
 * subtly wrong live somewhere they can be commented:
 *
 * **The write waits for the callback.** `stdout.write` returning `false` means
 * the pipe is full, and a fake that ignored that would either lose the tail of
 * a 10 MB line or exit before it drained. Awaiting the callback is what makes
 * the flood a real backpressure stimulus rather than a memory spike.
 *
 * **The sleepers are not detached.** `detached: false` puts them in the fake
 * agent's own process group, which is the topology the kill fixture needs: a
 * group-kill aimed at the agent must reach them, and a positive-pid kill must
 * not.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import type { ExecShimPorts } from './run.ts';

export function createProcessPorts(): ExecShimPorts {
  return {
    writeOut: (text) =>
      new Promise((resolveWrite, rejectWrite) => {
        process.stdout.write(text, (error) => {
          if (error === null || error === undefined) resolveWrite();
          else rejectWrite(error);
        });
      }),

    writeErr: (text) => {
      process.stderr.write(text);
    },

    env: () => process.env,

    sleep: (ms) =>
      new Promise((done) => {
        setTimeout(done, ms);
      }),

    spawnSleeper: (seconds) => {
      // A real `sleep <n>` — the `sh` replaces itself with it — that has
      // SIGTERM set to SIG_IGN, because POSIX preserves an *ignored*
      // disposition across `exec` while resetting handlers to default.
      //
      // A bare `sleep` would die on the group SIGTERM, and the spec asserting
      // "the group survived SIGTERM" would then be asserting something weaker
      // than it reads: the escalation to SIGKILL is only tested if every member
      // of the tree genuinely survives the first signal.
      const child = spawn('/bin/sh', ['-c', `trap "" TERM; exec sleep ${seconds}`], {
        stdio: 'ignore',
        detached: false,
      });
      // Unreferenced so this process is not held open by them; they still
      // outlive it, which is the whole point.
      child.unref();
      return child.pid ?? -1;
    },

    writeFile: (absolutePath, content) => {
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, content);
    },

    ignoreSigterm: () => {
      // A handler that does nothing is not the same as SIG_IGN: the process
      // stays signalable, `ps` still shows it running, and the escalation to
      // SIGKILL is what ends it — which is exactly the sequence under test.
      process.on('SIGTERM', () => {});
    },

    hangForever: () => {
      // A referenced timer, so the loop has a reason to stay alive with
      // nothing left to do. stdout stays open: a client that saw EOF would
      // call the turn finished rather than observing a wedge.
      setInterval(() => {}, 1 << 30);
    },

    nowMs: () => Date.now(),
    cwd: () => process.cwd(),
    resolvePath: (from, relative) => resolve(from, relative),

    claimSession: (dir, sessionId) => {
      mkdirSync(dir, { recursive: true });
      try {
        // `wx` is the claim: the create fails if the file is there, and it
        // fails in the kernel rather than after a read this process did. Two
        // children racing for one id therefore get one `true` between them,
        // which is the behaviour being impersonated.
        writeFileSync(join(dir, encodeURIComponent(sessionId)), '', { flag: 'wx' });
        return true;
      } catch {
        return false;
      }
    },
  };
}
