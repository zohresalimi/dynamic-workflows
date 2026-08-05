/**
 * One line per invocation, written by the process that was invoked.
 *
 * The crash-fuzz suite's first invariant is "no effect was executed twice"
 * (docs/14-testing-strategy.md §11), and it is deliberately not checked
 * against the effect journal: the journal is the mechanism that is supposed to
 * prevent the second execution, so reading it back to ask whether one happened
 * proves only that it agrees with itself. A text file the child appends to is
 * an observation of the world instead, and the invariant becomes a
 * duplicate-key check.
 *
 * The four fields are `{runId, nodeId, attempt, idempotencyKey}` and all four
 * matter. A log keyed on `(runId, nodeId)` alone could not tell crash-resume
 * (same attempt, must memoise) from failure-retry (new attempt, must
 * re-execute) — and those are different operations, not two names for one.
 *
 * Written **first** and **synchronously**: this is the record that the
 * invocation happened, and the process it exists to observe is one that gets
 * `SIGKILL`ed on purpose. A line sitting in a stream buffer when the signal
 * lands is a line that never existed.
 */
import { appendFileSync } from 'node:fs';

/** Where the log goes. Unset means no log, and the turn is unaffected. */
export const SIDE_EFFECT_LOG_ENV = 'DeFlow_SIDE_EFFECT_LOG';

/**
 * The four fields, as an argv flag and as an environment variable.
 *
 * Both, because DeFlowd passes them one way or the other depending on how the
 * adapter builds its argv, and a fixture that only worked one way would look
 * green right up until the adapter changed. argv wins when both are present:
 * it is the more specific of the two.
 */
export const IDEMPOTENCY_FIELDS = [
  { flag: '--run-id', env: 'DeFlow_RUN_ID', key: 'runId' },
  { flag: '--node-id', env: 'DeFlow_NODE_ID', key: 'nodeId' },
  { flag: '--attempt', env: 'DeFlow_ATTEMPT', key: 'attempt' },
  { flag: '--ikey', env: 'DeFlow_IKEY', key: 'idempotencyKey' },
] as const;

export const IDEMPOTENCY_FLAGS = IDEMPOTENCY_FIELDS.map((field) => field.flag);

export interface SideEffectRecord {
  readonly runId: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly idempotencyKey: string;
}

/**
 * Scans argv directly rather than going through `parseArgv`.
 *
 * That is deliberate: "every invocation appends exactly one line" has to hold
 * for an invocation whose argv turned out to be unusable, and an unparsed
 * invocation is exactly the one whose absence from the log would be hardest to
 * explain later.
 */
export function readInvocation(argv: readonly string[], env: NodeJS.ProcessEnv): SideEffectRecord {
  const value = (flag: string, name: string): string => {
    const at = argv.lastIndexOf(flag);
    if (at >= 0 && argv[at + 1] !== undefined) return argv[at + 1] as string;
    return env[name] ?? '';
  };

  const attempt = Number.parseInt(value('--attempt', 'DeFlow_ATTEMPT'), 10);
  return {
    runId: value('--run-id', 'DeFlow_RUN_ID'),
    nodeId: value('--node-id', 'DeFlow_NODE_ID'),
    // Verbatim from argv/env, except that an absent or unreadable attempt is 0
    // rather than NaN — NaN does not survive JSON.stringify.
    attempt: Number.isFinite(attempt) ? attempt : 0,
    idempotencyKey: value('--ikey', 'DeFlow_IKEY'),
  };
}

/** Appends one line, or does nothing at all when the variable is unset. */
export function recordInvocation(argv: readonly string[], env: NodeJS.ProcessEnv): void {
  const path = env[SIDE_EFFECT_LOG_ENV];
  if (path === undefined || path === '') return;
  appendFileSync(path, `${JSON.stringify(readInvocation(argv, env))}\n`);
}
