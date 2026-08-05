/**
 * The mock agent, dressed as a `ConformanceAdapter` — one factory, six
 * capability profiles.
 *
 * The capability row is **probed**, not read out of the fixture. Routing
 * trusts the probed row, and the whole of assertion 6 is the question of
 * whether that row is telling the truth about the binary standing behind it;
 * a row assembled from the same fixture the binary reads would agree with it
 * by construction and prove nothing.
 */
import type { ProviderId } from '@DeFlow/core';
import { ProviderIdSchema } from '@DeFlow/core';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AdapterFactory,
  ConformanceAdapter,
  ConformanceCase,
  ConformanceStage,
} from '../../../src/index.ts';
import { probeProvider } from '../../../src/index.ts';
import {
  liveInGroup,
  MOCK_AGENT_BIN,
  mockAgentBinary,
  scenario,
  type TestLedger,
} from './harness.ts';

/** The six named profiles, in the order `docs/07-provider-adapter-layer.md` §5
 * measured them. `mock-full` is the synthetic seventh column of that table. */
export const CONFORMANCE_PROFILES = [
  'claude',
  'codex',
  'opencode',
  'copilot',
  'gemini',
  'mock-full',
] as const;

export type ConformanceProfile = (typeof CONFORMANCE_PROFILES)[number];

/** How each case is staged against the mock. One row per assertion group. */
function argvFor(kase: ConformanceCase, profile: ConformanceProfile): string[] {
  const common = ['--seed', '42', '--capabilities', profile];
  switch (kase) {
    case 'turn':
      return [...common, '--scenario', scenario('minimal-turn.jsonc')];
    case 'cancel':
      // Wedges after two chunks and answers `session/cancel` by flushing a
      // tail — which is the half of assertion 4 implementations get wrong.
      return [...common, '--hang-forever'];
    case 'permission':
      return [...common, '--scenario', scenario('permission-branches.jsonc')];
    case 'capability-honesty':
      return common;
    case 'malformed-line':
      return [...common, '--malformed-line'];
    case 'oversized-frame':
      return [...common, '--huge-line'];
  }
}

export interface MockAdapterOptions {
  readonly profile: ConformanceProfile;
  readonly ledger: TestLedger;
  readonly clock: Parameters<typeof probeProvider>[1]['clock'];
  readonly dataDir: string;
  /** Advertised but refused, for the dishonesty run (KAR-04.4 `--dishonest-capabilities`). */
  readonly dishonest?: string;
}

/**
 * A factory for one profile. AC3's "adding an adapter adds one call site" is
 * the reason this returns a factory rather than being one.
 */
export function mockAdapter(options: MockAdapterOptions): AdapterFactory {
  return async (): Promise<ConformanceAdapter> => {
    const provider: ProviderId = ProviderIdSchema.parse(`mock-${options.profile}`);
    const cwd = join(options.dataDir, 'probe', options.profile);
    await mkdir(cwd, { recursive: true });

    const probed = await probeProvider(
      {
        provider,
        binaryPath: MOCK_AGENT_BIN,
        argv: ['--capabilities', options.profile],
        cwd,
      },
      {
        clock: options.clock,
        ledger: options.ledger.sink,
        capabilities: options.ledger.capabilities,
      },
    );

    const dishonest =
      options.dishonest === undefined ? [] : ['--dishonest-capabilities', options.dishonest];

    return {
      name: `mock-agent:${options.profile}${options.dishonest === undefined ? '' : ` (dishonest ${options.dishonest})`}`,
      capabilityRow: probed.row,
      stage(kase: ConformanceCase): ConformanceStage {
        return {
          kind: 'target',
          binary: mockAgentBinary(),
          argv: [...argvFor(kase, options.profile), ...dishonest],
        };
      },
    };
  };
}

export { liveInGroup };
