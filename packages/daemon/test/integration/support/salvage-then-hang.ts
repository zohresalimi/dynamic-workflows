/**
 * A daemon life that starts KAR-07.4's salvage sequence and stops dead between
 * the `workspace.dirty_on_remove` append and the salvage commit.
 *
 * It exists so EPIC-07-S17's crash scenario is a **real** crash: a separate
 * process, `SIGKILL`ed with no handler and no flush, leaving behind only what
 * SQLite had already committed and whatever git had already done. Simulating
 * the crash in-process would leave the runner's own memory — and its open
 * database handle — intact, and the property under test is precisely that
 * `--force` is unreachable from a life that ended before the commit.
 *
 * The pause is injected at the `git` port, which is the same seam the specs
 * already record argv through: the first `add` invocation writes the ready file
 * and then never resolves. That is exactly "after the capture is durable and
 * before the commit", with no clock, no timer and nothing faked.
 *
 * argv: <dataDir> <repo> <worktreePath> <runId> <nodeId> <branch> <readyFile>
 */
import { openLedger } from '@DeFlow/ledger';
import { writeFileSync } from 'node:fs';
import process from 'node:process';
import { Git } from '../../../src/git/git.ts';
import { WorkspaceManager } from '../../../src/git/worktree-manager.ts';
import { systemClock } from '../../../src/index.ts';

const [dataDir, repo, path, runId, nodeId, branch, readyFile] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

const wrapped = new Git(repo);
const db = openLedger(dataDir);

const manager = new WorkspaceManager({
  git: {
    async run(args, opts) {
      if (args[0] === 'add') {
        // Committed and visible to any other connection from here on: the
        // capture is durable, the commit has not started.
        writeFileSync(readyFile, 'about to commit');
        // Wait to be killed. No handler: SIGKILL is the point.
        await new Promise(() => {});
      }
      return wrapped.run(args, opts);
    },
  },
  db,
  clock: systemClock,
  epoch: 1,
});

await manager.remove({ runId, nodeId, path, branch });
