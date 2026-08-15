/**
 * KAR-16.5 AC1 — `deflow replay <fixture> --speed <n>x --port <p>`.
 *
 * The argv layer only, kept apart from `./harness.ts` so the harness stays a
 * function a spec can call and this stays a parser a spec can call. EPIC-18
 * owns the `deflow` binary and its subcommand table; this is the body that
 * table will point `replay` at, and `pnpm dev:replay` runs it directly through
 * `./main.ts` in the meantime (AC8).
 *
 * Everything here refuses rather than guesses. A `--speed` it cannot read, a
 * port that is not a port, an unknown flag and a fixture that is not in the
 * corpus are each an error naming what was given — because every one of them
 * otherwise turns into *"the harness booted and nothing happened"*, which is
 * indistinguishable from a broken UI and is the exact opposite of what a
 * development harness is for.
 */
import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSpeed, type Speed } from './speed.ts';

/** Where the committed corpus lives, relative to this file. */
export const CORPUS_DIR = fileURLToPath(
  new URL('../../../../test/fixtures/runs/', import.meta.url),
);

/** The daemon's own default, so a replay is reachable where a daemon would be. */
export const DEFAULT_REPLAY_PORT = 7777;

export interface ReplayCommand {
  /** As given: a corpus name or a path. Resolved by `resolveFixture`. */
  readonly fixture: string;
  readonly speed: Speed;
  readonly port: number;
  readonly paused: boolean;
  readonly dev: boolean;
  readonly dataDir: string | undefined;
}

export class BadReplayArgv extends Error {
  constructor(message: string) {
    super(
      `${message}\n\n` +
        'usage: deflow replay <fixture> [--speed 1x|20x|50x|max] [--port <p>] [--paused] [--dev]\n' +
        '       <fixture> is a name from test/fixtures/runs/ or a path to an events.jsonl',
    );
    this.name = 'BadReplayArgv';
  }
}

/** `--flag value` and `--flag=value` both, because both get typed. */
function readValue(argv: readonly string[], index: number, flag: string): [string, number] {
  const inline = argv[index]?.slice(flag.length + 1);
  if (argv[index]?.startsWith(`${flag}=`) === true) {
    if (inline === undefined || inline === '')
      throw new BadReplayArgv(`${flag} was given no value`);
    return [inline, index];
  }
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new BadReplayArgv(`${flag} was given no value`);
  }
  return [next, index + 1];
}

function readPort(given: string): number {
  const port = Number(given);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new BadReplayArgv(`--port ${JSON.stringify(given)} is not a port (0–65535; 0 binds one)`);
  }
  return port;
}

export function parseReplayArgv(argv: readonly string[]): ReplayCommand {
  let fixture: string | undefined;
  let speed: Speed = parseSpeed('1x');
  let port = DEFAULT_REPLAY_PORT;
  let paused = false;
  let dev = false;
  let dataDir: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    const flag = argument.split('=')[0] ?? argument;

    if (!argument.startsWith('--')) {
      if (fixture !== undefined) {
        throw new BadReplayArgv(`two fixtures were given: ${fixture} and ${argument}`);
      }
      fixture = argument;
      continue;
    }

    switch (flag) {
      case '--speed': {
        const [value, next] = readValue(argv, index, '--speed');
        speed = parseSpeed(value);
        index = next;
        break;
      }
      case '--port': {
        const [value, next] = readValue(argv, index, '--port');
        port = readPort(value);
        index = next;
        break;
      }
      case '--data-dir': {
        const [value, next] = readValue(argv, index, '--data-dir');
        dataDir = value;
        index = next;
        break;
      }
      case '--paused':
        paused = true;
        break;
      case '--dev':
        dev = true;
        break;
      default:
        throw new BadReplayArgv(`${flag} is not a flag deflow replay knows`);
    }
  }

  if (fixture === undefined) throw new BadReplayArgv('no fixture was given');
  return { fixture, speed, port, paused, dev, dataDir };
}

/** Every recording in the corpus, in directory order. */
export function corpus(): readonly string[] {
  return readdirSync(CORPUS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * The `events.jsonl` `given` names — a corpus name, a directory, or the file
 * itself.
 *
 * All three because all three get typed: the epic writes
 * `fixtures/three-patches.jsonl` and a person types `three-patches`.
 */
export function resolveFixture(given: string, dir: string = CORPUS_DIR): string {
  const named = join(dir, given, 'events.jsonl');
  if (existsSync(named)) return named;

  const path = isAbsolute(given) ? given : resolve(process.cwd(), given);
  if (existsSync(path)) return path;

  throw new BadReplayArgv(
    `no recording called ${JSON.stringify(given)}: it is neither a file nor one of the ` +
      `corpus — ${corpus().join(', ')}`,
  );
}
