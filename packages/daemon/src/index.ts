/**
 * @DeFlow/daemon — DeFlowd itself: the hono HTTP+SSE server, the orchestrator
 * tick loop, the Effect Runner, Planner, Context Builder, Blackboard, Gate
 * Runner, Workspace Manager and MCP host.
 *
 * R2: nothing depends on this package except packages/cli. It is a leaf, and
 * anything another package needs from it belongs in @DeFlow/core if it is pure,
 * or is a port that the daemon implements and injects if it is not.
 *
 * EPIC-06 and EPIC-15 fill in the orchestrator. What exists today is the
 * process shape from KAR-01.3: one HTTP server, one origin, and `src/main.ts`
 * as the `node --watch` entry point.
 */

export type { StartedHttp, StartHttpOptions } from './http/server.ts';
export { DEFAULT_HOSTNAME, DEFAULT_PORT, startHttp } from './http/server.ts';
export type { CreateLoggerOptions } from './logging.ts';
export { CENSOR, createLogger, log, REDACT_PATHS } from './logging.ts';
export { API_VERSION, BOOT_ID, BUILD, uptimeMs } from './meta.ts';
