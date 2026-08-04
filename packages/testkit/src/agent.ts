/**
 * Putting a fake binary on PATH (docs/14-testing-strategy.md §3.3).
 *
 * The fixture returns both halves on purpose. `pathEnv` is what a child process
 * should be given so a bare `claude` resolves; `binary` is the resolved
 * absolute path, and **that is what production code must store**. DeFlowd's
 * PATH at daemon start is not the user's login-shell PATH, so any code that
 * relies on a lookup at spawn time works under test and fails under the daemon.
 */
import { accessSync, constants } from 'node:fs';
import { mkdir, symlink } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The real executable that gets linked. */
export const FAKE_AGENT_BIN = fileURLToPath(new URL('../bin/fake-agent.ts', import.meta.url));

export interface AgentOnPath {
  /** The name the binary is linked as — the name a provider CLI would have. */
  readonly name: string;
  /** The tmp `bin/` directory holding the link. */
  readonly binDir: string;
  /** Absolute path to the link. What production code stores. */
  readonly binary: string;
  /** `PATH` with `binDir` prepended. What a spawned child should be given. */
  readonly pathEnv: string;
}

/**
 * Symlinks the fake agent into `<tmp>/bin/<name>` and returns it alongside a
 * PATH that finds it.
 *
 * The link keeps no `.ts` extension, exactly like a real vendor CLI. Node
 * resolves the symlink to its target before choosing a loader, so the target's
 * `.ts` extension is what gets type-stripped — verified on Node 24.18.0.
 */
export async function linkFakeAgent(tmp: string, name = 'claude'): Promise<AgentOnPath> {
  // Losing the executable bit is not a loud failure: the shell skips the link
  // during PATH lookup and finds the developer's *real* vendor CLI further
  // along, and the spec then tests that instead. Fail here rather than there.
  try {
    accessSync(FAKE_AGENT_BIN, constants.X_OK);
  } catch {
    throw new Error(
      `${FAKE_AGENT_BIN} is not executable. Restore it with "chmod +x" — without the bit, a PATH ` +
        `lookup for "${name}" silently finds a real vendor CLI instead of this fake.`,
    );
  }

  const binDir = join(tmp, 'bin');
  await mkdir(binDir, { recursive: true });
  const binary = join(binDir, name);
  await symlink(FAKE_AGENT_BIN, binary);
  return {
    name,
    binDir,
    binary,
    pathEnv: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
  };
}
