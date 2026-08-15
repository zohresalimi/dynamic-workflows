# ADR 0015: FTS5 and BM25 only for retrieval at M1

**Status:** Accepted · **Date:** 2 August 2026 · **Deciders:** Meg

## Context

F6.7 (semantic retrieval over a run's own artifacts and prior runs) is **P1**, not P0. The reflex
implementation in 2026 is embeddings plus a vector index, and for this corpus that reflex is wrong on
the merits as well as on the timing.

**What DeFlow's corpus actually is**: stack traces, test output, diffs, file paths, symbol names,
error codes, commit messages, gate verdicts. Overwhelmingly _exact-match_ territory — BM25's
strongest suit and dense retrieval's weakest. The 2026 hybrid-search literature is consistent that
embeddings conflate identifiers differing by a few characters, which is catastrophic exactly where
it matters: `getUserById` and `getUsersById` are not the same function, and a retriever that thinks
they are will hand an agent the wrong context with high confidence.

DeFlow also already has git, ripgrep and the file tree, and the vendor CLIs ship excellent repo
search of their own. Retrieval here is over _DeFlow's_ artifacts, not over the user's codebase.

And the infrastructure argument is decisive under NF6 (`npx deflowai up`, no database server, no
Docker for the core). **Verified 2026-08-02** on Node 22.22.2: `better-sqlite3@13.0.2` bundles
**SQLite 3.53.4 compiled with `ENABLE_FTS5`**; `CREATE VIRTUAL TABLE ... USING fts5(...)` works, and
`bm25()` ranking with `ORDER BY rank` returns sensible results. Zero extra dependencies, zero build
step, no model download, no extension loading, no Docker — and because
[ADR 0007](./0007-better-sqlite3-over-node-sqlite.md) pins the driver, the SQL behaviour does not
drift with the user's Node install.

## Decision

**Retrieval at M1 is SQLite FTS5 with BM25 ranking, and nothing else. No embeddings until a
semantic-recall miss is actually measured.**

```sql
CREATE VIRTUAL TABLE artifact_fts USING fts5(
  title, body, kind UNINDEXED, node_id UNINDEXED, run_id UNINDEXED,
  tokenize = "unicode61 remove_diacritics 2 tokenchars '_-.'"
);

SELECT node_id,
       snippet(artifact_fts, 1, '[', ']', '…', 24) AS s,
       bm25(artifact_fts, 2.0, 1.0) AS score
FROM artifact_fts WHERE artifact_fts MATCH ?1 ORDER BY rank LIMIT 20;
```

**The `tokenchars '_-.'` setting is the one non-obvious detail and it is load-bearing.** Without it
FTS5 splits on underscores, hyphens and dots, so `snake_case` identifiers, `kebab-case` names and
`file.ext` paths are shredded into fragments and recall on code collapses. This is the difference
between a retriever that works on this corpus and one that does not, and it is one line of schema.

The `bm25(artifact_fts, 2.0, 1.0)` weighting boosts title matches over body matches.

Retrieval sits inside packet assembly, under a hard token budget expressed as a fraction of the
target adapter's declared `maxContext` — default 50%, never above 60%. Full detail, along with the
"offload, don't summarise" rule that governs what happens when the budget is exceeded, is in
[08-context-and-memory.md](../08-context-and-memory.md).

## Consequences

### Positive

- **Zero marginal dependency cost.** FTS5 is already in the binary already being shipped. NF6 is
  satisfied outright, with no model download and no first-run latency.
- BM25 is the right ranker for a corpus of identifiers, paths and error strings — this is not a
  compromise made for simplicity, it is the better retriever for this data.
- Fully offline (NF1), fully deterministic, and testable with no network and no model.
- `deflow doctor` can report FTS5 availability in one line.

### Negative

- **No semantic recall.** A query phrased differently from the indexed text will miss. "The bit that
  handles logging in" will not retrieve `authenticateSession`. This is a real capability gap and it
  is accepted for M1 on the grounds that F6.7 is P1 and the gap has not been measured yet.
- Query quality falls on the caller. A node asking for context must produce reasonable keywords.

### Neutral

- Run events stay in the global ledger (every table keyed by `run_id`), with cross-run project memory
  in a separate `.DeFlow/memory/project.db`, so retention and GC have different lifecycles. The FTS
  index follows the same split.

## Alternatives considered

- **Embeddings from day one (sqlite-vec, LanceDB, local Qdrant).** Rejected on all three axes:
  wrong retriever for this corpus, unproven need for a P1 feature, and infrastructure weight.
  LanceDB and Qdrant violate NF6 directly.
- **`sqlite-vss`.** Rejected outright: **deprecated by its own author** (Alex Garcia) in favour of
  `sqlite-vec`. Do not start there.
- **libSQL's native vector type.** A real option if we were already on libSQL — but
  [ADR 0007](./0007-better-sqlite3-over-node-sqlite.md) rejected libSQL, and vectors are not a
  reason to reopen it.
- **`fastembed`.** Rejected as the future embedding path: last published December 2025 and it pulls
  native `@anush008/tokenizers` bindings, a cross-platform install hazard for `npx deflowai up`.

## Revisit when

**A semantic-recall miss is measured, not anticipated.** The concrete signal: a node that had the
answer available in the corpus, asked for it, and did not get it — observed and logged, more than
occasionally. Instrument retrieval hit rate per node type in the cross-run dashboard (F10.11), which
is being built anyway.

When that trigger fires, upgrade **in cost order**, and stop at the first step that works:

1. **Query expansion first.** Have the cheap planner model emit three to five keyword variants and
   OR them into the FTS5 query. Pennies, no new dependency, and it recovers most of the
   "I described it differently" gap. **Do this before embeddings.**
2. **`sqlite-vec`, not `sqlite-vss`.** Alive but pre-1.0: stable v0.1.9 (31 March 2026), pre-release
   v0.1.10-alpha.4 (18 May 2026, adding a DiskANN index). Caveats to weigh at the time: still alpha
   after two years, and a known extension/SQLite-version mismatch class of bug on Windows with
   better-sqlite3 — which lands squarely on the M3 Windows target. Combine with FTS5 via **Reciprocal
   Rank Fusion** (`1/(60+rank)` summed), not by normalising BM25 against cosine.
3. **Embedding model: `@huggingface/transformers` v4.2.0** with a 768-dimension model, running
   server-side in Node. Ollama embeddings (`nomic-embed-text`, `embeddinggemma`) only as an optional
   accelerator when the user already runs Ollama — never as a required dependency.

There is a decent chance step 1 is where this stops.

---

[← ADR index](./README.md) · [Architecture docs](../README.md)
