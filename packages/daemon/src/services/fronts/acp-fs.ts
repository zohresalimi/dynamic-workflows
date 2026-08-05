/** The ACP front for `fs/*`: unwrap params, call ./../fs-service.ts, wrap the
 * result. No policy — see the service. ACP v2 deletes both methods from the
 * client, at which point this file is deleted and mcp-fs.ts is re-pointed. */
import type * as acp from '@agentclientprotocol/sdk';
import type { FsService } from '../fs-service.ts';

export function acpFsHandlers(fs: FsService): Record<string, (params: never) => unknown> {
  return {
    'fs/read_text_file': async (params: acp.ReadTextFileRequest) => ({
      content: await fs.readText({
        path: params.path,
        line: params.line ?? null,
        limit: params.limit ?? null,
      }),
    }),
    'fs/write_text_file': async (params: acp.WriteTextFileRequest) => {
      await fs.writeText({ path: params.path, content: params.content });
      return {};
    },
  } as Record<string, (params: never) => unknown>;
}
