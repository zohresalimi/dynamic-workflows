/**
 * KAR-10.1 — task intake: normalising a submitted task into a `task.submitted`
 * event, and nothing else (docs/06-planning-and-replanning.md §1.1).
 *
 * *"Intake does exactly one thing: normalise the input into a `task.submitted`
 * event carrying the raw source plus its provenance. **No interpretation
 * happens here.**"* That sentence is the whole contract this file exists to
 * hold, which is why `normaliseInput` does no I/O and makes no judgment about
 * the content it is given — it is handed already-resolved bytes (a file was
 * already read, an issue was already fetched) and it does the one honest thing
 * left: hash them, decide whether they fit inline, and wrap them with
 * provenance. Reading the file, fetching the issue and resolving a path against
 * `cwd` are all I/O, and all live in `@DeFlow/daemon` — this module cannot
 * perform any of it (R1).
 *
 * The 64 KiB inline threshold is intake's own, smaller than the ledger's
 * general 256 KiB spill ceiling in `@DeFlow/ledger`'s `blobs.ts`: a 200 KB spec
 * document must not bloat every ledger read, so the decision is made here,
 * before the event is ever handed to `appendEvents`.
 *
 * Verifies: KAR-10.1 · AC1, AC2, AC3
 */
import { z } from 'zod';
import { sha256HexBytes } from './hash.ts';
import type { Handle } from './ids.ts';
import { HandleSchema } from './ids.ts';

/** The three wire shapes AC1 accepts. A spec document is the `file` kind with
 * its own `mediaType` in provenance — there is no fourth shape. */
export const INTAKE_KINDS = ['text', 'file', 'issue'] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];

/** Who submitted the task: the web UI or the CLI (AC7). Both are clients of
 * the same daemon code path. */
export const INTAKE_SUBMITTERS = ['ui', 'cli'] as const;
export type IntakeSubmitter = (typeof INTAKE_SUBMITTERS)[number];

/**
 * A source at or under this many bytes is inlined as `payload.raw`; over it,
 * the bytes go to the content-addressed blob store and the payload holds
 * `payload.handle` instead (AC2, EPIC-10-S2's last scenario).
 */
export const INTAKE_INLINE_THRESHOLD_BYTES = 64 * 1024;

const BareSha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'must be a 64-character hex sha256');

/**
 * AC2's provenance fields, one variant per kind — closed, so a typo in `kind`
 * is rejected at the schema boundary rather than silently carrying no
 * kind-specific fields at all.
 */
/**
 * KAR-19.3 — the repository the task was submitted against.
 *
 * **Optional, and added after the fact.** Until this field existed, `cwd`
 * arrived on the request, was validated, and was then thrown away: the only
 * durable record of which repository a run belonged to was `run.created.cwd`,
 * which is written *by* the framing interview — so the caller that has to open
 * that interview had no way to find the repository at all. That is one of the
 * missing joints EPIC-19 exists to reconnect, and it is invisible until
 * something tries to make the call.
 *
 * Optional rather than required because payloads already on disk do not have it
 * — including the three runs from 2026-08-12 that started this epic — and a
 * required field would make them unreadable, which is the one thing a ledger
 * may never do to its own history. A `task.submitted` with no `cwd` is a run
 * this build cannot frame, and it says so rather than guessing at a directory.
 */
const submittedCwd = z.string().min(1).optional();

export const TaskProvenanceSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('text'),
    by: z.enum(INTAKE_SUBMITTERS),
    /** ms epoch, from the injected `Clock` — never read internally. */
    submittedAt: z.number().int().nonnegative(),
    cwd: submittedCwd,
  }),
  z.strictObject({
    kind: z.literal('file'),
    by: z.enum(INTAKE_SUBMITTERS),
    submittedAt: z.number().int().nonnegative(),
    cwd: submittedCwd,
    /** Absolute, post-`realpath` — AC4's resolution, never the agent's own string. */
    resolvedPath: z.string().min(1),
    /** The size of the source, in bytes — independent of whether it was inlined. */
    bytes: z.number().int().nonnegative(),
    mediaType: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal('issue'),
    by: z.enum(INTAKE_SUBMITTERS),
    submittedAt: z.number().int().nonnegative(),
    cwd: submittedCwd,
    url: z.string().min(1),
    /** Which resolver answered — `'gh'` today; a name, never a claim about
     * HTTPS being used, so a future non-GitHub fallback has somewhere to say so. */
    resolver: z.string().min(1),
    httpStatus: z.number().int(),
    /** ms epoch the resolver's answer arrived — distinct from `submittedAt`
     * because the two can differ by however long the resolver took. */
    fetchedAt: z.number().int().nonnegative(),
  }),
]);

export type TaskProvenance = z.infer<typeof TaskProvenanceSchema>;

/**
 * `task.submitted`'s payload (AC2). `raw` xor `handle`, enforced structurally
 * rather than by convention — a payload carrying both, or neither, is not a
 * shape this event can mean.
 */
export const TaskSubmittedSchema = z
  .strictObject({
    sha256: BareSha256Schema,
    /** Present iff the source is at or under the inline threshold. */
    raw: z.string().optional(),
    /** Present iff it is not — `artifact://<sha256>` into the blob store. */
    handle: HandleSchema.optional(),
    provenance: TaskProvenanceSchema,
  })
  .superRefine((payload, ctx) => {
    if ((payload.raw !== undefined) === (payload.handle !== undefined)) {
      ctx.addIssue({
        code: 'custom',
        path: ['raw'],
        message:
          'exactly one of raw or handle must be present: raw for a source at or under ' +
          `${INTAKE_INLINE_THRESHOLD_BYTES} bytes, handle for one over it`,
      });
    }
  });

export type TaskSubmitted = z.infer<typeof TaskSubmittedSchema>;

// ── normaliseInput ───────────────────────────────────────────────────────────

export interface NormaliseTextInput {
  readonly kind: 'text';
  readonly text: string;
}

export interface NormaliseFileInput {
  readonly kind: 'file';
  /** The file's exact bytes, already read. */
  readonly bytes: Uint8Array;
  /** Absolute, post-`realpath` (AC4) — already resolved by the caller. */
  readonly resolvedPath: string;
  readonly mediaType: string;
}

export interface NormaliseIssueInput {
  readonly kind: 'issue';
  /** The resolver's raw response text, already fetched. */
  readonly raw: string;
  readonly url: string;
  readonly resolver: string;
  readonly httpStatus: number;
}

export type NormaliseInput = NormaliseTextInput | NormaliseFileInput | NormaliseIssueInput;

export interface NormaliseInputPorts {
  /** ms epoch, from the injected `Clock` — never read internally (NF9). */
  readonly now: number;
  readonly by: IntakeSubmitter;
  /**
   * Called only when the encoded bytes exceed `INTAKE_INLINE_THRESHOLD_BYTES`.
   * Stores them in the content-addressed blob store and returns the handle to
   * reference them by. A port, like `Clock` and `Random`, because writing to
   * disk is I/O and this module performs none (R1) — the daemon supplies
   * `@DeFlow/ledger`'s `putBlob`.
   */
  readonly store: (bytes: Uint8Array, mediaType: string) => Handle;
  /**
   * KAR-19.3 — the repository the run was submitted against, recorded so the
   * framing turn that happens later can find it. Absent leaves the field off
   * the payload entirely rather than writing an empty string.
   */
  readonly cwd?: string;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8');

function mediaTypeOf(input: NormaliseInput): string {
  switch (input.kind) {
    case 'file':
      return input.mediaType;
    case 'issue':
      return 'application/json';
    case 'text':
      return 'text/plain';
  }
}

function bytesAndProvenanceOf(
  input: NormaliseInput,
  ports: NormaliseInputPorts,
): { bytes: Uint8Array; provenance: TaskProvenance } {
  const { now, by } = ports;
  const where = ports.cwd === undefined ? {} : { cwd: ports.cwd };
  switch (input.kind) {
    case 'text':
      return {
        bytes: utf8Encoder.encode(input.text),
        provenance: { kind: 'text', by, submittedAt: now, ...where },
      };
    case 'file':
      return {
        bytes: input.bytes,
        provenance: {
          kind: 'file',
          by,
          submittedAt: now,
          ...where,
          resolvedPath: input.resolvedPath,
          bytes: input.bytes.byteLength,
          mediaType: input.mediaType,
        },
      };
    case 'issue':
      return {
        bytes: utf8Encoder.encode(input.raw),
        provenance: {
          kind: 'issue',
          by,
          submittedAt: now,
          ...where,
          url: input.url,
          resolver: input.resolver,
          httpStatus: input.httpStatus,
          fetchedAt: now,
        },
      };
  }
}

/**
 * Normalises one already-resolved source into a `task.submitted` payload.
 *
 * No summarising, no rewriting, no truncating: `raw`, when present, decodes
 * the exact bytes handed in — byte-identical to what was submitted (AC3) — and
 * `sha256` is always the digest of those same bytes, whichever way the payload
 * ends up carrying them.
 *
 * Verifies: KAR-10.1 test plan #1 · AC2, AC3
 */
export async function normaliseInput(
  input: NormaliseInput,
  ports: NormaliseInputPorts,
): Promise<TaskSubmitted> {
  const { bytes, provenance } = bytesAndProvenanceOf(input, ports);
  const sha256 = await sha256HexBytes(bytes);

  const payload: TaskSubmitted =
    bytes.byteLength <= INTAKE_INLINE_THRESHOLD_BYTES
      ? { sha256, raw: utf8Decoder.decode(bytes), provenance }
      : { sha256, handle: ports.store(bytes, mediaTypeOf(input)), provenance };

  return TaskSubmittedSchema.parse(payload);
}
