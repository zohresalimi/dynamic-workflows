/**
 * KAR-04.4 — the six named capability profiles, generated from the
 * capability-matrix fixture rather than typed by hand.
 *
 * docs/07-provider-adapter-layer.md §5 states the rule this module exists to
 * enforce: "This table is a test fixture to re-probe, never a hardcoded
 * constant." `fixtures/capability-matrix.json` is that fixture — the exact
 * `agentCapabilities` block each of the five real adapters returned on
 * 2026-08-02, plus a sixth, synthetic `mock-full` profile that advertises
 * everything. `CAPABILITY_PROFILES` below is *computed* from it by
 * `generateCapabilityProfiles`, not hand-written, so
 * `test/capability-profiles.test.ts` can re-parse the fixture independently
 * and catch the day someone edits one without the other (AC2).
 *
 * Three shapes appear on purpose (AC3): gemini omits `sessionCapabilities`
 * entirely, copilot's is `{ list: {} }` rather than a boolean, and codex is
 * the only profile whose `mcpCapabilities` carries explicit `false` rather
 * than an absent key. Naive optional-chaining flattens all three into one —
 * which is precisely the bug this fixture exists to make visible in a unit
 * test instead of hours into a real multi-hour run.
 *
 * **`CAPABILITY_PROFILES` is computed from a *statically imported* copy of
 * the fixture, found by KAR-18.6 (2026-08-12).** A `readFileSync` against
 * `CAPABILITY_MATRIX_PATH` (`import.meta.url`-relative) resolves correctly
 * inside the workspace, where this file is a sibling of
 * `../fixtures/capability-matrix.json` — but tsdown inlines this module's
 * *code* into `packages/cli/dist/mock-agent.mjs` without carrying the fixture
 * along, so the same relative path in the tarball points at
 * `packages/cli/dist/fixtures/capability-matrix.json`, which `files:
 * ["dist"]` never ships. The result was not a graceful degradation: every
 * invocation of the installed `deflow-mock-agent` binary, including `--version`,
 * threw `ENOENT` at import time, before a single line of argv parsing ran —
 * caught by `e2e/install-verification.test.ts`'s EPIC-18-S42 spec, which runs
 * the real packed tarball rather than the workspace source. The `import …
 * with { type: 'json' }` below makes the JSON part of the module graph tsdown
 * already bundles, so there is no path to resolve at runtime at all — in the
 * workspace or in the tarball. `CAPABILITY_MATRIX_PATH` and
 * `readCapabilityMatrix` stay: `test/capability-profiles.test.ts`'s AC2 spec
 * needs an independent read of the fixture off disk to compare against, and
 * that test only ever runs against workspace source.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import capabilityMatrixFixture from '../fixtures/capability-matrix.json' with { type: 'json' };

/** In this exact order: it is also the order AC2's error message lists. */
export const CAPABILITY_PROFILE_NAMES = [
  'claude',
  'codex',
  'opencode',
  'copilot',
  'gemini',
  'mock-full',
] as const;

export type CapabilityProfileName = (typeof CAPABILITY_PROFILE_NAMES)[number];

/** Ships inside the package tarball — see `files` in package.json. */
export const CAPABILITY_MATRIX_PATH = fileURLToPath(
  new URL('../fixtures/capability-matrix.json', import.meta.url),
);

/**
 * The raw fixture shape: one arbitrary JSON block per profile name. "Arbitrary"
 * is deliberate — a measured `initialize` response is whatever the vendor
 * actually sent, not whatever this package's own `AgentCapabilities` type
 * happens to describe this month (§5's "resume": true is a plain boolean;
 * the current ACP SDK types session capabilities as object-or-null. Both are
 * real: the fixture is a snapshot of the wire, not of the SDK).
 */
export type CapabilityMatrix = Readonly<Record<string, unknown>>;

export type CapabilityProfiles = Readonly<Record<CapabilityProfileName, unknown>>;

function isCapabilityProfileName(name: string): name is CapabilityProfileName {
  return (CAPABILITY_PROFILE_NAMES as readonly string[]).includes(name);
}

/**
 * The build-time step AC2 requires: validates the fixture names exactly the
 * six expected profiles — no more, no fewer — and returns them keyed and
 * frozen. Every profile block is passed through verbatim; this function's job
 * is completeness, not reshaping.
 */
export function generateCapabilityProfiles(matrix: CapabilityMatrix): CapabilityProfiles {
  const names = Object.keys(matrix);

  const missing = CAPABILITY_PROFILE_NAMES.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new Error(`capability-matrix fixture is missing profile(s): ${missing.join(', ')}`);
  }

  const unknown = names.filter((name) => !isCapabilityProfileName(name));
  if (unknown.length > 0) {
    throw new Error(`capability-matrix fixture has unexpected profile(s): ${unknown.join(', ')}`);
  }

  const profiles = {} as Record<CapabilityProfileName, unknown>;
  for (const name of CAPABILITY_PROFILE_NAMES) profiles[name] = matrix[name];
  return Object.freeze(profiles);
}

/** An independent read of the fixture off disk — workspace-only; see
 * `test/capability-profiles.test.ts`'s AC2 spec, the reason this stays. */
function readCapabilityMatrix(): CapabilityMatrix {
  return JSON.parse(readFileSync(CAPABILITY_MATRIX_PATH, 'utf8')) as CapabilityMatrix;
}

/**
 * The six named profiles, generated from a *statically imported* copy of the
 * fixture — part of this module's own bundle in the tarball, not a path
 * resolved at runtime. See the module doc comment above.
 */
export const CAPABILITY_PROFILES: CapabilityProfiles = generateCapabilityProfiles(
  capabilityMatrixFixture as CapabilityMatrix,
);
