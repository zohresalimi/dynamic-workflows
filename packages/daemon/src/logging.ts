/**
 * DeFlowd's operator log.
 *
 * Two properties are configured here on the first commit that has a logger at
 * all, because retrofitting either one across six months of call sites is
 * miserable:
 *
 *   1. **Redaction** (F5.9, KAR-01.3 AC6). Secrets reach log call sites by
 *      accident — a whole request object, a whole env — and a `redact` config
 *      is the only thing that catches the accident.
 *   2. **Per-subsystem children** (AC9). `log.child({ mod, runId })` is what
 *      makes `pnpm dev | <pretty printer> | grep '"mod":"scheduler"'` work at
 *      2am.
 *
 * These logs are **not** an event store. Ledger events are domain facts written
 * inside the transaction that advances run state; pino is a losable side
 * channel for the operator. The review question is: if this line vanished,
 * would any state be wrong? If yes, it belongs in the ledger.
 * See docs/13-observability-and-telemetry.md §1.
 *
 * There is deliberately no `transport` here. The pretty printer is a pipe in
 * `pnpm dev:pretty`, never a runtime transport: a transport spawns a worker
 * thread inside DeFlowd and turns production logs into something other than
 * ndjson.
 */
import './env.ts'; // side effect: populates process.env before the level is read
import type { DestinationStream, Logger } from 'pino';
import pino from 'pino';

/** What a redacted value is replaced with. */
export const CENSOR = '[redacted]';

/**
 * AC6, verbatim from docs/13-observability-and-telemetry.md §1. The leading
 * `*.` is pino's one-level wildcard, which is what catches "someone logged the
 * whole request object".
 */
export const REDACT_PATHS = [
  '*.authorization',
  '*.token',
  '*.headers.cookie',
  'env.ANTHROPIC_API_KEY',
  'env.OPENAI_API_KEY',
  'env.GITHUB_TOKEN',
] as const;

export interface CreateLoggerOptions {
  /** Defaults to $DeFlow_LOG_LEVEL, else "info". */
  readonly level?: string | undefined;
  /** Defaults to stdout. Injected by tests so the output can be asserted on. */
  readonly destination?: DestinationStream | undefined;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const config = {
    level: options.level ?? process.env.DeFlow_LOG_LEVEL ?? 'info',
    redact: { paths: [...REDACT_PATHS], censor: CENSOR },
  };
  return options.destination === undefined ? pino(config) : pino(config, options.destination);
}

/** The daemon's root logger. Subsystems take `log.child({ mod, runId })`. */
export const log: Logger = createLogger();
