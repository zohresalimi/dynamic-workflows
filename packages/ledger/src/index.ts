/**
 * @DeFlow/ledger — the SQLite event store: append-only event log, effect
 * journal, plan/run/node_wake tables, PRAGMA user_version migrations, the
 * content-addressed blob store and the SSE tail queries.
 *
 * This file is the package's whole contract: re-exports only, no logic
 * (docs/16-repo-layout.md §8).
 *
 * KAR-03.1 ships the connection layer. KAR-03.2 adds the migration runner,
 * migration 0001's six-table schema, and `openLedger`. KAR-03.3 adds the
 * append-only event log. KAR-03.4 adds the data plane — `io_chunk`, the bounded
 * drains and the per-run counters. KAR-03.7 adds the fence: the
 * single-instance lease and the daemon epoch. KAR-03.9 adds the
 * content-addressed blob store an oversized payload spills into. The rest of
 * EPIC-03 fills the rest in.
 *
 * Note what is not here and never will be: an `updateEvent`, a `deleteEvent`
 * or an `amendEvent`. The `event` table is append-only, and
 * `test/append-only.test.ts` fails the build if one appears. Nor is there an
 * `iterate()` anywhere — streaming reads drain with bounded `LIMIT` queries,
 * for the reason `drain.ts` records.
 */
// KAR-03.3 — the append-only event log: append(), readRange() and nothing that writes twice.
export {
  type AppendOptions,
  appendEvents,
  EVENT_TAIL_SQL,
  type EventDraft,
  EventDraftSchema,
  type EventPage,
  InvalidEventEnvelope,
  PayloadTooLarge,
  readRange,
  type StoredEvent,
} from './append.ts';
// KAR-03.9 — the content-addressed blob store: what an oversized payload
// becomes, and the excerpt that keeps a lost artifact renderable.
export {
  ARTIFACT_FAILED_INTEGRITY,
  ARTIFACT_UNAVAILABLE,
  type ArtifactStatus,
  type ArtifactView,
  BLOB_DIR,
  BlobCorrupt,
  BlobMissing,
  type BlobRef,
  blobHandle,
  blobPath,
  blobTempPath,
  EXCERPT_BYTES,
  getBlob,
  InvalidBlobHandle,
  inspectArtifact,
  isBlobRef,
  MAX_INLINE_PAYLOAD_BYTES,
  PAYLOAD_MIME,
  putBlob,
  type SpillResult,
  spillBytes,
  spillIfLarge,
} from './blobs.ts';
// KAR-03.6 — the checkpoint cache: written with the events it covers, and
// discarded rather than believed whenever it might be stale.
export {
  CHECKPOINT_EVENT_INTERVAL,
  type Checkpoint,
  CheckpointAheadOfLedger,
  type CheckpointEnv,
  type CheckpointerOptions,
  type CheckpointRead,
  type CheckpointRejection,
  type CheckpointRejectionReason,
  type CheckpointWrite,
  checkpointsEnabled,
  describeCheckpointRejection,
  NO_CHECKPOINT_ENV,
  type ReplayOptions,
  type ReplayResult,
  RunCheckpointer,
  readCheckpoint,
  replayRun,
  writeCheckpoint,
} from './checkpoint.ts';
// KAR-03.4 — bounded drains. The only supported way to read more than one window.
export { DEFAULT_DRAIN_BATCH, type DrainOptions, drainEvents, drainIoChunks } from './drain.ts';
// KAR-03.7 — the daemon epoch: bumped once per daemon life, stamped on every
// write, and compared at the append boundary.
export { bumpEpoch, readEpoch, StaleEpoch } from './epoch.ts';
// KAR-03.1 — the driver adapter behind the Db port declared in @DeFlow/core.
export { LedgerAlreadyOpen, LedgerTooNew } from './errors.ts';
// KAR-03.4 — the data plane: agent bytes land here and never in `event`.
export {
  appendIoChunk,
  appendIoChunks,
  InvalidIoChunk,
  IO_CHUNK_TAIL_SQL,
  IO_STREAMS,
  type IoChunkDraft,
  type IoChunkPage,
  type IoChunkSelector,
  type IoStream,
  readIoChunks,
  type StoredIoChunk,
} from './io-chunk.ts';
// KAR-03.7 — the single-instance lease. Taken first in boot, before anything
// else can change the world.
export {
  acquireLease,
  DaemonAlreadyRunning,
  HOLDER_FILE,
  type Lease,
  LOCK_FILE,
} from './lease.ts';
// KAR-03.2 — ~40 lines over PRAGMA user_version, plus the pre-migration backup.
export { type Migration, migrate } from './migrate.ts';
export { MIGRATIONS } from './migrations/index.ts';
export { openLedger } from './open-ledger.ts';
export { applyPragmas, LEDGER_PRAGMAS, SYNCHRONOUS, withFullSync } from './pragmas.ts';
// KAR-03.4 — the counters that keep "~2,000 control events per run" a measurement.
export {
  CONTROL_EVENT_BUDGET,
  type RunStats,
  readRunStats,
  SNAPSHOT_REVISIT_THRESHOLD,
} from './run-stats.ts';
export { openRead, openWrite } from './sqlite-db.ts';
