/**
 * KAR-05.2 — the `provider_capabilities` table, which is a manifest and not a
 * cache.
 *
 * File-backed and reopened rather than `:memory:`, because the claim under
 * test is a durability claim: the record of what an installed agent could do
 * has to outlive the daemon that probed it, and the three-part primary key
 * `(provider, version, binary_sha256)` is what preserves the history a resume
 * guard later compares against (docs/07-provider-adapter-layer.md §6.1).
 *
 * Verifies: EPIC-05-S8 · KAR-05.2 AC4
 */
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import {
  openLedger,
  readProviderCapabilities,
  recordProviderCapabilities,
} from '../../src/index.ts';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const row = (over: Partial<Parameters<typeof recordProviderCapabilities>[1]> = {}) => ({
  provider: 'mock',
  version: '1.0.0',
  binarySha256: SHA_A,
  binaryPath: '/opt/DeFlow/bin/mock',
  capsJson: '{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}',
  probedAt: 1_754_313_093_000,
  ...over,
});

suite('the manifest keeps one row per (provider, version, sha)', () => {
  it('inserts on the first probe and reports that it inserted', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(recordProviderCapabilities(db, row())).toEqual({ inserted: true });
      expect(readProviderCapabilities(db, 'mock')).toEqual([row()]);
    } finally {
      db.close();
    }
  });

  it('re-probing an unchanged binary refreshes probed_at and nothing else', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      recordProviderCapabilities(db, row());
      // A second probe of the same bytes, whose response differs only because
      // the agent decided to say something else. The first answer is the
      // record; only "when did we last see it" moves.
      const again = recordProviderCapabilities(
        db,
        row({ capsJson: '{"different":true}', probedAt: 1_754_400_000_000 }),
      );

      expect(again).toEqual({ inserted: false });
      expect(readProviderCapabilities(db, 'mock')).toEqual([row({ probedAt: 1_754_400_000_000 })]);
    } finally {
      db.close();
    }
  });

  it('a version bump inserts a second row and leaves the first byte-identical', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      recordProviderCapabilities(db, row());
      recordProviderCapabilities(
        db,
        row({ version: '1.1.0', binarySha256: SHA_B, capsJson: '{"v":2}' }),
      );

      expect(readProviderCapabilities(db, 'mock')).toEqual([
        row(),
        row({ version: '1.1.0', binarySha256: SHA_B, capsJson: '{"v":2}' }),
      ]);
    } finally {
      db.close();
    }
  });

  it('a rebuilt binary at the same version is a third row', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      recordProviderCapabilities(db, row());
      recordProviderCapabilities(db, row({ version: '1.1.0', binarySha256: SHA_B }));
      recordProviderCapabilities(db, row({ version: '1.1.0', binarySha256: 'c'.repeat(64) }));

      expect(readProviderCapabilities(db, 'mock')).toHaveLength(3);
    } finally {
      db.close();
    }
  });

  it('survives the process that wrote it', async ({ tmp }) => {
    const first = openLedger(tmp);
    try {
      recordProviderCapabilities(first, row());
    } finally {
      first.close();
    }

    const second = openLedger(tmp);
    try {
      expect(readProviderCapabilities(second, 'mock')).toEqual([row()]);
    } finally {
      second.close();
    }
  });

  it('keeps providers apart, and answers an unprobed one with nothing', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      recordProviderCapabilities(db, row());
      recordProviderCapabilities(db, row({ provider: 'codex' }));

      expect(readProviderCapabilities(db, 'mock')).toEqual([row()]);
      expect(readProviderCapabilities(db, 'codex')).toEqual([row({ provider: 'codex' })]);
      expect(readProviderCapabilities(db, 'gemini')).toEqual([]);
    } finally {
      db.close();
    }
  });
});

suite('the schema refuses what a manifest must not hold', () => {
  it('refuses a relative binary_path — §4.3 stores what was resolved', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(() => recordProviderCapabilities(db, row({ binaryPath: 'bin/mock' }))).toThrow(
        /absolute/i,
      );
    } finally {
      db.close();
    }
  });

  it('refuses caps_json that is not JSON: the column is read back and parsed', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(() => recordProviderCapabilities(db, row({ capsJson: 'not json' }))).toThrow(
        /caps_json/i,
      );
    } finally {
      db.close();
    }
  });
});
