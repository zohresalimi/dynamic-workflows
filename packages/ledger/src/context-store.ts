/**
 * KAR-09.2 AC10 — persisting a `ContextPacket`: the manifest into the ledger,
 * the text into the content-addressed store, and `prompt.txt` onto disk as a
 * derived artifact (docs/08-context-and-memory.md §3, docs/16-repo-layout.md
 * §7.1).
 *
 * The split is the whole design.
 *
 * **The event carries the manifest, never the text.** `context.built`'s
 * payload is the packet *minus every segment's `text`*, because segment text
 * is the entire rendered prompt and `event` is append-only and re-read in full
 * by every replay for the life of the run. Copying a 100k-token prompt into it
 * would make the control plane grow without bound for data already reachable
 * through `contentHash`. `test/integration/context-built.test.ts` asserts the
 * absence by walking the payload for a key named `text` at any depth, rather
 * than by checking the one place it would obviously be.
 *
 * **The store is the global blob store, not a per-run directory.**
 * §3 sketches `runs/<runId>/artifacts/<sha256>/`; repo-layout §7.2 supersedes
 * it with one content-addressed store under the data directory, for the reason
 * content addressing exists at all — the same failing build log across three
 * retries and two runs is *one* object. A per-run artifact directory would
 * store it six times and would make a handle unresolvable from any other run.
 *
 * **`prompt.txt` is derived and says so.** It exists because NF8 wants every
 * artifact inspectable on disk in an open format, and because when something
 * goes wrong you want the literal bytes. But the manifest is authoritative, so
 * the render has to be recomputable from it: `rehydratePacket` pulls every
 * segment back out of the store and `verifyDerivedPrompt` re-renders and
 * compares. A `derived.json` beside the file records that the file is
 * rebuildable, so a consistency check rebuilds rather than trusts it. If those
 * two ever diverge, the node inspector is showing a file nobody can reproduce.
 *
 * Verifies: EPIC-09-S13, EPIC-09-S11 (third scenario), EPIC-09-S7 (third
 * scenario) · AC10
 */
import type {
  ContextPacket,
  ContextPacketRecord,
  EventSeq,
  Handle,
  IdempotencyKey,
  PacketDemotion,
  Segment,
} from '@DeFlow/core';
import { ContextPacketRecordSchema, ContextPacketSchema, renderPacket } from '@DeFlow/core';
import { Buffer } from 'node:buffer';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { appendEvents, type EventDraft } from './append.ts';
import { blobHandle, getBlob, putBlob } from './blobs.ts';

/** The mime a segment body carries. Prompts are text; the store is content
 * addressed and does not file by type, so this is a label on the reference. */
export const SEGMENT_MIME = 'text/plain';

/** The derived-artifact manifest written beside `prompt.txt` (NF8). */
export const DERIVED_MANIFEST = 'derived.json';

/** `<runDir>/nodes/<nodeId>/` — repo-layout §7.1. */
export function nodeDirOf(runDir: string, nodeId: string): string {
  return join(runDir, 'nodes', nodeId);
}

/** `<runDir>/nodes/<nodeId>/prompt.txt`. */
export function promptPathOf(runDir: string, nodeId: string): string {
  return join(nodeDirOf(runDir, nodeId), 'prompt.txt');
}

/** `artifact://<hex>` for a `sha256-<hex>` content hash. The two spellings
 * exist because one addresses a segment and the other addresses a blob; this
 * is the one place that converts between them. */
export function handleForContentHash(contentHash: string): Handle {
  return blobHandle(contentHash.slice('sha256-'.length));
}

/**
 * A packet whose `renderedPromptHandle` does not address the bytes the render
 * actually produces.
 *
 * Refused rather than corrected: the handle is what the node inspector follows
 * to show "the prompt this node received", and a packet that points at
 * different bytes than it renders to is a record of a run that did not happen.
 */
export class RenderedPromptHandleMismatch extends Error {
  readonly declared: Handle;
  readonly actual: Handle;

  constructor(nodeId: string, declared: Handle, actual: Handle) {
    super(
      `node "${nodeId}" declares renderedPromptHandle ${declared} but rendering its segments ` +
        `produces ${actual}. The manifest is authoritative and prompt.txt is derived from it, so ` +
        'the two must address the same bytes — build the packet with buildPacket(), which derives ' +
        'the handle from the render rather than being told it.',
    );
    this.name = 'RenderedPromptHandleMismatch';
    this.declared = declared;
    this.actual = actual;
  }
}

export interface PersistPacketOptions {
  /** The global data directory — where `blobs/` lives. */
  readonly dataDir: string;
  /** `<target-repo>/.DeFlow/runs/<runId>`. */
  readonly runDir: string;
  readonly packet: ContextPacket;
  /**
   * What the demotion pass took out, so the handles it minted resolve. Without
   * it a demoted body is addressed by a handle nothing can answer, and
   * "handles are lossless" stops being true.
   */
  readonly demotion?: PacketDemotion;
  readonly ts: number;
  readonly epoch: number;
  readonly ikey?: IdempotencyKey;
}

export interface PersistedPacket {
  /** The `context.built` event's seq. */
  readonly seq: EventSeq;
  /** The `context.compacted` event's seq, when the build demoted anything. */
  readonly compactedSeq: EventSeq | null;
  readonly record: ContextPacketRecord;
  readonly promptPath: string;
  readonly renderedPromptHandle: Handle;
}

const encode = (text: string): Uint8Array => Buffer.from(text, 'utf8');

/** The manifest form: every segment minus its `text`. */
function recordOf(packet: ContextPacket): ContextPacketRecord {
  return ContextPacketRecordSchema.parse({
    ...packet,
    segments: packet.segments.map(({ text: _text, ...rest }) => rest),
  });
}

/**
 * Stores the packet's bytes, writes `prompt.txt`, and appends `context.built`.
 *
 * Blobs and files are written **before** the event, so an event that exists is
 * an event whose content resolves. The reverse order would leave a manifest
 * pointing at blobs a crash lost, which is the one failure a content-addressed
 * store cannot repair by itself.
 */
export function persistContextPacket(
  db: Parameters<typeof appendEvents>[0],
  options: PersistPacketOptions,
): PersistedPacket {
  const { packet, dataDir, runDir } = options;

  for (const segment of packet.segments) {
    putBlob(dataDir, encode(segment.text), SEGMENT_MIME, options.ikey);
  }
  // The demoted bodies too: the handle in a stub is a promise that the bytes
  // are retrievable, and this is where it is kept.
  for (const body of options.demotion?.bodies ?? []) {
    putBlob(dataDir, encode(body.text), SEGMENT_MIME, options.ikey);
  }

  const prompt = renderPacket(packet);
  const renderedPromptHandle = putBlob(dataDir, encode(prompt), SEGMENT_MIME, options.ikey);
  if (renderedPromptHandle !== packet.renderedPromptHandle) {
    throw new RenderedPromptHandleMismatch(
      packet.nodeId,
      packet.renderedPromptHandle,
      renderedPromptHandle,
    );
  }

  const promptPath = promptPathOf(runDir, packet.nodeId);
  writeDerived(runDir, packet.nodeId, prompt, packet.renderedPromptHandle);

  const record = recordOf(packet);
  const drafts: EventDraft[] = [
    {
      runId: packet.runId,
      ts: options.ts,
      kind: 'context.built',
      v: 1,
      epoch: options.epoch,
      nodeId: packet.nodeId,
      attempt: packet.attempt,
      ...(options.ikey === undefined ? {} : { ikey: options.ikey }),
      payload: { node: packet.nodeId, attempt: packet.attempt, packet: record },
    },
  ];

  const demotion = options.demotion;
  if (demotion !== undefined && demotion.droppedSegments.length > 0) {
    drafts.push({
      runId: packet.runId,
      ts: options.ts,
      kind: 'context.compacted',
      v: 1,
      epoch: options.epoch,
      nodeId: packet.nodeId,
      attempt: packet.attempt,
      payload: {
        node: packet.nodeId,
        scope: 'DeFlow.packet',
        // DeFlow demoted these bodies itself and counted both ends, so the
        // numbers are measured rather than vendor-reported (§6.1).
        fidelity: 'exact',
        trigger: 'threshold',
        before: demotion.before,
        after: demotion.after,
        droppedSegments: [...demotion.droppedSegments],
        demotedToHandles: [...demotion.demotedToHandles],
        pinnedKept: packet.pinnedDigests,
        // §6.3's transcript snapshot is KAR-09.6's story. A DeFlow-side
        // demotion loses nothing — every dropped body is in the store under
        // its own handle — so there is no "original" to point at beyond them.
        originalHandle: null,
      },
    });
  }

  const seqs = appendEvents(db, drafts);
  const seq = seqs[0];
  if (seq === undefined) throw new Error('appending context.built returned no seq');

  return {
    seq,
    compactedSeq: seqs[1] ?? null,
    record,
    promptPath,
    renderedPromptHandle,
  };
}

/** What `derived.json` records: this file is rebuildable, and from what. */
interface DerivedEntry {
  readonly path: string;
  readonly handle: Handle;
  readonly rebuildFrom: string;
}

function writeDerived(runDir: string, nodeId: string, prompt: string, handle: Handle): void {
  const dir = nodeDirOf(runDir, nodeId);
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, 'prompt.txt'), prompt);
  const entries: readonly DerivedEntry[] = [
    { path: 'prompt.txt', handle, rebuildFrom: 'context.built' },
  ];
  writeFileAtomic(
    join(dir, DERIVED_MANIFEST),
    `${JSON.stringify({ derived: entries }, null, 2)}\n`,
  );
}

/**
 * Write, fsync, rename — the recipe of docs/05-durable-execution.md §9.4, with
 * the temp file a sibling of its target so the rename is atomic rather than a
 * cross-filesystem copy.
 */
function writeFileAtomic(path: string, text: string): void {
  const temp = `${path}.DeFlow.tmp`;
  const fd = openSync(temp, 'w');
  try {
    writeSync(fd, encode(text));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

/**
 * The full packet, with every segment's `text` fetched back out of the store.
 *
 * This is what makes "the manifest is authoritative" checkable rather than
 * asserted: a manifest that cannot be rehydrated into a packet that renders to
 * the stored prompt is a manifest that has lost something.
 */
export function rehydratePacket(dataDir: string, record: ContextPacketRecord): ContextPacket {
  const segments: Segment[] = record.segments.map((segment) => ({
    ...segment,
    text: Buffer.from(getBlob(dataDir, handleForContentHash(segment.contentHash))).toString('utf8'),
  }));
  return ContextPacketSchema.parse({ ...record, segments });
}

export type DerivedPromptCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Whether the `prompt.txt` on disk still is what the manifest says it is.
 *
 * Rebuild-rather-than-trust, in one function: the answer comes from
 * re-rendering the rehydrated manifest, never from reading `derived.json`'s
 * recorded handle back and believing it.
 */
export function verifyDerivedPrompt(
  dataDir: string,
  runDir: string,
  record: ContextPacketRecord,
): DerivedPromptCheck {
  const path = promptPathOf(runDir, record.nodeId);
  let onDisk: string;
  try {
    onDisk = readFileSync(path, 'utf8');
  } catch {
    return { ok: false, reason: `${path} is missing; rebuild it from the context.built manifest` };
  }
  const rebuilt = renderPacket(rehydratePacket(dataDir, record));
  if (onDisk === rebuilt) return { ok: true };
  return {
    ok: false,
    reason:
      `${path} does not match a render of the context.built manifest. prompt.txt is a derived, ` +
      'non-authoritative artifact (NF8): rebuild it rather than trusting it.',
  };
}
