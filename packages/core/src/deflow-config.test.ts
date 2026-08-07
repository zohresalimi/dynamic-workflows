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
import { configuredConstraints, parseDeFlowConfig, pinReinjectTurnsFor } from './deflow-config.ts';
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
