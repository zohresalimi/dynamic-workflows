/**
 * The binary's argv, and the one rule that governs it: an argument this version
 * does not understand is an error, never a default.
 *
 * A silent fallback here would make a whole test file green for the wrong
 * reason — `--capabilities gemini` quietly ignored is a suite that proves the
 * Gemini profile works when it was never selected.
 */

export const BIN_NAME = 'DeFlow-mock-agent';

/** Used when `--seed` is absent, so an unseeded run is still reproducible. */
export const DEFAULT_SEED = 0;

export const USAGE = `${BIN_NAME} — a deterministic ACP agent that runs as a real subprocess.

Usage:
  ${BIN_NAME} [--seed <n>]

Options:
  --seed <n>    Seed for every generated id and timestamp. Default ${DEFAULT_SEED}.
                Two runs at the same seed write byte-identical output.
  -h, --help    Print this text and exit 0.

Speaks ACP protocol version 1 over newline-delimited JSON on stdin and stdout,
and exits 0 when stdin reaches EOF. It needs no credential, no network and no
vendor CLI.
`;

export interface MockAgentOptions {
  readonly seed: number;
}

export type ParsedArgv =
  | { readonly kind: 'run'; readonly options: MockAgentOptions }
  | { readonly kind: 'help' }
  | { readonly kind: 'error'; readonly message: string };

export function parseArgv(argv: readonly string[]): ParsedArgv {
  let seed = DEFAULT_SEED;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { kind: 'help' };

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

    return { kind: 'error', message: `unknown argument "${argument ?? ''}"` };
  }

  return { kind: 'run', options: { seed } };
}
