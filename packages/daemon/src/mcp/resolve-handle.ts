/**
 * KAR-09.5 AC4, AC5 — resolving a handle to bytes, on the DeFlow side of the
 * MCP socket.
 *
 * @DeFlow/core's `handle-access.ts` decides *whether* this node may resolve
 * this handle; this decides *what it resolves to*, which is the half that
 * needs a disk. The split is R1's, and it is also what makes the permission
 * argument checkable: the decision is a pure function with a table of cases,
 * and this file cannot reach a byte without having called it.
 *
 * Three rules the implementation exists to hold.
 *
 * **A digest is not a capability.** The blob store is global — the same failing
 * build log across two runs is one object (repo-layout §7.2) — so "the bytes
 * exist" and "this run may read them" are different questions. Resolution goes
 * through the run's artifact index (`runs/<runId>/artifacts/<sha256>/`), and a
 * handle another run recorded is refused **naming the run boundary** rather
 * than served because the digest happened to be in the store. Otherwise a
 * handle leaked into a prompt would be a cross-run read primitive.
 *
 * **The symlink route is checked with the same mediator EPIC-08 built.** The
 * pure decision covers the level row, lexical containment and the declared read
 * scope; it cannot see a symlink inside the worktree pointing out of it, and
 * `createPathMediator().contain()` can. Reusing it rather than restating it is
 * the whole point — a second implementation of containment is how the two
 * boundaries come to disagree, and the one that disagrees quietly is the one
 * nobody is testing.
 *
 * **Never an empty success.** Every failure path here returns a typed refusal
 * carrying the digest or the path that failed. A tool that answers a lost blob
 * with `text: ''` tells the agent the build log was empty, and the agent
 * believes it.
 *
 * Verifies: EPIC-09-S26 (second scenario), EPIC-09-S27 (third scenario),
 * EPIC-09-S29 · AC4, AC5
 */
import type { Handle, HandleRefusal, NodeHandleAccess, RunId } from '@DeFlow/core';
import { decideFileHandleAccess, parseHandle, sliceLines } from '@DeFlow/core';
import { ARTIFACT_SCHEME, blobPath, getBlob, readRunArtifact } from '@DeFlow/ledger';
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createPathMediator } from '../services/path-mediation.ts';

export type HandleResolution =
  | {
      readonly ok: true;
      readonly handle: string;
      /** The bytes actually resolved — the whole blob, or exactly the line
       * range a `file://` handle named. */
      readonly text: string;
      readonly bytes: number;
    }
  | { readonly ok: false; readonly refusal: HandleRefusal };

export interface ArtifactResolveRequest {
  readonly runId: RunId;
  /** Verbatim from the agent, before anything is assumed about it. */
  readonly handle: string;
  /**
   * The node's level, scope and declared read globs. `undefined` means the
   * grant carried none, and every `file://` handle is refused — a file read
   * whose boundary nobody supplied is not one this tool performs.
   */
  readonly access: NodeHandleAccess | undefined;
}

/**
 * The store the MCP host resolves handles through.
 *
 * A port rather than a concrete call so a spec can drive the host without a
 * run directory, and so the host itself never learns where blobs live.
 */
export interface ArtifactStore {
  resolve(request: ArtifactResolveRequest): Promise<HandleResolution>;
}

export interface RunArtifactStorePorts {
  /** DeFlowd's data directory — where `blobs/` lives. */
  readonly dataDir: string;
  /** `<target-repo>/.DeFlow/runs/<runId>`, where the artifact index lives. */
  readonly runDirOf: (runId: string) => string;
}

const refuse = (refusal: HandleRefusal): HandleResolution => ({ ok: false, refusal });

const byteLengthOf = (text: string): number => Buffer.byteLength(text, 'utf8');

export function runArtifactStore(ports: RunArtifactStorePorts): ArtifactStore {
  return {
    async resolve(request: ArtifactResolveRequest): Promise<HandleResolution> {
      const parsed = parseHandle(request.handle);

      // The ladder first, and before anything is opened: a refusal has to cost
      // the same whether or not the file exists, or the tool becomes an
      // existence oracle for paths the node may not read.
      const denied = decideFileHandleAccess(parsed, request.access);
      if (denied !== null) return refuse(denied);
      if (parsed === null) throw new Error('unreachable: a null handle is always refused above');

      return parsed.scheme === 'artifact'
        ? resolveArtifact(ports, request.runId, parsed.sha256)
        : await resolveFile(request, parsed.path, parsed.firstLine, parsed.lastLine);
    },
  };
}

function resolveArtifact(
  ports: RunArtifactStorePorts,
  runId: RunId,
  sha256: string,
): HandleResolution {
  const handle = `${ARTIFACT_SCHEME}${sha256}`;
  const entry = readRunArtifact(ports.runDirOf(runId), sha256);
  if (entry === null) {
    // Two different refusals, because they mean two different things to whoever
    // reads them: bytes nobody has, versus bytes this run was never shown.
    return existsSync(blobPath(ports.dataDir, sha256))
      ? refuse({
          code: 'artifact-foreign-run',
          message:
            `artifact ${sha256} was not recorded in run ${runId}. A handle resolves only from ` +
            'the run that recorded it: the content-addressed store is shared, the permission ' +
            'to read through it is not',
        })
      : refuse({
          code: 'artifact-unknown',
          message: `no artifact ${sha256} is recorded in run ${runId}`,
        });
  }

  try {
    const bytes = getBlob(ports.dataDir, handle);
    return { ok: true, handle, text: Buffer.from(bytes).toString('utf8'), bytes: bytes.byteLength };
  } catch (error) {
    // Indexed but unreadable — lost, truncated or no longer hashing to its own
    // name. `getBlob` verifies the digest on the way out, so this is the one
    // place that distinguishes "the store has it" from "the store still has
    // the bytes it promised".
    return refuse({
      code: 'artifact-unreadable',
      message:
        `artifact ${sha256} is recorded in run ${runId} but its bytes could not be returned: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

async function resolveFile(
  request: ArtifactResolveRequest,
  path: string,
  firstLine: number,
  lastLine: number,
): Promise<HandleResolution> {
  const access = request.access;
  if (access === undefined) {
    throw new Error('unreachable: a file handle without an access context is refused above');
  }
  const root = access.scope.worktree;

  // Routes 3 and 4 — a symlink inside the worktree pointing out of it, which no
  // lexical check can see. Same mediator, same `PathEscapeRoute` vocabulary,
  // same answer as `fs/read_text_file` would have given.
  const mediator = createPathMediator({ level: access.level, scope: access.scope });
  const contained = await mediator.contain(path);
  if (contained.outcome !== 'inside') {
    return refuse({
      code: 'permission-denied',
      message:
        `file://${path} resolves outside this node's worktree (${contained.route}). ` +
        'DeFlow_read_artifact is decided by the same containment check as fs/read_text_file',
      denial: {
        method: 'fs/read_text_file',
        requested: `file://${path}#L${firstLine}-L${lastLine}`,
        permission: access.level,
        reason: { code: 'path-escape', detail: contained.route },
      },
    });
  }

  const absolute = isAbsolute(contained.path) ? contained.path : resolve(root, contained.path);
  let text: string;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch (error) {
    return refuse({
      code: 'file-unreadable',
      message: `file://${path} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
  }

  const slice = sliceLines(text, firstLine, lastLine);
  if (slice === null) {
    return refuse({
      code: 'line-range-empty',
      message:
        `file://${path} has ${text.split('\n').length} lines, so #L${firstLine}-L${lastLine} ` +
        'names nothing. A range past the end of a file is a refusal, never an empty body',
    });
  }

  return {
    ok: true,
    handle: `file://${path}#L${firstLine}-L${lastLine}`,
    text: slice,
    bytes: byteLengthOf(slice),
  };
}

/** The `artifact://` half of a handle, for a caller that already knows it has
 * one. Exported so nothing else re-spells the scheme. */
export function digestOf(handle: Handle | string): string {
  return handle.startsWith(ARTIFACT_SCHEME) ? handle.slice(ARTIFACT_SCHEME.length) : handle;
}
