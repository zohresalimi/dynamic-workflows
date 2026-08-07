/**
 * KAR-09.7 AC6 — `tokenEstimateFactor` is part of the capability manifest, and
 * a manifest survives the daemon.
 *
 * File-backed and reopened rather than `:memory:`, because the claim is a
 * durability claim: a factor that lived in the daemon's heap would silently
 * reset to its seed on every restart, and the failure mode of that is not an
 * error — it is a pre-flight budget that quietly goes back to overfilling
 * Anthropic contexts, twenty nodes at a time, for ever.
 *
 * Verifies: EPIC-09-S38 (scenario 4), EPIC-09-S39 (scenario 2) · KAR-09.7 AC5,
 * AC6 · test plan #7
 */
import { it } from '@DeFlow/testkit';
import { expect, describe as suite } from 'vitest';
import {
  openLedger,
  readTokenCalibration,
  readTokenCalibrations,
  recordTokenSample,
} from '../../src/index.ts';

const NOW = 1_754_400_000_000;
const MODEL = 'model-a';
const OTHER = 'model-b';

suite('the factor is stored per (provider, model) and survives a restart', () => {
  it('starts a provider at its family seed with no samples', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      expect(readTokenCalibration(db, 'claude', MODEL, 'anthropic')).toEqual({
        provider: 'claude',
        model: MODEL,
        family: 'anthropic',
        samples: 0,
        tokenEstimateFactor: 1.2,
        appliedFactor: 1.2,
        updatedAt: null,
      });
      // A caller that cannot name the family gets the conservative default
      // seed rather than a guess dressed up as anthropic's.
      expect(readTokenCalibration(db, 'claude', MODEL).appliedFactor).toBe(1.05);
    } finally {
      db.close();
    }
  });

  it('keeps the factor across a close and a reopen of the same file', async ({ tmp }) => {
    const first = openLedger(tmp);
    try {
      for (let sample = 0; sample < 6; sample += 1) {
        recordTokenSample(first, {
          provider: 'claude',
          model: MODEL,
          family: 'anthropic',
          estimated: 1_000,
          actual: 1_180,
          now: NOW + sample,
        });
      }
    } finally {
      first.close();
    }

    const reopened = openLedger(tmp);
    try {
      const row = readTokenCalibration(reopened, 'claude', MODEL);
      expect(row.samples).toBe(6);
      expect(row.tokenEstimateFactor).toBeCloseTo(1.18, 10);
      // Six samples is past the switchover, so the learned ratio is what a
      // budget would actually multiply by.
      expect(row.appliedFactor).toBeCloseTo(1.18, 10);
      expect(row.updatedAt).toBe(NOW + 5);
    } finally {
      reopened.close();
    }
  });

  it('applies the seed until the fifth sample, whatever it has learned', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      for (let sample = 0; sample < 4; sample += 1) {
        recordTokenSample(db, {
          provider: 'claude',
          model: MODEL,
          family: 'anthropic',
          estimated: 1_000,
          actual: 1_500,
          now: NOW + sample,
        });
      }
      const four = readTokenCalibration(db, 'claude', MODEL);
      expect(four.samples).toBe(4);
      expect(four.tokenEstimateFactor).toBeCloseTo(1.5, 10);
      expect(four.appliedFactor).toBe(1.2);

      recordTokenSample(db, {
        provider: 'claude',
        model: MODEL,
        family: 'anthropic',
        estimated: 1_000,
        actual: 1_500,
        now: NOW + 4,
      });
      expect(readTokenCalibration(db, 'claude', MODEL).appliedFactor).toBeCloseTo(1.5, 10);
    } finally {
      db.close();
    }
  });

  it('keys per model, so rerouting a node does not reuse the other model’s factor', async ({
    tmp,
  }) => {
    const db = openLedger(tmp);
    try {
      for (let sample = 0; sample < 6; sample += 1) {
        recordTokenSample(db, {
          provider: 'claude',
          model: MODEL,
          family: 'anthropic',
          estimated: 1_000,
          actual: 1_180,
          now: NOW + sample,
        });
        recordTokenSample(db, {
          provider: 'claude',
          model: OTHER,
          family: 'anthropic',
          estimated: 1_000,
          actual: 1_400,
          now: NOW + sample,
        });
      }
      expect(readTokenCalibration(db, 'claude', MODEL).tokenEstimateFactor).toBeCloseTo(1.18, 10);
      expect(readTokenCalibration(db, 'claude', OTHER).tokenEstimateFactor).toBeCloseTo(1.4, 10);
      expect(readTokenCalibrations(db)).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('records nothing for a sample with no estimate to compare against', async ({ tmp }) => {
    const db = openLedger(tmp);
    try {
      const row = recordTokenSample(db, {
        provider: 'claude',
        model: MODEL,
        family: 'anthropic',
        estimated: 0,
        actual: 5_000,
        now: NOW,
      });
      expect(row.samples).toBe(0);
      expect(readTokenCalibrations(db)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('converges toward the authoritative figure across a restart per sample', async ({ tmp }) => {
    // The convergence claim, but with the daemon dying between every node —
    // which is the only version of it that proves the state is in the file.
    for (let sample = 0; sample < 20; sample += 1) {
      const db = openLedger(tmp);
      try {
        recordTokenSample(db, {
          provider: 'claude',
          model: MODEL,
          family: 'anthropic',
          estimated: 2_000,
          actual: 2_360,
          now: NOW + sample,
        });
      } finally {
        db.close();
      }
    }

    const db = openLedger(tmp);
    try {
      const row = readTokenCalibration(db, 'claude', MODEL);
      expect(row.samples).toBe(20);
      expect(Math.abs(row.appliedFactor - 1.18)).toBeLessThanOrEqual(0.02);
    } finally {
      db.close();
    }
  });
});
