/**
 * A fake `gh` for KAR-10.1's issue-resolution tests and KAR-22.4's connector
 * tests.
 *
 * **The generator moved to `./fake-cli-bin.ts` in KAR-22.6**, which needed the
 * identical fixture for Atlassian's `acli`. Two nearly-identical shell-script
 * generators would have been the duplication that story exists to avoid, so
 * this file is now the `gh`-shaped name for one of them and nothing else. The
 * types are re-exported so KAR-10.1's and KAR-22.4's specs read exactly as they
 * did.
 */
import {
  type FakeCliBin,
  type FakeCliRoute,
  type WriteFakeCliOptions,
  writeFakeCli,
} from './fake-cli-bin.ts';

export type FakeGhBin = FakeCliBin;
export type FakeGhRoute = FakeCliRoute;
export type WriteFakeGhOptions = WriteFakeCliOptions;

/** Writes an executable `gh` to `<tmp>/fake-gh-bin/gh`. See `./fake-cli-bin.ts`. */
export function writeFakeGh(tmp: string, options: WriteFakeGhOptions = {}): Promise<FakeGhBin> {
  return writeFakeCli(tmp, 'gh', options);
}
