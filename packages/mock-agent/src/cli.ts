/**
 * The binary's argv, and the one rule that governs it: an argument this version
 * does not understand is an error, never a default.
 *
 * A silent fallback here would make a whole test file green for the wrong
 * reason — `--capabilities gemini` quietly ignored is a suite that proves the
 * Gemini profile works when it was never selected.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITY_PROFILE_NAMES, type CapabilityProfileName } from './capability-profiles.ts';
import { DEFAULT_REPLAY_SPEED, REPLAY_SPEEDS, type ReplaySpeed } from './replay.ts';
import { IDEMPOTENCY_FLAGS } from './side-effect-log.ts';

export const BIN_NAME = 'DeFlow-mock-agent';

/** Used when `--seed` is absent, so an unseeded run is still reproducible. */
export const DEFAULT_SEED = 0;

/** `--scenario`'s environment equivalent, for a spawn that owns no argv. */
export const SCENARIO_ENV = 'DeFlow_MOCK_SCENARIO';

/** The scenario library that ships inside the package (see `files` in package.json). */
export const BUILTIN_SCENARIO_DIR = fileURLToPath(new URL('../scenarios/', import.meta.url));

/**
 * One dedicated flag per pathological behaviour (KAR-04.3 AC8).
 *
 * Each resolves to the *same shipped scenario file* the suite runs, never to a
 * second in-memory definition: two definitions of one behaviour drift, and the
 * drift is invisible until the day someone's reproduction stops reproducing.
 * `DeFlow-mock-agent --huge-line` is meant to be the whole bug report.
 */
export const PATHOLOGICAL_FLAGS: Readonly<Record<string, string>> = {
  '--hang-forever': 'hang-forever.jsonc',
  '--hang-forever-ignoring-cancel': 'hang-forever-ignoring-cancel.jsonc',
  '--exit-mid-turn': 'exit-mid-turn.jsonc',
  '--malformed-line': 'malformed-line.jsonc',
  '--invalid-frame': 'invalid-frame.jsonc',
  '--huge-line': 'huge-line.jsonc',
  '--no-newline': 'no-newline.jsonc',
};

/**
 * KAR-04.4 AC4 — the five capabilities a `--dishonest-capabilities` run can
 * lie about, mapped to the one request method each corresponds to.
 *
 * `additionalDirectories` maps to `session/new` rather than to a lifecycle
 * method of its own: it is a modifier on session creation, not a method, and
 * `session/new` is the request whose params it qualifies.
 */
export const DISHONEST_CAPABILITY_METHODS = {
  'session.resume': 'session/resume',
  'session.fork': 'session/fork',
  'session.list': 'session/list',
  'session.delete': 'session/delete',
  additionalDirectories: 'session/new',
} as const;

export type DishonestCapability = keyof typeof DISHONEST_CAPABILITY_METHODS;
export type DishonestMethod = (typeof DISHONEST_CAPABILITY_METHODS)[DishonestCapability];

function isDishonestCapability(value: string): value is DishonestCapability {
  return Object.hasOwn(DISHONEST_CAPABILITY_METHODS, value);
}

export const USAGE = `${BIN_NAME} — a deterministic ACP agent that runs as a real subprocess.

Usage:
  ${BIN_NAME} [--seed <n>] [--scenario <path>]

Options:
  --seed <n>          Seed for every generated id and timestamp. Default ${DEFAULT_SEED}.
                      Two runs at the same seed write byte-identical output.
  --scenario <path>   A JSON or JSONC scenario file describing the whole turn.
                      Also read from $${SCENARIO_ENV}; the flag wins.
                      Without one, the built-in greeting turn runs.
  --capabilities <name>       Selects a named agentCapabilities profile,
                              returned verbatim in the initialize response.
                              One of: ${CAPABILITY_PROFILE_NAMES.join(', ')}.
                              Without one, a fixed built-in default is used.
  --capabilities-file <path>  Supplies an arbitrary JSON block as
                              agentCapabilities instead of a named profile.
                              Cannot be combined with --capabilities.
  --dishonest-capabilities <capability>
                              Advertises <capability> as supported, then
                              answers its request with JSON-RPC -32601. One
                              of: ${Object.keys(DISHONEST_CAPABILITY_METHODS).join(', ')}.
  --replay <path>     Serves a captured session from a golden recording at
                      recordings/<provider>@<version>/<case>.ndjson instead of
                      generating a turn. Cannot be combined with --scenario, a
                      pathological flag, or any --capabilities flag: in this
                      mode every frame, every id and every timestamp comes out
                      of the file.
  --replay-speed <s>  "real" honours the recorded millisecond offsets between
                      consecutive agent frames; "max" (the default, and what CI
                      runs) emits as fast as the pipe allows.
  --run-id <id>       Recorded, with the three below, as one line in
  --node-id <id>      $DeFlow_SIDE_EFFECT_LOG when that variable is set, so
  --attempt <n>       "was this effect executed twice?" is a duplicate-key
  --ikey <key>        check on a text file. Also read from the environment.
  -h, --help          Print this text and exit 0.

Pathological behaviours — one flag each, so a reported bug is one command.
Each runs the shipped scenario of the same name; none may be combined with
--scenario or with each other.

  --hang-forever                    Stop mid-turn and never write again. Answers
                                    session/cancel by flushing a tail and ending
                                    the turn with stopReason "cancelled".
  --hang-forever-ignoring-cancel    The same wedge, deaf to session/cancel.
  --exit-mid-turn                   process.exit(1) mid-frame, leaving a
                                    truncated line on stdout.
  --malformed-line                  Write a line that is not JSON at all, then
                                    carry on with valid frames.
  --invalid-frame                   Write valid JSON that fails validation
                                    against the published ACP schema.
  --huge-line                       Write a single 10 MB line, in 64 KiB chunks.
  --no-newline                      Flood 64 KiB at a time and never emit \\n.

Speaks ACP protocol version 1 over newline-delimited JSON on stdin and stdout,
and exits 0 when stdin reaches EOF. It needs no credential, no network and no
vendor CLI.
`;

/**
 * How `agentCapabilities` was selected on argv. `'default'` keeps the fixed
 * built-in block KAR-04.1 shipped, unchanged (no test written against it may
 * break just because this story exists).
 */
export type CapabilitiesSelection =
  | { readonly kind: 'default' }
  | { readonly kind: 'name'; readonly name: CapabilityProfileName }
  | { readonly kind: 'file'; readonly path: string };

/** KAR-04.5 — the recording this run serves, and how fast it serves it. */
export interface ReplaySelection {
  readonly path: string;
  readonly speed: ReplaySpeed;
}

export interface MockAgentOptions {
  readonly seed: number;
  /** The scenario file named on argv, if any. */
  readonly scenarioPath: string | null;
  readonly capabilities: CapabilitiesSelection;
  readonly dishonestCapability: DishonestCapability | null;
  /** Non-null when `--replay` was given, in which case nothing else generates. */
  readonly replay: ReplaySelection | null;
}

export type ParsedArgv =
  | { readonly kind: 'run'; readonly options: MockAgentOptions }
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string };

export function parseArgv(argv: readonly string[]): ParsedArgv {
  let seed = DEFAULT_SEED;
  let scenarioPath: string | null = null;
  let behaviour: string | null = null;
  let capabilities: CapabilitiesSelection = { kind: 'default' };
  let dishonestCapability: DishonestCapability | null = null;
  let replayPath: string | null = null;
  let replaySpeed: ReplaySpeed | null = null;

  /** Two scripts and one turn is a silent choice, so it is refused instead. */
  const conflict = (flag: string, other: string): ParsedArgv => ({
    kind: 'error',
    message: `${flag} cannot be combined with ${other}`,
  });

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { kind: 'help' };

    if (argument !== undefined && PATHOLOGICAL_FLAGS[argument] !== undefined) {
      if (behaviour !== null) return conflict(argument, behaviour);
      if (scenarioPath !== null) return conflict(argument, '--scenario');
      if (replayPath !== null) return conflict(argument, '--replay');
      behaviour = argument;
      continue;
    }

    if (argument === '--replay') {
      const raw = argv[index + 1];
      if (raw === undefined || raw.startsWith('--')) {
        return { kind: 'error', message: '--replay needs a path to a recording' };
      }
      if (scenarioPath !== null) return conflict('--replay', '--scenario');
      if (behaviour !== null) return conflict('--replay', behaviour);
      replayPath = raw;
      index += 1;
      continue;
    }

    if (argument === '--replay-speed') {
      const raw = argv[index + 1];
      if (raw === undefined || !(REPLAY_SPEEDS as readonly string[]).includes(raw)) {
        return {
          kind: 'error',
          message:
            `--replay-speed needs one of: ${REPLAY_SPEEDS.join(', ')}` +
            `${raw === undefined ? '' : `, got "${raw}"`}`,
        };
      }
      replaySpeed = raw as ReplaySpeed;
      index += 1;
      continue;
    }

    if (argument === '--seed') {
      const raw = argv[index + 1];
      // Number.parseInt would read "--capabilities" as NaN and "12abc" as 12.
      // A seed that was silently misread is a determinism claim that quietly
      // stops being true, so both cases are rejected.
      if (raw === undefined || !/^\d+$/.test(raw)) {
        return {
          kind: 'error',
          message: `--seed needs a non-negative integer, got ${raw === undefined ? 'nothing' : `"${raw}"`}`,
        };
      }
      seed = Number.parseInt(raw, 10);
      index += 1;
      continue;
    }

    if (argument === '--scenario') {
      const raw = argv[index + 1];
      if (raw === undefined || raw.startsWith('--')) {
        return { kind: 'error', message: '--scenario needs a path to a scenario file' };
      }
      if (behaviour !== null) return conflict(behaviour, '--scenario');
      if (replayPath !== null) return conflict('--scenario', '--replay');
      scenarioPath = raw;
      index += 1;
      continue;
    }

    if (argument === '--capabilities') {
      const raw = argv[index + 1];
      if (raw === undefined || raw.startsWith('--')) {
        return { kind: 'error', message: '--capabilities needs a profile name' };
      }
      if (capabilities.kind === 'file') return conflict('--capabilities', '--capabilities-file');
      if (!(CAPABILITY_PROFILE_NAMES as readonly string[]).includes(raw)) {
        // AC5: no silent fallback to a default profile — a whole test file
        // green for the wrong reason is worse than a loud, early exit.
        return {
          kind: 'error',
          message: `--capabilities: unknown profile "${raw}" — choose one of: ${CAPABILITY_PROFILE_NAMES.join(', ')}`,
        };
      }
      capabilities = { kind: 'name', name: raw as CapabilityProfileName };
      index += 1;
      continue;
    }

    if (argument === '--capabilities-file') {
      const raw = argv[index + 1];
      if (raw === undefined || raw.startsWith('--')) {
        return { kind: 'error', message: '--capabilities-file needs a path to a JSON file' };
      }
      if (capabilities.kind === 'name') return conflict('--capabilities-file', '--capabilities');
      capabilities = { kind: 'file', path: raw };
      index += 1;
      continue;
    }

    if (argument === '--dishonest-capabilities') {
      const raw = argv[index + 1];
      if (raw === undefined || raw.startsWith('--')) {
        return { kind: 'error', message: '--dishonest-capabilities needs a capability name' };
      }
      if (!isDishonestCapability(raw)) {
        return {
          kind: 'error',
          message:
            `--dishonest-capabilities: unknown capability "${raw}" — choose one of: ` +
            `${Object.keys(DISHONEST_CAPABILITY_METHODS).join(', ')}`,
        };
      }
      dishonestCapability = raw;
      index += 1;
      continue;
    }

    // The idempotency fields belong to the side-effect log, which scans argv
    // itself — it has to work for an invocation whose argv is otherwise
    // unusable. They are accepted here only so they are not "unknown".
    if (argument !== undefined && (IDEMPOTENCY_FLAGS as readonly string[]).includes(argument)) {
      if (argv[index + 1] === undefined) {
        return { kind: 'error', message: `${argument} needs a value` };
      }
      index += 1;
      continue;
    }

    return { kind: 'error', message: `unknown argument "${argument ?? ''}"` };
  }

  // Validated after the loop so the flags may be given in either order — and
  // refused rather than ignored, because a --replay-speed nobody applied is a
  // cadence assertion that quietly measures the wrong thing.
  if (replayPath === null && replaySpeed !== null) {
    return { kind: 'error', message: '--replay-speed only means something alongside --replay' };
  }
  if (replayPath !== null && capabilities.kind !== 'default') {
    return conflict('--replay', `--capabilities${capabilities.kind === 'file' ? '-file' : ''}`);
  }
  if (replayPath !== null && dishonestCapability !== null) {
    return conflict('--replay', '--dishonest-capabilities');
  }

  return {
    kind: 'run',
    options: {
      seed,
      scenarioPath:
        behaviour === null
          ? scenarioPath
          : join(BUILTIN_SCENARIO_DIR, PATHOLOGICAL_FLAGS[behaviour] as string),
      capabilities,
      dishonestCapability,
      replay:
        replayPath === null
          ? null
          : { path: replayPath, speed: replaySpeed ?? DEFAULT_REPLAY_SPEED },
    },
  };
}
