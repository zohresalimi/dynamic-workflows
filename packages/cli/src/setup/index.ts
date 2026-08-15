/**
 * `deflow setup`'s public surface: the argv parser `bin.ts` uses, and the
 * command itself.
 *
 * The parser lives here rather than in `bin.ts` for the reason every other
 * command's does — a refusal for a mistyped flag is a sentence somebody reads
 * at the worst possible moment, and a sentence is testable without a process.
 */
export {
  exitCodeFor,
  freshShellPath,
  parseVersion,
  profileTarget,
  SETUP_STEPS,
  type SetupStep,
  type SetupStepId,
  shellKind,
  windowsRefusal,
} from './plan.ts';
export { PROFILE_MARKER, profileHasLine } from './profile.ts';
export { runSetup, type SetupOptions, type SetupResult } from './run.ts';

export interface SetupArgs {
  readonly json: boolean;
  readonly yes: boolean;
  readonly fix: boolean;
  /** `--from <spec>`: the npm specifier to install. `undefined` means `deflow`. */
  readonly from: string | undefined;
}

export type ParsedSetupArgs =
  | { readonly ok: true; readonly args: SetupArgs }
  | { readonly ok: false; readonly message: string };

/**
 * `--json`, `--yes`, `--fix`, `--from <spec>` and `--no-color`.
 *
 * `-y` is accepted as `--yes` because that is what every installer on the
 * machine already accepts, and an operator who types it and gets a usage error
 * has been corrected on a point nobody cares about.
 */
export function parseSetupArgs(argv: readonly string[]): ParsedSetupArgs {
  let json = false;
  let yes = false;
  let fix = false;
  let from: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') json = true;
    else if (flag === '--yes' || flag === '-y') yes = true;
    else if (flag === '--fix') fix = true;
    else if (flag === '--no-color') continue;
    else if (flag === '--from') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        return {
          ok: false,
          message: 'deflow setup: --from needs an npm specifier, e.g. --from deflow@0.2.0',
        };
      }
      from = value;
      index += 1;
    } else {
      return { ok: false, message: `deflow setup: unknown option "${String(flag)}"` };
    }
  }

  return { ok: true, args: { json, yes, fix, from } };
}
