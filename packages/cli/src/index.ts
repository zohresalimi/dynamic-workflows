/**
 * DeFlow — the only package published to npm.
 *
 * `bin`, `files` and the tsdown config that inlines every @DeFlow/* package
 * (noExternal: [/^@DeFlow\//], external: ["@lydell/node-pty"]) arrive with
 * EPIC-18. Declaring bins before dist/ exists would make `pnpm install` link
 * paths that are not there yet, so they are deliberately absent from the
 * scaffold.
 *
 * KAR-10.1 adds `runTask`, the body of `DeFlow run "…"` (docs/11 §7.1) — ahead
 * of the argv parser and the `bin` entry EPIC-18 wires up, because the ACs it
 * has to satisfy are about what the command *does*: post the same wire shape
 * `POST /api/runs` accepts, over the daemon's own HTTP API. *"Both entry
 * points — POST /api/runs and DeFlow run '…' — go through the same daemon
 * code path; the CLI is a client of the HTTP API, not a second
 * implementation."* This function is that client: it performs a real HTTP
 * request against a running DeFlowd and nothing else, so a golden ledger
 * produced through it is byte-identical (modulo ids and timestamps) to one
 * produced through the HTTP route directly (AC7).
 */
import type { PermissionLevel } from '@DeFlow/core';

export interface RunTaskOptions {
  /** The daemon's own origin, e.g. `http://127.0.0.1:4173` — never assumed. */
  readonly baseUrl: string;
  /** The repository the run executes against. */
  readonly cwd: string;
  readonly permission?: PermissionLevel;
  readonly budget?: {
    readonly costUsd?: number | null;
    readonly wallclockMs?: number | null;
  };
  /** Forwarded as the `Idempotency-Key` header (AC6). */
  readonly idempotencyKey?: string;
}

export interface RunTaskResult {
  readonly runId: string;
  readonly seq: number;
  readonly status: string;
}

/** A submission the daemon refused — the same `field`/`message` pair
 * `POST /api/runs` answers a 4xx with. */
export class RunTaskRejected extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'RunTaskRejected';
    this.field = field;
  }
}

/**
 * `DeFlow run "<text>"` — posts free text to `POST /api/runs` on the daemon at
 * `options.baseUrl`, and returns the same `{ runId, seq, status }` the HTTP
 * route does.
 *
 * `X-DeFlow-Submitted-By: cli` is what turns into `provenance.by: 'cli'` on
 * the `task.submitted` event the daemon appends (../../daemon/src/http/api.ts).
 */
export async function runTask(text: string, options: RunTaskOptions): Promise<RunTaskResult> {
  const response = await fetch(`${options.baseUrl}/api/runs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-DeFlow-Submitted-By': 'cli',
      ...(options.idempotencyKey === undefined
        ? {}
        : { 'Idempotency-Key': options.idempotencyKey }),
    },
    body: JSON.stringify({
      input: { kind: 'text', text },
      cwd: options.cwd,
      permission: options.permission ?? 'worktree',
      ...(options.budget === undefined ? {} : { budget: options.budget }),
    }),
  });

  const payload = (await response.json()) as Record<string, unknown>;
  if (response.status === 201) {
    return {
      runId: payload.runId as string,
      seq: payload.seq as number,
      status: payload.status as string,
    };
  }
  throw new RunTaskRejected(
    typeof payload.field === 'string' ? payload.field : '<root>',
    typeof payload.message === 'string'
      ? payload.message
      : `POST /api/runs failed with ${response.status}`,
  );
}
