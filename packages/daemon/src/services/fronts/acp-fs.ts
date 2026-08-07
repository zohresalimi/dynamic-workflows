/** The ACP front for `fs/*`: unwrap params, call ./../fs-service.ts, wrap the
 * result. No policy — see the service. ACP v2 deletes both methods from the
 * client, at which point this file is deleted and mcp-fs.ts is re-pointed.
 * KAR-08.2 AC7/AC8 — a refusal becomes a JSON-RPC error response; ./reject.ts
 * owns how, and ./acp-terminal.ts uses the same one. */
import type * as acp from '@agentclientprotocol/sdk';
import type { FsService } from '../fs-service.ts';
import { rejecting } from './reject.ts';

export function acpFsHandlers(fs: FsService): Record<string, (params: never) => unknown> {
  return {
    'fs/read_text_file': async (params: acp.ReadTextFileRequest) =>
      rejecting(async () => ({
        content: await fs.readText({
          path: params.path,
          line: params.line ?? null,
          limit: params.limit ?? null,
        }),
      })),
    'fs/write_text_file': async (params: acp.WriteTextFileRequest) => {
      await rejecting(() => fs.writeText({ path: params.path, content: params.content }));
      return {};
    },
  } as Record<string, (params: never) => unknown>;
}
