/**
 * KAR-19.8 — the identifier DeFlow hands a vendor for one turn, derived from
 * the identifiers DeFlow keeps.
 *
 * **The defect this exists to close.** On 2026-08-13 a run reached framing and
 * died on `Error: Invalid session ID. Must be a valid UUID.`, on every attempt,
 * because `live-chain.ts` put `` `${runId}-framing` `` on a flag Claude Code
 * 2.1.220 validates. DeFlow's run ids are not UUIDs and were never meant to be:
 * `run_20260813T110608Z_379fc8` sorts by time, reads in a directory listing and
 * is what an operator greps for six weeks later (NF8). So the mapping goes the
 * other way — DeFlow keeps its id, and the vendor is handed one of the form it
 * demands.
 *
 * **Derived, never minted.** `randomUUID()` at the call site satisfies the
 * vendor in a minute and takes three things with it, none of which fails a test
 * on its own: `--resume` on a second attempt opens a session the first
 * attempt's transcript is not in; the transcript under the vendor's own
 * projects directory can no longer be found from the ledger; and KAR-12.2's
 * independence assertion stops being about a value DeFlow chose. The tuple is
 * `(runId, nodeId, attempt)` — the same one F4.3 derives an idempotency key
 * from, because it is the same question asked of the same inputs.
 *
 * **RFC 4122 §4.3, and the version matters.** The value is a name-based v5
 * UUID: `sha1(namespace || "<runId>/<nodeId>/<attempt>")`, with the version and
 * variant bits set as the RFC requires. A v8 (RFC 9562's hash-based custom
 * form) would be more honest about the digest and is *rejected* by the common
 * `[1-5]`-version validators a vendor CLI is likely to be using — which would
 * reproduce this very bug with a different message. SHA-1 here is a namespaced
 * identifier construction, not a security primitive.
 *
 * Verifies: EPIC-19-S53 · KAR-19.8 AC1, AC2, AC4
 */
import type { NodeId, RunId } from '@DeFlow/core';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { type ArgumentForm, type ArgumentProvenance, UUID_PATTERN } from './argument-forms.ts';
import { registryRefused } from './failures.ts';
import type { ResumeStrategyName } from './resume.ts';

/**
 * The namespace every DeFlow-derived vendor session id is minted under.
 *
 * A constant, and it must never change: it is half the input to an id that is
 * written into a vendor's transcript filename by one daemon life and looked up
 * by the next. Changing it orphans every transcript DeFlow has ever recorded a
 * handle for.
 */
export const VENDOR_SESSION_NAMESPACE = '967f7f27-e7b2-4355-a36c-9c40d9846672';

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/**
 * Which flag a vendor takes a session id on, and what form it must be in.
 *
 * **KAR-19.11 folded this into one vocabulary.** KAR-19.8 introduced a
 * `SESSION_ID_FORMS` table of its own, which was right for one flag and wrong
 * as a pattern: the next argument found wrong — `--json-schema`, two days later
 * — would have needed a second parallel table, and the one after that a third.
 * `form` is now an `ArgumentForm` like every other declared argument's, and the
 * session id is a row in the entry's own `arguments` audit rather than a
 * mechanism beside it.
 */
/**
 * KAR-19.13 AC7 — what a vendor does when it is handed an id it has **already
 * seen**.
 *
 * Two answers, and the difference is a wedged run:
 *
 * - `'create-only'` — the flag *creates* a session and cannot attach to one, so
 *   an id a previous process spent is refused outright. Claude Code 2.1.220
 *   exits 1 on `Session ID <uuid> is already in use`, which is how
 *   `run_20260816T194933Z_839b9b` died at planning. An id may therefore be
 *   presented **once**, and a second turn of the same kind is a second session.
 * - `'may-attach'` — presenting the id again continues the conversation the
 *   first presentation started, so re-presenting it is the *cheaper* answer and
 *   keeps one transcript per turn kind.
 *
 * A declaration rather than a name test: `if (provider === 'claude')` inside the
 * derivation is the shortcut this exists to refuse, because the registry is the
 * one file allowed to name a vendor and a vendor name anywhere else is the next
 * thing that has to be found by hand.
 */
export type SessionIdReuse = 'create-only' | 'may-attach';

export interface SessionIdSpec {
  readonly flag: string;
  readonly form: ArgumentForm;
  /** KAR-19.13 AC7 — whether the flag can only create, or may attach. */
  readonly reuse: SessionIdReuse;
  /** How that was established, kept apart from the `form`'s provenance because
   * the two are separate claims about the same flag and were learned three days
   * apart. */
  readonly reuseProvenance: ArgumentProvenance;
}

/**
 * Whether an id already presented on this flag may be presented again.
 *
 * An **undeclared** flag answers `true`: a fresh session per turn costs one
 * extra transcript handle, and re-presenting an id a vendor refuses costs the
 * run. The safe direction is the one nobody has to be right about in advance.
 */
export function sessionIdIsSingleUse(spec: SessionIdSpec | undefined): boolean {
  return spec === undefined || spec.reuse === 'create-only';
}

/** The tuple a vendor session id is a function of, and nothing else. */
export interface VendorSessionKey {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** 0-based, as everywhere else in the ledger. */
  readonly attempt: number;
}

/** `<runId>/<nodeId>/<attempt>`, the same shape `ikey()` builds — `RunId` and
 * `NodeId` both forbid `/`, so no component can corrupt the separator. */
function name(key: VendorSessionKey): string {
  if (!Number.isInteger(key.attempt) || key.attempt < 0) {
    // Tagged rather than a bare `RangeError`, like every other throw in this
    // package (`test/adapter-shape.test.ts`): a caller that reached here with a
    // fractional attempt has a bug, and a bug that arrives in the ledger as a
    // typed refusal is one somebody can read six weeks later.
    throw registryRefused(
      `a vendor session id is derived from (runId, nodeId, attempt) and attempt must be a ` +
        `non-negative integer, got ${key.attempt}`,
      { runId: key.runId, node: key.nodeId, attempt: key.attempt },
    );
  }
  return `${key.runId}/${key.nodeId}/${key.attempt}`;
}

/**
 * The vendor-side session id for one `(runId, nodeId, attempt)`.
 *
 * The **one** producer of the value: no call site formats a session id itself
 * (AC1), and `test/no-formatted-session-id.test.ts` is what keeps that true.
 */
export function vendorSessionId(key: VendorSessionKey): string {
  const namespace = Buffer.from(VENDOR_SESSION_NAMESPACE.replaceAll('-', ''), 'hex');
  const digest = createHash('sha1')
    .update(namespace)
    .update(Buffer.from(name(key), 'utf8'))
    .digest();

  const bytes = Uint8Array.prototype.slice.call(digest, 0, 16);
  // RFC 4122 §4.3: version 5 in the high nibble of octet 6, variant 0b10 in the
  // top bits of octet 8. Without both, the string is 32 hex characters that a
  // strict validator refuses — which is the bug this module exists to close.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  const hex = Buffer.from(bytes).toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}

/**
 * The session id one *attempt* of a node reaches the vendor with, given the
 * resume strategy KAR-05.5 selected for it (AC4).
 *
 * `ResumeNative` resumes the session the node's first attempt opened, so every
 * attempt derives from attempt 0 — a second attempt that opened a fresh session
 * would be `--resume`-ing into a transcript that does not contain the work it
 * is meant to continue. `ResumeByReplay` rebuilds the conversation from the
 * ledger, which *is* a new session, so the attempt stays in the tuple and the
 * two transcripts remain separately findable.
 */
export function vendorSessionIdFor(
  key: VendorSessionKey & { readonly strategy: ResumeStrategyName },
): string {
  return vendorSessionId({
    runId: key.runId,
    nodeId: key.nodeId,
    attempt: key.strategy === 'ResumeNative' ? 0 : key.attempt,
  });
}
