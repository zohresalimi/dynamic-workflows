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
import type { Clock, Db, RunId } from '@DeFlow/core';
import { mintRunId, normaliseInput } from '@DeFlow/core';
import { appendEvents, lookupIntakeKey, putBlob, readRange, recordIntakeKey } from '@DeFlow/ledger';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { z } from 'zod';
import { firstInvalidField, RunIntakeBodySchema } from './request-schema.ts';
import { resolveIssue } from './resolve-issue.ts';
import { resolveWithinRepo } from './resolve-path.ts';

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

export type RunIntakeResult =
  | { readonly outcome: 'created'; readonly runId: RunId; readonly seq: number }
  | { readonly outcome: 'rejected'; readonly field: string; readonly message: string };

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

/** The `seq` AC6's repeated-key response echoes: the first event this run
 * ever had, which for a run intake created is always its `task.submitted`. */
function firstEventSeq(db: Db, runId: RunId): number {
  const first = readRange(db, runId, 0, 1).events[0];
  if (first === undefined) {
    throw new Error(`intake_key named ${runId}, but the ledger holds no event for it`);
  }
  return first.seq;
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

  // AC6 — a repeated key returns the original run, touching nothing else.
  if (request.idempotencyKey !== undefined) {
    const existing = lookupIntakeKey(ports.db, request.idempotencyKey);
    if (existing !== null) {
      return { outcome: 'created', runId: existing, seq: firstEventSeq(ports.db, existing) };
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
  const [seq] = appendEvents(ports.db, [
    {
      runId,
      ts: ports.clock.now(),
      kind: 'task.submitted',
      v: 1,
      epoch: ports.epoch,
      payload,
    },
  ]);
  if (seq === undefined) throw new Error('appendEvents returned no seq for task.submitted');

  if (request.idempotencyKey !== undefined) {
    recordIntakeKey(ports.db, request.idempotencyKey, runId, ports.clock.now());
  }

  return { outcome: 'created', runId, seq };
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

  switch (body.input.kind) {
    case 'text':
      return normaliseInput({ kind: 'text', text: body.input.text }, { now, by, store });

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
        { now, by, store },
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
        { now, by, store },
      );
    }
  }
}
