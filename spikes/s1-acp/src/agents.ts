/**
 * What to spawn for each agent, and at which exact version.
 *
 * The two vendor agents are the ones the story names, and the choice is
 * deliberate: Claude Code does not speak ACP natively (verified absent from
 * `claude --help` v2.1.220), so the community *adapter* is the real risk
 * surface (A0-2); `gemini --acp` is a native-ACP agent and the cheapest to
 * authenticate.
 *
 * They are run through `npx` at a pinned exact version rather than installed
 * as dependencies of this spike, so that `pnpm install` here stays small
 * enough for CI and the vendor binary is never a build-time artefact of this
 * repository. Set `SPIKE_ACP_BIN_<NAME>` to point at a local checkout instead.
 */
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('..', import.meta.url));

export interface AgentSpec {
  readonly name: string;
  readonly version: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly kind: 'vendor' | 'fake';
  /** The prompt used for the permission turn, or null for fakes that ignore it. */
  readonly permissionPrompt: string;
  readonly cancelPrompt: string;
}

const PERMISSION_PROMPT =
  'Create a file named forbidden.txt in the current directory containing the word hello. Use the Write tool.';
const CANCEL_PROMPT =
  'Count slowly from 1 to 400, writing one number per line with a short comment about each number. Do not use any tools. Take your time.';

function fake(name: string, mode: string): AgentSpec {
  return {
    name,
    version: '9.9.9',
    command: process.execPath,
    args: [`${here}agents/fake-agent.ts`, '--mode', mode],
    kind: 'fake',
    permissionPrompt: PERMISSION_PROMPT,
    cancelPrompt: CANCEL_PROMPT,
  };
}

function vendor(name: string, version: string, spec: string, args: string[]): AgentSpec {
  const override = process.env[`SPIKE_ACP_BIN_${name.toUpperCase().replaceAll('-', '_')}`];
  return {
    name,
    version,
    command: override ?? 'npx',
    args: override ? args : ['-y', spec, ...args],
    kind: 'vendor',
    permissionPrompt: PERMISSION_PROMPT,
    cancelPrompt: CANCEL_PROMPT,
  };
}

export function agentSpec(name: string): AgentSpec {
  switch (name) {
    case 'claude-agent-acp':
      return vendor(name, '0.64.1', '@agentclientprotocol/claude-agent-acp@0.64.1', []);
    case 'gemini-cli':
      return vendor(name, '0.53.1', '@google/gemini-cli@0.53.1', ['--acp']);
    // Real binaries, spawned as real child processes, that produce the three
    // failure shapes a vendor cannot be asked for on demand.
    case 'fake-flood':
      return fake(name, 'flood');
    case 'fake-deadlock':
      return fake(name, 'deadlock');
    case 'fake-trailing':
      return fake(name, 'trailing');
    case 'fake-divergent':
      return fake(name, 'divergent');
    default:
      throw new Error(`unknown agent "${name}"`);
  }
}
