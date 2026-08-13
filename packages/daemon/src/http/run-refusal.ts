/**
 * KAR-19.2 AC2, AC8 — reading a refusal back out of the ledger.
 *
 * The refusal's *prose* is deliberately not stored. What `POST /api/runs`
 * wrote down is the facts — one `provider.probed` per provider, then
 * `run.aborted` — and this re-renders the sentence from them through
 * `admitRun`, the same function that produced the one on the 4xx. Two stored
 * copies of a sentence are two that can disagree; a stored one is one that can
 * never be improved. Re-rendering makes *"the same renderer"* (AC3) true for
 * the read path as well as the write path.
 *
 * The read is bounded and cheap: a refused run's whole ledger is a handful of
 * events, and a run that was never refused is answered by the first page coming
 * back without an admission record.
 *
 * Verifies: EPIC-19-S15 · AC2, AC8
 */
import {
  admitRun,
  type ProviderResolution,
  providerSpec,
  type RunAdmission,
} from '@DeFlow/adapters';
import type { RunId } from '@DeFlow/core';
import type { LedgerView } from './ledger-view.ts';

/** Enough to cover the registry several times over; a refused run's ledger is
 * `task.submitted`, one row per provider, and `run.aborted`. */
const REFUSAL_WINDOW = 64;

/** What `GET /api/runs/:id` carries for a run admission refused. */
export interface RunRefusal {
  readonly code: string;
  readonly message: string;
  readonly providers: readonly {
    readonly id: string;
    readonly state: string;
    readonly vendorPath: string | null;
    readonly adapterPackage: string;
  }[];
}

/**
 * The admission arm of a `provider.probed` payload, or `null`.
 *
 * Read structurally rather than through the Zod union: what arrives here has
 * been through `JSON.parse`, and the honest thing to say about it is what was
 * actually checked. `admission` is the discriminator — the probe arm never
 * carries it.
 */
function asResolution(payload: unknown): ProviderResolution | null {
  const record = payload as Record<string, unknown> | null;
  if (record === null || typeof record.admission !== 'string') return null;
  if (typeof record.provider !== 'string') return null;

  /** A recorded string, or the empty one — never a stringified object. */
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  const path = (value: unknown): string | null => (typeof value === 'string' ? value : null);

  return {
    provider: record.provider,
    state: record.admission as ProviderResolution['state'],
    // `kind` is not recorded: nothing about a refusal read back needs it, and
    // `providerVerdict` only consults it on the `not-installed` branch, where
    // the recorded `vendorBin === adapterBin` says the same thing.
    kind: record.vendorBin === record.adapterBin ? 'native' : 'adapter',
    vendorBin: str(record.vendorBin),
    vendorPath: path(record.vendorPath),
    adapterBin: str(record.adapterBin),
    adapterPath: path(record.adapterPath),
    package: str(record.package),
    // Not recorded either, and deliberately read from the registry rather than
    // from the row: whether a binary ships inside DeFlow's own tarball is a
    // property of the build rendering the sentence, not of the machine the
    // refusal happened on six weeks ago (KAR-19.7 AC8).
    bundled: providerSpec(record.provider)?.bundled ?? false,
    ...(typeof record.stderr === 'string' ? { handshakeStderr: record.stderr } : {}),
  };
}

/**
 * Why this run was refused at submission, or `null` — for every run that was
 * not, which is nearly all of them.
 */
export function runRefusal(view: LedgerView, runId: RunId): RunRefusal | null {
  const resolutions = view
    .tail(runId, 0, REFUSAL_WINDOW)
    .filter((event) => event.kind === 'provider.probed')
    .map((event) => asResolution(event.payload))
    .filter((entry): entry is ProviderResolution => entry !== null);

  if (resolutions.length === 0) return null;

  const admission: RunAdmission = admitRun(resolutions);
  if (admission.outcome !== 'refused') return null;

  return {
    code: admission.code,
    message: admission.message,
    providers: admission.providers,
  };
}
