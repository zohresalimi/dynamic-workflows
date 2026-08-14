/**
 * KAR-18.2 — step 4 of the boot sequence: "probe providers"
 * (docs/03-local-development.md §9), filling the slot `boot.ts` has held open
 * since KAR-03.7.
 *
 * This is `detectProviders` with the cache turned on and the ledger wired up.
 * The difference between this and `deflow init`'s pass is one flag and it is
 * the whole point: `init` is run *because* something about the installation
 * changed, so it handshakes every binary it finds; `up` runs on every start and
 * is on the NF3 budget, so it answers from the recorded manifest for any binary
 * whose bytes are unchanged (EPIC-18-S17).
 *
 * Nothing here throws for a machine with no agent CLI on it. Zero providers is
 * a fact about the machine, not a failure of boot: the daemon starts, reports
 * what to install, and refuses the *run* later (NF7, AC8). A probe that threw
 * here would be the opaque `ENOENT: spawn claude` that EPIC-18-S15 exists to
 * make impossible.
 *
 * **Where the refusal actually happens: `POST /api/runs`** (KAR-19.2). This
 * comment used to promise a refusal to "schedule agent nodes later", and for
 * one release nothing implemented it — so "refuses to schedule" became "never
 * schedules, and says nothing", which cost an operator an afternoon on
 * 2026-08-12. Admission now reads what this probe found, at submission,
 * *before* the 201: `./admission.ts` folds it onto the two binary resolutions
 * and `@DeFlow/adapters`' `admitRun` decides. A node is never reached at all on
 * a machine that cannot serve one.
 *
 * **AR-1.** Nothing in this path reads a credential file or an API-key
 * environment variable. The probe hands the child the environment it was given
 * plus the vendor's own spawn overlay, and where a vendor reports that it needs
 * a login, the *string* of the command is rendered for the operator to run
 * themselves (packages/adapters/src/provider-availability.ts).
 */
import type { Db } from '@DeFlow/core';
import { type Clock, mintRunId, ProviderIdSchema } from '@DeFlow/core';
import { readEpoch, readProviderCapabilities, recordProviderCapabilities } from '@DeFlow/ledger';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { sqliteLedgerSink } from '../exec/ledger-sink.ts';
import {
  detectProviders,
  type ProviderDetectionEntry,
  type ProviderDetectionStatus,
  pathRoots,
} from './detect.ts';

export type { ProviderDetectionEntry, ProviderDetectionStatus };

export interface BootProbePorts {
  /** The daemon's write connection — the manifest lives in the ledger. */
  readonly db: Db;
  /** Time enters here and nowhere else (NF9); `probed_at` is `clock.now()`. */
  readonly clock: Clock;
  /** The global state directory: scratch homes and event spill both land here. */
  readonly dataDir: string;
  /**
   * The environment whose `PATH` is searched.
   *
   * The operator's own, passed down from `deflow up` — which is the one context
   * where reading `PATH` is correct rather than a machine-specific bug, because
   * the command runs in their terminal. DeFlowd's own environment later on is
   * not the login shell's, which is why every resolved path is *persisted* and
   * never re-derived from `PATH` at spawn time (§4.3).
   */
  readonly env: NodeJS.ProcessEnv;
  /** Six random hex characters for the synthetic run id the probe events
   * carry. Injected so a spec can make the id reproducible. */
  readonly randomHex: () => string;
}

/**
 * Probes every registered provider, reusing the manifest where the binary has
 * not changed.
 *
 * Never throws: a provider that is absent, or that resolves and then refuses to
 * answer `initialize`, comes back as an entry saying so.
 */
export async function probeProvidersOnBoot(
  ports: BootProbePorts,
): Promise<readonly ProviderDetectionEntry[]> {
  const scratchDir = join(ports.dataDir, 'boot-probe');
  try {
    return await detectProviders({
      roots: pathRoots(ports.env),
      clock: ports.clock,
      env: ports.env,
      reuseCache: true,
      capabilities: {
        record: (row) => recordProviderCapabilities(ports.db, row),
        read: (provider) =>
          readProviderCapabilities(ports.db, provider).map((row) => ({
            ...row,
            provider: ProviderIdSchema.parse(row.provider),
          })),
      },
      ledger: sqliteLedgerSink({
        db: ports.db,
        runId: mintRunId(ports.clock.now(), ports.randomHex),
        epoch: readEpoch(ports.db),
        dataDir: ports.dataDir,
      }),
      scratchDir,
    });
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

/** How many of these are usable right now — the number `deflow up` prints. */
export function availableCount(entries: readonly ProviderDetectionEntry[]): number {
  return entries.filter((entry) => entry.status === 'detected' || entry.status === 'cached').length;
}
