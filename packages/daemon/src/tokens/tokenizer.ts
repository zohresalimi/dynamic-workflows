/**
 * KAR-09.7 Tier 2 — the `Tokenizer` port's one implementation
 * (docs/08-context-and-memory.md §7).
 *
 * **The import specifier is the whole story of this file.** `gpt-tokenizer`
 * publishes one entrypoint per encoding, and each pulls its own BPE ranks
 * module — ~2.2 MB for `o200k_base`, another ~1.1 MB for the next one. Reaching
 * for the barrel, or for `gpt-tokenizer/model/<name>`, is how a daemon ends up
 * carrying every table ever published for no accuracy gain at all. This is the
 * only file in the workspace allowed to name the package, and
 * `test/token-entrypoint.test.ts` asserts both halves: one BPE table in the
 * graph, under a stated byte budget.
 *
 * **One universal estimator for every provider**, not one per vendor. There is
 * no public exact tokenizer for Claude 3+, and the tiktoken-family undercount
 * is a systematic bias rather than noise — which means it is *correctable*, and
 * `@DeFlow/core`'s calibration is what corrects it, per (provider, model),
 * from measurements DeFlow already has. A second estimator would be a second
 * bias to learn, with no measurement to learn it from.
 *
 * The dead ends are worth restating because two of them look authoritative:
 * `@anthropic-ai/tokenizer` is still 0.0.4 and implements only the Claude
 * 1/2-era BPE — the package name is a trap; `js-tiktoken` works but is slower
 * with no accuracy gain; `tiktoken` / `@dqbd/tiktoken` add a wasm binary for no
 * accuracy gain, and NF6 says nothing in this workspace compiles at install
 * time; shelling out to Python adds a Python dependency to `npx deflowai up` and
 * still is not exact for Claude.
 *
 * Verifies: EPIC-09-S37 · KAR-09.7 AC1, AC3
 */
import type { TokenCount, Tokenizer } from '@DeFlow/core';
import { countTokens } from 'gpt-tokenizer/encoding/o200k_base';

/** The label every figure this module produces carries. */
const METHOD = 'gpt-tokenizer/o200k_base' as const;

/**
 * The Tier-2 tokenizer.
 *
 * A factory rather than a module-level constant so that the BPE table is not a
 * side effect of importing the module — a caller that never counts anything
 * should not pay two megabytes for the privilege, and a test that wants to
 * assert the graph should not have to load it.
 */
export function o200kTokenizer(): Tokenizer {
  return {
    method: METHOD,
    count(text: string): TokenCount {
      return { estimated: countTokens(text), method: METHOD };
    },
  };
}
