/**
 * KAR-19.10 AC4 — one sentence, three surfaces.
 *
 * The red: the CLI, `GET /api/runs/:id` and the UI each derive "which agent is
 * this run on" separately, and two of them disagree — which is precisely how
 * `doctor` and admission came to disagree in the first place. So the sentence
 * is one pure function over three facts, it lives in the package all three
 * surfaces already depend on, and `test/one-provider-announcement.test.ts`
 * asserts at source that nothing else composes one.
 *
 * Verifies: EPIC-19-S67 · AC4, AC5
 */
import { expect, it, describe as suite } from 'vitest';
import {
  announceProviderChoice,
  PROVIDER_ROUTES,
  type ProviderChoiceFacts,
  routeLabel,
} from './provider-choice.ts';

const choice = (over: Partial<ProviderChoiceFacts> = {}): ProviderChoiceFacts => ({
  provider: 'mock',
  binaryPath: '/tmp/deflow-bin/DeFlow-mock-agent',
  route: 'shim',
  ...over,
});

suite('announceProviderChoice — the three facts, in one line', () => {
  it('names the provider, the absolute binary path and the route', () => {
    const line = announceProviderChoice(choice());
    expect(line).toContain('mock');
    expect(line).toContain('/tmp/deflow-bin/DeFlow-mock-agent');
    expect(line).toContain('exec shim');
  });

  it('is one line — a run preamble is one line or it is noise', () => {
    expect(announceProviderChoice(choice()).includes('\n')).toBe(false);
  });

  it('names the ACP route by the words the operator reads in doctor', () => {
    expect(announceProviderChoice(choice({ route: 'acp' }))).toContain('ACP adapter');
  });

  it('labels every route in the closed set', () => {
    expect([...PROVIDER_ROUTES]).toEqual(['acp', 'shim']);
    for (const route of PROVIDER_ROUTES) expect(routeLabel(route).length).toBeGreaterThan(0);
  });

  it('says the same thing about the same run every time it is asked', () => {
    expect(announceProviderChoice(choice())).toBe(announceProviderChoice(choice()));
  });
});
