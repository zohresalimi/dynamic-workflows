/**
 * KAR-04.1 — the binary is reached by a resolved absolute path, never by a
 * `PATH` lookup at spawn time.
 *
 * DeFlowd's `PATH` at daemon start differs from the user's login shell — a
 * silent, machine-specific failure that presents as "works for me"
 * (docs/07-provider-adapter-layer.md §4.3). The second half of this file is the
 * regression test that stops anyone simplifying the resolution step away: under
 * a launchd-shaped `PATH` the bare vendor name is `ENOENT`, and the stored
 * absolute path still starts.
 *
 * Verifies: EPIC-04-S3
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { MOCK_AGENT_BIN } from '../support/harness.ts';

const run = promisify(execFile);

/**
 * What DeFlowd sees when it is started from a launchd or systemd unit: the
 * system directories and its own Node runtime, and none of the login shell's
 * additions. Node's directory is there because DeFlowd is a Node process and
 * always knows where its interpreter lives — the shebang could not resolve
 * otherwise, and pretending it could would make this scenario fail for a reason
 * that has nothing to do with the rule under test. Neither directory holds a
 * `claude`, which is the whole point of the third case below.
 */
const DAEMON_PATH = `/usr/bin:/bin:${dirname(process.execPath)}`;

let tmp = '';
let binDir = '';
let linked = '';

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'DeFlow-'));
  binDir = join(tmp, 'bin');
  await mkdir(binDir, { recursive: true });
  linked = join(binDir, 'claude');
  await symlink(MOCK_AGENT_BIN, linked);
});

afterEach(async () => {
  if (process.env.DeFlow_KEEP_TMP === undefined) await rm(tmp, { recursive: true, force: true });
});

suite('EPIC-04-S3 — spawned by resolved absolute path', () => {
  it('resolves to an absolute path inside the temp directory', () => {
    expect(isAbsolute(MOCK_AGENT_BIN)).toBe(true);
    expect(isAbsolute(linked)).toBe(true);
    expect(linked.startsWith(tmp)).toBe(true);
    expect(
      `${binDir}${delimiter}${process.env.PATH ?? ''}`.startsWith(`${binDir}${delimiter}`),
    ).toBe(true);
  });

  it('starts from the stored absolute path under a daemon-shaped PATH', async () => {
    const { stdout } = await run(linked, ['--help'], { env: { PATH: DAEMON_PATH } });
    expect(stdout).toContain('DeFlow-mock-agent');
  });

  it('fails with ENOENT when the bare vendor name is spawned instead', async () => {
    // This is the failure a NodeFailure with reason "adapter.spawn-failed" has
    // to be built from, and it is the one that never happens on the developer's
    // machine because their login shell PATH finds the binary.
    const failure = await run('claude', ['--help'], { env: { PATH: DAEMON_PATH } }).then(
      () => null,
      (error: NodeJS.ErrnoException) => error,
    );
    expect(failure?.code).toBe('ENOENT');
  });
});
