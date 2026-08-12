/**
 * `DeFlow doctor` (KAR-18.4) — the whole command, minus the process it runs in.
 *
 * Returns rather than exits, and never writes to a stream itself: `bin.ts`
 * owns the process, and a function that called `process.exit` could not be
 * tested without one. That is the same split `runInit` and `runUp` already
 * use.
 *
 * **Nothing here throws.** `doctor` is the first thing a new user runs and the
 * one command whose whole job is to describe a broken machine; a stack trace
 * from inside a probe would be the single worst output it could produce
 * (EPIC-18-S27). So every category is wrapped, and a category that threw
 * becomes a `fail` check carrying the message — visible, attributable, and
 * still leaving the other seven their answers.
 *
 * **The order of collection is load-bearing in exactly one place.** The
 * runtime writability check runs first, because everything downstream of it —
 * the manifest, the FTS5 tables, the calibration — lives in the state
 * directory it is checking. When that directory is unusable the ledger is not
 * opened at all, and the sections that need it say so rather than reporting a
 * second, derived failure with a less useful message.
 *
 * Verifies: EPIC-18-S26 … EPIC-18-S36 · AC1-AC11
 */
import type { Clock, Db } from '@DeFlow/core';
import { mintRunId } from '@DeFlow/core';
import { loadNodePty, pathRoots, resolveDataDir, systemClock } from '@DeFlow/daemon';
import { openLedger, readEpoch } from '@DeFlow/ledger';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';
import type { Style } from '../render/style.ts';
import { installMode } from './agent-install.ts';
import { type AgentsInput, type AgentsResult, agentChecks } from './agents.ts';
import { authChecks } from './auth.ts';
import { gitChecks } from './git.ts';
import { memoryChecks } from './memory.ts';
import { probeWritable } from './paths.ts';
import {
  type DoctorCheck,
  type DoctorReport,
  type DoctorSectionId,
  type DoctorSectionInput,
  reduceReport,
  renderJson,
  renderText,
} from './report.ts';
import { runtimeChecks } from './runtime.ts';
import { sandboxChecks } from './sandbox.ts';

/** Where the regenerated capability fixtures go when nothing says otherwise. */
export const CAPABILITY_FIXTURE_DIR = 'capabilities';

/** `kernel.apparmor_restrict_unprivileged_userns`, read from procfs.
 *
 * A file read rather than a `sysctl` subprocess: the value is a file on the
 * only platform that has it, and spawning a binary to read a file is one more
 * thing that can be missing from a `PATH`. */
function readSysctlFromProc(key: string): string | null {
  try {
    return readFileSync(`/proc/sys/${key.replaceAll('.', '/')}`, 'utf8');
  } catch {
    return null;
  }
}

export interface DoctorOptions {
  /** The repository doctor was run from. */
  readonly cwd: string;
  /** Defaults to `process.env`: `PATH`, `XDG_DATA_HOME`/`DeFlow_DATA_DIR` and
   * the auth-shadowing variables all come from here. */
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: Clock;
  /** Emit the machine document instead of the human one (AC10). */
  readonly json?: boolean;
  /** The platform whose sandbox prerequisites are reported. An input, so the
   * Linux ladder is exercisable from macOS. */
  readonly platform?: NodeJS.Platform;
  readonly readSysctl?: (key: string) => string | null;
  /** The optional native pty. An input so its absence is stageable. */
  readonly loadPty?: () => Promise<unknown>;
  /** `process.versions.node` by default. */
  readonly nodeVersion?: string;
  /** Where `<agent>@<version>.json` is written; `<dataDir>/capabilities` by
   * default, never the operator's repository. */
  readonly capabilityFixtureDir?: string;
  /** Run the F3.4 battery. Default true. */
  readonly conformance?: boolean;
  /** KAR-18.8 — install the ACP adapter for every `adapter-missing` provider
   * without asking. The only way an install happens with no TTY (AC6). */
  readonly fix?: boolean;
  /** Whether stdout is a terminal, so an offer can be made at all. An input so
   * a spec can stage one without a pty. */
  readonly isTty?: () => boolean;
  /** Prints one question and reads the answer — the only reader of stdin in
   * this command, and never called under `--json` or `--fix`. */
  readonly prompt?: (question: string) => Promise<string>;
  /** KAR-18.9 AC7 — the styling decision, computed once by `bin.ts` and passed
   * here. Absent means "no stream said anything", which is no colour and 80
   * columns. */
  readonly style?: Style;
}

export interface DoctorResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  /** The reduced report, so a caller can assert on statuses rather than prose. */
  readonly report: DoctorReport;
}

/** Six lowercase hex characters for the probe session's run id. */
const randomHex = (): string => randomBytes(3).toString('hex');

/**
 * One question on `output`, one answer off `input` — and an answer either way
 * (KAR-18.8 AC4).
 *
 * The interface is opened per question and closed again, rather than held for
 * the length of the command, because `doctor`'s ordinary path never asks
 * anything — and a readline interface attached to stdin keeps the process alive
 * whether or not anybody typed into it.
 *
 * The `close` race is the part that matters. `Interface#question` on a stream
 * that ends without ever delivering a line **never settles**, so a machine
 * whose stdout is a terminal and whose stdin is closed — a `doctor` under a
 * supervisor, in a job that attached a tty for debugging, or behind a pipe
 * nobody writes to — would sit at the prompt forever with no way out. Ending
 * the stream is an answer: it is `''`, and `''` is *no*.
 */
export function askOn(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): (question: string) => Promise<string> {
  return async (question: string): Promise<string> => {
    const lines = createInterface({ input, output });
    try {
      return await new Promise<string>((resolve) => {
        lines.on('close', () => resolve(''));
        void lines.question(question).then(resolve, () => resolve(''));
      });
    } finally {
      lines.close();
    }
  };
}

/** The default prompt: the question on stdout, the answer off stdin. */
const askOnStdin = (question: string): Promise<string> =>
  askOn(process.stdin, process.stdout)(question);

/** Runs one category, turning a throw into a visible `fail` rather than a
 * stack trace on stderr. */
async function collect(
  id: DoctorSectionId,
  checks: () => Promise<readonly DoctorCheck[]> | readonly DoctorCheck[],
): Promise<DoctorSectionInput> {
  try {
    return { id, checks: await checks() };
  } catch (error) {
    return {
      id,
      checks: [
        {
          id: `${id}.error`,
          status: 'fail',
          detail:
            `this check could not be completed: ${
              error instanceof Error ? error.message : String(error)
            }. That is a bug in doctor rather than a fact about this machine, and it is reported ` +
            'here rather than thrown so the other categories still answer.',
          action: "run 'DeFlow doctor --json' and attach its output to a bug report",
        },
      ],
    };
  }
}

/** The ledger, or `null` for any reason it could not be opened. */
function openLedgerOrNull(dataDir: string): Db | null {
  if (!probeWritable(dataDir).writable) return null;
  try {
    return openLedger(dataDir);
  } catch {
    return null;
  }
}

/** This installation's epoch, or `0` when it cannot be read — the probe's own
 * events are still attributable, and losing the whole agents pass over an
 * unreadable counter would be the wrong trade. */
function epochOrZero(db: Db | null): number {
  if (db === null) return 0;
  try {
    return readEpoch(db);
  } catch {
    return 0;
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const env = options.env ?? process.env;
  const clock = options.clock ?? systemClock;
  const dataDir = resolveDataDir(env);
  const workspaceDir = join(options.cwd, '.DeFlow');
  const roots = pathRoots(env);

  const runtime = await collect('runtime', () =>
    runtimeChecks({
      nodeVersion: options.nodeVersion ?? process.versions.node,
      roots,
      dataDir,
      workspaceDir,
    }),
  );

  // The state directory decides whether there is a ledger to read at all. It
  // is probed here rather than inferred from the check above, so that this
  // branch reads as its own decision instead of as a search through prose.
  //
  // `openLedger` runs the migrations, and a ledger that will not open is one of
  // the machine states doctor exists to describe — so a throw here becomes a
  // `null` db, which every downstream section already knows how to report.
  const db = openLedgerOrNull(dataDir);

  try {
    const sections: DoctorSectionInput[] = [runtime];

    sections.push(await collect('git', () => gitChecks({ cwd: options.cwd, env, dataDir })));

    sections.push(
      await collect('sandboxing', () =>
        sandboxChecks({
          platform: options.platform ?? process.platform,
          roots,
          readSysctl: options.readSysctl ?? readSysctlFromProc,
        }),
      ),
    );

    // One pass over the machine, three sections out of it: probing twice would
    // mean spawning every installed vendor CLI twice.
    const probed = await agentPass({
      cwd: options.cwd,
      env,
      roots,
      dataDir,
      db,
      clock,
      runId: mintRunId(clock.now(), randomHex),
      epoch: epochOrZero(db),
      capabilityFixtureDir: options.capabilityFixtureDir ?? join(dataDir, CAPABILITY_FIXTURE_DIR),
      conformance: options.conformance ?? true,
      install: {
        mode: installMode({
          json: options.json === true,
          fix: options.fix === true,
          tty: (options.isTty ?? (() => process.stdout.isTTY === true))(),
        }),
        prompt: options.prompt ?? askOnStdin,
      },
    });
    sections.push(
      { id: 'agents', checks: probed.agents },
      { id: 'capabilities', checks: probed.capabilities },
      { id: 'conformance', checks: probed.conformance },
    );

    sections.push(
      await collect('auth', () => authChecks({ env, loginCommands: probed.loginCommands })),
    );

    sections.push(
      await collect('memory', async () =>
        memoryChecks({ db, pty: await (options.loadPty ?? loadNodePty)() }),
      ),
    );

    const report = reduceReport(sections);
    return {
      exitCode: report.exitCode,
      stdout: options.json === true ? renderJson(report) : renderText(report, options.style),
      stderr: '',
      report,
    };
  } finally {
    // A close that throws would replace a finished report with a stack trace,
    // which is the one output this command must never produce.
    try {
      db?.close();
    } catch {
      // Nothing left to say: the report is already built and every fact in it
      // was read before this point.
    }
  }
}

/**
 * `agentChecks`, with its own containment.
 *
 * `collect` cannot serve here because one pass produces three sections, and a
 * throw has to land in all three — reporting a crashed probe as an empty
 * Capabilities section would be exactly the silence AC1 forbids.
 */
async function agentPass(input: AgentsInput): Promise<AgentsResult> {
  try {
    return await agentChecks(input);
  } catch (error) {
    const detail = `the provider pass could not be completed: ${
      error instanceof Error ? error.message : String(error)
    }. Every section it feeds is reported as failed rather than left empty.`;
    const action = "run 'DeFlow doctor --json' and attach its output to a bug report";
    return {
      agents: [{ id: 'agents.error', status: 'fail', detail, action }],
      capabilities: [{ id: 'capabilities.error', status: 'fail', detail, action }],
      conformance: [{ id: 'conformance.error', status: 'fail', detail, action }],
      loginCommands: new Map(),
    };
  }
}
