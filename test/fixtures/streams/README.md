# `stream-json` fixtures

One committed line-stream per situation the parsers have to read, in the dialect the vendor emits.

## `compact-boundary.stream-json.jsonl`

The stream EPIC-09's Definition of Ready calls for: a `system` / `compact_boundary` frame followed
by a `result` envelope with a populated `modelUsage`. It is what KAR-09.6's parser specs read, and
what the fake exec-shim agent reproduces for the integration specs.

**It is synthetic, and that is stated here rather than implied.** The *shape* is the one recorded
from Claude Code 2.1.220 — `fixtures/cli-shapes/claude-code@2.1.220.json`, captured by execution on
2026-08-02, plus the `compact_boundary` frame decoded from the same bundle's zod schemas
(`compact_metadata` carries `trigger` and `pre_tokens`, and nothing else). The *bytes* were written
by hand from that record: capturing a real compaction costs real quota against a developer's own
subscription, needs credentials CI does not have, and would put a raw transcript of somebody's
machine into the repository. Every identifier here is fabricated and every path is relative.

What keeps it honest is that nothing downstream is allowed to trust it alone:

- `packages/testkit/src/exec-shim/frames.test.ts` holds the fake vendor's frames against the
  recorded shape, so the fake cannot drift into a frame no real CLI emits;
- the `compact_boundary` and `modelUsage` shapes are re-asserted against the installed CLI by the
  conformance battery, which is where a vendor change is supposed to be caught — by `DeFlow doctor`,
  not by a failed three-hour run.

The `system` / `status` line before the boundary is deliberate: it drives a spinner and must **not**
produce a second `context.compacted` event (EPIC-09-S31, second scenario).

## `codex-turn-completed.jsonl`

The other half of KAR-14.1's Tier-1 corpus: `codex exec --json`'s JSONL, ending in the
`turn.completed` frame whose `usage` carries `input_tokens`, `cached_input_tokens` and
`output_tokens`. It is what proves the two dialects normalise to **one** `TokenUsage` — a rollup
that reported Claude's spend and Codex's spend in two different shapes would be two rollups.

**It is synthetic for the same reasons, stated the same way.** The shape is the one
`docs/08-context-and-memory.md` §7 records from Codex CLI 0.146.0, captured on 2026-08-02; the bytes
were written by hand from that record rather than recorded, because capturing a real turn spends
real quota against a developer's own subscription and would put a transcript of somebody's machine
into the repository. Every identifier here is fabricated.

Three things about it are deliberate:

- **The counts are the same figures the Claude fixture carries** (18,420 in / 2,310 out), so a test
  that normalises both can assert one shape rather than two, and a parser that read the wrong
  dialect's field would produce a `null` rather than a plausible number.
- **`cached_input_tokens`, not `cacheReadInputTokens`.** The vendor's spelling, unnormalised on
  disk, because the normalisation is what `turnCompletedReport` is for and a pre-normalised fixture
  would test nothing.
- **No cost and no window anywhere in the file.** This dialect reports neither, and a fixture that
  invented them would let a parser that defaulted them pass.
