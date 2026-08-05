/**
 * KAR-05.2 — reading and writing the probed capability manifest.
 *
 * The two rules this module exists to hold:
 *
 * 1. **A probe never overwrites what a previous probe recorded.** The three
 *    part primary key means a version bump or a rebuilt binary is a new row;
 *    the same binary probed again is the same row. The only column a repeat
 *    probe moves is `probed_at`, which answers "when did we last see this
 *    binary" without touching "what did it say it could do". Anything else
 *    would destroy the record the resume poisoning guard compares against
 *    (docs/07-provider-adapter-layer.md §6.1).
 * 2. **`caps_json` goes in as text and comes out as text.** The bytes the
 *    agent sent are the artefact; parsing on the way in would mean the column
 *    held this build's idea of the response rather than the response. The two
 *    checks below are the only ones applied, and both are refusals rather than
 *    repairs: a path that is not absolute, and text that is not JSON at all —
 *    a column nobody can parse back is not a manifest, it is a corrupt row
 *    that no later migration can fix.
 */
import type { Db, DbStatement } from '@DeFlow/core';
import { isAbsolute } from 'node:path';

/** One probed row, exactly as the table holds it. */
export interface ProviderCapabilityRow {
  readonly provider: string;
  /** The verbatim `--version` output. */
  readonly version: string;
  /** sha256 of the resolved entry file, 64 lowercase hex. */
  readonly binarySha256: string;
  /** Absolute, as resolved (§4.3). */
  readonly binaryPath: string;
  /** The entire `initialize` response, unmodified. */
  readonly capsJson: string;
  /** ms epoch, from the injected `Clock`. */
  readonly probedAt: number;
}

/** Whether this probe added a row or found its own primary key already there. */
export interface RecordProbeResult {
  readonly inserted: boolean;
}

/**
 * `ON CONFLICT … DO UPDATE SET probed_at` rather than `INSERT OR IGNORE`: the
 * conflict is the expected case — most probes are of a binary that has not
 * changed — and "we looked again just now" is worth recording, while what the
 * binary said it could do is not re-written.
 */
const RECORD_SQL = `
  INSERT INTO provider_capabilities
    (provider, version, binary_sha256, binary_path, caps_json, probed_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (provider, version, binary_sha256)
    DO UPDATE SET probed_at = excluded.probed_at
`;

/**
 * Asked *before* the upsert and inside the same transaction, because neither
 * `changes` nor `RETURNING` can tell an insert from an update here: an upsert
 * reports one changed row either way, and a re-probe of an unchanged binary
 * normally returns byte-identical `caps_json`, so comparing the surviving text
 * against the offered text says "inserted" for the commonest case there is.
 */
const EXISTS_SQL = `
  SELECT 1 AS present FROM provider_capabilities
   WHERE provider = ? AND version = ? AND binary_sha256 = ?
`;

const READ_SQL = `
  SELECT provider, version, binary_sha256, binary_path, caps_json, probed_at
    FROM provider_capabilities
   WHERE provider = ?
   ORDER BY probed_at, version, binary_sha256
`;

function assertRecordable(row: ProviderCapabilityRow): void {
  if (!isAbsolute(row.binaryPath)) {
    throw new TypeError(
      `provider_capabilities.binary_path must be absolute, as resolved at probe time; ` +
        `got ${JSON.stringify(row.binaryPath)}. DeFlowd's PATH is not the user's login-shell ` +
        'PATH, so a bare name re-resolved at spawn time is a machine-specific failure.',
    );
  }
  try {
    JSON.parse(row.capsJson);
  } catch {
    throw new TypeError(
      'provider_capabilities.caps_json must be the initialize response as JSON text; ' +
        `got ${JSON.stringify(row.capsJson.slice(0, 60))}. The column is refused here rather ` +
        'than at read time because the manifest is append-only in practice: a row written ' +
        'unparseable is one no later probe replaces.',
    );
  }
}

/**
 * Records one probe. Returns `{ inserted: false }` when the three-part key was
 * already present, in which case the stored `caps_json` is left exactly as the
 * first probe wrote it.
 */
export function recordProviderCapabilities(db: Db, row: ProviderCapabilityRow): RecordProbeResult {
  assertRecordable(row);
  const exists: DbStatement<{ present: number }> = db.prepare(EXISTS_SQL);
  const record = db.prepare(RECORD_SQL);

  return db.transaction(() => {
    const present = exists.get(row.provider, row.version, row.binarySha256) !== undefined;
    record.run(
      row.provider,
      row.version,
      row.binarySha256,
      row.binaryPath,
      row.capsJson,
      row.probedAt,
    );
    return { inserted: !present };
  });
}

interface CapabilityDbRow {
  readonly provider: string;
  readonly version: string;
  readonly binary_sha256: string;
  readonly binary_path: string;
  readonly caps_json: string;
  readonly probed_at: number;
}

/**
 * Every row probed for `provider`, oldest first — a history, not a lookup.
 * Callers that want "what is installed now" take the last one; callers that
 * want "what was installed when this node started" compare against the
 * version and sha the `node.started` event recorded.
 */
export function readProviderCapabilities(
  db: Db,
  provider: string,
): readonly ProviderCapabilityRow[] {
  const statement: DbStatement<CapabilityDbRow> = db.prepare(READ_SQL);
  return statement.all(provider).map((stored) => ({
    provider: stored.provider,
    version: stored.version,
    binarySha256: stored.binary_sha256,
    binaryPath: stored.binary_path,
    capsJson: stored.caps_json,
    probedAt: stored.probed_at,
  }));
}
