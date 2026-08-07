/**
 * KAR-09.5 AC4, AC5 — the handle grammar, the line range, and the permission
 * check `DeFlow_read_artifact` needs *because* it is a DeFlow-hosted tool
 * (docs/04-domain-model.md §1, docs/09-workspace-and-safety.md §8).
 *
 * **This is the scope escape that is obvious once named and invisible
 * otherwise.** Everything an agent does to the filesystem goes through ACP's
 * `fs/*` methods, which EPIC-08 mediates: the ladder decides, the worktree
 * contains, the declared scope narrows. `DeFlow_read_artifact` does not. It is
 * a tool DeFlow itself hosts over its own socket, so an agent that cannot open
 * `infra/secrets.tf` with `fs/read_text_file` would be able to open it by
 * asking DeFlow politely — unless this file exists.
 *
 * So the `file://` arm runs the *same* `decidePermission` the ACP boundary
 * runs, against the same `PermissionScope`, and then narrows it with the node's
 * declared read scope through the same `pathScopeMatches` KAR-08.7 uses. Not a
 * second implementation of containment: a second *call site* of the first one.
 * A second implementation is how the two boundaries come to disagree, and the
 * one that disagrees quietly is always the one nobody is testing.
 *
 * **Fail closed.** A node whose access context was never wired up gets a
 * refusal, not a default. The alternative — treat "no scope supplied" as "no
 * restriction" — makes the safety of every `file://` resolution depend on a
 * caller remembering to pass an argument.
 *
 * Pure and total: no clock, no filesystem, no exception. Reading the bytes is
 * `@DeFlow/daemon`'s `resolve-handle.ts`, on the other side of the R1 boundary.
 *
 * Verifies: EPIC-09-S27 (third scenario), EPIC-09-S29 (first scenario) · AC4
 */
import { pathScopeMatches, relativeToWorktree } from './path-scope.ts';
import { decidePermission, type PermissionReason, type PermissionScope } from './permission.ts';
import type { PermissionLevel } from './plan-graph.ts';
import { resolvePosix } from './scope.ts';

/** §1: `artifact://<64 hex sha256>`, content-addressed and immutable. */
const ARTIFACT_HANDLE = /^artifact:\/\/([0-9a-f]{64})$/;

/** §1: `file://<repo-relative path>#L12-L40`. The `(?!/)` is what keeps an
 * absolute path out — a handle naming `/etc/passwd` is not a handle. */
const FILE_HANDLE = /^file:\/\/((?!\/)[^\s#]+)#L(\d+)-L(\d+)$/;

export interface ParsedArtifactHandle {
  readonly scheme: 'artifact';
  readonly sha256: string;
}

export interface ParsedFileHandle {
  readonly scheme: 'file';
  /** Repo-relative, verbatim from the handle — never resolved here. */
  readonly path: string;
  /** 1-based and inclusive, both ends, as `#L12-L40` reads. */
  readonly firstLine: number;
  readonly lastLine: number;
}

export type ParsedHandle = ParsedArtifactHandle | ParsedFileHandle;

/**
 * `value` as one of the two handle shapes, or `null`.
 *
 * `null` rather than a thrown error: every caller is answering an agent, and a
 * malformed handle is a refusal the model can fix inside its own loop, not an
 * exception the daemon should be catching.
 */
export function parseHandle(value: string): ParsedHandle | null {
  const artifact = ARTIFACT_HANDLE.exec(value);
  if (artifact?.[1] !== undefined) return { scheme: 'artifact', sha256: artifact[1] };

  const file = FILE_HANDLE.exec(value);
  if (file?.[1] === undefined) return null;
  const firstLine = Number(file[2]);
  const lastLine = Number(file[3]);
  // A backwards or zero-based range is not a range this file can honour, and
  // clamping it into one would answer a question nobody asked.
  if (firstLine < 1 || lastLine < firstLine) return null;
  return { scheme: 'file', path: file[1], firstLine, lastLine };
}

/**
 * Lines `first`..`last` of `text`, 1-based and inclusive, or `null` when the
 * range starts past the end of the file.
 *
 * `null` and never `''`: AC5's rule is that resolution never returns an empty
 * body, and a range past the end is exactly the case where returning one would
 * look like success.
 */
export function sliceLines(text: string, first: number, last: number): string | null {
  const lines = text.split('\n');
  if (first > lines.length) return null;
  return lines.slice(first - 1, last).join('\n');
}

/** The node's boundary, as handle resolution needs it. */
export interface NodeHandleAccess {
  readonly level: PermissionLevel;
  /** The same scope the ACP `fs/*` boundary is decided against. */
  readonly scope: PermissionScope;
  /** `pathScopes.read`. Empty means the node declared none, which the ladder's
   * containment check already bounds to the worktree. */
  readonly readScope?: readonly string[];
}

export type HandleRefusalCode =
  | 'handle-malformed'
  | 'permission-denied'
  | 'scope-violation'
  | 'artifact-unknown'
  | 'artifact-foreign-run'
  | 'artifact-unreadable'
  | 'file-unreadable'
  | 'line-range-empty';

/** What `permission.denied` records, minus the node and attempt the ledger
 * caller owns. Carried as fields rather than as a formatted sentence, for the
 * same reason `PermissionDeniedSchema` splits `reason` from `declared`: two
 * facts, not one string somebody has to parse back out. */
export interface HandleDenial {
  readonly method: 'fs/read_text_file';
  /** The handle verbatim, before any resolution. */
  readonly requested: string;
  readonly permission: PermissionLevel;
  readonly reason: PermissionReason;
  readonly declared?: readonly string[];
}

export interface HandleRefusal {
  readonly code: HandleRefusalCode;
  /** What the agent is told. Names the level and the scope where those are
   * what decided it, because "denied" alone costs a retry loop. */
  readonly message: string;
  /** Present when the refusal is a permission decision, and therefore one the
   * ledger should carry as `permission.denied` (EPIC-09-S29). */
  readonly denial?: HandleDenial;
}

/**
 * Whether this node may resolve this `file://` handle — `null` when it may.
 *
 * An `artifact://` handle has nothing to decide here: it addresses bytes
 * DeFlow itself put in the store, and whether *this run* recorded them is the
 * resolver's question, not the ladder's.
 */
export function decideFileHandleAccess(
  handle: ParsedHandle | null,
  access: NodeHandleAccess | undefined,
): HandleRefusal | null {
  if (handle === null) {
    return {
      code: 'handle-malformed',
      message:
        'that is not a handle: expected artifact://<64 hex sha256> or ' +
        'file://<repo-relative path>#L12-L40',
    };
  }
  if (handle.scheme === 'artifact') return null;

  const requested = `file://${handle.path}#L${handle.firstLine}-L${handle.lastLine}`;
  if (access === undefined) {
    return {
      code: 'permission-denied',
      message:
        `${requested} cannot be resolved: this node's permission level and path scope were ` +
        'not supplied to the MCP host, and a file handle is never resolved without them',
    };
  }

  const absolute = resolvePosix(access.scope.worktree, handle.path);
  const answer = decidePermission(
    access.level,
    { method: 'fs/read_text_file', path: absolute },
    access.scope,
  );
  if (answer.outcome !== 'allow') {
    return {
      code: 'permission-denied',
      message:
        `${requested} is refused at permission level "${access.level}" ` +
        `(${answer.reason.code}${answer.reason.detail === undefined ? '' : `:${answer.reason.detail}`}). ` +
        'DeFlow_read_artifact is decided by the same ladder as fs/read_text_file',
      denial: {
        method: 'fs/read_text_file',
        requested,
        permission: access.level,
        reason: answer.reason,
      },
    };
  }

  const declared = access.readScope ?? [];
  const relative = relativeToWorktree(access.scope.worktree, absolute);
  if (declared.length > 0 && !pathScopeMatches(declared, relative)) {
    return {
      code: 'scope-violation',
      message:
        `${requested} is outside this node's declared read scope. Level "${access.level}", ` +
        `read scope [${declared.join(', ')}], requested "${relative}"`,
      denial: {
        method: 'fs/read_text_file',
        requested,
        permission: access.level,
        reason: { code: 'scope-violation', detail: relative },
        declared,
      },
    };
  }

  return null;
}
