/**
 * KAR-08.8 — auth-shadowing detection and reporting
 * (docs/15-security-model.md §2.3, docs/07-provider-adapter-layer.md).
 *
 * `ANTHROPIC_API_KEY` present in DeFlowd's own environment **silently
 * shadows subscription auth** in Claude Code — the user believes they are on
 * their subscription and is being billed per token. `buildChildEnv()`
 * (KAR-08.4, `./env.ts`) already prevents the billing half: the variable is
 * not on the allowlist, so it never reaches the child unless a node
 * explicitly declares it. What that leaves is the *loud* half this module
 * builds — the invariant is that the effective auth mode of every provider
 * is a recorded, rendered fact, never something inferred from a bill:
 *
 *  - `resolveProviderAuth()` decides, per node attempt, whether a shadowing
 *    variable should reach the child at all (only when the node explicitly
 *    selected the api_key path) and what belongs in the ledger either way —
 *    a `provider.auth_mode` record always, a `provider.auth_shadow_stripped`
 *    record when subscription auth silently dropped one.
 *  - `checkAuthShadowing()` is the `deflow doctor` check (EPIC-18, KAR-18.4
 *    — this module holds the policy ahead of that command existing, the same
 *    split `../git/version.ts` uses for the git version floor): every
 *    provider whose environment carries a shadowing variable, the auth mode
 *    that will actually be used, and how to change it.
 *
 * **The shadowing variable set is data (AC3).** `AUTH_SHADOW_VARS` is a
 * plain array, not a set of `if` branches, so a new vendor's env-var
 * convention is a one-line addition and nothing here has to be taught a new
 * shape.
 *
 * AC5 (Copilot's `_meta["terminal-auth"]` rendered as a shell command DeFlow
 * never runs) and AC6 (an empty `authMethods` array is the normal,
 * already-authenticated case and produces no warning) are already built and
 * tested by KAR-05.3's `@DeFlow/adapters` `renderAuthMethods` /
 * `reportAvailability` — see `packages/adapters/src/provider-availability.ts`
 * and its suite "authMethods is rendered for the operator, never run". They
 * are a different half of the same story and are not duplicated here.
 *
 * Verifies: EPIC-08-S31, EPIC-08-S32 · KAR-08.8 AC1, AC2, AC3, AC4
 */
import { type ProviderAuthMode, type ProviderId, ProviderIdSchema } from '@DeFlow/core';

/** One environment variable that shadows one provider's subscription auth. */
export interface AuthShadowVar {
  readonly variable: string;
  readonly provider: ProviderId;
}

/**
 * §2.3's shadowing set, stated once. Two rows for Gemini because Google's own
 * CLI honours both names — `GOOGLE_API_KEY` is the older Gemini API
 * convention, `GEMINI_API_KEY` the newer one, and either shadows the same
 * subscription auth (AC3).
 *
 * Provider ids match `packages/adapters/src/provider-registry.ts`'s
 * `PROVIDER_SPECS` keys, because a caller ordinarily has a `ProviderId` that
 * came from there (a node's `provider.scheduled` event) and this table has
 * to answer questions about the same value.
 */
export const AUTH_SHADOW_VARS: readonly AuthShadowVar[] = [
  { variable: 'ANTHROPIC_API_KEY', provider: ProviderIdSchema.parse('claude') },
  { variable: 'OPENAI_API_KEY', provider: ProviderIdSchema.parse('codex') },
  { variable: 'GEMINI_API_KEY', provider: ProviderIdSchema.parse('gemini') },
  { variable: 'GOOGLE_API_KEY', provider: ProviderIdSchema.parse('gemini') },
];

/** Every shadowing variable name that affects `provider`, in table order. An
 * empty array for a provider `AUTH_SHADOW_VARS` names no row for — most of
 * them, since only vendors with an env-var API-key convention appear at all. */
export function shadowVarsFor(provider: ProviderId): readonly string[] {
  return AUTH_SHADOW_VARS.filter((row) => row.provider === provider).map((row) => row.variable);
}

export interface ResolveProviderAuthInput {
  readonly node: string;
  readonly attempt: number;
  readonly provider: ProviderId;
  /**
   * What the node's provider config selected. Defaults to `'subscription'` —
   * DeFlow never invents an `api_key` mode; something in the plan config has
   * to have selected it explicitly (§2.3's "explicit, per-provider, opt-in").
   */
  readonly mode?: ProviderAuthMode;
  /** DeFlowd's own environment, or a fixture in a test — the same `base`
   * `buildChildEnv()` reads, and deliberately never `process.env` read here
   * directly, for the same reason. */
  readonly base: NodeJS.ProcessEnv;
}

/** `provider.auth_shadow_stripped`'s payload — `variable` only, never a
 * value: there is no field here one could put a secret in. */
export interface ProviderAuthShadowStrippedPayload {
  readonly node: string;
  readonly attempt: number;
  readonly provider: ProviderId;
  readonly variable: string;
}

/** `provider.auth_mode`'s payload — the fact the run report and the cost
 * report both read, rather than infer. */
export interface ProviderAuthModePayload {
  readonly node: string;
  readonly attempt: number;
  readonly provider: ProviderId;
  readonly mode: ProviderAuthMode;
}

export interface ResolvedProviderAuth {
  readonly mode: ProviderAuthMode;
  /**
   * Variable names to add to `buildChildEnv()`'s `declared` list, so the
   * caller's own env reaches the child. Non-empty only on the api_key path,
   * and only for a variable actually present in `base` — asking for one
   * nobody set invents nothing, the same rule `declared` already keeps.
   */
  readonly passthrough: readonly string[];
  readonly authModeEvent: ProviderAuthModePayload;
  /**
   * Present only when subscription auth was selected and a shadowing
   * variable is present in `base` — the loud record of what
   * `buildChildEnv()`'s allowlist already does quietly by never adding it.
   */
  readonly shadowStrippedEvents: readonly ProviderAuthShadowStrippedPayload[];
}

/**
 * The whole decision, in one place: what a node's child environment should
 * receive, and what the ledger should say about it (AC1, AC2).
 */
export function resolveProviderAuth(input: ResolveProviderAuthInput): ResolvedProviderAuth {
  const mode = input.mode ?? 'subscription';
  const vars = shadowVarsFor(input.provider);
  const present = vars.filter((name) => input.base[name] !== undefined);

  const authModeEvent: ProviderAuthModePayload = {
    node: input.node,
    attempt: input.attempt,
    provider: input.provider,
    mode,
  };

  if (mode === 'api_key') {
    return { mode, passthrough: present, authModeEvent, shadowStrippedEvents: [] };
  }

  return {
    mode,
    passthrough: [],
    authModeEvent,
    shadowStrippedEvents: present.map((variable) => ({
      node: input.node,
      attempt: input.attempt,
      provider: input.provider,
      variable,
    })),
  };
}

/** One row of `deflow doctor`'s auth-shadowing report. */
export interface AuthShadowDoctorRow {
  readonly provider: ProviderId;
  readonly variable: string;
  /** The auth mode that will actually be used, given the caller's configured
   * modes (or `'subscription'`, the default, when the provider is not
   * configured at all). */
  readonly effectiveMode: ProviderAuthMode;
  /** Names the variable and states the auth mode; never the value. */
  readonly detail: string;
}

/**
 * `deflow doctor`'s auth-shadowing check (AC4): every provider whose
 * environment carries a shadowing variable, the auth mode that will actually
 * be used, and how to change it — reported before a run ever starts, from
 * `base` alone, never a value.
 *
 * `configuredModes` is what the operator's `.DeFlow/config.yaml` selected per
 * provider, if anything; a provider absent from it defaults to
 * `'subscription'`, the same default `resolveProviderAuth` uses.
 */
export function checkAuthShadowing(
  base: NodeJS.ProcessEnv,
  configuredModes: ReadonlyMap<ProviderId, ProviderAuthMode> = new Map(),
): readonly AuthShadowDoctorRow[] {
  const rows: AuthShadowDoctorRow[] = [];

  for (const { variable, provider } of AUTH_SHADOW_VARS) {
    if (base[variable] === undefined) continue;
    const effectiveMode = configuredModes.get(provider) ?? 'subscription';
    const detail =
      effectiveMode === 'subscription'
        ? `${variable} is set, but ${provider} is configured for subscription auth: it will be ` +
          `stripped before the agent runs. Unset ${variable}, or opt ${provider} into the api_key ` +
          `auth mode to use it deliberately.`
        : `${variable} is set and ${provider} is configured to use it: this provider will run on ` +
          `API-key billing, not your subscription.`;
    rows.push({ provider, variable, effectiveMode, detail });
  }

  return rows;
}
