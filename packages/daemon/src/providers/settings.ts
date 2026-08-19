/**
 * KAR-25.3 AC3 — the one place a resolution learns it is disabled.
 *
 * `provider_setting` (`@DeFlow/ledger`, migration 0018) holds one boolean per
 * provider; `@DeFlow/adapters`' `ProviderResolution.disabled` is what
 * `providerRoutes` actually reads. This module is the seam between them —
 * every caller that needs a disabled-aware reduction goes through
 * `disabledProviderIds` and `withDisabled` rather than reading
 * `provider_setting` for itself, which is what keeps "disabled" one fact
 * stamped onto the value everywhere it is asked about (`../boot.ts`'s
 * `providerResolutions` thunk, `../pipeline/live-chain.ts`'s `chooseProvider`,
 * `../providers/quota-reroute.ts`'s `quotaRouteFor`, `../http/api.ts`'s
 * `GET /providers`, and — through this package's public export — `deflow
 * doctor`'s `agentChecks` and `deflow setup`'s adapter-verification step)
 * instead of six call sites each re-deriving it from the table.
 */
import type { ProviderResolution } from '@DeFlow/adapters';
import type { Db } from '@DeFlow/core';
import { listProviderSettings } from '@DeFlow/ledger';

/** Every provider id this machine currently has disabled. Cheap: the table
 *  holds only the exceptions (`ProviderSettingRecord`'s own doc comment). */
export function disabledProviderIds(db: Db): ReadonlySet<string> {
  return new Set(
    listProviderSettings(db)
      .filter((row) => row.disabled)
      .map((row) => row.provider),
  );
}

/** `resolutions`, with `disabled` stamped on wherever `disabled` names it —
 *  and left exactly as given everywhere else, including a resolution that
 *  already carried `disabled: true` from an earlier stamping. */
export function withDisabled(
  resolutions: readonly ProviderResolution[],
  disabled: ReadonlySet<string>,
): readonly ProviderResolution[] {
  return resolutions.map((resolution) =>
    disabled.has(resolution.provider) ? { ...resolution, disabled: true } : resolution,
  );
}
