/** The ACP front for `terminal/*`: unwrap params, call
 * ./../terminal-service.ts, wrap the result. No allowlist, no pty lifecycle,
 * no ring buffer — those are the service's. ACP v2 deletes all five methods
 * from the client, at which point this file is deleted. */
import type * as acp from '@agentclientprotocol/sdk';
import type { TerminalService } from '../terminal-service.ts';

export function acpTerminalHandlers(
  terminal: TerminalService,
): Record<string, (params: never) => unknown> {
  return {
    'terminal/create': (params: acp.CreateTerminalRequest) => ({
      terminalId: terminal.create({
        command: params.command,
        args: params.args ?? [],
        cwd: params.cwd ?? null,
        env: params.env ?? null,
      }),
    }),
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
