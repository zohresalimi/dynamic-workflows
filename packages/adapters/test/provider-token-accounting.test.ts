/**
 * KAR-14.1 AC4 — what each vendor claims it can count, as data.
 *
 * `tokenAccounting` sits beside `family` in the one file allowed to name
 * vendors, and for the identical reason KAR-09.7 put `family` there: it cannot
 * be probed. An `initialize` response says what an agent can *do*; no field in
 * it says whether the CLI underneath prints a token count when it finishes.
 * You have to know that Claude Code emits `modelUsage` before you can ask it
 * anything, exactly as you have to know that OpenCode takes a subcommand.
 *
 * The honest default is `'none'`, and it is the whole point of the field.
 * Roadmap A4-3 records that only Claude Code and Codex were checked (on
 * 2026-08-02); the other four are **Unverified**. A provider that turns out to
 * report nothing must be a column in a table, degrading to a blank cost cell,
 * rather than a code fork discovered three hours into a run.
 *
 * Verifies: EPIC-14-S3 · KAR-14.1 AC4
 */
import { ProviderIdSchema } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { PROVIDER_SPECS, providerTokenAccounting } from '../src/index.ts';

const accounting = (id: string) => providerTokenAccounting(ProviderIdSchema.parse(id));

suite('every registered provider states its accounting fidelity', () => {
  it('states one for each of the verified adapters', () => {
    for (const spec of Object.values(PROVIDER_SPECS)) {
      expect(['exact', 'estimated', 'none']).toContain(spec.tokenAccounting);
    }
  });

  it("names the two that were verified, and only those, as 'exact'", () => {
    expect(accounting('claude')).toBe('exact');
    expect(accounting('codex')).toBe('exact');

    // A4-3: Unverified, so the honest answer is that DeFlow cannot price them.
    for (const id of ['gemini', 'copilot', 'opencode']) {
      expect(accounting(id), `${id} claims an accounting fidelity nobody measured`).toBe('none');
    }
  });

  it("answers 'none' for a provider that is not registered at all", () => {
    // The failure this refuses is the expensive one: an unknown provider that
    // defaulted to 'exact' would have its zero-cost turns charted as free.
    expect(accounting('not-a-provider')).toBe('none');
  });
});
