/**
 * KAR-09.4 — `.DeFlow/config.yaml`, as far as this story needs it.
 *
 * The file itself is read in `@DeFlow/daemon`; what lives here is the shape and
 * the two lookups, so a malformed `pinReinjectTurns` is a rejection with a path
 * rather than a `NaN` that quietly disables the mechanism it configures.
 *
 * Verifies: EPIC-09-S23 (background), EPIC-09-S22 (third scenario) · AC4, AC5
 */
import { expect, it, describe as suite } from 'vitest';
import { DEFAULT_AUTOCOMPACT_PCT } from './compaction.ts';
import {
  compactionLeverFor,
  configuredConstraints,
  parseDeFlowConfig,
  patchPolicyOf,
  pinReinjectTurnsFor,
} from './deflow-config.ts';
import { DEFAULT_PATCH_RULE_SPECS } from './patch-policy.ts';
import { PIN_REINJECT_TURNS_DEFAULT } from './reinjection.ts';

suite('pinReinjectTurnsFor (AC5)', () => {
  it('reads the interval for the named provider', () => {
    const config = parseDeFlowConfig({
      providers: { claude: { pinReinjectTurns: 8 }, codex: { pinReinjectTurns: 5 } },
    });

    expect(pinReinjectTurnsFor(config, 'claude')).toBe(8);
    expect(pinReinjectTurnsFor(config, 'codex')).toBe(5);
  });

  it('defaults to 8 for a provider the file never mentions', () => {
    const config = parseDeFlowConfig({ providers: { claude: { pinReinjectTurns: 5 } } });

    expect(pinReinjectTurnsFor(config, 'gemini')).toBe(PIN_REINJECT_TURNS_DEFAULT);
  });

  it('defaults to 8 for an empty file', () => {
    expect(pinReinjectTurnsFor(parseDeFlowConfig(null), 'claude')).toBe(PIN_REINJECT_TURNS_DEFAULT);
  });

  it('refuses an interval of zero rather than disabling the mechanism silently', () => {
    expect(() => parseDeFlowConfig({ providers: { claude: { pinReinjectTurns: 0 } } })).toThrow(
      /pinReinjectTurns/,
    );
  });
});

suite('configuredConstraints (AC4)', () => {
  it('parses the structured run-config constraints', () => {
    const config = parseDeFlowConfig({
      constraints: [
        { form: 'allow-only', subject: 'write-path', allowed: ['src/checkout/**'] },
        { form: 'forbid', subject: 'exfiltrate credentials', forbidden: ['.env'] },
      ],
    });

    expect(configuredConstraints(config)).toEqual([
      { form: 'allow-only', subject: 'write-path', allowed: ['src/checkout/**'] },
      { form: 'forbid', subject: 'exfiltrate credentials', forbidden: ['.env'] },
    ]);
  });

  it('is empty rather than undefined when none are configured', () => {
    expect(configuredConstraints(parseDeFlowConfig({}))).toEqual([]);
  });

  it('refuses a prose constraint, because there is no free-prose path into a pin', () => {
    expect(() =>
      parseDeFlowConfig({ constraints: ['do not write outside src/checkout'] }),
    ).toThrow();
  });
});

suite('the rest of the file', () => {
  it('is carried through untouched, so one story does not narrow the config', () => {
    const config = parseDeFlowConfig({ scheduling: { maxParallel: 3 } });

    expect(config).toMatchObject({ scheduling: { maxParallel: 3 } });
  });
});

suite('the compaction lever, per provider (KAR-09.6 AC7, AC8)', () => {
  it('reads autocompactPct for the named provider', () => {
    const config = parseDeFlowConfig({ providers: { claude: { autocompactPct: 55 } } });

    expect(compactionLeverFor(config, 'claude', 'worktree')).toEqual({
      autocompactPct: 55,
      autoCompactDisabled: false,
    });
  });

  it('defaults a write-capable node to 70% when the file says nothing', () => {
    expect(compactionLeverFor(parseDeFlowConfig(null), 'claude', 'full')).toEqual({
      autocompactPct: DEFAULT_AUTOCOMPACT_PCT,
      autoCompactDisabled: false,
    });
  });

  it('carries a read node’s DISABLE_AUTO_COMPACT opt-in through', () => {
    const config = parseDeFlowConfig({ providers: { claude: { disableAutoCompact: true } } });

    expect(compactionLeverFor(config, 'claude', 'read')).toEqual({
      autocompactPct: null,
      autoCompactDisabled: true,
    });
  });

  it('refuses a percentage outside 1–100 rather than clamping one nobody typed', () => {
    expect(() => parseDeFlowConfig({ providers: { claude: { autocompactPct: 0 } } })).toThrow(
      /autocompactPct/,
    );
    expect(() => parseDeFlowConfig({ providers: { claude: { autocompactPct: 101 } } })).toThrow(
      /autocompactPct/,
    );
  });
});

/**
 * KAR-11.4 AC3, AC10 — `policy.patch` in the operator's own file
 * (docs/06-planning-and-replanning.md §4.3).
 */
suite('the patch policy table (KAR-11.4 AC3)', () => {
  it('uses the eight documented defaults when the file declares no policy.patch', () => {
    const resolved = patchPolicyOf(parseDeFlowConfig({ providers: {} }));

    expect(resolved.source).toBe('default');
    expect(resolved.rules).toEqual(DEFAULT_PATCH_RULE_SPECS);
  });

  it('uses the defaults for a file that has no policy key at all', () => {
    expect(patchPolicyOf(parseDeFlowConfig(null)).rules).toEqual(DEFAULT_PATCH_RULE_SPECS);
  });

  it('takes the operator’s table verbatim, in the order they wrote it', () => {
    const rules = [
      { id: 'expensive', when: { costDeltaUsd: '> 50.00' }, decision: 'approve' },
      { id: 'default', decision: 'approve' },
    ];
    const resolved = patchPolicyOf(parseDeFlowConfig({ policy: { patch: { rules } } }));

    expect(resolved.source).toBe('config');
    expect(resolved.rules).toEqual(rules);
  });

  it('refuses a rule whose comparison cannot be evaluated, naming the file’s own path', () => {
    expect(() =>
      parseDeFlowConfig({
        policy: {
          patch: {
            rules: [{ id: 'expensive', when: { costDeltaUsd: 'lots' }, decision: 'approve' }],
          },
        },
      }),
    ).toThrow(/costDeltaUsd/);
  });

  it('refuses a decision outside auto | approve | reject', () => {
    expect(() =>
      parseDeFlowConfig({ policy: { patch: { rules: [{ id: 'x', decision: 'maybe' }] } } }),
    ).toThrow();
  });
});
