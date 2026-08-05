/**
 * A real agent process that writes the git index of a real repository
 * (EPIC-06-S5, scenario 4).
 *
 * It is a separate binary rather than a function the spec calls for the reason
 * docs/14-testing-strategy.md §3.3 gives: mocking the process boundary tests
 * the mock. The claim under test is that two *processes* never touch one git
 * index at the same time, and a promise that resolves in the same event loop
 * cannot contend for `.git/index.lock` the way two `git add`s can.
 *
 * What it does is deliberately the shape of a write agent's turn: create a
 * file, stage it, keep working for a moment, and look at the repository again
 * before finishing. The hold is what turns "two agents were admitted together"
 * from a race that might not reproduce into one that does — a second writer
 * admitted at the same instant is inside this window, and both the porcelain
 * this agent reads back and the wall-clock interval it records will say so.
 *
 * `git` is run through the environment it was **given**: the runner spawns this
 * process with `@DeFlow/testkit`'s `GIT_ENV` already applied and every ambient
 * `GIT_*` stripped, so the developer's own ~/.gitconfig cannot change what
 * `git status --porcelain` prints here. The package root is not imported
 * instead because importing it registers vitest fixtures at module load, and
 * this process is not a vitest worker.
 *
 *   argv[2]  the repository
 *   argv[3]  this node's id — also the file it writes, so the two agents can
 *            never conflict on content and the only thing they contend for is
 *            the index itself
 *   argv[4]  the NDJSON log both agents append to
 *   argv[5]  how long to hold, in ms
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , repoDir, nodeId, logPath, holdText] = process.argv;
if (repoDir === undefined || nodeId === undefined || logPath === undefined) {
  throw new Error('usage: git-writer-agent.ts <repoDir> <nodeId> <logPath> [holdMs]');
}
const holdMs = Number(holdText ?? '250');

interface GitResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const git = (...args: string[]): GitResult => {
  const result = spawnSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  return {
    exitCode: result.status ?? 1,
    stdout: (result.stdout ?? '').trimEnd(),
    stderr: (result.stderr ?? '').trim(),
  };
};

/**
 * One line per observation, appended synchronously.
 *
 * The log is the spec's *observation of the world*, not an inference from the
 * ledger the scheduler wrote: a lock that is computed correctly and then not
 * respected produces a perfectly consistent ledger, and only the timestamps
 * and the porcelain of the processes themselves can contradict it.
 */
const record = (entry: Record<string, unknown>): void => {
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

record({ node: nodeId, phase: 'enter', at: Date.now() });

const file = `${nodeId}.txt`;
writeFileSync(join(repoDir, file), `written by ${nodeId}\n`);

const added = git('add', file);
// Two reads of the same repository with the whole hold between them. Equal
// means nothing else moved the index while this agent held it; different is
// the scenario's "git status --porcelain between them is stable" failing.
const before = git('status', '--porcelain');
await sleep(holdMs);
const after = git('status', '--porcelain');

record({
  node: nodeId,
  phase: 'exit',
  at: Date.now(),
  add: { exitCode: added.exitCode, stderr: added.stderr },
  porcelainBefore: before.stdout,
  porcelainAfter: after.stdout,
});

// A non-zero exit is how `.git/index.lock` contention reaches the spec: git
// refuses the second concurrent `add` rather than corrupting anything, and a
// swallowed exit code would turn that refusal into a silent pass.
process.exit(added.exitCode === 0 && before.exitCode === 0 && after.exitCode === 0 ? 0 : 1);
