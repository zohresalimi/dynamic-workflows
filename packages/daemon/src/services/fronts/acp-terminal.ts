/** The ACP front for `terminal/*`: unwrap params, call
 * ./../terminal-service.ts, wrap the result. No allowlist, no pty lifecycle,
 * no ring buffer — those are the service's. ACP v2 deletes all five methods
 * from the client, at which point this file is deleted.
 *
 * `terminal/create` is awaited rather than answered synchronously, because a
 * gated command waits for a human (KAR-08.3 AC1): the response frame is what
 * the agent is blocked on, and it does not go back until the operator has
 * answered and the process has actually been spawned. A refused command comes
 * back as the same JSON-RPC error `fs/*` refusals do — see ./reject.ts. */
import type * as acp from '@agentclientprotocol/sdk';
import type { TerminalService } from '../terminal-service.ts';
import { rejecting } from './reject.ts';

export function acpTerminalHandlers(
  terminal: TerminalService,
): Record<string, (params: never) => unknown> {
  return {
    'terminal/create': async (params: acp.CreateTerminalRequest) =>
      rejecting(async () => ({
        terminalId: await terminal.create({
          command: params.command,
          args: params.args ?? [],
          cwd: params.cwd ?? null,
          env: params.env ?? null,
        }),
      })),
    'terminal/output': (params: acp.TerminalOutputRequest) => terminal.output(params.terminalId),
    'terminal/wait_for_exit': (params: acp.WaitForTerminalExitRequest) =>
      terminal.waitForExit(params.terminalId),
    'terminal/kill': (params: acp.KillTerminalRequest) => {
      terminal.kill(params.terminalId);
      return {};
    },
    'terminal/release': (params: acp.ReleaseTerminalRequest) => {
      terminal.release(params.terminalId);
      return {};
    },
  } as Record<string, (params: never) => unknown>;
}
