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
 * EPIC-03 fills the rest in. KAR-06.3 adds the write-ahead effect journal and
 * migration 0006's triggers, which make an `effect` row's history unrewritable.
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
  lastSeqOfKinds,
  PayloadTooLarge,
  readEventTs,
  readGlobalRange,
  readRange,
  type StoredEvent,
} from './append.ts';
// KAR-09.10 — `artifact_fts`: the FTS5 index over run artifacts, its one
// documented query, opt-in retrieval, and the rebuild a tokenizer change
// requires in place of an ALTER it cannot do.
export {
  ARTIFACT_FTS_SCHEMA,
  ARTIFACT_FTS_TOKENIZE,
  type ArtifactFtsAvailability,
  type ArtifactFtsHit,
  type ArtifactFtsRebuild,
  type ArtifactIndexEntry,
  artifactFtsAvailability,
  createArtifactFtsTables,
  ftsPhraseQuery,
  indexArtifact,
  queryArtifactFts,
  type RetrievalDeclaration,
  rebuildArtifactFts,
  resolveRetrieval,
} from './artifact-index.ts';
// KAR-09.8 — the blackboard: `fact` and `fact_edges` as a materialised view of
// the `fact.*` events, and the only module that writes them. Droppable by
// construction — `rebuildBlackboard` puts both tables back from seq 0.
export {
  BLACKBOARD_SCHEMA,
  type BlackboardRebuild,
  createBlackboardTables,
  FACT_EVENT_KINDS,
  // KAR-15.6 AC5 — F10.4's second query: the consumer set of one fact, in SQL.
  type FactConsumerRow,
  type FactEdgeDirection,
  type FactEdgeRow,
  type FactEventEnvelope,
  type FactEventKind,
  type FactInvalidation,
  type InvalidateFactOptions,
  invalidateFact,
  isFactEventKind,
  projectFactEvent,
  type ResolvedFactRead,
  type ResolveReadsOptions,
  readersBefore,
  readFactByKey,
  readFactConsumers,
  readFactEdges,
  readFacts,
  readTaintedNodes,
  rebuildBlackboard,
  resolveDeclaredReads,
  type StoredFact,
  type TaintedNode,
  type WriteFactResult,
  writeFact,
} from './blackboard.ts';
// KAR-03.9 — the content-addressed blob store: what an oversized payload
// becomes, and the excerpt that keeps a lost artifact renderable.
export {
  ARTIFACT_FAILED_INTEGRITY,
  ARTIFACT_SCHEME,
  ARTIFACT_UNAVAILABLE,
  type ArtifactStatus,
  type ArtifactView,
  BLOB_DIR,
  BLOB_STAGING_DIR,
  BlobCorrupt,
  BlobMissing,
  type BlobRef,
  type BlobSpillWriter,
  blobHandle,
  blobPath,
  blobTempPath,
  EXCERPT_BYTES,
  getBlob,
  InvalidBlobHandle,
  inspectArtifact,
  isBlobRef,
  MAX_INLINE_PAYLOAD_BYTES,
  openBlobSpill,
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
// KAR-07.6 — the live pairwise conflict matrix, keyed on a canonical pair and
// carrying both tips so a stale row is detectable rather than trusted.
export {
  type ConflictProbeRow,
  canonicalPair,
  readConflictProbe,
  readConflictProbes,
  upsertConflictProbe,
} from './conflict-probe.ts';
// KAR-09.2 — persisting a ContextPacket: the manifest into `context.built`,
// the segment text into the blob store, and prompt.txt onto disk as a derived,
// non-authoritative artifact (NF8).
export {
  DERIVED_MANIFEST,
  type DerivedPromptCheck,
  handleForContentHash,
  nodeDirOf,
  type PersistedPacket,
  type PersistPacketOptions,
  persistContextPacket,
  promptPathOf,
  RenderedPromptHandleMismatch,
  rehydratePacket,
  SEGMENT_MIME,
  verifyDerivedPrompt,
} from './context-store.ts';
// KAR-03.4 — bounded drains. The only supported way to read more than one window.
export { DEFAULT_DRAIN_BATCH, type DrainOptions, drainEvents, drainIoChunks } from './drain.ts';
// KAR-06.3 — the write-ahead effect journal: the intent row written before the
// side effect, the ordinal derived from it rather than counted, and the four
// triggers (migration 0006) that stop anything reopening a terminal row.
export {
  EFFECT_STATES,
  type EffectAttemptKey,
  EffectNotPending,
  type EffectRow,
  type EffectRowDraft,
  type EffectState,
  type JournalledEffect,
  journalEffect,
  markEffectCancelled,
  markEffectDone,
  markEffectFailed,
  // KAR-15.5 — the `node_id` prefix reserved for journal rows that belong to no
  // plan node, which `NodeIdSchema` can never produce.
  NON_NODE_EFFECT_PREFIX,
  nextOrdinal,
  readEffect,
  readEffects,
  // KAR-06.9 — the rows a dead daemon left mid-effect: startup reconciliation's
  // whole input.
  readInheritedEffects,
  // KAR-06.4 — the `pending`-row scaffold a mutating shell effect journals its
  // before/after worktree hashes into, and migration 0007 that permits it.
  scaffoldEffect,
} from './effects.ts';
// KAR-03.7 — the daemon epoch: bumped once per daemon life, stamped on every
// write, and compared at the append boundary.
export { bumpEpoch, readEpoch, StaleEpoch } from './epoch.ts';
// KAR-03.1 — the driver adapter behind the Db port declared in @DeFlow/core.
export { LedgerAlreadyOpen, LedgerTooNew } from './errors.ts';
// KAR-12.6 AC6, AC7 — which runs "the last N runs" means, and what
// `gates.loaded` and `gate.evaluated` said across them: the sample the
// gate-hygiene projection in @DeFlow/gates reduces.
export {
  DEFAULT_HYGIENE_RUN_SAMPLE,
  type GateHygieneSample,
  type GateHygieneSampleOptions,
  type SampledGateEvaluation,
  sampleGateHygiene,
} from './gate-hygiene.ts';
// KAR-15.6 — the two point reads the inspection surfaces need: one node
// attempt's packet manifest, and the spec a run is judged against.
export {
  type RunOrigin,
  readContextPacket,
  readGateVerdicts,
  readLatestSpecAmendment,
  readRunCreatedSpec,
  readRunOrigin,
} from './inspection.ts';
// KAR-10.1 AC6 / KAR-15.5 AC5 — the API-level `Idempotency-Key`, journalled in
// the `effect` table under an `intake:` namespace no engine key can produce.
export {
  INTAKE_EFFECT_KIND,
  INTAKE_IKEY_PREFIX,
  INTAKE_NODE_ID,
  type IntakeKeyRecord,
  intakeIkey,
  lookupIntakeKey,
  recordIntakeKey,
} from './intake-keys.ts';
// KAR-03.4 — the data plane: agent bytes land here and never in `event`.
export {
  appendIoChunk,
  appendIoChunks,
  InvalidIoChunk,
  // KAR-15.6 AC4 — the tail: the last N chunks, read off the end of the index.
  IO_CHUNK_HEAD_SQL,
  IO_CHUNK_TAIL_SQL,
  IO_STREAMS,
  type IoChunkDraft,
  type IoChunkPage,
  type IoChunkSelector,
  type IoStream,
  readIoChunks,
  readIoChunkTail,
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
// KAR-15.6 AC3 — when a node started and stopped, for the inspector bundle.
export { type NodeTiming, readNodeTiming } from './node-timing.ts';
// KAR-06.6 — the `node_wake` table: every wait in the system, from a 2-second
// retry backoff to a 30-day human gate, as one row and zero CPU. Never a timer.
export {
  appendEventsConsumingWakes,
  appendEventsSchedulingWakes,
  clearWake,
  dueWakes,
  InvalidWakeReason,
  type NodeWakeKey,
  type NodeWakeRow,
  nextWakeAt,
  readWake,
  readWakes,
  scheduleWake,
  scheduleWakeIfChanged,
} from './node-wake.ts';
// KAR-15.3 — the post-commit emitter the SSE stream parks on. It fires after
// the outermost transaction returns and carries nothing: the reaction to it is
// "drain from your cursor" (docs/11-api-and-realtime.md §5.2).
export { committing, onCommitted } from './notify.ts';
// KAR-03.8 — the daemon's start-of-life rebuild: every run in a data
// directory, folded from the ledger a dead process left behind.
export {
  headSeq,
  type LedgerReplay,
  listRunIds,
  type OpenedLedger,
  openAndReplay,
  type RunReplay,
  replayAll,
  runHeadSeq,
} from './open-and-replay.ts';
export { openLedger } from './open-ledger.ts';
// KAR-11.4 — F8.3's approval queue for proposed patches, projected from the
// log: queued patches waiting on a human, and rejected ones a human may still
// approve explicitly.
export type { PendingPatchApproval, QueuedPatchEstimate } from './patch-queue.ts';
export { pendingPatchApprovals } from './patch-queue.ts';
// KAR-11.1 — one immutable, content-addressed plan version: the row, the file
// under `.DeFlow/runs/<runId>/plan/` and `plan.proposed`, or none of the three.
export type {
  ApplyPatchedPlanOptions,
  ApplyPatchedPlanOutcome,
  PersistedPlan,
  PersistPlanOptions,
} from './plans.ts';
// KAR-15.6 — the scrubber's version rail: every plan version a run proposed,
// as one grouped, bounded statement.
export {
  applyPatchedPlanVersion,
  listPlanVersions,
  PATCH_STALE,
  PlanHashMismatch,
  PlanNotValidated,
  type PlanVersionRow,
  persistPlanVersion,
  planDirOf,
  planPathOf,
  RUN_PLAN_DIR,
  readPlanDoc,
  // KAR-11.5 — resolving one version and the patch behind it, for the diff
  // endpoint's `reason`/`decision` join.
  readPlanPatchedEvent,
  readPlanPatchProposedEvent,
  readPlanVersion,
} from './plans.ts';
export { applyPragmas, LEDGER_PRAGMAS, SYNCHRONOUS, withFullSync } from './pragmas.ts';
// KAR-05.9 — the `process` table: written in the same transaction as
// `node.started`, and the next daemon's only handle on an orphaned agent.
export {
  appendEventsWithProcess,
  clearProcess,
  markProcess,
  PROCESS_STATES,
  type ProcessKey,
  type ProcessRow,
  type ProcessRowDraft,
  type ProcessState,
  readLiveProcesses,
  readProcess,
  readProcesses,
  recordProcess,
} from './processes.ts';
// KAR-05.2 — the probed capability manifest: a history keyed on
// (provider, version, binary_sha256), never a table that is updated in place.
export {
  listProviderCapabilities,
  type ProviderCapabilityRow,
  type RecordProbeResult,
  readProviderCapabilities,
  recordProviderCapabilities,
} from './provider-capabilities.ts';
// KAR-14.4 AC10 — the most recent rate limit per provider, across every run:
// a vendor's quota is a fact about a binary on this machine, not about a run.
export {
  MAX_REPORTED_PROVIDERS,
  readLatestRateLimits,
  type StoredRateLimit,
} from './rate-limits.ts';
// KAR-16.5 — restoring a recorded run into an *empty* ledger, `seq` gaps and
// all, so `DeFlow replay` serves a fixture through the normal routes rather
// than through a second read path the UI would have to know about.
export {
  InvalidRecordedEvent,
  type RecordedEvent,
  type RestoredLedger,
  restoreRecordedEvents,
  SeqNotAhead,
} from './restore.ts';
// KAR-09.5 — the run's artifact index: which digests this run offloaded, and
// what each one is. The bytes stay in the global blob store; this is what makes
// a handle resolvable from the run that recorded it and no other.
export {
  listRunArtifacts,
  RUN_ARTIFACT_DIR,
  RUN_ARTIFACT_ENTRY,
  type RunArtifactEntry,
  readRunArtifact,
  recordRunArtifact,
  runArtifactDirOf,
  runArtifactsDirOf,
} from './run-artifacts.ts';
// KAR-15.7 — the reduced state at an arbitrary seq, server-side: one reducer,
// never io_chunk, and the greatest committed seq at or below the request.
export {
  type RunSnapshot,
  type SnapshotOptions,
  type SnapshotSeq,
  snapshotRunAt,
} from './run-snapshot.ts';
// KAR-03.4 — the counters that keep "~2,000 control events per run" a measurement.
export {
  CONTROL_EVENT_BUDGET,
  type RunStats,
  readRunStats,
  SNAPSHOT_REVISIT_THRESHOLD,
} from './run-stats.ts';
export { openRead, openWrite } from './sqlite-db.ts';
// KAR-09.7 — the learned half of the capability manifest: `tokenEstimateFactor`
// per (provider, model), overwritten after every node and read before every
// pre-flight budget.
export {
  readTokenCalibration,
  readTokenCalibrations,
  recordTokenSample,
  type TokenCalibrationRow,
  type TokenSample,
} from './token-calibration.ts';
// KAR-09.6 — §6.3's transcript snapshot: one file copy on a compaction
// boundary, tagged so F5.9's redaction pass can find it. A missing file is
// null, never an error.
export {
  listRawTranscripts,
  RAW_TRANSCRIPT,
  snapshotTranscript,
  TRANSCRIPT_MIME,
  TRANSCRIPT_SNAPSHOT_REASON,
  type TranscriptSnapshotInput,
} from './transcript-snapshot.ts';
// KAR-07.2 — the `worktrees` projection: an index over `git worktree list
// --porcelain -z`, replaced whole on every refresh, never the source of truth.
export { readWorktrees, replaceWorktrees, type WorktreeRow } from './worktrees.ts';
