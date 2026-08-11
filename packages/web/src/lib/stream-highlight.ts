/**
 * KAR-17.5 — incremental colourisation of a stream that never stops.
 *
 * Verifies: EPIC-17-S21 (scenario 4) · AC2
 *
 * `@shikijs/stream` exists for precisely this: *"highlighting text streams like
 * LLM outputs"*. `ShikiStreamTokenizer.enqueue(chunk)` re-tokenises only the
 * trailing region whose grammar state is not yet settled and answers
 * `{ recall, stable, unstable }`:
 *
 * - **`stable`** — tokens that cannot change however the stream continues.
 * - **`unstable`** — the tail, which the next chunk may re-interpret. A string
 *   literal is unstable until its closing quote arrives.
 * - **`recall`** — how many previously-emitted tokens the new chunk invalidated.
 *
 * That is the whole reason the cost per chunk does not grow with the buffer, and
 * `./stream-highlight.test.ts` measures it against the naive implementation on
 * the same machine rather than trusting this paragraph.
 *
 * **It uses the application's one highlighter** (`./highlighter.ts`, docs/12
 * §7). `ShikiStreamTokenizer` takes a `HighlighterCore` rather than making one,
 * so there is no second grammar registry and no second theme set — which is
 * what `test/one-shiki-instance.test.ts` is checking, and what would otherwise
 * cost a few hundred kilobytes in whichever chunk this landed in.
 *
 * A language this build does not carry is **not an error**. `ensureGrammar`
 * answers `null`, the tokenizer runs with no grammar, and the output is plain
 * uncoloured tokens — the panel still shows what the agent said, which is its
 * entire job.
 */
import type { ThemedToken } from '@shikijs/core';
import { ShikiStreamTokenizer } from '@shikijs/stream';
import { ensureGrammar, HIGHLIGHTER_THEMES, sharedHighlighter } from './highlighter.ts';

export interface StreamHighlighter {
  /** Feeds one chunk and returns the tokens as they now stand. */
  push(chunk: string): Promise<readonly ThemedToken[]>;
  /** Stable tokens plus the unsettled tail, in order. */
  tokens(): readonly ThemedToken[];
  /** Flushes the tail as stable — the stream ended. */
  close(): readonly ThemedToken[];
}

/**
 * A tokenizer over the shared highlighter, for one message's body.
 *
 * One per *message* rather than one per panel: a `tool_call`'s captured build
 * log and the agent's prose beside it are different grammars, and one tokenizer
 * spanning both would carry the grammar state of one into the other.
 */
export async function createStreamHighlighter(lang: string): Promise<StreamHighlighter> {
  const highlighter = await sharedHighlighter();
  const grammar = await ensureGrammar(lang);

  const tokenizer = new ShikiStreamTokenizer({
    highlighter,
    // `'text'` is Shiki's own no-grammar language and is always available; it
    // is what makes an unknown language render as plain text rather than throw.
    lang: grammar ?? 'text',
    themes: HIGHLIGHTER_THEMES,
    defaultColor: false,
  });

  const stable: ThemedToken[] = [];
  let unstable: readonly ThemedToken[] = [];

  const all = (): readonly ThemedToken[] => [...stable, ...unstable];

  return {
    async push(chunk: string): Promise<readonly ThemedToken[]> {
      const result = await tokenizer.enqueue(chunk);
      // `recall` counts back into what was already emitted, so it is applied to
      // the stable list before the new stable tokens are appended. Ignoring it
      // duplicates the tokens a re-interpreted literal produced.
      if (result.recall > 0) stable.splice(stable.length - result.recall, result.recall);
      stable.push(...result.stable);
      unstable = result.unstable;
      return all();
    },
    tokens: all,
    close(): readonly ThemedToken[] {
      const { stable: last } = tokenizer.close();
      stable.push(...last);
      unstable = [];
      return all();
    },
  };
}
