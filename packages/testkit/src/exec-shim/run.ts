/**
 * One invocation of the fake exec-shim agent, start to finish.
 *
 * Everything the process does goes through `ExecShimPorts`, so the order of
 * operations can be read in one place: refuse the invocation, or record it,
 * make it visible in the world, and only then write bytes. That order is not
 * cosmetic — the side-effect log has to be on disk before anything can crash,
 * and the SIGTERM handler has to be installed before the first byte, or a
 * signal arriving early would kill the process the fixture exists to keep
 * alive.
 *
 * The ports are also why `run` never reads the clock, spawns, or exits by
 * itself. `bin/fake-agent.ts` supplies the real ones.
 *
 * **Steps describe the stream.** Under `--output-format json` or `text` a real
 * vendor emits only the final document, so a scenario's steps have no wire
 * representation there and are not emitted. That is the vendor's behaviour
 * being reproduced, not a shortcut: a fake that printed its chunks under `json`
 * would teach a shim to look for lines that never arrive.
 */

import {
  type Dialect,
  decideCli,
  type OutputFormat,
  readDialect,
  type ShimEnv,
  schemaPathIn,
} from './dialects.ts';
import {
  claudeStreamJson,
  codexJsonl,
  copilotJson,
  type FrameContext,
  type HugeLineParts,
  type Line,
  patternSlice,
  uuidsFromSeed,
} from './frames.ts';
import {
  type ExecShimScenario,
  type ExecStep,
  loadExecShimScenario,
  type ResultScript,
  SCENARIO_ENV,
} from './scenario.ts';

export interface ExecShimPorts {
  /** Resolves once the bytes have left, so a 10 MB line is not truncated. */
  writeOut(text: string): Promise<void>;
  writeErr(text: string): void;
  sleep(ms: number): Promise<void>;
  /** Backgrounds a real `sleep <seconds>` and returns its pid. */
  spawnSleeper(seconds: number): number;
  /** Writes `content` at an already-resolved absolute path, creating parents. */
  writeFile(absolutePath: string, content: string): void;
  /** Installs the no-op `SIGTERM` handler. */
  ignoreSigterm(): void;
  /** Keeps the process alive with nothing left to do. Never returns. */
  hangForever(): void;
  /** The clock reading the whole invocation is stamped from. */
  nowMs(): number;
  /** The directory declared paths are resolved against. */
  cwd(): string;
  /** `resolve(cwd, path)`, kept a port so the runner stays free of node:path. */
  resolvePath(from: string, relative: string): string;
  /** The process environment, read only by the `envEcho` step. A port rather
   * than `process.env` so the runner stays testable without a process. */
  env(): Readonly<Record<string, string | undefined>>;
}

/**
 * The client-chosen session id on the argv, or `null` when none was passed.
 *
 * `lastIndexOf` for the same reason `seedFrom` uses it: a repeated flag means
 * the last one wins, which is what a shell user expects and what the vendors do.
 */
export function sessionIdIn(argv: readonly string[]): string | null {
  const at = argv.lastIndexOf('--session-id');
  if (at < 0) return null;
  const value = argv[at + 1];
  return value === undefined || value.startsWith('--') ? null : value;
}

/** The seed for a run: `--seed` in argv, else `$DeFlow_FAKE_SEED`, else none. */
export const SEED_ENV = 'DeFlow_FAKE_SEED';
/** A fixed clock reading, so `resetsAt` is an equality rather than a window. */
export const NOW_ENV = 'DeFlow_FAKE_NOW';
/** Overrides the scenario's exit code, so one scenario serves both S18 cases. */
export const EXIT_CODE_ENV = 'DeFlow_FAKE_EXIT_CODE';

/** Exit codes for the fake's own refusals, distinct from a scripted one. */
const USAGE_ERROR = 64;
const DATA_ERROR = 65;

export function seedFrom(argv: readonly string[], env: ShimEnv): number | null {
  const at = argv.lastIndexOf('--seed');
  const fromArgv = at < 0 ? Number.NaN : Number.parseInt(argv[at + 1] ?? '', 10);
  if (Number.isFinite(fromArgv)) return fromArgv;
  const fromEnv = Number.parseInt(env[SEED_ENV] ?? '', 10);
  return Number.isFinite(fromEnv) ? fromEnv : null;
}

const DEFAULT_RESULT: ResultScript = {
  subtype: 'success',
  isError: false,
  stopReason: 'end_turn',
  text: '',
  totalCostUsd: 0,
  permissionDenials: [],
};

/** One JSON object and the newline that ends its line. */
const line = (value: Line): string => `${JSON.stringify(value)}\n`;

/** The 10 MB payload, written `chunkBytes` at a time so the reader sees it grow. */
async function writeHugeLine(
  ports: ExecShimPorts,
  parts: HugeLineParts,
  totalBytes: number,
  chunkBytes: number,
): Promise<void> {
  await ports.writeOut(parts.prefix);
  for (let written = 0; written < totalBytes; ) {
    const size = Math.min(chunkBytes, totalBytes - written);
    await ports.writeOut(patternSlice(written, size));
    written += size;
  }
  // The newline is what makes it *one line*. Without it this would be the
  // never-terminating-line hazard, which is a different failure.
  await ports.writeOut(`${parts.suffix}\n`);
}

/** A step a dialect has no frame for. Loud, never skipped. */
class UnrepresentableStep extends Error {}

/**
 * KAR-09.9 AC2 — a scripted `structured_output` survives only if the
 * invocation actually carried a schema flag.
 *
 * The real CLI populates the field for a `--json-schema` run and omits it
 * otherwise. Reproducing that is the whole value of the fake here: a shim that
 * stopped passing the flag has to *fail* — an absent structured output is a
 * contract failure (docs/08-context-and-memory.md §9.1) — and it cannot fail if
 * the double hands the object over regardless.
 */
function withStructuredOutputFor(
  scenario: ExecShimScenario,
  argv: readonly string[],
): ExecShimScenario {
  if (scenario.result?.structuredOutput === undefined) return scenario;
  if (schemaPathIn(argv) !== null) return scenario;

  const { structuredOutput: _dropped, ...rest } = scenario.result;
  return { ...scenario, result: rest };
}

async function emitClaudeStream(
  scenario: ExecShimScenario,
  context: FrameContext,
  ports: ExecShimPorts,
  announcement: string | null,
): Promise<void> {
  const frames = claudeStreamJson(context);
  await ports.writeOut(line(frames.systemInit()));
  if (announcement !== null) await ports.writeOut(line(frames.assistant(announcement)));

  for (const step of scenario.steps) {
    if (step.type === 'chunks') {
      for (let index = 0; index < step.count; index += 1) {
        // The gap goes *between* chunks: a leading sleep would make the first
        // frame late for no reason a cadence assertion could explain.
        if (index > 0 && step.delayMs > 0) await ports.sleep(step.delayMs);
        await ports.writeOut(line(frames.assistant(step.text)));
      }
    } else if (step.type === 'message') {
      await ports.writeOut(line(frames.assistant(step.text)));
    } else if (step.type === 'rateLimit') {
      await ports.writeOut(line(frames.rateLimit(step.status, step.resetsInSeconds)));
    } else if (step.type === 'compaction') {
      // The spinner frame first, then the boundary — the order a real
      // compaction arrives in, and the pair a consumer has to collapse into one
      // event (EPIC-09-S31, second scenario).
      await ports.writeOut(line(frames.compactingStatus()));
      await ports.writeOut(line(frames.compactBoundary(step.trigger, step.preTokens)));
    } else if (step.type === 'envEcho') {
      for (const name of step.names) {
        await ports.writeOut(line(frames.assistant(`${name}=${ports.env()[name] ?? ''}`)));
      }
    } else if (step.type === 'malformedLine') {
      await ports.writeOut(`${step.text}\n`);
    } else {
      await writeHugeLine(ports, frames.hugeLineParts(), step.totalBytes, step.chunkBytes);
    }
  }

  if (scenario.result !== null) await ports.writeOut(line(frames.result(scenario.result)));
}

async function emitCodexJsonl(
  scenario: ExecShimScenario,
  context: FrameContext,
  ports: ExecShimPorts,
  announcement: string | null,
): Promise<void> {
  const frames = codexJsonl(context);
  await ports.writeOut(line(frames.taskStarted()));
  if (announcement !== null) await ports.writeOut(line(frames.agentMessage(announcement)));

  for (const step of scenario.steps) {
    if (step.type === 'chunks') {
      for (let index = 0; index < step.count; index += 1) {
        if (index > 0 && step.delayMs > 0) await ports.sleep(step.delayMs);
        await ports.writeOut(line(frames.agentMessage(step.text)));
      }
    } else if (step.type === 'message') {
      await ports.writeOut(line(frames.agentMessage(step.text)));
    } else if (step.type === 'rateLimit') {
      // Codex has no rate-limit event. Emitting one as some other frame would
      // invent a vendor behaviour, and dropping it silently would make a
      // scenario that tests nothing look like one that passed.
      throw new UnrepresentableStep(
        'the codex-jsonl dialect has no rate_limit_event frame — script that step under claude-stream-json',
      );
    } else if (step.type === 'compaction') {
      // Same rule, and the one that matters most here: Codex reports no
      // compaction boundary at all, so a fake that emitted one would teach a
      // parser that every vendor announces its compactions.
      throw new UnrepresentableStep(
        'the codex-jsonl dialect has no compact_boundary frame — script that step under claude-stream-json',
      );
    } else if (step.type === 'envEcho') {
      for (const name of step.names) {
        await ports.writeOut(line(frames.agentMessage(`${name}=${ports.env()[name] ?? ''}`)));
      }
    } else if (step.type === 'malformedLine') {
      await ports.writeOut(`${step.text}\n`);
    } else {
      await writeHugeLine(ports, frames.hugeLineParts(), step.totalBytes, step.chunkBytes);
    }
  }

  await ports.writeOut(line(frames.taskComplete(scenario.result ?? DEFAULT_RESULT)));
}

/** The single document `--output-format json` produces, per dialect. */
function singleDocument(dialect: Dialect, scenario: ExecShimScenario, context: FrameContext): Line {
  const script = scenario.result ?? DEFAULT_RESULT;
  if (dialect === 'copilot-json') return copilotJson(context).document(script);
  if (dialect === 'codex-jsonl') return codexJsonl(context).taskComplete(script);
  return claudeStreamJson(context).result(script);
}

async function emit(
  dialect: Dialect,
  format: OutputFormat,
  scenario: ExecShimScenario,
  context: FrameContext,
  ports: ExecShimPorts,
  announcement: string | null,
): Promise<void> {
  if (format === 'stream-json') {
    await emitClaudeStream(scenario, context, ports, announcement);
    return;
  }
  if (format === 'jsonl') {
    await emitCodexJsonl(scenario, context, ports, announcement);
    return;
  }
  if (format === 'json') {
    await ports.writeOut(line(singleDocument(dialect, scenario, context)));
    return;
  }

  // text: whatever the turn ended up saying, and nothing else.
  const text = (scenario.result ?? DEFAULT_RESULT).text;
  if (text !== '') await ports.writeOut(`${text}\n`);
}

/**
 * Runs one invocation.
 *
 * Returns the exit code, or `null` when the scenario says to hang: the caller
 * must then leave the process alive rather than exiting with a code that would
 * make a wedge look like a clean finish.
 */
export async function runExecShim(
  argv: readonly string[],
  env: ShimEnv,
  ports: ExecShimPorts,
): Promise<number | null> {
  const dialect = readDialect(env);
  if (!dialect.ok) {
    ports.writeErr(`${dialect.stderr}\n`);
    return dialect.exitCode;
  }

  const spec = env[SCENARIO_ENV];
  if (spec === undefined) {
    ports.writeErr(
      `fake-agent: ${SCENARIO_ENV} is not set. The binary reproduces a scripted invocation and ` +
        `has no default one — a fake that invented a turn would be a fake nobody wrote.\n`,
    );
    return USAGE_ERROR;
  }

  const loaded = loadExecShimScenario(spec);
  if (!loaded.ok) {
    ports.writeErr(`fake-agent: ${loaded.message}\n`);
    return DATA_ERROR;
  }
  const scenario = withStructuredOutputFor(loaded.scenario, argv);

  const decision = decideCli(dialect.dialect, argv);
  if (!decision.ok) {
    ports.writeErr(`${decision.stderr}\n`);
    return decision.exitCode;
  }

  // Installed before a byte is written: a SIGTERM that arrived during the
  // stream would otherwise end the process this scenario exists to keep alive.
  if (scenario.ignoreSigterm) ports.ignoreSigterm();

  const cwd = ports.cwd();
  for (const file of scenario.writeFiles) {
    ports.writeFile(ports.resolvePath(cwd, file.path), file.content);
  }

  const tree = scenario.spawnGrandchildren;
  const pids =
    tree === null
      ? []
      : Array.from({ length: tree.count }, () => ports.spawnSleeper(tree.sleepSeconds));

  const exitCode = (() => {
    const override = Number.parseInt(env[EXIT_CODE_ENV] ?? '', 10);
    return Number.isFinite(override) ? override : scenario.exitCode;
  })();

  if (scenario.noOutput) {
    // Zero bytes on both streams, by leaving before either is touched. The
    // scripted stderr is deliberately not written: "silent" has to mean silent,
    // or the one case the battery cares about stops being reproducible.
    if (!scenario.hangForever) return exitCode;
    ports.hangForever();
    return null;
  }

  const nextUuid = uuidsFromSeed(seedFrom(argv, env));
  const context: FrameContext = {
    // KAR-12.2 AC5 — a client-chosen `--session-id <uuid>` is honoured
    // verbatim in every emitted frame (**verified 2026-08-02** against Claude
    // Code and Gemini CLI), so the fake honours it too: a fake that answered on
    // an id of its own would make DeFlow's own check unrunnable against it, and
    // a fake that diverges from the vendor on the one field a safety
    // precondition reads is worse than no fake.
    //
    // An explicit `sessionId` in the scenario still wins, and that is what
    // makes the *dishonest* case scriptable: an agent claiming a session
    // nobody opened is a case DeFlow has to fail on, and it needs a stimulus.
    sessionId: scenario.sessionId ?? sessionIdIn(argv) ?? nextUuid(),
    nextUuid,
    nowMs: (() => {
      const fixed = Number.parseInt(env[NOW_ENV] ?? '', 10);
      return Number.isFinite(fixed) ? fixed : ports.nowMs();
    })(),
  };

  try {
    // A test cannot otherwise learn the pids of processes whose whole purpose
    // is to outlive the one that spawned them.
    await emit(
      dialect.dialect,
      decision.format,
      scenario,
      context,
      ports,
      pids.length === 0 ? null : `grandchildren: ${pids.join(',')}`,
    );
  } catch (error) {
    if (!(error instanceof UnrepresentableStep)) throw error;
    ports.writeErr(`fake-agent: ${error.message}\n`);
    return DATA_ERROR;
  }

  if (scenario.stderr !== '') ports.writeErr(scenario.stderr);

  if (!scenario.hangForever) return exitCode;
  // Not an exit code of any value: a wedged agent that reported one would let
  // a client call the run finished, and every timeout path below would be dead
  // code (docs/07-provider-adapter-layer.md §2.5).
  ports.hangForever();
  return null;
}
