/**
 * KAR-18.4, categories 4–6 — Agents, Capabilities and Conformance.
 *
 * The three are one module because they are one pass over the machine: what is
 * installed, what it said when asked, and whether it behaves. Splitting them
 * would mean probing twice, and a probe is a spawned vendor process.
 *
 * Three decisions shape it.
 *
 * **The matrix is derived, never hardcoded (AR-5).** Every capability answer
 * below comes out of a stored `initialize` response through
 * `@DeFlow/adapters`' `capability()`. There is no table in this file keyed by
 * vendor name — `test/no-capability-table.test.ts` enforces the same rule one
 * package over, and EPIC-18-S31's second scenario is why: two of the five
 * measured adapter versions were published the same day they were probed, so a
 * constant would be wrong within a month.
 *
 * **Recorded first, detected second.** The manifest rows are read *before*
 * detection runs, because detection records new ones — comparing after would
 * be comparing a row with itself and drift would never be reported. That is
 * the whole of EPIC-18-S32, including its third row: a locally-linked or
 * nightly build reports an unchanged version string while being a different
 * program, which only the sha256 catches.
 *
 * **A missing binary resolves to "absent"; it never rejects.** `doctor` is the
 * first thing a new user runs, and the difference between "0 installed, here
 * is how to install one" and `ENOENT: spawn claude` decides whether they try
 * again (EPIC-18-S27).
 *
 * Verifies: EPIC-18-S26, EPIC-18-S27, EPIC-18-S31, EPIC-18-S32 · AC2, AC6, AC7
 */
import {
  binaryDrift,
  CAPABILITY_PATHS,
  type CapabilityKey,
  type CapabilityRow,
  capability,
  PROVIDER_SPECS,
  renderAuthMethods,
  selectResumeStrategy,
} from '@DeFlow/adapters';
import type { Clock, Db, RunId } from '@DeFlow/core';
import { ProviderIdSchema } from '@DeFlow/core';
import {
  detectProviders,
  type ProviderDetectionEntry,
  type ProviderDoctorReport,
  runProviderDoctor,
  sqliteLedgerSink,
} from '@DeFlow/daemon';
import {
  listProviderCapabilities,
  readProviderCapabilities,
  recordProviderCapabilities,
} from '@DeFlow/ledger';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DoctorCheck } from './report.ts';

/** Where the goldens are refreshed from, named in every drift warning (AC7). */
export const RECORD_COMMAND = 'pnpm test:record';

/** `<dataDir>/doctor-probe/` — a throwaway working directory per probe. */
const PROBE_SCRATCH = 'doctor-probe';

/** The routing questions the regenerated matrix answers, in report order. */
const MATRIX_KEYS: readonly CapabilityKey[] = Object.keys(CAPABILITY_PATHS) as CapabilityKey[];

export interface AgentsInput {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** `PATH`, split — the operator's own, passed in rather than read here. */
  readonly roots: readonly string[];
  readonly dataDir: string;
  /** `null` when the state directory could not be opened. */
  readonly db: Db | null;
  readonly clock: Clock;
  /** The session the probe's own events are attributed to. */
  readonly runId: RunId;
  readonly epoch: number;
  /** Where `<agent>@<version>.json` is written and diffed (AC6). */
  readonly capabilityFixtureDir: string;
  /** Run the F3.4 battery. Off makes `doctor` fast and says it did not test. */
  readonly conformance: boolean;
}

export interface AgentsResult {
  /**
   * The login commands each probed adapter reported, per provider — rendered
   * as strings by `@DeFlow/adapters`' `renderAuthMethods`, and passed to the
   * Auth shadowing section so `doctor` can print what the operator should run
   * (AC5).
   *
   * A string, and only ever a string. Nothing turns one back into an argv:
   * Copilot's `initialize` hands back a literal `{command, args}` ready to
   * execute, and executing it is precisely what AR-1 forbids.
   */
  readonly loginCommands: ReadonlyMap<string, readonly string[]>;
  readonly agents: readonly DoctorCheck[];
  readonly capabilities: readonly DoctorCheck[];
  readonly conformance: readonly DoctorCheck[];
}

/** sha256 of the resolved entry file, streamed — a vendor bin can be tens of
 * megabytes, and this is the same digest the probe records. */
async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Uint8Array);
  return hash.digest('hex');
}

const short = (sha: string): string => sha.slice(0, 12);

/** Every provider the registry knows, with the command that installs it. */
function installHints(): string {
  return Object.values(PROVIDER_SPECS)
    .map((spec) => `  ${spec.id}: npm install -g ${spec.package}`)
    .join('\n');
}

const usable = (entry: ProviderDetectionEntry): boolean =>
  entry.status === 'detected' || entry.status === 'cached';

/** The summary line, and — when nothing is installed — what to do about it. */
function summaryCheck(entries: readonly ProviderDetectionEntry[]): DoctorCheck {
  const installed = entries.filter(usable);
  if (installed.length > 0) {
    return {
      id: 'agents.summary',
      status: 'ok',
      detail: `${installed.length} installed: ${installed
        .map((entry) => entry.provider)
        .join(', ')}`,
      data: { installed: installed.length },
    };
  }

  return {
    id: 'agents.summary',
    status: 'ok',
    detail: [
      '0 installed — which is not a failure. Install any one of these:',
      installHints(),
      '  The bundled mock agent runs a whole plan with no vendor CLI, and ' +
        '"DeFlow replay <fixture>" serves a recorded run over the same HTTP contract the UI ' +
        'speaks to a live daemon, so development and replay work regardless.',
    ].join('\n'),
    data: { installed: 0 },
  };
}

/** One installed adapter: the absolute path, the version, the sha256. */
function installedCheck(
  entry: ProviderDetectionEntry,
  sha: string | null,
  row: CapabilityRow | undefined,
): DoctorCheck {
  return {
    id: `agents.${entry.provider}`,
    status: 'ok',
    detail:
      `${entry.provider} ${entry.version ?? '(no version reported)'} at ${entry.binaryPath} ` +
      `(sha256 ${sha === null ? 'unreadable' : short(sha)}) — the absolute path DeFlowd would ` +
      "spawn, resolved now rather than looked up on the daemon's own PATH later.",
    data: {
      provider: entry.provider,
      binaryPath: entry.binaryPath,
      version: entry.version,
      sha256: sha,
      probedAt: row?.probedAt ?? null,
    },
  };
}

/** AC7 — a version or a sha that moved since the last recorded probe. */
function driftCheck(
  provider: string,
  recorded: CapabilityRow,
  installed: { readonly version: string; readonly sha256: string },
): DoctorCheck {
  const drift = binaryDrift(
    { version: recorded.version, sha256: recorded.binarySha256 },
    installed,
  );

  if (drift.length === 0) {
    return {
      id: `agents.${provider}.drift`,
      status: 'ok',
      detail:
        `${provider} matches the recorded manifest: ${recorded.version} ` +
        `(sha256 ${short(recorded.binarySha256)}), so the goldens recorded against it still ` +
        'describe the binary that is installed.',
      data: { drift: [] },
    };
  }

  return {
    id: `agents.${provider}.drift`,
    status: 'warn',
    detail:
      `${provider} has drifted since the last recorded probe (${drift.join(' and ')}): ` +
      `recorded ${recorded.version} sha256 ${short(recorded.binarySha256)}, installed ` +
      `${installed.version} sha256 ${short(installed.sha256)}. Recordings are keyed on the exact ` +
      `agent version, so refresh the goldens with "${RECORD_COMMAND}" before trusting a replay ` +
      'against them.',
    data: {
      drift: [...drift],
      recorded: { version: recorded.version, sha256: recorded.binarySha256 },
      installed: { version: installed.version, sha256: installed.sha256 },
    },
  };
}

/**
 * The regenerated matrix for one probed row: every routing question, answered
 * from what the agent actually said.
 *
 * Booleans, and an absent key reads as `false` — the same reading
 * `@DeFlow/adapters`' `canResume`/`canFork`/`canList` use, because a
 * capability nobody advertised is one DeFlow must not route through. The
 * *reason* survives alongside it (`capability-absent` versus
 * `capability-denied`), so an operator reading "cannot fork" can still tell
 * "never mentioned it" from "told us no" without the matrix having to carry a
 * third value that every consumer would then have to interpret.
 */
function capabilityMatrixOf(row: CapabilityRow): Record<string, boolean> {
  const matrix: Record<string, boolean> = {};
  for (const key of MATRIX_KEYS) matrix[key] = capability(row, key).supported === true;
  return matrix;
}

/** Why each answer is what it is, for the `--json` document. */
function capabilityReasons(row: CapabilityRow): Record<string, string> {
  const reasons: Record<string, string> = {};
  for (const key of MATRIX_KEYS) reasons[key] = capability(row, key).reason;
  return reasons;
}

interface Baseline {
  readonly file: string;
  readonly matrix: Record<string, unknown>;
}

/** The most recently probed fixture for `agent`, whatever version it names. */
function readBaseline(dir: string, agent: string): Baseline | null {
  if (!existsSync(dir)) return null;

  const candidates = readdirSync(dir)
    .filter((name) => name.startsWith(`${agent}@`) && name.endsWith('.json'))
    .sort();

  let newest: { at: number; baseline: Baseline } | null = null;
  for (const name of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
        probedAt?: string;
        capabilityMatrix?: Record<string, unknown>;
      };
      if (parsed.capabilityMatrix === undefined) continue;
      const at = Date.parse(parsed.probedAt ?? '') || 0;
      if (newest === null || at >= newest.at) {
        newest = { at, baseline: { file: name, matrix: parsed.capabilityMatrix } };
      }
    } catch {
      // A fixture nobody can parse is not a baseline. Regenerating over it is
      // the right outcome, and saying nothing about it is the wrong one — but
      // it is the *diff* that is unavailable, not the probe.
    }
  }
  return newest?.baseline ?? null;
}

/** Fields whose value changed between the baseline and this probe. */
function matrixDiff(
  baseline: Record<string, unknown>,
  current: Record<string, boolean>,
): readonly string[] {
  const fields = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  return [...fields]
    .filter((field) => JSON.stringify(baseline[field]) !== JSON.stringify(current[field]))
    .sort();
}

/**
 * One adapter's capability check: regenerate, persist, diff (AC6).
 *
 * The fixture is written *before* the diff is reported, so the file on disk is
 * always the last thing that was actually probed — a diff that failed to write
 * would otherwise leave the baseline describing a machine that no longer
 * exists, and the next run would report the same change again.
 */
async function capabilityCheck(
  provider: string,
  row: CapabilityRow,
  fixtureDir: string,
  clock: Clock,
): Promise<DoctorCheck> {
  const matrix = capabilityMatrixOf(row);
  const reasons = capabilityReasons(row);
  const strategy = selectResumeStrategy(row);
  const baseline = readBaseline(fixtureDir, provider);
  const probedAt = new Date(clock.now()).toISOString();

  mkdirSync(fixtureDir, { recursive: true });
  await writeFile(
    join(fixtureDir, `${provider}@${row.version}.json`),
    `${JSON.stringify(
      {
        agent: provider,
        version: row.version,
        binarySha256: row.binarySha256,
        probedAt,
        agentCapabilities: (JSON.parse(row.capsJson) as { agentCapabilities?: unknown })
          .agentCapabilities,
        capabilityMatrix: matrix,
        capabilityReasons: reasons,
      },
      null,
      2,
    )}\n`,
  );

  const resumeSentence =
    `resume strategy DeFlow would use: ${strategy}` +
    (strategy === 'ResumeByReplay'
      ? ' — this adapter advertises no session.resume, so a resumed node replays its ' +
        'transcript into a fresh session instead.'
      : ' — this adapter advertises session.resume, so a resumed node rejoins its session.');

  const head =
    `${provider} ${row.version}: regenerated from its own initialize response at ${probedAt}. ` +
    resumeSentence;

  if (baseline === null) {
    return {
      id: `capabilities.${provider}`,
      status: 'ok',
      detail: `${head} No earlier fixture existed for this adapter, so this probe is the new baseline.`,
      data: { matrix, reasons, resume: strategy, probedAt },
    };
  }

  const changed = matrixDiff(baseline.matrix, matrix);
  if (changed.length === 0) {
    return {
      id: `capabilities.${provider}`,
      status: 'ok',
      detail: `${head} Unchanged against the recorded baseline ${baseline.file}.`,
      data: { matrix, reasons, resume: strategy, probedAt, baseline: baseline.file },
    };
  }

  const named = changed
    .map(
      (field) =>
        `${field}: ${JSON.stringify(baseline.matrix[field])} → ${JSON.stringify(matrix[field])}`,
    )
    .join(', ');

  return {
    id: `capabilities.${provider}`,
    status: 'warn',
    detail:
      `${head} Conformance-relevant change against the recorded baseline ${baseline.file} — ` +
      `adapter ${provider}, ${named}. Re-run the F3.4 battery and refresh the goldens with ` +
      `"${RECORD_COMMAND}" before trusting a recording made against the old answer.`,
    data: {
      matrix,
      reasons,
      resume: strategy,
      probedAt,
      baseline: baseline.file,
      changed: [...changed],
    },
  };
}

/** The battery's report, per adapter, as a check apiece. */
function conformanceChecks(report: ProviderDoctorReport): readonly DoctorCheck[] {
  return report.providers
    .filter((entry) => entry.conformance !== null)
    .map((entry) => {
      const results = entry.conformance?.results ?? [];
      const failed = results.filter((result) => result.status === 'failed');
      const skipped = results.filter((result) => result.status === 'skipped');
      const passed = results.length - failed.length - skipped.length;
      const census = `${passed} passed, ${failed.length} failed, ${skipped.length} skipped`;

      return {
        id: `conformance.${entry.provider}`,
        // A failed assertion routes the planner away from this adapter (NF7);
        // it does not make the machine unusable, and `fail` is reserved for
        // "DeFlow cannot run here at all" so the exit code stays worth
        // branching on.
        status: failed.length === 0 ? ('ok' as const) : ('warn' as const),
        detail:
          `${entry.provider}: ${census}. ` +
          (failed.length === 0
            ? 'A skip is a result, not a pass — two of the eight assertions have to be provoked ' +
              'and cannot be staged against an installed binary.'
            : `Failed: ${failed
                .map((result) => `#${result.assertion} ${result.name} (${result.detail})`)
                .join('; ')}`),
        data: { passed, failed: failed.length, skipped: skipped.length },
      };
    });
}

export async function agentChecks(input: AgentsInput): Promise<AgentsResult> {
  if (input.db === null) {
    const unavailable = (id: string): DoctorCheck => ({
      id,
      status: 'warn',
      detail:
        'not checked: the global state directory could not be opened, and the capability ' +
        'manifest lives in it — see the Runtime section.',
    });
    return {
      loginCommands: new Map(),
      agents: [unavailable('agents.unavailable')],
      capabilities: [unavailable('capabilities.unavailable')],
      conformance: [unavailable('conformance.unavailable')],
    };
  }

  const db = input.db;

  // Read before detecting: detection records rows, and a comparison made after
  // it would be a row compared with itself (EPIC-18-S32).
  const recorded = new Map(
    listProviderCapabilities(db).map((row) => [
      row.provider,
      { ...row, provider: ProviderIdSchema.parse(row.provider) } as CapabilityRow,
    ]),
  );

  const scratchDir = join(input.dataDir, PROBE_SCRATCH);
  let entries: readonly ProviderDetectionEntry[];
  try {
    entries = await detectProviders({
      roots: input.roots,
      clock: input.clock,
      env: input.env,
      capabilities: {
        record: (row) => recordProviderCapabilities(db, row),
        read: (provider) =>
          readProviderCapabilities(db, provider).map((row) => ({
            ...row,
            provider: ProviderIdSchema.parse(row.provider),
          })),
      },
      ledger: sqliteLedgerSink({
        db,
        runId: input.runId,
        epoch: input.epoch,
        dataDir: input.dataDir,
      }),
      scratchDir,
    });
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }

  const agents: DoctorCheck[] = [summaryCheck(entries)];
  const capabilities: DoctorCheck[] = [];
  const loginCommands = new Map<string, readonly string[]>();

  for (const entry of entries) {
    if (!usable(entry) || entry.binaryPath === null) {
      agents.push({
        id: `agents.${entry.provider}`,
        status: 'ok',
        detail: entry.detail,
        data: { provider: entry.provider, status: entry.status },
      });
      continue;
    }

    let sha: string | null = null;
    try {
      sha = await sha256File(entry.binaryPath);
    } catch {
      // A binary that resolved and then could not be read is a fact worth
      // reporting, but it is not worth losing the rest of the section over.
    }

    const probed = readProviderCapabilities(db, entry.provider)
      .map((row) => ({ ...row, provider: ProviderIdSchema.parse(row.provider) }) as CapabilityRow)
      .filter((row) => sha === null || row.binarySha256 === sha)
      .toSorted((a, b) => b.probedAt - a.probedAt)[0];

    agents.push(installedCheck(entry, sha, probed));

    const previously = recorded.get(entry.provider);
    if (previously !== undefined && sha !== null && entry.version !== null) {
      agents.push(driftCheck(entry.provider, previously, { version: entry.version, sha256: sha }));
    }

    if (probed !== undefined) {
      capabilities.push(
        await capabilityCheck(entry.provider, probed, input.capabilityFixtureDir, input.clock),
      );

      // AC5's second half. `renderAuthMethods` reads the `authMethods` block
      // out of the stored response and returns *text*; an empty array is the
      // normal, already-authenticated case (all five measured vendors but
      // Copilot answered exactly that) and produces no line at all.
      const commands = renderAuthMethods(probed.capsJson)
        .map((instruction) => instruction.command)
        .filter((command): command is string => command !== null);
      if (commands.length > 0) loginCommands.set(entry.provider, commands);
    }
  }

  if (capabilities.length === 0) {
    capabilities.push({
      id: 'capabilities.none',
      status: 'warn',
      detail:
        'no matrix could be generated: no adapter answered an ACP initialize on this machine, ' +
        'and the matrix is derived from live responses rather than read from a constant (AR-5). ' +
        'Install a vendor CLI and run doctor again.',
    });
  }

  const installedCount = entries.filter(usable).length;
  if (installedCount === 0) {
    return {
      loginCommands,
      agents,
      capabilities,
      conformance: [
        {
          id: 'conformance.skipped',
          // "skipped", never "passed": a green doctor on a machine where
          // nothing was tested is how a broken adapter reaches a three-hour run.
          status: 'warn',
          detail:
            'skipped — no adapter installed. The F3.4 battery asserts what an installed vendor ' +
            'CLI actually does, and there is nothing here to assert it against. This is not a ' +
            'pass.',
        },
      ],
    };
  }

  if (!input.conformance) {
    return {
      loginCommands,
      agents,
      capabilities,
      conformance: [
        {
          id: 'conformance.skipped',
          status: 'warn',
          detail:
            'skipped — --skip-conformance was passed. The battery spawns a real turn per ' +
            'assertion per adapter; nothing below was tested, which is not the same as passing.',
        },
      ],
    };
  }

  try {
    const report = await runProviderDoctor({
      db,
      clock: input.clock,
      dataDir: input.dataDir,
      epoch: input.epoch,
      runId: input.runId,
    });
    const checks = conformanceChecks(report);
    return {
      loginCommands,
      agents,
      capabilities,
      conformance:
        checks.length > 0
          ? checks
          : [
              {
                id: 'conformance.none',
                status: 'warn',
                detail:
                  'the battery produced no adapter report: every installed binary failed to ' +
                  're-probe. See the Agents section for which one and why.',
              },
            ],
    };
  } catch (error) {
    return {
      loginCommands,
      agents,
      capabilities,
      conformance: [
        {
          id: 'conformance.error',
          status: 'warn',
          detail:
            'the F3.4 battery could not be run: ' +
            `${error instanceof Error ? error.message : String(error)}. Nothing below was ` +
            'tested, which is not the same as passing.',
        },
      ],
    };
  }
}
