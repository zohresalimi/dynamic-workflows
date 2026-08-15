/**
 * KAR-19.5 — the smoke scenario, as a function, so the same chain can be run
 * twice: once against the shipped `dist/` (the smoke test) and once against a
 * copy of it with one link cut (the AC4 sabotage table).
 *
 * **What this harness refuses to substitute is the whole of its value.** The
 * binary is the built one, not the source tree. The daemon is a real process
 * the CLI starts for itself, not a `boot()` call in this process. The ledger is
 * a SQLite file on disk that the run itself wrote, not a fixture. The events
 * are read back out of that file, not off a projection this process holds. The
 * only substitution is the agent, and it is `deflow-mock-agent` — a real
 * executable on a real `PATH` speaking real ACP over a real subprocess
 * (docs/14-testing-strategy.md §3: fake binaries, not mocked modules).
 *
 * **Every stage is waited for by name.** That is EPIC-19-S34's *"it does not
 * fail with a timeout alone"* clause implemented rather than intended: a
 * scenario whose only failure mode is "90 seconds elapsed" tells the next
 * reader nothing about which link is missing, and diagnosing that is most of
 * the work. `LINKS` below names each stage after the shipped call that produces
 * it, and `SmokeFailure.link` carries that name out.
 */
import type { RunId } from '@DeFlow/core';
import { openLedger, readRange } from '@DeFlow/ledger';
import { makeRepo } from '@DeFlow/testkit';
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** Where `pnpm build` puts the binary an operator actually runs. */
export const DIST_DIR = join(repoRoot, 'packages/cli/dist');

/**
 * AC6's budget, in milliseconds, and the number the smoke spec's own timeout is
 * set from.
 *
 * Stated here rather than in the spec so `test/integration/smoke-project.test.ts`
 * can assert that the vitest project's `testTimeout` is this figure and not a
 * larger one somebody reached for on a slow afternoon.
 */
export const SMOKE_BUDGET_MS = 90_000;

/**
 * git's own directory, and the only thing on the hermetic `PATH` that is not
 * `node` or the bundled agent.
 *
 * `deflow run` refuses to start a run on a machine whose git is below 2.38, so
 * a `PATH` with no git at all would make this scenario exit 5 for a reason it
 * is not about. git is not an agent CLI, so "no vendor CLI" is unaffected.
 */
export const GIT_DIR = dirname(
  execFileSync('/usr/bin/env', ['sh', '-c', 'command -v git'], { encoding: 'utf8' }).trim(),
);

/**
 * A directory holding a `node` symlink and nothing else.
 *
 * Never `dirname(process.execPath)` itself: on a normal installation that is
 * also the npm global bin directory, which is where a developer's own
 * `claude-agent-acp` lives — and a scenario written to prove "no vendor CLI"
 * would then pass for that adapter's reason, on that laptop only.
 */
function nodeOnlyDir(): string {
  const dir = join(tmpdir(), `DeFlow-smoke-node-${String(process.pid)}`);
  mkdirSync(dir, { recursive: true });
  const link = join(dir, 'node');
  if (!existsSync(link)) symlinkSync(process.execPath, link);
  return dir;
}

export const NODE_DIR = nodeOnlyDir();

/**
 * The `--import` hook every Node process in the scenario is started with, so
 * AC3's *"no outbound socket was opened"* is a test rather than a claim.
 *
 * It refuses rather than only records: a connection to anything that is not
 * loopback throws where it was attempted, and the attempt is appended to
 * `$DeFlow_SMOKE_NETLOG` so the assertion can name it. Loopback stays open
 * because the CLI reaches its own daemon over it — the claim NF1 makes is about
 * the network, not about a unix-domain-shaped TCP socket on 127.0.0.1.
 *
 * `dns.lookup` is patched for the same reason: a `fetch('https://…')` that
 * cannot resolve fails before `connect` is ever reached, and a guard that only
 * watched `connect` would call that a pass.
 */
const NET_GUARD_SOURCE = `
import net from 'node:net';
import dns from 'node:dns';
import { appendFileSync } from 'node:fs';

const log = process.env.DeFlow_SMOKE_NETLOG;
const loopback = (host) =>
  host === undefined ||
  host === null ||
  host === '' ||
  host === 'localhost' ||
  host === '127.0.0.1' ||
  host === '::1' ||
  host === '::ffff:127.0.0.1';

const record = (what) => {
  if (log !== undefined) appendFileSync(log, what + '\\n');
};

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = typeof args[0] === 'object' && args[0] !== null ? args[0] : { port: args[0], host: args[1] };
  const host = typeof options.host === 'string' ? options.host : options.path === undefined ? undefined : null;
  if (options.path === undefined && !loopback(host)) {
    record('connect ' + String(host) + ':' + String(options.port));
    throw new Error('DeFlow smoke test: outbound connection to ' + String(host) + ' refused');
  }
  return connect.apply(this, args);
};

const lookup = dns.lookup;
dns.lookup = function (hostname, ...rest) {
  if (!loopback(hostname)) {
    record('lookup ' + String(hostname));
    const callback = rest.at(-1);
    const error = new Error('DeFlow smoke test: DNS lookup of ' + String(hostname) + ' refused');
    if (typeof callback === 'function') return callback(error);
    throw error;
  }
  return lookup(hostname, ...rest);
};
`;

/**
 * AC1's *"builds or resolves the real `deflow` binary"* — and **builds** is the
 * half that matters.
 *
 * A stale `dist/` is the one way this scenario can lie: it would run yesterday's
 * binary against today's assertions and report that a link is connected when
 * the commit that connected it has not been bundled. That is this epic's own
 * failure mode with an extra step, so freshness is checked rather than assumed —
 * every `.ts` under a package's `src/` and `bin/`, against `dist/bin.mjs`'s own
 * mtime.
 *
 * Called from a `beforeAll` with its own timeout, deliberately outside the AC6
 * budget: the budget is a statement about how long a *run* takes, and folding a
 * cold Vite build into it would make the number mean nothing.
 */
export function ensureBuilt(distDir: string = DIST_DIR): void {
  const bin = join(distDir, 'bin.mjs');
  const builtAt = existsSync(bin) ? statSync(bin).mtimeMs : 0;
  let newest = 0;
  for (const pkg of readdirSync(join(repoRoot, 'packages'), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    for (const sub of ['src', 'bin']) {
      const dir = join(repoRoot, 'packages', pkg.name, sub);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir, { recursive: true, withFileTypes: true })) {
        if (!file.isFile()) continue;
        if (!file.name.endsWith('.ts') && !file.name.endsWith('.vue')) continue;
        newest = Math.max(newest, statSync(join(file.parentPath, file.name)).mtimeMs);
      }
    }
  }
  if (builtAt > newest) return;

  const built = spawnSync('pnpm', ['build'], { cwd: repoRoot, encoding: 'utf8' });
  if (built.status !== 0) {
    throw new Error(
      `the smoke test runs the built binary and ${bin} is older than the source it is built ` +
        `from, so it rebuilt it — and \`pnpm build\` exited ${String(built.status)}:\n` +
        `${built.stderr}${built.stdout}`,
    );
  }
}

/** The hermetic `PATH`: the bundled agent, node, git. Nothing else. */
export const smokePath = (binDir: string): string => [binDir, NODE_DIR, GIT_DIR].join(':');

export interface SmokeEnvInput {
  /** The scenario's own `fs.mkdtemp` root. Everything writable is under it. */
  readonly tmp: string;
  /** The directory holding the `deflow-mock-agent` symlink. */
  readonly binDir: string;
  /** Where the network guard appends refused attempts. */
  readonly netLog?: string;
  /** The `--import` hook, when one has been written. */
  readonly netGuard?: string;
}

/**
 * The environment every process in the scenario is given, built once so
 * `test/integration/smoke-hermetic.test.ts` can assert AC3 against the same
 * function the scenario runs with rather than against a copy of it.
 *
 * Built from **nothing** rather than from `process.env` with entries removed:
 * an allowlist that starts empty cannot be defeated by a variable nobody
 * thought of, and `*_API_KEY`/`*_TOKEN` is a shape, not a list.
 */
export function smokeChildEnv(input: SmokeEnvInput): NodeJS.ProcessEnv {
  return {
    PATH: smokePath(input.binDir),
    HOME: join(input.tmp, 'home'),
    // The data directory resolves to `$XDG_DATA_HOME/DeFlow`, so this is what
    // keeps the run's ledger out of `~/.DeFlow` (AC3).
    XDG_DATA_HOME: join(input.tmp, 'xdg'),
    TMPDIR: join(input.tmp, 'tmp'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'DeFlow smoke',
    GIT_AUTHOR_EMAIL: 'smoke@example.com',
    GIT_COMMITTER_NAME: 'DeFlow smoke',
    GIT_COMMITTER_EMAIL: 'smoke@example.com',
    DeFlow_LOG_LEVEL: 'silent',
    DeFlow_DEV: '0',
    BROWSER: 'none',
    ...(input.netLog === undefined ? {} : { DeFlow_SMOKE_NETLOG: input.netLog }),
    ...(input.netGuard === undefined ? {} : { NODE_OPTIONS: `--import ${input.netGuard}` }),
  };
}

/**
 * The chain, stage by stage, each named after the shipped call that produces
 * it.
 *
 * This table is AC4's other half: the sabotage rows cut these links, and the
 * failure message a cut produces is the name in here. A stage with a vague name
 * would make the table's *"names the link"* clause vacuous.
 */
export const LINKS = {
  submitted: 'intake writing task.submitted',
  framingWake: "intake's framing wake",
  created: 'the framing turn reaching run.created',
  proposed: 'the approval reaching compilePlanV1',
  started: 'the plan reaching executeRun',
  chunk: 'the io_chunk producer',
  completed: 'the node reaching node.completed',
  terminal: 'the run reaching a terminal state',
} as const;

export type SmokeLink = (typeof LINKS)[keyof typeof LINKS];

/**
 * The one sentence `stage()` writes when it gives up on the clock.
 *
 * Exported because the sabotage table asserts its **absence** for the row whose
 * provider fails rather than whose link is missing (KAR-19.9 AC9): *"it does
 * not reach its own timeout"*. A copy of the phrase over there would pass the
 * day this one was reworded, which is the failure the clause exists to catch,
 * one level up.
 */
export const SMOKE_STAGE_TIMED_OUT = 'it did not happen within';

/** A stage that did not happen, carrying the link whose absence explains it. */
export class SmokeStageMissing extends Error {
  readonly link: SmokeLink;

  constructor(link: SmokeLink, detail: string) {
    super(`the smoke chain stopped at ${link}: ${detail}`);
    this.name = 'SmokeStageMissing';
    this.link = link;
  }
}

export interface SmokeOptions {
  /** The `dist/` to run. Defaults to the repository's own build. */
  readonly distDir?: string;
  /**
   * How long any single stage may take.
   *
   * The smoke test leaves it at the default; the sabotage table shortens it,
   * because a cut link is a stage that will never happen and six rows waiting
   * out the full budget would cost ten minutes to learn nothing.
   */
  readonly stageTimeoutMs?: number;
  /** Kept for the caller to inspect and, on failure, to report. */
  readonly keepTmp?: boolean;
}

export interface SmokeResult {
  readonly tmp: string;
  readonly dataDir: string;
  readonly runId: string;
  /** Every event kind in the run's own stream, in `seq` order. */
  readonly kinds: readonly string[];
  /** The node ids the plan compiled. */
  readonly planNodes: readonly string[];
  /** The node ids that reached `node.completed`. */
  readonly completedNodes: readonly string[];
  /** `deflow run`'s own stdout, whole. */
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  /**
   * True when agent bytes were on the CLI's stdout **before** the run reached a
   * terminal event — AC2's *"while the run was in flight"*, which is the clause
   * a buffered renderer would fail and an end-of-run flush would pass.
   */
  readonly outputWhileRunning: boolean;
  /** Non-loopback connections attempted by any process in the scenario. */
  readonly outboundAttempts: readonly string[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const RUN_ID = /run_\d{8}T\d{6}Z_[0-9a-f]{6}/;

/** The markdown task an operator would write. Deliberately ordinary. */
const TASK = [
  '# Add a health endpoint',
  '',
  'Expose `GET /health` returning `200` with the body `ok`.',
  '',
  '## Acceptance criteria',
  '',
  '- A request to `/health` answers 200.',
  '',
].join('\n');

/**
 * The one gate definition the scratch repository carries.
 *
 * The default plan the bundled agent proposes ends in a deterministic
 * `typecheck` gate, and `.DeFlow/gates/` is the directory `deflow init` creates
 * for exactly this — a gate is repository configuration, so writing one here is
 * arranging the scenario rather than faking it. The command is `node --version`
 * because `node` is on the hermetic `PATH` and the gate under test is the
 * *wiring*, not TypeScript.
 */
const TYPECHECK_GATE = [
  'id: typecheck',
  'kind: deterministic',
  'title: TypeScript project check',
  'run: node --version',
  'cwd: worktree',
  'timeout: 60s',
  'effect: pure',
  'permission: worktree',
  'expect:',
  '  exitCode: 0',
  'findings:',
  '  parser: none',
  'satisfies: []',
  '',
].join('\n');

interface Spawned {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  readonly exited: Promise<number | null>;
}

function spawnCli(input: {
  readonly distDir: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}): Spawned {
  const out: string[] = [];
  const err: string[] = [];
  const child = spawn(process.execPath, [join(input.distDir, 'bin.mjs'), ...input.argv], {
    cwd: input.cwd,
    env: input.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => out.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => err.push(chunk.toString()));
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
  return { child, stdout: () => out.join(''), stderr: () => err.join(''), exited };
}

/** One run's event kinds, in `seq` order, or `[]` before the stream exists. */
function kindsOf(dataDir: string, runId: string): readonly string[] {
  let db: ReturnType<typeof openLedger> | null = null;
  try {
    db = openLedger(dataDir);
    return readRange(db, runId as RunId, 0, 2_000).events.map((event) => event.kind);
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

interface LedgerRead {
  readonly kinds: readonly string[];
  readonly planNodes: readonly string[];
  readonly completedNodes: readonly string[];
  readonly ioChunks: number;
  /**
   * A phrase the agent itself wrote, taken out of the first `io_chunk` frame.
   *
   * The `io_chunk` row holds the raw ACP frame; what has to appear on the
   * terminal is the *text inside it*. Asserting "stdout is non-empty" would
   * pass on the renderer's own header line and prove nothing about the agent,
   * which is precisely the clause AC2 is making.
   */
  readonly agentSaid: string | null;
  /**
   * KAR-19.9 AC9 — why the run gave up, or `null` for a run that has not.
   *
   * Read off the run's own ledger rather than off the CLI's transcript, which
   * is the point: before this story a run whose turns kept failing appended
   * nothing at all, so there was no such sentence to read anywhere and the
   * scenario could only report that time had passed.
   */
  readonly endedFailure: EndedFailure | null;
}

/** The typed failure a run ended on, as the ledger recorded it. */
interface EndedFailure {
  readonly node: string;
  readonly reason: string;
  readonly message: string;
  /** How many attempts were journalled for that node before it gave up. */
  readonly attempts: number;
}

/** The agent's own words inside one `session/update` frame, or `null`. */
function agentTextOf(frame: string): string | null {
  try {
    const parsed = JSON.parse(frame) as {
      readonly params?: {
        readonly update?: { readonly content?: { readonly text?: unknown } };
      };
    };
    const text = parsed.params?.update?.content?.text;
    if (typeof text !== 'string') return null;
    const line = text.split('\n').find((candidate) => candidate.trim().length > 8);
    return line?.trim() ?? null;
  } catch {
    return null;
  }
}

/**
 * The failure a run **gave up** on, or `null`.
 *
 * Only for a run that reached `run.aborted`. A live run with a failed attempt
 * behind it has not given up — its node is inside the retry ladder — and a
 * scenario that ended itself on the first `node.failed` would fail the run that
 * KAR-19.9 AC7 exists to protect: two failures and a success is a working run.
 *
 * The **last** failure rather than the first, because that is the attempt the
 * ceiling was reached on, and its `attempt` count is what makes the sentence
 * *"after 3 attempts"* true.
 */
function endedFailureOf(
  kinds: readonly string[],
  failures: readonly EndedFailure[],
): EndedFailure | null {
  if (!kinds.includes('run.aborted')) return null;
  const last = failures.at(-1);
  if (last === undefined) return null;
  return { ...last, attempts: failures.filter((one) => one.node === last.node).length };
}

function readLedger(dataDir: string, runId: string): LedgerRead {
  let db: ReturnType<typeof openLedger> | null = null;
  try {
    db = openLedger(dataDir);
    const events = readRange(db, runId as RunId, 0, 2_000).events;
    const planNodes: string[] = [];
    const completedNodes: string[] = [];
    const failures: EndedFailure[] = [];
    for (const event of events) {
      if (event.kind === 'node.failed') {
        const payload = event.payload as {
          readonly node?: unknown;
          readonly failure?: { readonly reason?: unknown; readonly message?: unknown };
        };
        failures.push({
          node: String(payload.node),
          reason: String(payload.failure?.reason),
          message: String(payload.failure?.message),
          attempts: 0,
        });
      }
      if (event.kind === 'plan.proposed') {
        const payload = event.payload as { readonly graph?: { readonly nodes?: unknown[] } };
        planNodes.length = 0;
        for (const node of payload.graph?.nodes ?? []) {
          planNodes.push(String((node as { readonly id?: unknown }).id));
        }
      }
      if (event.kind === 'node.completed') {
        const payload = event.payload as { readonly node?: unknown };
        completedNodes.push(String(payload.node));
      }
    }
    // The data plane, read separately: `io_chunk` is deliberately not on the
    // control plane (KAR-03.4), so "the agent produced bytes" is a different
    // question from "the run produced events".
    const chunks = db
      .prepare<{ data: Uint8Array | string }>(
        'SELECT data FROM io_chunk WHERE run_id = ? ORDER BY seq LIMIT 8',
      )
      .all(runId);
    let agentSaid: string | null = null;
    for (const chunk of chunks) {
      agentSaid ??= agentTextOf(
        typeof chunk.data === 'string' ? chunk.data : Buffer.from(chunk.data).toString('utf8'),
      );
    }

    const kinds = events.map((event) => event.kind);
    return {
      kinds,
      planNodes,
      completedNodes,
      ioChunks: chunks.length,
      agentSaid,
      endedFailure: endedFailureOf(kinds, failures),
    };
  } catch {
    return {
      kinds: [],
      planNodes: [],
      completedNodes: [],
      ioChunks: 0,
      agentSaid: null,
      endedFailure: null,
    };
  } finally {
    db?.close();
  }
}

interface DaemonFile {
  readonly pid: number;
  readonly port: number;
  readonly token: string;
}

function daemonFile(dataDir: string): DaemonFile | null {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8')) as DaemonFile;
  } catch {
    return null;
  }
}

/** The daemon the CLI started for itself. It is detached, so nothing else
 * here will take it down. */
async function stopDaemon(dataDir: string): Promise<void> {
  const file = daemonFile(dataDir);
  if (file === null) return;
  try {
    process.kill(file.pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(file.pid, 0);
    } catch {
      return;
    }
    await sleep(50);
  }
}

const TERMINAL_KINDS = ['run.completed', 'run.aborted', 'run.needs_human', 'run.paused'];

/**
 * Runs the whole scenario and returns what the ledger and the terminal say.
 *
 * Throws `SmokeStageMissing` at the first stage that does not happen, which is
 * what makes a cut link a *named* failure rather than a timeout.
 */
export async function runSmokeScenario(options: SmokeOptions = {}): Promise<SmokeResult> {
  const distDir = options.distDir ?? DIST_DIR;
  const stageMs = options.stageTimeoutMs ?? 45_000;
  const bin = join(distDir, 'bin.mjs');
  if (!existsSync(bin)) {
    throw new Error(
      `${bin} does not exist. The smoke test runs the built binary rather than the source ` +
        'tree; run `pnpm build` first.',
    );
  }

  const tmp = await mkdtemp(join(tmpdir(), 'DeFlow-smoke-'));
  const dataDir = join(tmp, 'xdg', 'DeFlow');
  const netLog = join(tmp, 'outbound.log');
  const netGuard = join(tmp, 'net-guard.mjs');
  writeFileSync(netGuard, NET_GUARD_SOURCE, 'utf8');
  for (const dir of ['home', 'xdg', 'tmp']) mkdirSync(join(tmp, dir), { recursive: true });

  const binDir = join(tmp, 'bin');
  mkdirSync(binDir, { recursive: true });
  symlinkSync(join(distDir, 'mock-agent.mjs'), join(binDir, 'deflow-mock-agent'));

  const env = smokeChildEnv({ tmp, binDir, netLog, netGuard });
  const repo = await makeRepo({ dir: join(tmp, 'repo') });
  writeFileSync(join(repo.dir, 'spec.md'), TASK, 'utf8');

  let cli: Spawned | null = null;
  try {
    // ── `deflow init`, exactly as the operator runs it ──────────────────────
    const init = spawnCli({ distDir, argv: ['init'], cwd: repo.dir, env });
    const initCode = await init.exited;
    if (initCode !== 0) {
      throw new Error(`deflow init exited ${String(initCode)}:\n${init.stderr()}${init.stdout()}`);
    }
    mkdirSync(join(repo.dir, '.DeFlow', 'gates'), { recursive: true });
    writeFileSync(join(repo.dir, '.DeFlow', 'gates', 'typecheck.yaml'), TYPECHECK_GATE, 'utf8');
    await repo.git('add', '-A');
    await repo.git('commit', '-m', 'DeFlow smoke: initialise the workspace');

    // ── `deflow run --file spec.md` ─────────────────────────────────────────
    cli = spawnCli({ distDir, argv: ['run', '--file', 'spec.md'], cwd: repo.dir, env });
    const process_ = cli;

    /**
     * The run id, once the CLI has printed it — so every stage after the first
     * can ask the ledger whether the run is still going.
     */
    let submittedRunId: string | null = null;

    /**
     * KAR-19.9 AC9 — a run that **gave up** ends the scenario there and then,
     * saying so.
     *
     * Without it a failing provider is indistinguishable from a missing link:
     * the stage waits out its budget and reports that time passed, which is
     * exactly the diagnosis-free timeout AC4 calls a hole in the smoke test.
     * The sentence is the ledger's own — the typed reason from KAR-02.10's
     * closed taxonomy, on the `node.failed` the run ended on — and it exists to
     * be read only because AC1 made the daemon write it.
     */
    const gaveUp = (link: SmokeLink): SmokeStageMissing | null => {
      if (submittedRunId === null) return null;
      const failure = readLedger(dataDir, submittedRunId).endedFailure;
      if (failure === null) return null;
      return new SmokeStageMissing(
        link,
        `the run failed after ${String(failure.attempts)} attempt(s) on node ` +
          `${failure.node}: ${failure.reason} — ${failure.message}\n` +
          `stdout:\n${process_.stdout()}\nstderr:\n${process_.stderr()}`,
      );
    };

    const stage = async <T>(link: SmokeLink, read: () => T | null): Promise<T> => {
      const deadline = Date.now() + stageMs;
      while (Date.now() < deadline) {
        const value = read();
        if (value !== null) return value;
        // Asked before the exit-code arm below, because both are true of a run
        // that gave up and only one of them says why.
        const ended = gaveUp(link);
        if (ended !== null) throw ended;
        if (process_.child.exitCode !== null) {
          const value2 = read();
          if (value2 !== null) return value2;
          throw new SmokeStageMissing(
            link,
            `deflow run exited ${String(process_.child.exitCode)} first\n` +
              `stdout:\n${process_.stdout()}\nstderr:\n${process_.stderr()}`,
          );
        }
        await sleep(100);
      }
      throw new SmokeStageMissing(
        link,
        `${SMOKE_STAGE_TIMED_OUT} ${String(stageMs)} ms\n` +
          `stdout:\n${process_.stdout()}\nstderr:\n${process_.stderr()}`,
      );
    };

    const runId = await stage(LINKS.submitted, () => RUN_ID.exec(process_.stdout())?.[0] ?? null);
    submittedRunId = runId;
    await stage(LINKS.submitted, () =>
      kindsOf(dataDir, runId).includes('task.submitted') ? true : null,
    );

    // The framing wake is consumed within a tick of being written, so what is
    // waited on is its effect rather than the row: a run that reaches
    // `run.created` was woken and framed.
    await stage(LINKS.created, () =>
      kindsOf(dataDir, runId).includes('run.created') ? true : null,
    );

    // The F1.3 gate, answered the way the web UI answers it — over the daemon's
    // own route, with the token the daemon wrote for itself. There is no
    // `--yes` on `deflow run` and there should not be: the gate exists to be
    // answered by a person.
    const file = daemonFile(dataDir);
    if (file === null)
      throw new SmokeStageMissing(LINKS.created, 'the daemon wrote no daemon.json');
    const approved = await fetch(
      `http://127.0.0.1:${String(file.port)}/api/runs/${runId}/spec/approve`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${file.token}` },
        body: '{}',
      },
    );
    if (!approved.ok) {
      throw new SmokeStageMissing(
        LINKS.created,
        `approving the spec answered ${String(approved.status)}`,
      );
    }

    await stage(LINKS.proposed, () =>
      kindsOf(dataDir, runId).includes('plan.proposed') ? true : null,
    );
    await stage(LINKS.started, () =>
      kindsOf(dataDir, runId).includes('node.started') ? true : null,
    );

    // AC2's *"while the run was in flight"*, and it is the agent's own words
    // that have to be there: the phrase is lifted out of the first `io_chunk`
    // frame and looked for on the CLI's stdout. A run that reached its end with
    // no `io_chunk` row at all is the io producer missing, and it is named
    // rather than waited out — S34's *"not a timeout alone"*.
    const outputWhileRunning = await stage(LINKS.chunk, () => {
      const read = readLedger(dataDir, runId);
      const terminal = read.kinds.some((kind) => TERMINAL_KINDS.includes(kind));
      if (read.agentSaid !== null && process_.stdout().includes(read.agentSaid)) return !terminal;
      if (!terminal) return null;
      throw new SmokeStageMissing(
        LINKS.chunk,
        read.ioChunks === 0
          ? 'the run reached a terminal state and its ledger holds no io_chunk row at all, so ' +
              'nothing produced the agent’s bytes'
          : `the run ended with ${String(read.ioChunks)} io_chunk rows and none of what the agent ` +
              `said reached the terminal (looked for ${JSON.stringify(read.agentSaid)})\n` +
              `stdout:\n${process_.stdout()}`,
      );
    });

    await stage(LINKS.completed, () =>
      kindsOf(dataDir, runId).includes('node.completed') ? true : null,
    );
    await stage(LINKS.terminal, () => {
      const kinds = kindsOf(dataDir, runId);
      return kinds.some((kind) => TERMINAL_KINDS.includes(kind)) ? true : null;
    });

    const exitCode = await Promise.race([
      process_.exited,
      sleep(stageMs).then(() => {
        throw new SmokeStageMissing(
          LINKS.terminal,
          `deflow run did not exit within ${String(stageMs)} ms of the terminal event`,
        );
      }),
    ]);

    const read = readLedger(dataDir, runId);
    return {
      tmp,
      dataDir,
      runId,
      kinds: read.kinds,
      planNodes: read.planNodes,
      completedNodes: read.completedNodes,
      stdout: process_.stdout(),
      stderr: process_.stderr(),
      exitCode,
      outputWhileRunning,
      outboundAttempts: existsSync(netLog)
        ? readFileSync(netLog, 'utf8').split('\n').filter(Boolean)
        : [],
    };
  } finally {
    if (cli !== null && cli.child.exitCode === null) {
      cli.child.kill('SIGKILL');
      await cli.exited;
    }
    await stopDaemon(dataDir);
    // AC7 — the tmpdir survives under DeFlow_KEEP_TMP=1, so the ledger of a
    // failed smoke run can be opened with plain `sqlite3`.
    if (options.keepTmp !== true && process.env.DeFlow_KEEP_TMP === undefined) {
      await rm(tmp, { recursive: true, force: true });
    }
  }
}
