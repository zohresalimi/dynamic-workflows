/**
 * KAR-18.1 AC6 — the provider detection pass `DeFlow init` runs.
 *
 * `doctor.ts`'s re-probe deliberately never touches `PATH`: DeFlowd's own
 * environment at daemon start is not the user's login-shell one, so the
 * targets there are the binary paths a previous probe already recorded. That
 * leaves an honest gap — something has to find the *first* row — and this
 * module is it. It runs inside the operator's own terminal, with the
 * operator's own `PATH`, which is the one context in this codebase where
 * reading it is correct rather than a machine-specific bug waiting to
 * happen. Every root it searches is passed in by the caller; the resolved
 * absolute path is what gets probed and persisted, and nothing later ever
 * re-derives it from `PATH` again (§4.3).
 *
 * A probe never overwrites what a previous probe recorded (KAR-05.2): the
 * three-part primary key means an unchanged binary is a no-op row, so running
 * this on every `init` — and later on every `up`, once KAR-18.2 fills
 * `boot.ts`'s `probe-providers` slot — costs nothing extra.
 */
import type { CapabilityStore, LedgerSink, ProviderSpec, ResolvedProvider } from '@DeFlow/adapters';
import { PROVIDER_SPECS, probeProvider, spawnPlan } from '@DeFlow/adapters';
import type { Clock, ProviderId } from '@DeFlow/core';
import { ProviderIdSchema } from '@DeFlow/core';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

export type ProviderDetectionStatus = 'detected' | 'not-installed' | 'probe-failed';

export interface ProviderDetectionEntry {
  readonly provider: string;
  readonly status: ProviderDetectionStatus;
  /** Absolute, or `null` when nothing on `roots` resolved. */
  readonly binaryPath: string | null;
  /** The verbatim `--version` output, or `null` when this provider was never probed. */
  readonly version: string | null;
  /** One human-readable line: what was found, or what to run to install it. */
  readonly detail: string;
}

export interface DetectProvidersPorts {
  /** Directories to search, in order — the operator's own `PATH`, split. */
  readonly roots: readonly string[];
  /** Time enters here and nowhere else (NF9); `probed_at` is `clock.now()`. */
  readonly clock: Clock;
  readonly capabilities: CapabilityStore;
  readonly ledger: LedgerSink;
  /** Where each probe's throwaway working directory is created and removed. */
  readonly scratchDir: string;
  /** The base environment a probe's vendor overlay is layered over. Defaults
   * to `process.env` — pass the operator's own for `init`, and a hermetic one
   * from a spec that wants to prove no ambient variable leaked in. */
  readonly env?: NodeJS.ProcessEnv;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What an operator can do about a provider nothing on `roots` resolved. */
function installHint(spec: ProviderSpec): string {
  return (
    `${spec.id} is not installed here: no executable "${spec.bin}" was found on PATH — install ` +
    `it with \`npm install -g ${spec.package}\` (or your platform's own installer for that ` +
    "package) and run 'DeFlow init' again"
  );
}

/** A fresh, empty directory for one provider's probe, under `root`. */
async function scratchFor(root: string, provider: string): Promise<string> {
  await mkdir(root, { recursive: true });
  return mkdtempSync(join(root, `${provider}-`));
}

/** One provider: resolve it against `roots`, and probe it for real if found. */
async function detectOne(
  id: ProviderId,
  spec: ProviderSpec,
  ports: DetectProvidersPorts,
): Promise<ProviderDetectionEntry> {
  let resolved: ResolvedProvider;
  try {
    resolved = spec.resolve({ roots: ports.roots });
  } catch {
    return {
      provider: id,
      status: 'not-installed',
      binaryPath: null,
      version: null,
      detail: installHint(spec),
    };
  }

  const home = await scratchFor(ports.scratchDir, id);
  try {
    const plan = spawnPlan(spec, { resolved, worktree: home });
    const probed = await probeProvider(
      {
        provider: id,
        binaryPath: resolved.path,
        argv: plan.argv,
        // The vendor overlay goes *over* the real environment, never in place
        // of it (the same rule `launchProvider`'s own `startChild` applies):
        // `plan.env` is empty for every provider but codex, and codex's own
        // `CODEX_PATH` entry means nothing to a child spawned with no PATH at
        // all to find `node` through its own shebang.
        env: { ...(ports.env ?? process.env), ...plan.env },
        cwd: home,
      },
      { clock: ports.clock, ledger: ports.ledger, capabilities: ports.capabilities },
    );
    return {
      provider: id,
      status: 'detected',
      binaryPath: resolved.path,
      version: probed.row.version,
      detail: probed.inserted
        ? `resolved to ${resolved.path} and recorded a new row: ${probed.row.version}`
        : `resolved to ${resolved.path}; unchanged since the last probe: ${probed.row.version}`,
    };
  } catch (error) {
    return {
      provider: id,
      status: 'probe-failed',
      binaryPath: resolved.path,
      version: null,
      detail: `${resolved.path} resolved but did not answer initialize: ${messageOf(error)}`,
    };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Every registered provider (`@DeFlow/adapters`' `PROVIDER_SPECS`), resolved
 * and probed against `roots`, in id order. Never throws for a provider that
 * is absent or that refuses to answer — a missing agent CLI is a fact about
 * this machine, not a failure of `init` itself (NF7).
 */
export async function detectProviders(
  ports: DetectProvidersPorts,
): Promise<readonly ProviderDetectionEntry[]> {
  const entries: ProviderDetectionEntry[] = [];
  for (const [rawId, spec] of Object.entries(PROVIDER_SPECS).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    entries.push(await detectOne(ProviderIdSchema.parse(rawId), spec, ports));
  }
  return entries;
}
