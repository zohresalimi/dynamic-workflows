/**
 * KAR-19.3 — the composition root's half of the live chain: the resolver
 * `deflow up` hands `createRunChain`.
 *
 * This is the single most consequential file in this epic, and it is worth
 * being precise about why. Every step of the chain existed, was exported and
 * had a passing suite; `run-chain.ts` then gave them a caller. What was still
 * missing on 2026-08-12 was the *binding*: `boot()` takes `runFraming` and
 * `advanceRun` as ports, `main.ts` and `up.ts` both called it without them, and
 * `drive.ts` returns early when they are absent. So an operator's run reached
 * its framing wake and stopped there, with a green suite in every direction.
 *
 * The seam is a port for a real reason rather than for symmetry: resolving a
 * provider means spawning binaries found on **the operator's own `PATH`**, and
 * DeFlowd's `PATH` at daemon start is not theirs (docs/03 §4.3). `deflow up`
 * runs in their terminal, splits their `PATH`, and passes the roots down. A
 * daemon that was never told which machine it is on resolves nothing, and that
 * is the honest answer rather than a guess.
 *
 * Four decisions in here are worth reading before changing:
 *
 * **The provider is the one admission already chose.** `usableProviders` over
 * `resolveProviderStates` is the same reduction `admitRun` makes at submission
 * time — real adapters first, the bundled agent last — and this file re-uses it
 * rather than asking "is anything installed?" a second time. A candidate with
 * no **probed** row in the ledger is skipped, because a capability read from
 * anywhere but a probed row is a constant wearing a capability's clothes
 * (KAR-05.2), and `admitFraming` would refuse it anyway.
 *
 * **The schemas are the run's own copy, generated rather than located.**
 * `writeRunSchemas` emits every registered document into
 * `<data-dir>/runs/<runId>/.DeFlow/schemas`, which is what a vendor CLI is
 * handed on `--json-schema` and what Ajv validates the return against — the
 * same bytes, from the same function, so the contract enforced by the child and
 * the contract enforced by DeFlow cannot drift. It also means the published
 * tarball needs no `schemas/` directory to find.
 *
 * **The child's environment is `buildChildEnv()`'s, and nothing else's.** That
 * is the one place an allowlist is applied (KAR-08.4), and a second way to
 * build an environment here would be a credential leak with a `spawn` in front
 * of it.
 *
 * **Nothing is cached across runs but the tmpdir.** Every value below is
 * derived from `(ledger, run, machine)` on each turn, so a second daemon picks
 * a run up with nothing inherited from the first.
 *
 * Verifies: EPIC-19-S16, EPIC-19-S21 · KAR-19.3 AC1, AC2
 */
import type { CapabilityRow } from '@DeFlow/adapters';
import { resolveProviderStates, usableProviders } from '@DeFlow/adapters';
import type { Clock, Handle, RunId } from '@DeFlow/core';
import { ProviderIdSchema } from '@DeFlow/core';
import { getBlob, listProviderCapabilities, putBlob, readRange } from '@DeFlow/ledger';
import { Buffer } from 'node:buffer';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Git } from '../git/git.ts';
import { RefFormatChecker } from '../git/ref-format.ts';
import { WorkspaceManager } from '../git/worktree-manager.ts';
import { log } from '../logging.ts';
import { buildChildEnv, createRunTmpdir } from '../proc/env.ts';
import { discoverConnectorServers } from '../providers/connector-servers.ts';
import { disabledProviderIds, withDisabled } from '../providers/settings.ts';
import { writeRunSchemas } from '../run-schemas.ts';
import { loadSchemaDirectory } from '../schema-store.ts';
import { o200kTokenizer } from '../tokens/tokenizer.ts';
import type { TurnIoWriter } from './live-agents.ts';
import { liveFramingAgent, livePlannerAgent, liveReconAgent } from './live-agents.ts';
import {
  openPreExecutionIo,
  openPreExecutionSession,
  PRE_EXECUTION_NODES,
} from './pre-execution-session.ts';
import {
  createRunChain,
  type RunChain,
  type RunChainContext,
  reconWorktreePath,
} from './run-chain.ts';

const wiring = log.child({ mod: 'live-chain' });

/**
 * The model name stamped on every packet and every recon fact's provenance.
 *
 * DeFlow selects no model anywhere: there is no configuration key for one, no
 * ACP field that reports one, and every adapter is invoked without naming one —
 * so the honest record is *"whatever this adapter's own default was"* rather
 * than a plausible-looking vendor string. A model id invented here would be
 * carried into a fact's provenance and read months later as a measurement.
 */
export const PROVIDER_DEFAULT_MODEL = 'provider-default';

/**
 * The context window every pre-execution packet is budgeted against.
 *
 * A **floor**, not a measurement, and deliberately conservative: no ACP
 * `initialize` response advertises a window, so this cannot be probed, and
 * being wrong in this direction refuses an oversized packet (a loud, local
 * failure) rather than sending one and having the vendor silently truncate the
 * spec every gate verdict is then measured against.
 */
export const ASSUMED_CONTEXT_FLOOR = 128_000;

/**
 * KAR-19.8 — the node ids the three pre-execution turns are recorded under.
 *
 * Re-exported from `./pre-execution-session.ts`, which owns them alongside the
 * derivation they are half of. The alias stays because this module is the one
 * every reader looks in for the shape of the chain.
 */
export { PRE_EXECUTION_NODES } from './pre-execution-session.ts';

export interface LiveChainOptions {
  /** The daemon's data directory: run directories, blobs and schemas. */
  readonly dataDir: string;
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  /**
   * The operator's `PATH`, split — `deflow up` passes theirs, for exactly the
   * reason `BootOptions.providerRoots` exists. Empty means nothing resolves,
   * which is the honest answer for a daemon that was never told.
   */
  readonly providerRoots: readonly string[];
  /**
   * DeFlowd's own environment, as `buildChildEnv()`'s **base** — never as a
   * child environment.
   *
   * Named `daemonEnv` rather than `env` because the difference is the whole of
   * KAR-08.4: what a child is given is what `buildChildEnv()` returns after its
   * allowlist has run, and a field called `env` here would read as the thing
   * that gets spawned with.
   */
  readonly daemonEnv: NodeJS.ProcessEnv;
}

/** The adapter a turn runs on, and the record that it was probed. */
export interface Chosen {
  readonly provider: string;
  readonly binaryPath: string;
  /** The probed row, verbatim — what `admitFraming` reads, and the only place
   * a capability may be read from (KAR-05.2). */
  readonly row: CapabilityRow;
}

/**
 * The adapter this machine can serve a schema-bearing turn on, or `null`.
 *
 * Two facts, and neither substitutes for the other: the binary resolves on the
 * operator's own roots, and this daemon's ledger holds a row somebody actually
 * shook hands with. The `shim.bin` path is the one taken — a pre-execution turn
 * is driven through the vendor's own CLI, not through its ACP bridge, because
 * the return contract rides on a flag only the CLI has.
 *
 * **KAR-25.3 AC3 — disabled is checked only when nothing has been admitted
 * yet.** A run with a recorded admission (`admittedProvider` below) is already
 * filtered to that one provider by name a few lines down, and it keeps
 * running on it whether or not the operator disables it afterwards — the same
 * answer `resolveProviderStates` already gives for a binary the operator
 * *uninstalls* mid-run, and the one this story's own scope notes call out
 * explicitly: disabling removes a provider from the picker and from
 * admission, it does not reach into a run already admitted onto it. Where
 * there is no recorded admission — a daemon booted without `providerRoots`,
 * the exact machine reader (c) of this story's plan names — a disabled
 * provider must not be silently selected either, which is what this filter is
 * for.
 */
export function chooseProvider(
  db: Parameters<typeof listProviderCapabilities>[0],
  roots: readonly string[],
  runId?: RunId,
): Chosen | null {
  const rows = new Map(listProviderCapabilities(db).map((row) => [row.provider, row]));
  // KAR-19.10 AC5, AC8 — the choice admission recorded, if this run has one.
  // Selection then *filters* to it rather than re-deciding: a second reduction
  // of the same machine agrees until the moment it does not, and the moment it
  // does not is a run silently spawning an agent nobody was told about. It is
  // also what makes `--provider` mean anything after the 201.
  const admitted = runId === undefined ? null : admittedProvider(db, runId);
  const disabled = admitted === null ? disabledProviderIds(db) : new Set<string>();
  const resolutions = withDisabled(resolveProviderStates(roots), disabled);

  for (const candidate of usableProviders(resolutions)) {
    if (admitted !== null && candidate.provider !== admitted) continue;
    const row = rows.get(candidate.provider);
    if (row === undefined) continue;
    if (candidate.vendorPath === null) continue;
    return {
      provider: candidate.provider,
      binaryPath: candidate.vendorPath,
      row: { ...row, provider: ProviderIdSchema.parse(row.provider) },
    };
  }
  return null;
}

/**
 * The provider id on this run's admission record, or `null`.
 *
 * Read structurally off the `provider.probed` payload rather than through the
 * Zod union, exactly as `http/run-refusal.ts` reads its own arm: the row came
 * back through `JSON.parse` and the honest thing to say about it is what was
 * checked. `chosen` is the discriminator — only the admitted arm carries it,
 * and a refusal chose nothing.
 */
function admittedProvider(
  db: Parameters<typeof listProviderCapabilities>[0],
  runId: RunId,
): string | null {
  // The admission rows sit at the head of a run's ledger, one per registered
  // provider at most, so a small window reads all of them.
  for (const event of readRange(db, runId, 0, ADMISSION_WINDOW).events) {
    if (event.kind !== 'provider.probed') continue;
    const payload = event.payload as { provider?: unknown; chosen?: unknown };
    if (payload.chosen === undefined || typeof payload.provider !== 'string') continue;
    return payload.provider;
  }
  return null;
}

/** Enough to cover the registry several times over. */
const ADMISSION_WINDOW = 64;

/**
 * The chain one daemon life runs, bound to this machine.
 *
 * Everything the resolver returns is rebuilt per turn except the run's private
 * tmpdir, which is created once per run so a turn does not leave a directory
 * behind on every tick.
 */
export function createLiveRunChain(options: LiveChainOptions): RunChain {
  const tmpdirs = new Map<RunId, string>();

  async function runTmpdir(runId: RunId): Promise<string> {
    const existing = tmpdirs.get(runId);
    if (existing !== undefined) return existing;
    const made = await createRunTmpdir();
    tmpdirs.set(runId, made);
    return made;
  }

  return createRunChain({
    resolve: async ({ runId, db, cwd, epoch }): Promise<RunChainContext | null> => {
      const chosen = chooseProvider(db, options.providerRoots, runId);
      if (chosen === null) {
        wiring.warn(
          { runId },
          `no adapter on this machine both resolves on the operator's PATH and has a probed ` +
            `capability row, so run ${runId} cannot be served; run 'deflow doctor' to see what ` +
            'this daemon found when it started',
        );
        return null;
      }

      const runDir = join(options.dataDir, 'runs', runId);
      mkdirSync(runDir, { recursive: true });
      const schemasDir = writeRunSchemas(runDir);
      const schemas = loadSchemaDirectory(schemasDir);

      const { env } = buildChildEnv({
        base: options.daemonEnv,
        // The roots this daemon was told to resolve against, rejoined: the
        // child must find the same binaries DeFlow resolved, and DeFlowd's own
        // `PATH` is not the operator's.
        loginPath: options.providerRoots.join(':'),
        tmpdir: await runTmpdir(runId),
      });

      // The connected MCP servers this binary has, for the connector policy —
      // cached per daemon life, so only the first turn of the first run pays
      // the CLI's own health-check. An empty answer just means no
      // `permissions` document: the safe direction, never a refusal.
      const connectorServers = await discoverConnectorServers({
        binaryPath: chosen.binaryPath,
        env,
      });

      const turn = {
        provider: chosen.provider,
        binaryPath: chosen.binaryPath,
        schemasDir,
        env,
        connectorServers,
      } as const;

      /**
       * KAR-19.13 — the port each turn kind opens its own vendor session
       * through.
       *
       * Deferred rather than computed here on purpose: the id depends on how
       * many turns of that kind the **ledger** already records, and `resolve`
       * runs once per wake while `repair` opens a second child inside one.
       * Reading the count at spawn time is what makes both a repair and a
       * restarted daemon get their own.
       */
      const openSession = (kind: keyof typeof PRE_EXECUTION_NODES) => () =>
        openPreExecutionSession({
          db,
          runId,
          nodeId: PRE_EXECUTION_NODES[kind],
          provider: chosen.provider,
          epoch,
          ts: options.clock.now(),
        });

      /**
       * KAR-27.3 AC2 — where each turn's bytes go while it is still running.
       *
       * The same shape as `openSession` and for the same reason: a turn kind
       * is fixed here, and the *child* is not. `repair` and every re-advanced
       * wake open their own session, and each one's transcript belongs under
       * its own attempt — so the sink is built per child from the number that
       * child's session came back with.
       */
      const openIo =
        (kind: keyof typeof PRE_EXECUTION_NODES) =>
        (attempt: number): TurnIoWriter =>
          openPreExecutionIo({
            db,
            runId,
            nodeId: PRE_EXECUTION_NODES[kind],
            attempt,
            clock: options.clock,
          });

      const git = new Git(cwd);

      return {
        provider: chosen.provider,
        model: PROVIDER_DEFAULT_MODEL,
        maxContext: ASSUMED_CONTEXT_FLOOR,
        capabilityRow: chosen.row,
        agents: {
          // KAR-19.8 — the vendor gets an id of the form it demands, derived
          // from the ids DeFlow keeps. Until 2026-08-13 these three lines read
          // `` `${runId}-framing` `` and the like, and Claude Code 2.1.220
          // refused every one of them: *"Invalid session ID. Must be a valid
          // UUID."* The run id stays what the ledger, the CLI and the UI name.
          //
          // KAR-19.13 — and each *child* opens its own, counted from the
          // ledger. These three lines then pinned the attempt at 0, so a
          // repaired turn or a re-advanced wake presented an id a previous
          // process had already spent, and the vendor refused it: *"Session ID
          // … is already in use"*.
          framing: liveFramingAgent({
            ...turn,
            cwd,
            openSession: openSession('framing'),
            openIo: openIo('framing'),
          }),
          // Spawned **in the detached worktree** the chain provisions, not in
          // the repository: a survey of the operator's own working tree would
          // report uncommitted state as a fact about the run's base commit.
          recon: liveReconAgent({
            ...turn,
            cwd: reconWorktreePath(runDir),
            openSession: openSession('recon'),
            openIo: openIo('recon'),
          }),
          planner: livePlannerAgent({
            ...turn,
            cwd,
            openSession: openSession('planner'),
            openIo: openIo('planner'),
          }),
        },
        schemas,
        registry: schemas,
        schemasDir,
        tokenizer: o200kTokenizer(),
        workspace: new WorkspaceManager({
          git: { run: (args, opts) => git.run(args, opts) },
          db,
          clock: options.clock,
          epoch,
        }),
        refs: new RefFormatChecker(git),
        runDir,
        putSurvey: (bytes: Uint8Array): Handle =>
          putBlob(options.dataDir, bytes, 'application/json'),
        captureEvidence: (text: string): Handle =>
          putBlob(options.dataDir, Buffer.from(text, 'utf8'), 'text/plain'),
        readTaskSource: (handle: Handle): string =>
          Buffer.from(getBlob(options.dataDir, handle)).toString('utf8'),
      };
    },
  });
}
