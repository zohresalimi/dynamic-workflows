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
 * KAR-08.2 filled in the `PathPolicy` seam EPIC-05 left open, and in doing so
 * changed its shape for one reason worth stating: **the policy resolves the
 * path, and the service touches nothing else.** A service that resolved the
 * path itself and then asked the policy whether it liked the result would have
 * two resolutions of the same string — and the one the filesystem sees would
 * be the one nobody checked. Resolve once, decide on the result, act on the
 * result. See ./path-mediation.ts.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

/**
 * What EPIC-08 plugs in: the agent's requested path in, the absolute path to
 * actually touch out. Throwing refuses the request — ./path-mediation.ts
 * throws `PermissionDeniedError`, which the ACP front turns into a rejection.
 */
export interface PathPolicy {
  resolve(operation: 'read' | 'write', requestedPath: string): Promise<string>;
}

/**
 * The filesystem itself, as a port.
 *
 * Not a mocking seam — the default below is the real thing. It exists because
 * EPIC-08-S10's claim is a *negative* one: a denied read must never open the
 * file, and "the bytes were never in this process" is not observable from
 * outside without a double that can say "zero opens".
 */
export interface FsIo {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

const nodeFsIo: FsIo = {
  readFile: (path) => readFile(path, 'utf8'),
  writeFile: (path, content) => writeFile(path, content, 'utf8'),
  mkdir: async (path) => {
    await mkdir(path, { recursive: true });
  },
};

export interface FsServiceOptions {
  /** The node's worktree. Relative paths resolve against it. */
  readonly root: string;
  /**
   * Absent, every path under `root` is allowed and nothing else is checked.
   * That is not the shipped policy — it is the *absence* of one, and EPIC-08
   * is what supplies it.
   */
  readonly policy?: PathPolicy;
  readonly io?: FsIo;
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
  const io = options.io ?? nodeFsIo;
  /** The policy's answer is the path, always. The unpoliced fallback is the
   * documented open default, and the *only* place this service resolves
   * anything itself. */
  const within = async (operation: 'read' | 'write', path: string): Promise<string> =>
    options.policy === undefined
      ? isAbsolute(path)
        ? resolve(path)
        : resolve(root, path)
      : await options.policy.resolve(operation, path);

  return {
    async readText(request) {
      const path = await within('read', request.path);
      const content = await io.readFile(path);
      return window(content, request.line ?? null, request.limit ?? null);
    },
    async writeText(request) {
      const path = await within('write', request.path);
      // The agent asked for a file, not for a directory tree; creating the
      // parent is what makes "write the report to docs/out/report.md" work on
      // a fresh worktree.
      await io.mkdir(resolve(path, '..'));
      await io.writeFile(path, request.content);
    },
  };
}
