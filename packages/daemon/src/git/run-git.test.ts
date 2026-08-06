/**
 * KAR-07.1 AC7 — `gitChildEnv()` keeps `SSH_AUTH_SOCK`: the `Git` wrapper is
 * the only thing in DeFlow that pushes, and it needs the user's forwarded
 * agent (docs/09-workspace-and-safety.md §1.1, §15-security-model.md §4.1).
 */
import { expect, it, describe as suite } from 'vitest';
import { gitChildEnv } from './run-git.ts';

suite('gitChildEnv (AC7)', () => {
  it('keeps SSH_AUTH_SOCK from the base environment', () => {
    const env = gitChildEnv({ SSH_AUTH_SOCK: '/tmp/agent.sock', PATH: '/usr/bin' });
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/agent.sock');
  });

  it('sets LC_ALL/LANG to C and disables terminal prompts, without dropping anything else', () => {
    const env = gitChildEnv({ SSH_AUTH_SOCK: '/tmp/agent.sock', HOME: '/home/dev' });
    expect(env).toMatchObject({
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      HOME: '/home/dev',
      LC_ALL: 'C',
      LANG: 'C',
      GIT_TERMINAL_PROMPT: '0',
    });
  });
});
