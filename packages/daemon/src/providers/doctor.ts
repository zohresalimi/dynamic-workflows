/**
 * KAR-15.6 AC8 — the doctor: re-probe every adapter this machine has, then run
 * the conformance battery against each one.
 *
 * Two halves, and the order between them is the point. The probe answers *"is
 * this still the binary the manifest describes"* — a vendor CLI is upgraded
 * under a running daemon all the time, and the capability row is keyed on
 * `(provider, version, sha256)` precisely so that a changed binary is a new row
 * rather than a silently-wrong one. The battery then answers the question the
 * row cannot: *"does it still behave"* — `@DeFlow/adapters`' eight assertions
 * (docs/07-provider-adapter-layer.md §11.3), run against the binary that was
 * just probed, so the report describes one binary rather than two.
 *
 * Three decisions shape this module.
 *
 * **The targets are the rows, re-checked.** A doctor that searched the machine
 * would need install roots it has nowhere to read from, and `PATH` is never
 * consulted (§4.3): DeFlowd's environment is not the user's login shell. So the
 * candidates are the binary paths the manifest already recorded, and each is
 * re-checked with `resolveExecutable` rather than trusted — a path that has
 * been moved, deleted or `chmod`ed since the last probe fails here, by name,
 * which is the answer the operator can act on. A provider nothing has ever
 * probed is reported `installed: false`, never omitted.
 *
 * **A failure is a row in the report, not a 500.** One vendor CLI that will
 * not answer `initialize` must not cost the operator the other four answers —
 * "the doctor crashed" is the least useful thing this endpoint could say.
 *
 * **Two of the eight assertions cannot be staged against an installed binary**
 * and are reported as skips carrying the reason (`UNSTAGEABLE_REASON`). A
 * malformed line and an oversized frame have to be *provoked*, and DeFlow has
 * no way to make a vendor emit either on demand; the mock agent stages both in
 * the adapter suite. A skip is a result — an assertion that quietly did not run
 * is indistinguishable from one that passed.
 */
import type {
  AgentBinary,
  CapabilityStore,
  ConformanceCase,
  ConformanceReport,
  ConformanceStage,
} from '@DeFlow/adapters';
import {
  PROVIDER_SPECS,
  type ProviderSpec,
  probeProvider,
  resolveExecutable,
  runProviderConformance,
} from '@DeFlow/adapters';
import type { Clock, Db, NodeId, ProviderId, RunId } from '@DeFlow/core';
import { NodeIdSchema, ProviderIdSchema } from '@DeFlow/core';
import {
  listProviderCapabilities,
  openLedger,
  type ProviderCapabilityRow,
  putBlob,
  readProviderCapabilities,
  recordProviderCapabilities,
} from '@DeFlow/ledger';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sqliteLedgerSink } from '../exec/ledger-sink.ts';
import { log } from '../logging.ts';

const doctor = log.child({ mod: 'provider-doctor' });

/** `<dataDir>/doctor/` — the scratch every probe and every staged case runs in. */
export const DOCTOR_DIR = 'doctor';

/** The two cases only a cooperating mock can stage, and why. */
export const UNSTAGEABLE_CASES: readonly ConformanceCase[] = ['malformed-line', 'oversized-frame'];

export const UNSTAGEABLE_REASON =
  'this case has to be provoked and DeFlow cannot make an installed agent emit a malformed ' +
  'line or an oversized frame on demand; the mock agent stages both in the adapter suite';

/** How the probe's own events are attributed. One node per doctor session. */
const DOCTOR_NODE: NodeId = NodeIdSchema.parse('provider-doctor');

export type ProbeStatus = 'probed' | 'failed' | 'skipped';

export interface ProviderDoctorEntry {
  readonly provider: string;
  /** True only when a binary was found *and* answered `initialize` just now. */
  readonly installed: boolean;
  readonly binaryPath: string | null;
  readonly version: string | null;
  readonly binarySha256: string | null;
  readonly probedAt: number | null;
  /** The vendor's own `initialize` result, unmodified. `null` when unprobed. */
  readonly capabilities: unknown;
  /** Whether this re-probe recorded a row the manifest did not already hold. */
  readonly changed: boolean;
  readonly probe: { readonly status: ProbeStatus; readonly detail: string };
  readonly conformance: ConformanceReport | null;
}

export interface ProviderDoctorReport {
  /** When the doctor ran, on the injected clock. */
  readonly probedAt: number;
  /** The session the probe events were appended under. */
  readonly runId: RunId;
  readonly providers: readonly ProviderDoctorEntry[];
}

export interface ProviderDoctorPorts {
  readonly db: Db;
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  /** The blob store an assertion's evidence is captured into (KAR-03.9). */
  readonly dataDir: string;
  /** This daemon life's epoch, stamped on the events the probe appends. */
  readonly epoch: number;
  /**
   * The id the doctor's own events are attributed to.
   *
   * A probe happens outside any run, and every event still needs a position:
   * NF10's rule is that a fact is attributable, not that it belongs to a task.
   * Nothing appends `run.created` for it, so the run projection never lists it
   * as a run — it is a session id, and it is what makes "which doctor
   * invocation recorded this row" answerable months later.
   */
  readonly runId: RunId;
}

/** The manifest's port, over the daemon's write connection. */
function capabilityStore(db: Db): CapabilityStore {
  return {
    record: (row) => recordProviderCapabilities(db, row),
    read: (provider) =>
      readProviderCapabilities(db, provider).map((row) => ({
        ...row,
        provider: ProviderIdSchema.parse(row.provider),
      })),
  };
}

/** The newest row per provider, by id. */
function recordedRows(db: Db): ReadonlyMap<string, ProviderCapabilityRow> {
  return new Map(listProviderCapabilities(db).map((row) => [row.provider, row]));
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The ACP-mode argv for one provider, variant 0.
 *
 * Read off the spec rather than off the recorded row: the row records the
 * binary, and *how DeFlow invokes it* is the registry's answer — the same one
 * a node attempt uses, which is what makes the battery's result predictive of
 * a real turn rather than of a special doctor invocation.
 */
function acpArgv(spec: ProviderSpec, provider: ProviderId, path: string, worktree: string) {
  return spec.argv({ resolved: { provider, path }, worktree });
}

/**
 * An empty directory for one probe or one staged case, under the data dir
 * rather than in `/tmp`.
 *
 * The data dir because that is the one directory DeFlowd owns and can be told
 * about: a doctor that scattered agent worktrees through the system temp would
 * leave them there for whatever cleans `/tmp` to find, and an agent's scratch
 * is where its edits land. Each is removed by its caller as soon as the case
 * that used it is over.
 */
async function doctorScratch(dataDir: string, name: string): Promise<string> {
  const dir = join(dataDir, DOCTOR_DIR);
  await mkdir(dir, { recursive: true });
  return mkdtempSync(join(dir, `${name}-`));
}

/**
 * The battery, against the binary that was just probed.
 *
 * `capabilityRow` is the row this very re-probe recorded, which is what makes
 * assertion 6 meaningful: the question it asks is whether the manifest is
 * telling the truth about the binary standing behind it, and a row read from
 * an earlier probe would be a claim about a binary that may no longer exist.
 *
 * **The battery writes to a ledger of its own**, opened in the doctor's scratch
 * and discarded with it. That is not squeamishness about noise: the eight
 * assertions drive *real turns*, and a real turn appends `node.started`,
 * `budget.consumed` and `io_chunk` rows for a node that is in no plan, under a
 * run nobody submitted. Folded into the daemon's own ledger they would be spend
 * recorded against a phantom run and calibration samples learned from a
 * diagnostic — two numbers that then show up in a real run's estimate. The one
 * fact the battery produces *about this machine* is the probe's, and that is
 * appended to the real log, by `probeProvider`, before this runs.
 *
 * It is a real, file-backed ledger rather than a sink that invents sequence
 * numbers, because `LedgerSink.append` returning the assigned `seq` is a
 * durability claim (`@DeFlow/adapters`' ports): an adapter is entitled to
 * believe that the event it just wrote is committed, and a fake seq is exactly
 * the lie the port's shape exists to prevent.
 */
async function battery(
  provider: ProviderId,
  binary: AgentBinary,
  argv: readonly string[],
  row: Awaited<ReturnType<typeof probeProvider>>['row'],
  ports: ProviderDoctorPorts,
): Promise<ConformanceReport> {
  const scratch: string[] = [];
  const scratchDir = await doctorScratch(ports.dataDir, `${provider}-battery`);
  const scratchDb = openLedger(scratchDir);
  const sink = sqliteLedgerSink({
    db: scratchDb,
    runId: ports.runId,
    epoch: ports.epoch,
    // The *real* store, so that a failing assertion's evidence is fetchable
    // through `GET /api/artifacts/:sha` after the scratch ledger is gone.
    dataDir: ports.dataDir,
  });

  try {
    return await runProviderConformance(
      () => ({
        name: `${provider} ${row.version}`,
        capabilityRow: row,
        stage(kase: ConformanceCase): ConformanceStage {
          if (UNSTAGEABLE_CASES.includes(kase)) {
            return { kind: 'unavailable', reason: UNSTAGEABLE_REASON };
          }
          return { kind: 'target', binary, argv };
        },
      }),
      {
        clock: ports.clock,
        ledger: sink,
        captureEvidence: (evidence) =>
          putBlob(
            ports.dataDir,
            typeof evidence === 'string' ? new TextEncoder().encode(evidence) : evidence,
            typeof evidence === 'string' ? 'text/plain' : 'application/octet-stream',
          ),
        worktree: async (kase) => {
          const dir = await doctorScratch(ports.dataDir, `${provider}-${kase}`);
          scratch.push(dir);
          return dir;
        },
        runId: ports.runId,
        nodeId: DOCTOR_NODE,
        provider,
      },
    );
  } finally {
    scratchDb.close();
    for (const dir of [...scratch, scratchDir]) rmSync(dir, { recursive: true, force: true });
  }
}

/** One provider: resolve, re-probe, then run the battery. */
async function checkProvider(
  provider: ProviderId,
  spec: ProviderSpec,
  recorded: ProviderCapabilityRow | undefined,
  ports: ProviderDoctorPorts,
): Promise<ProviderDoctorEntry> {
  const unprobed = {
    provider,
    installed: false,
    binaryPath: null,
    version: null,
    binarySha256: null,
    probedAt: null,
    capabilities: null,
    changed: false,
    conformance: null,
  } as const;

  if (recorded === undefined) {
    return {
      ...unprobed,
      probe: {
        status: 'skipped',
        detail:
          `nothing has probed ${provider}, so the manifest records no binary to re-check — ` +
          `install ${spec.package} and probe it before the battery can say anything about it`,
      },
    };
  }

  let binaryPath: string;
  try {
    // Checked, never trusted: a binary can be upgraded, moved or `chmod`ed
    // under a running daemon, and a recorded path that no longer resolves has
    // to fail by name rather than as an ENOENT from a spawn.
    binaryPath = resolveExecutable(provider, spec.bin, {
      roots: [],
      binaryPath: recorded.binaryPath,
    });
  } catch (error) {
    return {
      ...unprobed,
      binaryPath: recorded.binaryPath,
      probe: { status: 'failed', detail: messageOf(error) },
    };
  }

  // One directory for the whole of this provider's visit, because the argv is
  // built once and one vendor takes its working directory *in* the argv: a
  // scratch that outlived only the probe would leave the battery invoking the
  // binary against a directory that is no longer there.
  const home = await doctorScratch(ports.dataDir, provider);
  const argv = acpArgv(spec, provider, binaryPath, home);

  try {
    let probed: Awaited<ReturnType<typeof probeProvider>>;
    try {
      probed = await probeProvider(
        { provider, binaryPath, argv, cwd: home },
        {
          clock: ports.clock,
          ledger: sqliteLedgerSink({
            db: ports.db,
            runId: ports.runId,
            epoch: ports.epoch,
            dataDir: ports.dataDir,
          }),
          capabilities: capabilityStore(ports.db),
        },
      );
    } catch (error) {
      doctor.warn({ provider, err: error }, 'a provider could not be re-probed');
      return { ...unprobed, binaryPath, probe: { status: 'failed', detail: messageOf(error) } };
    }

    const found = {
      provider,
      installed: true,
      binaryPath,
      version: probed.row.version,
      binarySha256: probed.row.binarySha256,
      probedAt: probed.row.probedAt,
      capabilities: JSON.parse(probed.row.capsJson) as unknown,
      changed: probed.inserted,
      probe: {
        status: 'probed' as const,
        detail: probed.inserted
          ? `recorded a new row: ${probed.row.version} (${probed.row.binarySha256.slice(0, 12)})`
          : `unchanged since the last probe: ${probed.row.version}`,
      },
    };

    const binary: AgentBinary = {
      path: binaryPath,
      version: probed.row.version,
      sha256: probed.row.binarySha256,
    };

    try {
      return { ...found, conformance: await battery(provider, binary, argv, probed.row, ports) };
    } catch (error) {
      // The probe still happened and its row is still recorded; losing the
      // battery is not a reason to throw away the half of the answer that
      // succeeded.
      doctor.error({ provider, err: error }, 'the conformance battery could not be run');
      return {
        ...found,
        probe: { status: 'probed', detail: `${found.probe.detail}; battery: ${messageOf(error)}` },
        conformance: null,
      };
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

let inFlight: Promise<ProviderDoctorReport> | null = null;

/**
 * Re-probes every recorded adapter and runs the battery against each.
 *
 * **Single-flight**, and that is a property of the endpoint rather than an
 * optimisation: this spawns vendor processes, and a double-clicked button that
 * ran two batteries at once would have two of them probing the same binary and
 * writing the same rows. A second caller joins the report already being
 * computed — it is a re-probe that started moments before their request, which
 * is what they asked for, and no caller is ever served a cached one.
 */
export function runProviderDoctor(ports: ProviderDoctorPorts): Promise<ProviderDoctorReport> {
  if (inFlight !== null) return inFlight;
  const running = doctorRun(ports).finally(() => {
    inFlight = null;
  });
  inFlight = running;
  return running;
}

async function doctorRun(ports: ProviderDoctorPorts): Promise<ProviderDoctorReport> {
  const recorded = recordedRows(ports.db);
  const providers: ProviderDoctorEntry[] = [];

  // Sequential rather than concurrent: every entry spawns processes, and a
  // machine with five adapters installed would otherwise have five agents and
  // their children running at once while the operator waits for one answer.
  for (const [id, spec] of Object.entries(PROVIDER_SPECS).toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const provider = ProviderIdSchema.parse(id);
    providers.push(await checkProvider(provider, spec, recorded.get(id), ports));
  }

  return { probedAt: ports.clock.now(), runId: ports.runId, providers };
}
