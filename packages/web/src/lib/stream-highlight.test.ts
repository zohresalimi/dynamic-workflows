/**
 * KAR-17.5 test plan row 6 — a 2,000-chunk stream, and the cost of the last
 * chunk against the cost of the first.
 *
 * Verifies: EPIC-17-S21 (scenario 4) · AC2
 *
 * The row's red is *"the whole buffer is re-highlighted per chunk"*, and that
 * build **looks correct**: every token is right, the colours are right, and the
 * only symptom is that a panel left open on a chatty agent gets slower and
 * slower until the tab stops responding — an hour in, on somebody else's
 * machine. So the assertion has to be about the *shape of the cost curve*, not
 * about a wall-clock budget, because a budget large enough to pass on a loaded
 * CI box is large enough to pass for the quadratic build too.
 *
 * **Measured against a control on the same machine**, the way EPIC-05 measured
 * its two timing budgets. The control is the naive implementation — re-tokenise
 * the whole accumulated buffer on every chunk — run here, now, on this box. If
 * the metric cannot tell the control apart from the real thing, the metric is
 * broken and the test says so rather than passing.
 *
 * The control is 400 chunks rather than 2,000 because it is quadratic by
 * construction and 2,000 of them is minutes. That is not a weaker control: it
 * only has to *grow*, and it grows from the second chunk.
 */
import { expect, it, describe as suite } from 'vitest';
import { ensureGrammar, HIGHLIGHTER_THEMES, sharedHighlighter } from './highlighter.ts';
import { createStreamHighlighter } from './stream-highlight.ts';

/** One chunk of plausible agent output — a token or two, as a vendor emits. */
const chunk = (index: number): string =>
  index % 9 === 8 ? `\nconst v${index} = ${index};` : ` w${index}`;

/** The mean of a slice, in milliseconds. */
const mean = (values: readonly number[]): number =>
  values.reduce((total, one) => total + one, 0) / values.length;

/**
 * How much more the tail of a run costs than its head.
 *
 * A ratio rather than a difference, so the number means the same thing on a
 * fast machine and a slow one — which is the whole reason a curve is asserted
 * and not a duration.
 */
function growth(times: readonly number[], window: number): number {
  const head = mean(times.slice(0, window));
  const tail = mean(times.slice(-window));
  // A head of zero happens when the first chunks are under the clock's
  // resolution; the floor keeps the ratio finite and is stated rather than
  // hidden, because it biases *against* this test passing.
  return tail / Math.max(head, 0.001);
}

suite('AC2 / row 6 — incremental highlighting is measured, not assumed', () => {
  it('keeps per-chunk time flat over 2,000 chunks, where the naive version grows', {
    timeout: 120_000,
  }, async () => {
    const stream = await createStreamHighlighter('typescript');

    const streamed: number[] = [];
    for (let index = 0; index < 2_000; index += 1) {
      const started = performance.now();
      await stream.push(chunk(index));
      streamed.push(performance.now() - started);
    }

    // The control: the same input, tokenised the way a build that had never
    // heard of @shikijs/stream would do it.
    const highlighter = await sharedHighlighter();
    const lang = await ensureGrammar('typescript');
    const naive: number[] = [];
    let buffer = '';
    for (let index = 0; index < 400; index += 1) {
      buffer += chunk(index);
      const started = performance.now();
      highlighter.codeToTokens(buffer, {
        lang: lang ?? 'typescript',
        themes: HIGHLIGHTER_THEMES,
        defaultColor: false,
      });
      naive.push(performance.now() - started);
    }

    const naiveGrowth = growth(naive, 40);
    const streamedGrowth = growth(streamed, 200);

    // First: the measurement can see the failure it is looking for. Without
    // this the assertion below passes on a machine so fast that nothing is
    // measurable, which is the worst kind of green.
    expect(
      naiveGrowth,
      `the control did not grow (${naiveGrowth.toFixed(2)}×) — this measurement proves nothing`,
    ).toBeGreaterThan(3);

    // Then: the real thing does not do that. Generous against the control's
    // own number rather than absolute, because the ratio that matters is
    // "flat versus linear", not "under some constant".
    expect(
      streamedGrowth,
      `streamed ${streamedGrowth.toFixed(2)}× over 2,000 chunks; control ${naiveGrowth.toFixed(2)}× over 400`,
    ).toBeLessThan(naiveGrowth / 2);
    expect(streamedGrowth).toBeLessThan(4);

    stream.close();
  });

  it('produces the tokens it was asked for, so speed is not bought with silence', async () => {
    const stream = await createStreamHighlighter('typescript');

    await stream.push('const answer');
    await stream.push(' = 42;\n');
    await stream.push('const other = 7;\n');

    const tokens = stream.tokens();
    expect(tokens.length).toBeGreaterThan(4);
    expect(tokens.map((one) => one.content).join('')).toContain('const answer = 42;');
    // Colour, not just text: a "highlighter" returning uncoloured tokens would
    // be very fast and completely useless.
    expect(tokens.some((one) => (one.htmlStyle ?? one.color) !== undefined)).toBe(true);

    stream.close();
  });

  it('falls back to plain tokens for a language this build does not carry', async () => {
    // A grammar-less stream must still render. The panel's job is to show the
    // output, and an unknown language is not an error dialog.
    const stream = await createStreamHighlighter('brainfuck');

    await stream.push('++++[>++++<-]');
    expect(
      stream
        .tokens()
        .map((one) => one.content)
        .join(''),
    ).toContain('++++');

    stream.close();
  });
});
