/**
 * The transport-neutral filesystem service (docs/07-provider-adapter-layer.md
 * §3).
 *
 * This is where path resolution, workspace-root enforcement, the permission
 * ladder check and the ledger events live — *not* in the ACP handler. ACP v2
 * removes `fs/read_text_file` and `fs/write_text_file` from the client
 * entirely and pushes them onto MCP; when that lands, `fronts/mcp-fs.ts` is
 * re-pointed at this service and `fronts/acp-fs.ts` is deleted. That is only a
 * deletion if none of the security-sensitive code was ever in the front.
 *
 * What is here at M1 is real: real reads, real writes, paths resolved against
 * the node's worktree, and a `PathPolicy` seam. What is deliberately **not**
 * here is the policy behind that seam — path-scope enforcement (F5.3) and the
 * permission ladder are EPIC-08 (KAR-08.2, KAR-08.3). `createFsService` takes
 * the policy as a required-by-design port with a documented open default, so
 * that wiring it into a running daemon is a decision someone has to make
 * rather than something that already happened by omission.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

/** What EPIC-08 plugs in. Throws to refuse; returns to allow. */
export interface PathPolicy {
  authorize(operation: 'read' | 'write', absolutePath: string): void;
}

export interface FsServiceOptions {
  /** The node's worktree. Relative paths resolve against it. */
  readonly root: string;
  /**
   * Absent, every path under `root` is allowed and nothing else is checked.
   * That is not the shipped policy — it is the *absence* of one, and EPIC-08
   * is what supplies it.
   */
  readonly policy?: PathPolicy;
}

export interface ReadTextRequest {
  readonly path: string;
  /** 1-based first line to return. */
  readonly line?: number | null;
  /** How many lines from `line`. */
  readonly limit?: number | null;
}

export interface WriteTextRequest {
  readonly path: string;
  readonly content: string;
}

export interface FsService {
  readText(request: ReadTextRequest): Promise<string>;
  writeText(request: WriteTextRequest): Promise<void>;
}

/** The window `readText` returns when the caller asked for one. */
function window(content: string, line: number | null, limit: number | null): string {
  if (line === null && limit === null) return content;
  const lines = content.split('\n');
  const from = Math.max((line ?? 1) - 1, 0);
  return lines.slice(from, limit === null ? undefined : from + limit).join('\n');
}

export function createFsService(options: FsServiceOptions): FsService {
  const root = resolve(options.root);
  const within = (path: string): string => (isAbsolute(path) ? resolve(path) : resolve(root, path));

  return {
    async readText(request) {
      const path = within(request.path);
      options.policy?.authorize('read', path);
      const content = await readFile(path, 'utf8');
      return window(content, request.line ?? null, request.limit ?? null);
    },
    async writeText(request) {
      const path = within(request.path);
      options.policy?.authorize('write', path);
      // The agent asked for a file, not for a directory tree; creating the
      // parent is what makes "write the report to docs/out/report.md" work on
      // a fresh worktree.
      await mkdir(resolve(path, '..'), { recursive: true });
      await writeFile(path, request.content, 'utf8');
    },
  };
}
