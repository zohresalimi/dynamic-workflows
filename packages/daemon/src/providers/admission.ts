/**
 * KAR-19.2 — what the daemon knows about this machine when a task is submitted.
 *
 * `boot-probe.ts` has always promised this: *"the daemon starts, reports what
 * to install, and refuses to schedule agent nodes later (NF7)"*. The refusal it
 * promised was never implemented, so "refuses to schedule" became "never
 * schedules, and says nothing" — which is the whole of the 2026-08-12 incident.
 * This module is the missing half, and it is deliberately tiny: it turns two
 * things that already happened at boot into the resolutions `admitRun` reduces.
 *
 * **Both halves are needed and neither is sufficient.**
 *
 *   * The **filesystem** answers "is the vendor CLI here, is its ACP bridge
 *     here" — two resolutions, which is what makes `adapter-missing` sayable
 *     at all (KAR-18.8). It cannot answer whether the bridge *works*.
 *   * The **boot probe** answers "did it speak ACP when we asked" — which is a
 *     spawn, and one this machine already paid for at boot. Re-asking at
 *     submission time would put a second of latency on the one path that has to
 *     feel instant, and would make KAR-18.2's `--timings` argument meaningless
 *     (AC6, EPIC-19-S12).
 *
 * So: resolve now (cheap, `statSync`-shaped), and fold the boot probe's verdict
 * on top. Nothing here spawns anything, reads a credential file or touches the
 * network — `test/one-install-renderer.test.ts` asserts the last of those over
 * this file's source rather than trusting it.
 *
 * Verifies: EPIC-19-S9, EPIC-19-S12, EPIC-19-S14 · AC1, AC6, AC7
 */
import { type ProviderResolution, resolveProviderStates } from '@DeFlow/adapters';
import type { ProviderDetectionEntry } from './detect.ts';

export interface AdmissionInput {
  /** `PATH`, split — the operator's own, as `DeFlow up` passed it down. */
  readonly roots: readonly string[];
  /** What the boot probe found. Empty when no probe ran this daemon life. */
  readonly probe: readonly ProviderDetectionEntry[];
}

/**
 * The registry's providers, in id order, as this daemon life sees them.
 *
 * A provider that resolves both binaries and whose probe came back
 * `probe-failed` is reported `handshake-failed` and never `not-installed`: a
 * broken bridge reported as an absent one is the worst outcome available,
 * because the operator uninstalls and reinstalls a package that was already
 * there — twice — before suspecting the daemon (AC7).
 */
export function admissionResolutions(input: AdmissionInput): readonly ProviderResolution[] {
  const probed = new Map(input.probe.map((entry) => [entry.provider, entry]));

  return resolveProviderStates(input.roots).map((resolution) => {
    const entry = probed.get(resolution.provider);
    if (resolution.state !== 'installed' || entry?.status !== 'probe-failed') return resolution;

    return {
      ...resolution,
      state: 'handshake-failed' as const,
      // The child's own words, forwarded rather than restated. `detect.ts`
      // carries them off `probeProvider`'s failure detail; when the child said
      // nothing at all the key is absent and `providerVerdict` says so out loud
      // rather than printing an empty quotation.
      ...(entry.stderr === undefined || entry.stderr === ''
        ? {}
        : { handshakeStderr: entry.stderr }),
    };
  });
}
