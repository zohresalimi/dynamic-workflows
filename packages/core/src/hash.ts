/**
 * KAR-02.9 — sha256Hex over the canonical encoding, plus the three thin
 * named wrappers docs/04-domain-model.md §2 and §3 need: `planHash`,
 * `specHash` and `contentHash`.
 *
 * `sha256Hex` uses the Web Crypto API (`globalThis.crypto.subtle`) rather
 * than `node:crypto`: it is a global, not an import, so it does not trip
 * R1's "no `node:` builtin import" guard, and unlike randomness or the
 * clock, a hash digest is a pure deterministic function of its input — it
 * carries no ambient state that would need to arrive through an injected
 * port the way `Clock` or a random-hex source do (see ./run-id.ts).
 *
 * `planHash` and `specHash` exclude one field each — `planHash` itself, and
 * `approvedBy` respectively (AC7) — via a single named omit list per
 * function, not by `delete`-ing from a copy at every call site that needs
 * one. `contentHash` hashes its input directly: `Segment.contentHash` is
 * "sha256 of `text`" (§8.3 fields), not sha256 of a JSON encoding of it.
 *
 * Verifies: EPIC-02-S6, EPIC-02-S8 · AC1, AC7
 */
import { canonicalJson } from './canonical-json.ts';
import type { PlanHash } from './ids.ts';
import { PlanHashSchema } from './ids.ts';

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/** The sha256 digest of `input`'s UTF-8 bytes, as 64 lowercase hex
 * characters. The one primitive every hash in this module is built from. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return toHex(new Uint8Array(digest));
}

/** Returns a shallow copy of `value` with every key in `keys` removed. The
 * one place that implements "omit a field before hashing" — `planHash` and
 * `specHash` both call this instead of each growing its own `delete
 * copy.field` at the point of use (AC7). */
function omit(value: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (!keys.includes(key)) out[key] = val;
  }
  return out;
}

/** AC7: `planHash` never depends on its own prior value. */
const PLAN_HASH_OMIT_KEYS = ['planHash'] as const;

/**
 * AC7: `specHash` never depends on approval state, so re-approving an
 * unchanged spec does not change its identity (EPIC-02-S6).
 *
 * `specHash` itself is omitted for the same reason `planHash` omits `planHash`
 * — a digest cannot be part of what it digests. KAR-09.4 AC8 is what makes it
 * load-bearing rather than tidy: a verification gate resolves its criteria from
 * the ledger *by* `specHash`, and a document that cannot be verified against
 * its own recorded digest gives the gate nothing to select on.
 */
const SPEC_HASH_OMIT_KEYS = ['approvedBy', 'specHash'] as const;

/**
 * sha256 of the canonical encoding of `doc`, excluding the `planHash` field
 * itself, formatted as the `sha256-<64 hex>` string `PlanHashSchema`
 * requires. This is `PlanGraph.planHash` (docs/04-domain-model.md §3).
 */
export async function planHash(doc: Record<string, unknown>): Promise<PlanHash> {
  const hex = await sha256Hex(canonicalJson(omit(doc, PLAN_HASH_OMIT_KEYS)));
  return PlanHashSchema.parse(`sha256-${hex}`);
}

/**
 * sha256 of the canonical encoding of `spec`, excluding `approvedBy`, so
 * that approving an unchanged spec does not change its identity while
 * editing it does (docs/04-domain-model.md §2, EPIC-02-S6). This is
 * `TaskSpec.specHash`.
 */
export async function specHash(spec: Record<string, unknown>): Promise<string> {
  const hex = await sha256Hex(canonicalJson(omit(spec, SPEC_HASH_OMIT_KEYS)));
  return `sha256-${hex}`;
}

/**
 * sha256 of `text` itself — not of a JSON encoding of it. This is
 * `Segment.contentHash` (docs/04-domain-model.md §8.3), used by the pin
 * integrity check to assert that a pinned segment's exact bytes are still
 * present in the outgoing prompt after compaction.
 */
export async function contentHash(text: string): Promise<string> {
  return `sha256-${await sha256Hex(text)}`;
}
