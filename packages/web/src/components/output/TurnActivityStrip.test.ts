/**
 * KAR-27.4 AC1 — the strip's facts are separated by real gutters.
 *
 * Verifies: EPIC-27-S22
 *
 * Real Chromium rather than jsdom, for the same reason `StateChip.test.ts`
 * gives: the claim is about a **computed** value resolved against a cascade,
 * and jsdom does not resolve one. That is not incidental here — it is the whole
 * defect. `gap: var(--space-2)` naming a token nothing declares is not a parse
 * error and not a warning; the declaration becomes invalid at computed-value
 * time and `gap` silently resolves to `normal`. Every assertion that could be
 * made without a real cascade — the class is applied, the rule is in the
 * stylesheet, the element is a flex row — passed the whole time the operator
 * was reading `framingattempt 1 of 3running 1m 24s…`.
 *
 * Per this epic's flow-file agreement the *values* are visual work and not
 * test-first; what is asserted here is only that they resolve to something
 * rather than to nothing. `test/web-css-tokens.test.ts` is the guard that keeps
 * every other component from repeating the mistake.
 */
import { expect, it, describe as suite } from 'vitest';
import { render } from 'vitest-browser-vue';
import type { ApiClient } from '../../api/client.ts';
import { API_CLIENT } from '../../api/provide.ts';
import '../../styles/theme.css';
import TurnActivityStrip from './TurnActivityStrip.vue';

/**
 * A client whose io endpoint answers an empty page.
 *
 * The strip polls on mount, and a spec that let it reach the page's own origin
 * would be asserting against a 404 the component deliberately swallows. Empty
 * is the honest fixture: the four facts render from props and the clock, which
 * is exactly the state this assertion is about.
 */
const emptyIo = {
  runs: {
    ':id': {
      nodes: {
        ':nodeId': { io: { $get: (): Promise<Response> => Promise.resolve(new Response('')) } },
      },
    },
  },
} as unknown as ApiClient;

const mount = (): ReturnType<typeof render> =>
  render(TurnActivityStrip, {
    props: {
      runId: 'run_20260825T000000Z_000000',
      node: 'framing',
      attempt: 1,
      maxAttempts: 3,
      sinceTs: Date.now() - 84_000,
    },
    global: { provide: { [API_CLIENT as symbol]: emptyIo } },
  });

suite('EPIC-27-S22 — the strip lays its facts out with gutters', () => {
  it('resolves a non-zero column gap', async () => {
    const screen = mount();
    const strip = screen.container.querySelector('[data-turn-activity]');

    expect(strip).not.toBeNull();

    const gap = globalThis.getComputedStyle(strip as Element).columnGap;

    // `normal` is what an invalid `gap` declaration leaves behind, and it is
    // zero on a flex row. Either spelling of the failure is caught here.
    expect(gap).not.toBe('normal');
    expect(Number.parseFloat(gap)).toBeGreaterThan(0);
  });

  it('resolves a non-zero row gap, so a wrapped line does not sit on the one above', async () => {
    const screen = mount();
    const strip = screen.container.querySelector('[data-turn-activity]');
    const gap = globalThis.getComputedStyle(strip as Element).rowGap;

    expect(gap).not.toBe('normal');
    expect(Number.parseFloat(gap)).toBeGreaterThan(0);
  });

  it('still names the four facts KAR-27.3 gave it', async () => {
    const screen = mount();

    await expect.element(screen.getByText('framing')).toBeVisible();
    await expect.element(screen.getByText('attempt 1 of 3')).toBeVisible();
    expect(screen.container.querySelector('[data-turn-elapsed]')?.textContent).toContain('running');
    expect(screen.container.querySelector('[data-turn-quiet]')).not.toBeNull();
  });
});
