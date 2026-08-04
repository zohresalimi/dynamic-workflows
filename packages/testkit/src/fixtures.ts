/**
 * The extended `it` every later epic imports.
 *
 * `import { it } from '@DeFlow/testkit'` in place of vitest's own `it`, then
 * destructure the fixtures a spec needs. Fixtures are lazy — asking for none
 * costs nothing, and `agentPath` implies `tmp` without the spec saying so.
 */
import { it as base } from 'vitest';
import { type AgentOnPath, linkFakeAgent } from './agent.ts';
import { TestClock } from './clock.ts';
import { makeTempDir, removeTempDir } from './tmp.ts';

export interface DeFlowFixtures {
  /** A fresh `<os tmpdir>/DeFlow-<random>`, removed unless DeFlow_KEEP_TMP is set. */
  tmp: string;
  /** A fake agent binary linked into `<tmp>/bin`, plus the PATH that finds it. */
  agentPath: AgentOnPath;
  /** A manually-advanced Clock, starting at 0. */
  clock: TestClock;
}

export const it = base.extend<DeFlowFixtures>({
  tmp: async ({}, use) => {
    const dir = await makeTempDir();
    await use(dir);
    await removeTempDir(dir);
  },

  agentPath: async ({ tmp }, use) => {
    await use(await linkFakeAgent(tmp));
  },

  clock: async ({}, use) => {
    await use(new TestClock());
  },
});
