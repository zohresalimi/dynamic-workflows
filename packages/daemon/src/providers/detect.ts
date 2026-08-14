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
import {
  PROVIDER_SPECS,
  probeProvider,
  providerVerdict,
  resolveProviderState,
  spawnPlan,
} from '@DeFlow/adapters';
import type { Clock, ProviderId } from '@DeFlow/core';
import { ProviderIdSchema } from '@DeFlow/core';
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import process from 'node:process';

/**
 * `'cached'` is KAR-18.2's addition and the one status that is a *decision*
 * rather than an observation: the binary resolved, its bytes hash to a row this
 * machine already probed, and no `initialize` handshake was performed. It is
 * what keeps the boot probe inside NF3 (EPIC-18-S17).
 */
export type ProviderDetectionStatus = 'detected' | 'cached' | 'not-installed' | 'probe-failed';

export interface ProviderDetectionEntry {
  readonly provider: string;
  readonly status: ProviderDetectionStatus;
  /** Absolute, or `null` when nothing on `roots` resolved. */
  readonly binaryPath: string | null;
  /** The verbatim `--version` output, or `null` when this provider was never probed. */
  readonly version: string | null;
  /** One human-readable line: what was found, or what to run to install it. */
  readonly detail: string;
  /**
   * KAR-19.2 AC7 — for `probe-failed` only: what the child said on its own
   * stderr while failing to answer `initialize`, trimmed and never paraphrased.
   *
   * Carried as its own field rather than left inside `detail` because
   * admission forwards it into a refusal message built by a different
   * renderer, and re-extracting it out of a sentence would be a parse of our
   * own prose.
   */
  readonly stderr?: string;
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
  /**
   * KAR-18.2 — answer from the recorded manifest when the binary's bytes are
   * unchanged, instead of handshaking it again (EPIC-18-S17).
   *
   * Off by default, and deliberately so: `DeFlow init` is the command an
   * operator runs *because* something about their installation changed, and a
   * cached answer there would be the wrong one. `DeFlow up` runs on every
   * start, is on the NF3 budget, and turns it on.
   */
  readonly reuseCache?: boolean;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The probed child's own stderr, off `probeProvider`'s failure tag, or `null`.
 *
 * Read structurally rather than through a type import: `FailureTag.detail` is
 * `Record<string, unknown>` by construction, and what is honest to say about a
 * value out of it is what was actually checked.
 */
function childStderr(error: unknown): string | null {
  const detail = (error as { deflowFailure?: { detail?: unknown } } | null)?.deflowFailure?.detail;
  const said = (detail as { stderr?: unknown } | undefined)?.stderr;
  return typeof said === 'string' && said.trim() !== '' ? said.trim() : null;
}

/** `PATH`, split into the directories a binary is looked for in, in order. */
export function pathRoots(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? '').split(delimiter).filter((entry) => entry !== '');
}

/**
 * sha256 of the resolved entry file, streamed — the same digest `probeProvider`
 * records, computed the same way, because the two are compared.
 *
 * Streamed rather than read whole: a vendor bin can be tens of megabytes, and
 * this runs on every boot.
 */
async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return hash.digest('hex');
}

/**
 * What an operator can do about a provider nothing on `roots` resolved.
 *
 * Delegated to `providerVerdict` rather than written here, and that is
 * KAR-19.2 AC3 applied to the module that produced the original complaint.
 * This function used to say `<provider> is not installed here` while naming
 * `spec.bin` — the *adapter* — which is precisely the sentence KAR-18.8 removed
 * from `doctor`: true about `claude-agent-acp`, wrong about the `claude` the
 * operator could see working in the same shell. Resolving both binaries here
 * costs two `statSync` walks on a path that is already doing filesystem work,
 * and buys the same three-state vocabulary every other surface uses.
 */
function installHint(spec: ProviderSpec, roots: readonly string[]): string {
  return providerVerdict(resolveProviderState(spec, roots)).detail;
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
      detail: installHint(spec, ports.roots),
    };
  }

  // KAR-18.2 — the cache check, before anything is spawned. Keyed on the
  // sha256 of the entry file rather than on the reported version, because
  // reading the version is itself a spawn: asking `--version` five times is
  // most of what the cache exists to avoid, and a rebuilt binary at an
  // unchanged version — routine with a nightly or a `pnpm link` — would slip
  // past a version-only key anyway. A hash mismatch is a re-probe, and the
  // re-probe is what re-reads the version.
  if (ports.reuseCache === true) {
    const digest = await sha256File(resolved.path);
    const cached = ports.capabilities
      .read(id)
      .find((row) => row.binarySha256 === digest && row.binaryPath === resolved.path);
    if (cached !== undefined) {
      // "We looked again just now": the only column a repeat probe moves.
      ports.capabilities.record({ ...cached, probedAt: ports.clock.now() });
      return {
        provider: id,
        status: 'cached',
        binaryPath: resolved.path,
        version: cached.version,
        detail:
          `${resolved.path} is unchanged since the last probe (${cached.version}); answered from ` +
          'the capability manifest without an initialize handshake',
      };
    }
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
    const said = childStderr(error);
    return {
      provider: id,
      status: 'probe-failed',
      binaryPath: resolved.path,
      version: null,
      detail: `${resolved.path} resolved but did not answer initialize: ${messageOf(error)}`,
      ...(said === null ? {} : { stderr: said }),
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
