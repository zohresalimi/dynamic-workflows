/**
 * KAR-03.2 — shipped migrations are append-only.
 *
 * "Never edited once shipped" (docs/05-durable-execution.md §7.2) is a rule
 * nothing else in the tree enforces: `up()` runs against whatever bytes are on
 * disk today, and an edited migration silently reinterprets every ledger a
 * prior build already applied it to. So each shipped file's content hash is
 * pinned here, one row per migration.
 *
 * **A red row is not a licence to update the hash.** Migrations are
 * append-only: fix forward with a new numbered file, and leave this one
 * alone.
 *
 * Verifies: KAR-03.2 test plan #7 · AC7
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';

const migrationsDir = new URL('../src/migrations/', import.meta.url).pathname;

const hashOf = (filename: string): string =>
  createHash('sha256')
    .update(readFileSync(join(migrationsDir, filename)))
    .digest('hex');

/** Filename -> sha256 of the committed file. Append rows; never edit one. */
const SHIPPED: Record<string, string> = {
  // Shipped 2026-08-05, KAR-03.2.
  '0001-initial-schema.ts': 'ce9aa2b46a0614760259a9c9f5e14758a4249fc67dbafa0676072afd71650529',
  // Shipped 2026-08-05, KAR-03.3 — event.epoch.
  '0002-event-epoch.ts': '60c4b67cd912c12f807fb1175a381036b03492b562bc5e49d8b995fe17f5c548',
  // Shipped 2026-08-05, KAR-03.7 — the daemon epoch counter.
  '0003-daemon-epoch.ts': '583b917b806f13161f5c1d16188dd1d9fbdb5615193920772f45c51489954f87',
  // Shipped 2026-08-05, KAR-05.2 — the probed capability manifest.
  '0004-provider-capabilities.ts':
    '2efbb532aee1382ceaee7bc0bc15ab67af6be5c5211f2012b83719e44539f575',
  // Shipped 2026-08-05, KAR-05.9 — the process rows the orphan reaper reads.
  '0005-process.ts': '6f904a3002302ca793d87a468cad3223bfc8e101b2c71090ccf02c0444494fb4',
  // Shipped 2026-08-05, KAR-06.3 — the effect journal's four immutability triggers.
  '0006-effect-journal-guards.ts':
    'ff0ae6979c1050354592c40a7fa17918a9a1bfc4afc3da01ef9df4ca647be01f',
  // Shipped 2026-08-05, KAR-06.4 — the pending-row result_json scaffold.
  '0007-effect-scaffold.ts': 'd412b7a0a6a653d37097c4a2de5318fde2f26a306d7f4e8a2b3c58c21936f4a2',
  // Shipped 2026-08-06, KAR-07.2 — the `worktrees` projection over git's own
  // `worktree list --porcelain -z`.
  '0008-worktrees.ts': 'bbb4d7918881571f37af14cc40ae727218f3cf7eb5aa358e399a4862f1f1f741',
  // Shipped 2026-08-06, KAR-07.6 — the live pairwise `merge-tree` matrix.
  '0009-conflict-probe.ts': '9a498836ae869331696f4dc2fcee206055cc9e20f3ed1e23dff4482111829ab6',
  // Shipped 2026-08-07, KAR-09.7 — the learned `tokenEstimateFactor` per
  // (provider, model).
  '0010-token-calibration.ts': '2460e6594c6be09a14f2902b78d4b3929aad9637193677ee910939643012abb6',
  // Shipped 2026-08-07, KAR-09.8 — `fact` and `fact_edges`, the blackboard as
  // a droppable materialised view of the `fact.*` events.
  '0011-blackboard.ts': '7b5e59f58929bb841167f2968d56b952f2bb6dcf347d029cf19c8493b30af72c',
  // Shipped 2026-08-07, KAR-09.10 — `artifact_fts`, the FTS5 index over run
  // artifacts, and its `artifact_fts_provenance` companion table.
  '0012-artifact-fts.ts': 'b4938bab1dd766eafcd49711cdf6f123aa9efbff29cc9a6f1ff4c9f53641ffe5',
  // Shipped 2026-08-07, KAR-14.4 — `event_rate_limited`, a partial index over
  // the one event kind `deflow doctor` queries without a run_id.
  '0013-rate-limit-index.ts': '0de13bafd3347d31d7ba4a296cb8aba619b4e8948b04d4177cee973d05c159d2',
  // Shipped 2026-08-07, KAR-10.1 — `intake_key`, the map from an
  // Idempotency-Key header to the run it already minted.
  '0014-intake-keys.ts': '2cd149ea7045a109ef6834c9ba077a1b5b9ee97392a6857a03a3017d961c6738',
  // Shipped 2026-08-10, KAR-15.5 — the Idempotency-Key moves into the `effect`
  // journal (docs/11 §11.3) and `intake_key` is dropped.
  '0015-intake-keys-into-effects.ts':
    '95efcf117b0ffad3e941aa0455c908fa1dbd317c6b04c69f9da8354ae39ec48d',
  // Shipped 2026-08-15, KAR-22.1 — `project`, the map from a name to a
  // repository, with the realpath unique.
  '0016-projects.ts': 'b7f30e2075036f9adb22bc7d4403f9ea3ca5433659393824ae01f898ada75d34',
  // Shipped 2026-08-16, KAR-22.4 — `connector`, which services a project may
  // use. No credential column: ADR-0003, amended the same day.
  '0017-connectors.ts': 'f0785fba964c87d2265a409574d05359006afd5851243de3438c4b22d7547bb7',
  // Shipped 2026-08-19, KAR-25.3 — `provider_setting`, which runtimes this
  // machine has disabled. One boolean per provider.
  '0018-provider-settings.ts': '213893e925567100f1ca1faf8902521256bae62aea31ac8a1c670a40c11795c4',
};

const shippedMigrationFiles = readdirSync(migrationsDir).filter(
  (name) => name !== 'index.ts' && name.endsWith('.ts') && !name.endsWith('.test.ts'),
);

suite('shipped migration files are unchanged (AC7)', () => {
  it('pins a content hash for every shipped migration file', () => {
    expect(shippedMigrationFiles.sort()).toEqual(Object.keys(SHIPPED).sort());
  });

  for (const [filename, expected] of Object.entries(SHIPPED)) {
    it(`${filename} is unchanged since it shipped`, () => {
      expect(
        hashOf(filename),
        `${filename} changed content. Migrations are append-only: ship a new numbered file ` +
          'instead of editing this one.',
      ).toBe(expected);
    });
  }
});
