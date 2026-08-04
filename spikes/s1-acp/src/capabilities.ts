/**
 * The capability matrix is generated from what the agent advertised, never
 * from a constant.
 *
 * A0-9: the 2026-08-02 probe is a *snapshot*, and two of the five versions in
 * it were published the same day they were probed. It appears below only as
 * something to diff the observation against — the fixture that gets written is
 * always the observed value, and a contradiction is reported as news rather
 * than corrected into agreement.
 */
import type { CapabilityMatrix } from './report.ts';

/** What the 2026-08-02 live `initialize` probe recorded. Comparison input only. */
export const SNAPSHOT_2026_08_02: Record<string, { resume: boolean; list: boolean }> = {
  'claude-agent-acp': { resume: true, list: true },
  'gemini-cli': { resume: false, list: false },
  // The fake agent exists to contradict its own snapshot row on purpose.
  'fake-divergent': { resume: false, list: false },
};

interface RawCapabilities {
  loadSession?: unknown;
  sessionCapabilities?: Record<string, unknown> | null;
  mcpCapabilities?: Record<string, unknown> | null;
  promptCapabilities?: Record<string, unknown> | null;
}

/**
 * ACP spells "the agent supports X" as "the key X is present and not null" for
 * the session capabilities, and as a boolean elsewhere. Both are normalised to
 * a boolean here — the normalisation is the only interpretation applied, and
 * the untouched block is written to the fixture alongside it.
 */
const present = (block: Record<string, unknown> | null | undefined, key: string): boolean =>
  block !== null && block !== undefined && block[key] !== undefined && block[key] !== null;

const flag = (block: Record<string, unknown> | null | undefined, key: string): boolean =>
  block?.[key] === true;

/** Derives the matrix from the observed `agentCapabilities` block. */
export function observeMatrix(agentCapabilities: unknown): CapabilityMatrix {
  const observed = (agentCapabilities ?? {}) as RawCapabilities;
  const session = observed.sessionCapabilities ?? null;
  return {
    resume: present(session, 'resume'),
    list: present(session, 'list'),
    loadSession: observed.loadSession === true,
    mcpHttp: flag(observed.mcpCapabilities, 'http'),
    mcpSse: flag(observed.mcpCapabilities, 'sse'),
    mcpAcp: flag(observed.mcpCapabilities, 'acp'),
    promptImage: flag(observed.promptCapabilities, 'image'),
    promptAudio: flag(observed.promptCapabilities, 'audio'),
    promptEmbeddedContext: flag(observed.promptCapabilities, 'embeddedContext'),
  };
}

const yesNo = (value: boolean) => (value ? 'yes' : 'no');

/** Every place the observation contradicts the snapshot, stated in both directions. */
export function divergences(agent: string, observed: CapabilityMatrix): string[] {
  const snapshot = SNAPSHOT_2026_08_02[agent];
  if (!snapshot) return [];
  const notes: string[] = [];
  for (const key of ['resume', 'list'] as const) {
    if (snapshot[key] !== observed[key]) {
      notes.push(
        `session.${key}: snapshot ${yesNo(snapshot[key])}, observed ${yesNo(observed[key])}`,
      );
    }
  }
  return notes;
}

export interface CapabilityFixture {
  readonly agent: string;
  readonly version: string;
  readonly probedAt: string;
  readonly protocolVersion: number;
  readonly agentInfo: unknown;
  /** Verbatim, exactly as `initialize` returned it. */
  readonly agentCapabilities: unknown;
  readonly capabilityMatrix: CapabilityMatrix;
  readonly divergesFromSnapshot: string[];
}

export function buildFixture(input: {
  agent: string;
  version: string;
  probedAt: string;
  protocolVersion: number;
  agentInfo: unknown;
  agentCapabilities: unknown;
}): CapabilityFixture {
  const capabilityMatrix = observeMatrix(input.agentCapabilities);
  return {
    agent: input.agent,
    version: input.version,
    probedAt: input.probedAt,
    protocolVersion: input.protocolVersion,
    agentInfo: input.agentInfo,
    agentCapabilities: input.agentCapabilities,
    capabilityMatrix,
    divergesFromSnapshot: divergences(input.agent, capabilityMatrix),
  };
}
