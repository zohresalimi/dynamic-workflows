/**
 * KAR-10.1 — `submitTask`: the one function behind both entry points named in
 * the epic, `POST /api/runs` (../http/api.ts) and `DeFlow run "…"`
 * (@DeFlow/cli). Both call this; neither re-implements it (AC7).
 *
 * What it does, in order, matches AC1-AC6 exactly:
 *
 * 1. Validate the wire body (./request-schema.ts).
 * 2. Honour `Idempotency-Key`: a key already seen returns the run it minted,
 *    without touching the filesystem, the network or the ledger again (AC6).
 * 3. Resolve the source — read a file (after AC4's realpath containment
 *    check) or fetch an issue (./resolve-issue.ts) — entirely before anything
 *    is written. A missing file, an escaping path or an unreachable issue
 *    fails here, so a rejected submission leaves no half-born run (AC5).
 * 4. Normalise (`@DeFlow/core`'s `normaliseInput`) and append exactly one
 *    `task.submitted` event.
 * 5. **Admit or refuse** (KAR-19.2 AC1). If nothing on this machine can serve
 *    the run, the same transaction appends `provider.probed` per provider and
 *    `run.aborted`, schedules no framing wake, and the caller answers 4xx. The
 *    question — *"can anything here serve this run?"* — is answerable from the
 *    boot probe before the 201, and asking it later means minutes of framing
 *    spent and an operator who has already been told the run started.
 *
 * `run.created` is deliberately not appended here. Its payload's `spec:
 * TaskSpec` (docs/04-domain-model.md §9) cannot be produced without
 * interpreting the task, which is precisely what intake may not do
 * (docs/06-planning-and-replanning.md §1.1: *"No interpretation happens
 * here"*) — and `RunState`'s own reducer agrees: `reduce()`'s `run.created`
 * case is the only one that ever sets `repoRoot`, and `RunState.repoRoot`'s
 * doc comment already says `null` is the correct answer *"before that event
 * is folded"*. `run.created` is KAR-10.2's to append, once the framing
 * interview has actually produced the spec it carries.
 */
import type {
  ProviderResolution,
  RunAdmission,
  RunAdmissionRequest,
  RunRefusalCode,
} from '@DeFlow/adapters';
import type { Clock, Db, ProviderChoiceFacts, RunId, WakeReason } from '@DeFlow/core';
import { canonicalJson, mintRunId, normaliseInput, sha256Hex } from '@DeFlow/core';
import type { EventDraft } from '@DeFlow/ledger';
import {
  appendEvents,
  lookupIntakeKey,
  putBlob,
  readRange,
  recordIntakeKey,
  scheduleWake,
} from '@DeFlow/ledger';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { z } from 'zod';
import { FRAMING_NODE } from '../spec/gate.ts';
import { firstInvalidField, RunIntakeBodySchema } from './request-schema.ts';
import { resolveIssue } from './resolve-issue.ts';
import { resolveWithinRepo } from './resolve-path.ts';

/**
 * KAR-19.1 AC1 — why the framing hand-off is a `poll` and not a fifth reason.
 *
 * `WAKE_REASONS` is a closed vocabulary rendered verbatim in the timeline, and
 * the four members answer *"why is this node asleep"*. This wait is none of the
 * three specific ones — it is not a backoff, not a human gate, not a vendor
 * quota — it is "look at this run again, now", which is exactly what `poll`
 * means. Widening the set would be a `@DeFlow/core` vocabulary change made from
 * the wrong file for a wait that already has a word.
 */
export const FRAMING_WAKE_REASON: WakeReason = 'poll';

export interface RunIntakePorts {
  readonly db: Db;
  /** This daemon life's epoch; stamped on the appended event. */
  readonly epoch: number;
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  /** Where a file over the inline threshold is stored (KAR-03.9's blob store). */
  readonly dataDir: string;
  /** The 6-lowercase-hex `RunId` suffix. Injected so a spec is reproducible. */
  readonly randomHex: () => string;
  /** The child environment `gh` is resolved and run in. Defaults to the
   * daemon's own; a spec overrides it to find a fake `gh` on a temp PATH. */
  readonly issueEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * KAR-19.2 AC1 — can anything on this machine serve a run?
   *
   * A port and not a probe: the answer is a read of what boot already
   * established, so a submission pays for no handshake of its own (AC6). It is
   * called once per accepted submission and never for a repeated
   * `Idempotency-Key`, whose answer is already written down.
   *
   * **Absent means admitted**, and that is the same claim `BootOptions`'
   * `probeProviders` makes: a daemon that was never told which machine it is on
   * — a spec constructing these ports directly, a fixture, a supervisor — has
   * no honest basis on which to refuse anybody, and refusing on the strength of
   * a `PATH` it happened to inherit would be worse than not asking. `boot()`
   * supplies it whenever it was given `providerRoots`, which `DeFlow up` and
   * `DeFlow run`'s autostart always do.
   *
   * KAR-19.10 — it takes the operator's `--provider`, because an explicitly
   * named provider is honoured exactly or the run is refused (AC8), and that
   * is a decision for the one function `doctor` and selection also read.
   */
  readonly admit?: (request: RunAdmissionRequest) => RunAdmission;
}

export type RunIntakeSubmitter = 'ui' | 'cli';

export interface RunIntakeRequest {
  /** The parsed JSON body — validated here, so a caller need not pre-validate. */
  readonly body: unknown;
  /** `'ui'` for `POST /api/runs`, `'cli'` for `DeFlow run` (AC7). */
  readonly by: RunIntakeSubmitter;
  /** The `Idempotency-Key` header, if the caller sent one (AC6). */
  readonly idempotencyKey?: string;
}

/**
 * KAR-19.10 AC4 — what an accepted submission says about the agent it chose.
 *
 * The three facts and the limitation, carried on the 201 so the CLI can print
 * the announcement **before the first turn** rather than discovering it from
 * the stream after framing has started. `null` where nothing asked the question
 * (a daemon booted without `providerRoots`).
 */
export interface AdmittedProviderChoice extends ProviderChoiceFacts {
  /** AC7 — the turn this route will not reach, and how to fix it. */
  readonly limitation: string | null;
}

export type RunIntakeResult =
  | {
      readonly outcome: 'created';
      readonly runId: RunId;
      readonly seq: number;
      readonly provider?: AdmittedProviderChoice;
    }
  | { readonly outcome: 'rejected'; readonly field: string; readonly message: string }
  /**
   * KAR-19.2 — the machine cannot serve this run.
   *
   * A third outcome rather than a `rejected` with a special field, because the
   * two are different facts with different next actions and different exit
   * codes: `rejected` is *"your request is wrong"* (64), and this is *"this
   * machine cannot host a run"* (5). It carries a `runId` because — unlike a
   * rejection — the run **exists**: its refusal is in the ledger and is
   * answerable six weeks later (AC1, NF8).
   */
  | {
      readonly outcome: 'refused';
      readonly runId: RunId;
      /** The `seq` of the `run.aborted` that ended it. */
      readonly seq: number;
      readonly code: RunRefusalCode;
      readonly message: string;
      readonly providers: readonly {
        readonly id: string;
        readonly state: string;
        readonly vendorPath: string | null;
        readonly adapterPackage: string;
      }[];
    };

/** `.md`/`.markdown` is `text/markdown` (a spec document is the `file` kind
 * with its own content type — AC1's last sentence); everything else is
 * `text/plain`. Intake does not read a byte of content to decide this. */
function mediaTypeForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  return ext === '.md' || ext === '.markdown' ? 'text/markdown' : 'text/plain';
}

const REPO_PATH_ESCAPE_MESSAGE: Record<string, string> = {
  traversal: 'escapes the repository root (a "../" segment)',
  absolute: 'escapes the repository root (an absolute path outside it)',
  symlink: 'escapes the repository root (a symlink resolving outside it)',
  invalid: 'is not a usable path',
};

/** The `seq` AC6's repeated-key response echoes when the journal holds no
 * memoised body to read it out of: the first event this run ever had, which for
 * a run intake created is always its `task.submitted`. */
function firstEventSeq(db: Db, runId: RunId): number {
  const first = readRange(db, runId, 0, 1).events[0];
  if (first === undefined) {
    throw new Error(`the intake journal named ${runId}, but the ledger holds no event for it`);
  }
  return first.seq;
}

/**
 * The `201` body, as the bytes the effect journal memoises (KAR-15.5 AC5).
 *
 * `canonicalJson` rather than `JSON.stringify` for the reason every stored
 * value in this system uses it: the bytes are compared — the whole claim of
 * §11.3 is that a repeat is *byte-identical* — and a serialisation that is
 * "best efforts" at key order is one that can answer differently on the retry
 * it exists to make free. The key order it produces is the same one
 * `POST /api/runs` writes the live response in, and
 * `../../test/integration/intake-idempotency.test.ts` asserts the two agree
 * over the wire rather than trusting that they do.
 */
function intakeResponseBody(runId: RunId, seq: number): string {
  return canonicalJson({ runId, seq, status: 'awaiting-spec-approval' });
}

/** The `seq` a memoised `201` body carries, or `null` when there is none to
 * read — a ledger repaired by hand, or a row migration 0015 could not rebuild. */
function memoisedSeq(response: string | null): number | null {
  if (response === null) return null;
  try {
    const parsed: unknown = JSON.parse(response);
    const seq = (parsed as { seq?: unknown }).seq;
    return typeof seq === 'number' && Number.isSafeInteger(seq) ? seq : null;
  } catch {
    return null;
  }
}

/**
 * Handles one `POST /api/runs` (or `DeFlow run`) request end to end.
 *
 * Never throws for an ordinary rejection — a bad request, a missing file, an
 * unreachable issue all come back as `{ outcome: 'rejected' }`. It throws only
 * for something intake itself cannot recover from (a stale daemon epoch, a
 * write the ledger refused), which is a 500, not a 4xx.
 */
export async function submitTask(
  request: RunIntakeRequest,
  ports: RunIntakePorts,
): Promise<RunIntakeResult> {
  const parsed = RunIntakeBodySchema.safeParse(request.body);
  if (!parsed.success) {
    return {
      outcome: 'rejected',
      field: firstInvalidField(parsed.error),
      message: parsed.error.issues[0]?.message ?? 'invalid request body',
    };
  }
  const body = parsed.data;

  // AC6, and KAR-15.5 AC5 — a repeated key is answered **out of the effect
  // journal**, touching nothing else: no filesystem, no network, no append.
  // The `seq` comes from the memoised body rather than from a fresh read, so
  // the retry returns what the original call returned rather than what the
  // ledger happens to look like now.
  if (request.idempotencyKey !== undefined) {
    const existing = lookupIntakeKey(ports.db, request.idempotencyKey);
    if (existing !== null) {
      return {
        outcome: 'created',
        runId: existing.runId,
        seq: memoisedSeq(existing.response) ?? firstEventSeq(ports.db, existing.runId),
      };
    }
  }

  // Resolve the source, entirely before anything is written (AC5).
  let payload: Awaited<ReturnType<typeof normaliseInput>>;
  try {
    payload = await resolveAndNormalise(body, ports, request.by);
  } catch (error) {
    if (error instanceof IntakeRejected) {
      return { outcome: 'rejected', field: error.field, message: error.message };
    }
    throw error;
  }

  const runId = mintRunId(ports.clock.now(), ports.randomHex);
  // Hashed before the transaction, because `sha256Hex` is asynchronous and a
  // better-sqlite3 transaction is not: an `await` inside one would commit
  // whatever else the process did in the meantime along with it.
  const requestHash =
    request.idempotencyKey === undefined
      ? null
      : `sha256-${await sha256Hex(canonicalJson(request.body))}`;

  // KAR-19.2 AC1 — asked *before* the response, and answered from what boot
  // already found. A machine that cannot serve the run is a fact that is
  // knowable now; discovering it at the first agent node instead is minutes of
  // framing spent and an operator who has already been told the run started.
  const admission = ports.admit?.({ provider: body.provider }) ?? (ADMITTED satisfies RunAdmission);

  // The append, the framing wake and the journal row are **one** transaction
  // (AC6, and KAR-19.1 AC1): a crash between the first two would leave either a
  // run no key can find — so a retry starts a second one — or a key naming a run
  // the ledger does not hold; a crash between the event and the row would leave
  // a run nothing will ever pick up, which is the failure this story exists to
  // remove and the one nobody notices, because it looks exactly like a run that
  // has not got there yet.
  //
  // A refusal is in that same transaction, and for the same reason: a run whose
  // `task.submitted` committed and whose `run.aborted` did not is exactly the
  // silent, never-scheduled run this story exists to make impossible.
  const seq = ports.db.transaction(() => {
    const now = ports.clock.now();
    const [appended, ...rest] = appendEvents(ports.db, [
      {
        runId,
        ts: now,
        kind: 'task.submitted',
        v: 1,
        epoch: ports.epoch,
        payload,
      },
      ...refusalEvents(runId, now, ports.epoch, admission),
      ...choiceEvents(runId, now, ports.epoch, admission),
    ]);
    if (appended === undefined) throw new Error('appendEvents returned no seq for task.submitted');

    if (admission.outcome === 'refused') {
      // No framing wake, and no journal row. There is nothing to hand off to
      // and nothing to make idempotent: a retry of a refused submission must be
      // free to succeed, because the operator's next move is to fix the machine
      // and try again — and a memoised refusal would answer them with this
      // one for as long as the key lives.
      const ended = rest.at(-1);
      if (ended === undefined) throw new Error('a refusal appended no run.aborted');
      return ended;
    }

    // KAR-19.1 AC1 — the hand-off to framing, as the one durable thing a wait
    // is allowed to be. Due at `now`, because the operator is watching a prompt
    // and the next tick is the whole of AC3's budget; keyed on `(runId,
    // framing)`, so two submissions in the same millisecond are two rows and
    // neither inherits the other's (AC8).
    scheduleWake(ports.db, {
      runId,
      nodeId: FRAMING_NODE,
      wakeAt: ports.clock.now(),
      reason: FRAMING_WAKE_REASON,
    });

    if (request.idempotencyKey !== undefined && requestHash !== null) {
      recordIntakeKey(ports.db, {
        key: request.idempotencyKey,
        runId,
        requestHash,
        response: intakeResponseBody(runId, appended),
        at: ports.clock.now(),
      });
    }
    return appended;
  });

  if (admission.outcome === 'refused') {
    return {
      outcome: 'refused',
      runId,
      seq,
      code: admission.code,
      message: admission.message,
      providers: admission.providers,
    };
  }

  // The refused arm returned above, so `admission` is the admitted one here.
  const chosen = admission.chosen;
  return {
    outcome: 'created',
    runId,
    seq,
    ...(chosen === null
      ? {}
      : {
          provider: {
            provider: chosen.provider,
            binaryPath: chosen.binaryPath,
            route: chosen.route,
            limitation: admission.limitation,
          },
        }),
  };
}

/**
 * KAR-19.10 AC4 — the choice, written into the run's own stream.
 *
 * One `provider.probed` on the admission arm, for the provider that was chosen
 * and nothing else. It is the same event kind the refusal path writes and the
 * same arm, so nothing new was invented to carry it — and it is what makes the
 * announcement answerable six weeks later, and what `chooseProvider` obeys on a
 * later tick instead of re-reducing the machine and possibly disagreeing (AC8).
 */
function choiceEvents(
  runId: RunId,
  ts: number,
  epoch: number,
  admission: RunAdmission,
): EventDraft[] {
  if (admission.outcome !== 'admitted' || admission.chosen === null) return [];
  const chosen = admission.chosen;
  return [
    {
      runId,
      ts,
      kind: 'provider.probed',
      v: 1,
      epoch,
      payload: {
        provider: chosen.provider,
        admission: chosen.resolution.state,
        vendorBin: chosen.resolution.vendorBin,
        vendorPath: chosen.resolution.vendorPath,
        adapterBin: chosen.resolution.adapterBin,
        adapterPath: chosen.resolution.adapterPath,
        package: chosen.resolution.package,
        chosen: {
          route: chosen.route,
          binaryPath: chosen.binaryPath,
          routes: chosen.routes,
          unserved: [...chosen.unserved],
          ...(admission.limitation === null ? {} : { limitation: admission.limitation }),
        },
      },
    },
  ];
}

const ADMITTED: RunAdmission = { outcome: 'admitted', chosen: null, limitation: null };

/**
 * KAR-19.2 AC1 — what a refusal writes down, after `task.submitted`.
 *
 * One `provider.probed` per registered provider — *"recording what was and was
 * not found"* — and then `run.aborted` with `outcome: 'failed'`, which is what
 * puts the run on the `runs=*` topic like any other ending and what makes
 * `GET /api/runs/:id` report it as over rather than as waiting.
 *
 * The prose is **not** stored. `provider.probed` records the facts and
 * `run-refusal.ts` re-renders the sentence from them through the same function
 * that produced the one on the wire — a stored sentence is a sentence that can
 * never be improved, and two stored copies of it are two that can disagree.
 */
function refusalEvents(
  runId: RunId,
  ts: number,
  epoch: number,
  admission: RunAdmission,
): EventDraft[] {
  if (admission.outcome !== 'refused') return [];

  const probed: EventDraft[] = admission.resolutions.map((entry: ProviderResolution) => ({
    runId,
    ts,
    kind: 'provider.probed',
    v: 1,
    epoch,
    payload: {
      provider: entry.provider,
      admission: entry.state,
      vendorBin: entry.vendorBin,
      vendorPath: entry.vendorPath,
      adapterBin: entry.adapterBin,
      adapterPath: entry.adapterPath,
      package: entry.package,
      ...(entry.handshakeStderr === undefined ? {} : { stderr: entry.handshakeStderr }),
    },
  }));

  return [
    ...probed,
    {
      runId,
      ts,
      kind: 'run.aborted',
      v: 1,
      epoch,
      payload: { outcome: 'failed', criteriaSatisfied: [] },
    },
  ];
}

/** A typed rejection with the `field` AC1's error names — never thrown past
 * `submitTask`, which turns it into `{ outcome: 'rejected' }`. */
class IntakeRejected extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.name = 'IntakeRejected';
    this.field = field;
  }
}

async function resolveAndNormalise(
  body: z.infer<typeof RunIntakeBodySchema>,
  ports: RunIntakePorts,
  by: RunIntakeSubmitter,
): ReturnType<typeof normaliseInput> {
  const now = ports.clock.now();
  const store = (bytes: Uint8Array, mediaType: string) => putBlob(ports.dataDir, bytes, mediaType);
  // KAR-19.3 — the repository, recorded rather than validated and dropped.
  // The framing turn happens on a later tick, possibly on a later daemon, and
  // `run.created.cwd` is written *by* that turn: without this the caller that
  // has to open the interview has no way of knowing which repository the run
  // belongs to.
  const cwd = body.cwd;

  switch (body.input.kind) {
    case 'text':
      return normaliseInput({ kind: 'text', text: body.input.text }, { now, by, store, cwd });

    case 'file': {
      const resolution = await resolveWithinRepo(body.cwd, body.input.path);
      if (resolution.outcome === 'outside') {
        throw new IntakeRejected(
          'input.path',
          `input.path ${REPO_PATH_ESCAPE_MESSAGE[resolution.route]}`,
        );
      }
      let bytes: Uint8Array;
      try {
        bytes = await readFile(resolution.path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        throw new IntakeRejected(
          'input.path',
          `input.path could not be read (${code ?? 'unknown error'}): ${resolution.path}`,
        );
      }
      return normaliseInput(
        {
          kind: 'file',
          bytes,
          resolvedPath: resolution.path,
          mediaType: mediaTypeForPath(resolution.path),
        },
        { now, by, store, cwd },
      );
    }

    case 'issue': {
      let resolved: Awaited<ReturnType<typeof resolveIssue>>;
      try {
        resolved = await resolveIssue(body.input.url, {
          clock: ports.clock,
          ...(ports.issueEnv === undefined ? {} : { env: ports.issueEnv }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new IntakeRejected('input.url', message);
      }
      return normaliseInput(
        {
          kind: 'issue',
          raw: resolved.raw,
          url: body.input.url,
          resolver: resolved.resolver,
          httpStatus: resolved.httpStatus,
        },
        { now, by, store, cwd },
      );
    }
  }
}
