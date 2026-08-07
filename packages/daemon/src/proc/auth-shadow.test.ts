/**
 * KAR-08.8 — auth-shadowing detection, unit level.
 *
 * `buildChildEnv()` (KAR-08.4) already drops `ANTHROPIC_API_KEY` and its
 * peers by omission: they are not on the allowlist, so a base env carrying
 * one produces a child without it. What was still missing is what this file
 * covers — the *loud* half: a `provider.auth_shadow_stripped` event that
 * names the variable and the provider when subscription auth was selected
 * and a shadowing variable was present, a `provider.auth_mode` record for
 * both paths, and the `DeFlow doctor` check (EPIC-18, KAR-18.4 — this module
 * holds the policy ahead of that command existing, the same split
 * `../git/version.ts` uses for the git version floor).
 *
 * AC5 and AC6 — Copilot's `_meta["terminal-auth"]` rendered as a shell
 * command DeFlow never runs, and an empty `authMethods` array producing no
 * warning — are already built and tested by KAR-05.3's
 * `@DeFlow/adapters` `renderAuthMethods`/`reportAvailability`
 * (`packages/adapters/test/provider-registry.test.ts`, suite "authMethods is
 * rendered for the operator, never run"). Nothing here duplicates that
 * suite; this test only checks that this story's own new surface — shadow
 * detection and the doctor report — is correct.
 *
 * Verifies: EPIC-08-S31, EPIC-08-S32 · KAR-08.8 AC1, AC2, AC3, AC4 (test plan
 * #3, #5)
 */
import { ProviderIdSchema } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import {
  AUTH_SHADOW_VARS,
  checkAuthShadowing,
  resolveProviderAuth,
  shadowVarsFor,
} from './auth-shadow.ts';

const CLAUDE = ProviderIdSchema.parse('claude');
const CODEX = ProviderIdSchema.parse('codex');
const GEMINI = ProviderIdSchema.parse('gemini');

const SECRET = 'sk-ant-fixture-do-not-use';

suite('AUTH_SHADOW_VARS — data, not code (AC3)', () => {
  it('covers ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY and GOOGLE_API_KEY', () => {
    const byVariable = Object.fromEntries(
      AUTH_SHADOW_VARS.map((row) => [row.variable, row.provider]),
    );
    expect(byVariable.ANTHROPIC_API_KEY).toBe(CLAUDE);
    expect(byVariable.OPENAI_API_KEY).toBe(CODEX);
    expect(byVariable.GEMINI_API_KEY).toBe(GEMINI);
    expect(byVariable.GOOGLE_API_KEY).toBe(GEMINI);
  });

  it('is a plain array a new vendor is a one-line addition to', () => {
    expect(Array.isArray(AUTH_SHADOW_VARS)).toBe(true);
    for (const row of AUTH_SHADOW_VARS) {
      expect(Object.keys(row).toSorted()).toEqual(['provider', 'variable']);
    }
  });

  it('shadowVarsFor names every variable that shadows a given provider', () => {
    expect(shadowVarsFor(GEMINI).toSorted()).toEqual(['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
    expect(shadowVarsFor(CLAUDE)).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('a provider nothing shadows gets an empty list, not an error', () => {
    expect(shadowVarsFor(ProviderIdSchema.parse('copilot'))).toEqual([]);
  });
});

suite('resolveProviderAuth — subscription auth strips and reports (AC1, EPIC-08-S31)', () => {
  it('a shadowing variable present in base produces one auth_shadow_stripped event naming it', () => {
    const result = resolveProviderAuth({
      node: 'n1',
      attempt: 0,
      provider: CLAUDE,
      mode: 'subscription',
      base: { ANTHROPIC_API_KEY: SECRET },
    });

    expect(result.shadowStrippedEvents).toEqual([
      { node: 'n1', attempt: 0, provider: CLAUDE, variable: 'ANTHROPIC_API_KEY' },
    ]);
  });

  it('the shadow_stripped payload carries no value field at all', () => {
    const result = resolveProviderAuth({
      node: 'n1',
      attempt: 0,
      provider: CLAUDE,
      mode: 'subscription',
      base: { ANTHROPIC_API_KEY: SECRET },
    });
    const payload = result.shadowStrippedEvents[0];
    expect(payload).toBeDefined();
    expect(Object.keys(payload ?? {}).toSorted()).toEqual([
      'attempt',
      'node',
      'provider',
      'variable',
    ]);
    expect(JSON.stringify(payload)).not.toContain(SECRET);
  });

  it('the run-manifest record is provider.auth_mode "subscription"', () => {
    const result = resolveProviderAuth({
      node: 'n1',
      attempt: 0,
      provider: CLAUDE,
      mode: 'subscription',
      base: { ANTHROPIC_API_KEY: SECRET },
    });
    expect(result.mode).toBe('subscription');
    expect(result.authModeEvent).toEqual({
      node: 'n1',
      attempt: 0,
      provider: CLAUDE,
      mode: 'subscription',
    });
  });

  it('never asks buildChildEnv to pass the variable through', () => {
    const result = resolveProviderAuth({
      node: 'n1',
      attempt: 0,
      provider: CLAUDE,
      mode: 'subscription',
      base: { ANTHROPIC_API_KEY: SECRET },
    });
    expect(result.passthrough).toEqual([]);
  });

  it('no shadowing variable present in base — nothing to strip, no event', () => {
    const result = resolveProviderAuth({
      node: 'n1',
      attempt: 0,
      provider: CLAUDE,
      mode: 'subscription',
      base: {},
    });
    expect(result.shadowStrippedEvents).toEqual([]);
    expect(result.authModeEvent.mode).toBe('subscription');
  });

  it('mode defaults to subscription — DeFlow never invents an api_key mode', () => {
    const result = resolveProviderAuth({
      node: 'n1',
      attempt: 0,
      provider: CLAUDE,
      base: { ANTHROPIC_API_KEY: SECRET },
    });
    expect(result.mode).toBe('subscription');
  });
});

suite('resolveProviderAuth — the explicit api_key path (AC2, EPIC-08-S32)', () => {
  it('the variable is named for buildChildEnv to declare, so it reaches the child', () => {
    const result = resolveProviderAuth({
      node: 'n1',
      attempt: 0,
      provider: CLAUDE,
      mode: 'api_key',
      base: { ANTHROPIC_API_KEY: SECRET },
    });
    expect(result.passthrough).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('the run manifest records provider.auth_mode "api_key"', () => {
    const result = resolveProviderAuth({
      node: 'n1',
      attempt: 0,
      provider: CLAUDE,
      mode: 'api_key',
      base: { ANTHROPIC_API_KEY: SECRET },
    });
    expect(result.mode).toBe('api_key');
    expect(result.authModeEvent).toEqual({
      node: 'n1',
      attempt: 0,
      provider: CLAUDE,
      mode: 'api_key',
    });
  });

  it('no auth_shadow_stripped event is emitted on the api_key path', () => {
    const result = resolveProviderAuth({
      node: 'n1',
      attempt: 0,
      provider: CLAUDE,
      mode: 'api_key',
      base: { ANTHROPIC_API_KEY: SECRET },
    });
    expect(result.shadowStrippedEvents).toEqual([]);
  });

  it('a declared variable absent from base is simply absent — nothing invented', () => {
    const result = resolveProviderAuth({
      node: 'n1',
      attempt: 0,
      provider: CLAUDE,
      mode: 'api_key',
      base: {},
    });
    expect(result.passthrough).toEqual([]);
  });
});

suite('checkAuthShadowing — the doctor report (AC4)', () => {
  it('names the variable and the provider for every shadowing variable present', () => {
    const rows = checkAuthShadowing({
      ANTHROPIC_API_KEY: SECRET,
      GOOGLE_API_KEY: 'fixture-google',
    });
    expect(rows.map((r) => r.variable).toSorted()).toEqual(['ANTHROPIC_API_KEY', 'GOOGLE_API_KEY']);
    expect(rows.find((r) => r.variable === 'ANTHROPIC_API_KEY')?.provider).toBe(CLAUDE);
    expect(rows.find((r) => r.variable === 'GOOGLE_API_KEY')?.provider).toBe(GEMINI);
  });

  it('states the auth mode that will actually be used, and how to change it', () => {
    const rows = checkAuthShadowing({ ANTHROPIC_API_KEY: SECRET });
    const row = rows[0];
    expect(row?.effectiveMode).toBe('subscription');
    expect(row?.detail).toMatch(/subscription/);
    expect(row?.detail).toMatch(/ANTHROPIC_API_KEY/);
    // "how to change it" — an operator reading this can act on it.
    expect(row?.detail).toMatch(/unset|api_key|opt/i);
  });

  it('never prints the variable value, even when the value looks like a real key', () => {
    const rows = checkAuthShadowing({ ANTHROPIC_API_KEY: SECRET });
    const rendered = JSON.stringify(rows);
    expect(rendered).not.toContain(SECRET);
  });

  it('a provider explicitly configured for the api_key path reports that mode, not subscription', () => {
    const rows = checkAuthShadowing({ ANTHROPIC_API_KEY: SECRET }, new Map([[CLAUDE, 'api_key']]));
    const row = rows[0];
    expect(row?.effectiveMode).toBe('api_key');
    expect(row?.detail).toMatch(/api.key|API key/i);
  });

  it('reports nothing when no shadowing variable is present — an empty env is not a warning', () => {
    expect(checkAuthShadowing({})).toEqual([]);
  });

  it('does not flag an ordinary, non-shadowing variable', () => {
    expect(checkAuthShadowing({ MY_APP_FEATURE_FLAG: 'on' })).toEqual([]);
  });
});
