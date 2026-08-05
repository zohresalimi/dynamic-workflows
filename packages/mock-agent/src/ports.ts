/**
 * The three things a pathological turn does that an ACP frame cannot express:
 * write raw bytes past the transport, end the process, and leave children
 * behind.
 *
 * They are ports rather than direct calls so that `scripted.ts` stays a
 * description of a turn and the process-level effects live in one place a
 * reader can find. It is also the only way `exit` can be reasoned about at
 * all: a function typed `never` that really is `process.exit` in the binary.
 *
 * **Raw writes go through the same `Writable` the transport wraps**, never
 * through `fs.writeSync(1, …)`. `acp.ndJsonStream` writes through
 * `Writable.toWeb(process.stdout)`, whose writer resolves once Node's write
 * callback has fired; a raw write issued after that promise lands therefore
 * lands after those bytes. A second, independent fd handle would reorder the
 * stream under load, and a malformed line that arrived *before* the frame it
 * was supposed to follow would test something nobody scripted.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';

export interface MockAgentPorts {
  /** Writes bytes verbatim, resolving once they have been flushed. */
  writeRaw(text: string): Promise<void>;
  /** Ends the process now. */
  exit(code: number): never;
  /**
   * Starts a process that outlives the agent, returning its pid.
   *
   * It stays in the agent's process group and takes no stdio, so it neither
   * holds the agent's pipes open nor escapes the group kill DeFlowd aims at
   * the pid it recorded.
   */
  spawnGrandchild(lifetimeMs: number): number;
}

export function createProcessPorts(stdout: NodeJS.WritableStream = process.stdout): MockAgentPorts {
  return {
    writeRaw: (text) =>
      new Promise((resolve, reject) => {
        stdout.write(text, (error) => {
          if (error === null || error === undefined) resolve();
          else reject(error);
        });
      }),
    exit: (code) => process.exit(code),
    spawnGrandchild: (lifetimeMs) => {
      const child = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${lifetimeMs})`], {
        stdio: 'ignore',
        detached: false,
      });
      child.unref();
      return child.pid ?? -1;
    },
  };
}
