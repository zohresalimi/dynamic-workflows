/**
 * KAR-08.2 — filesystem mediation at the ACP `fs/*` boundary
 * (docs/09-workspace-and-safety.md §8.2, docs/14-testing-strategy.md §10).
 *
 * @DeFlow/core's `decidePermission` decides; it may not touch a filesystem, so
 * its containment check is lexical. This is the half that can touch one, and
 * it exists because three of the four escape routes
 * [testing strategy §10](../../../../docs/14-testing-strategy.md) names are
 * lexical and **one is not**:
 *
 * 1. `..` traversal — lexical.
 * 2. an absolute path outside the worktree — lexical.
 * 3. a symlink inside the worktree pointing out of it — needs `realpath`.
 * 4. a path that is lexically inside and whose `realpath` is outside — needs
 *    `realpath`, and is the one a `resolve()`-only implementation misses
 *    entirely. It is trivially reachable: the agent creates the symlink itself
 *    with an allowed in-scope write, then writes through it.
 *
 * Four decisions here are load-bearing.
 *
 * **The check is applied to the deepest *existing* ancestor.** A naive
 * `realpath` on a file that does not exist yet throws, and the tempting fix —
 * skip the check for new files — reopens route 3 completely, because the
 * interesting write is always to a file that does not exist yet.
 *
 * **The answer is the resolved path, and the caller writes to that.** Deciding
 * on the resolution and then handing the agent's own string to the filesystem
 * reintroduces the whole class (EPIC-08-S7, last scenario). `mediate` returns
 * the path to use, and ./fs-service.ts has no other source for one.
 *
 * **The level decides before the path does.** That ordering is KAR-08.1's, and
 * it is re-used here rather than restated: the resolved path goes back through
 * `decidePermission`, so a `read` node's write is `level-read` whatever path
 * it named, and the reason code stays a function of the level rather than of
 * which path the agent happened to try.
 *
 * **Containment follows the filesystem's own case rule.** On APFS
 * `<worktree>/SRC` and `<worktree>/src` are the same directory, so a
 * case-sensitive prefix match denies legitimate writes there; on ext4 they are
 * two directories, so a case-insensitive match is a hole. The rule is probed
 * once, from the worktree itself, rather than guessed from `process.platform`
 * — a case-sensitive volume mounted on a Mac is not exotic. Same A5-7
 * normalization family as EPIC-07's id handling.
 *
 * Verifies: EPIC-08-S7, EPIC-08-S8, EPIC-08-S9, EPIC-08-S10 · AC1–AC5, AC7
 */
import {
  decidePermission,
  type NodeId,
  type PermissionDenyCode,
  type PermissionLevel,
  type PermissionReason,
  type PermissionScope,
  pathIsInside,
  REQUESTED_PATH_MAX,
} from '@DeFlow/core';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import type { PathPolicy } from './fs-service.ts';

/** The two ACP methods this mediates. `terminal/create` is KAR-08.3's, and it
 * reuses `contain` below for the one path a command carries: its cwd. */
export type PathMethod = 'fs/read_text_file' | 'fs/write_text_file';

/**
 * The four routes, as reason details.
 *
 * `invalid` is the fifth thing that can be wrong with a path and is not an
 * escape *route* so much as a refusal to guess: a NUL byte truncates the path
 * in every C-level filesystem API, so the path the kernel would see is not the
 * path this function checked.
 */
export const PATH_ESCAPE_ROUTES = ['traversal', 'symlink', 'absolute', 'invalid'] as const;

export type PathEscapeRoute = (typeof PATH_ESCAPE_ROUTES)[number];

/**
 * Everything a `permission.denied` event and an ACP rejection need, for any
 * request the safety layer refused.
 *
 * One shape across `fs/*` and `terminal/create` because the ledger row is one
 * shape: `permission.denied` names the method rather than having a variant per
 * method, and the node inspector renders one table.
 *
 * The reason may be a *gate* code — `not-allowlisted:rsync` on a request the
 * operator rejected is a denial, and recording it as anything else would lose
 * the only information in it.
 */
export interface MediationDenial {
  readonly level: PermissionLevel;
  readonly method: PathMethod | 'terminal/create';
  /** The agent's own string, before any resolution. */
  readonly requested: string;
  /**
   * KAR-13.4 AC3 — the post-`realpath` target, where one could be computed.
   *
   * *"The resolved path is shown, not only the requested one… because that is
   * the fact the decision turns on"*: a request for `./tmp/x` where `tmp` is a
   * symlink to `/etc` is a refusal about `/etc/x`, and a record that named only
   * `./tmp/x` would send a later reader looking inside the worktree for the
   * reason. Absent when there was nothing to resolve — an unusable path, or a
   * refusal the level made before any path was examined.
   */
  readonly resolved?: string;
  readonly reason: PermissionReason;
}

/** A refused `fs/*` request: the denial above, narrowed to what this file
 * decides. */
export interface PathDenial extends MediationDenial {
  readonly method: PathMethod;
  readonly reason: PermissionReason<PermissionDenyCode>;
}

export type PathMediation =
  | { readonly outcome: 'allow'; readonly path: string }
  | { readonly outcome: 'deny'; readonly denial: PathDenial };

/**
 * Containment on its own, with no level row in front of it: the resolved path
 * to use, or the route by which the request left the worktree.
 *
 * Exposed because `terminal/create` needs exactly this and nothing else for
 * its `cwd` — the ladder has already decided what the *command* may do, and
 * what is left is the same "where would this actually land" question the four
 * escape routes are about. A second implementation of it for commands is how
 * one of the two ends up missing route 4.
 */
export type PathContainment =
  | { readonly outcome: 'inside'; readonly path: string }
  | {
      readonly outcome: 'outside';
      readonly route: PathEscapeRoute;
      /** KAR-13.4 AC3 — where it would actually have landed, post-`realpath`.
       * Absent for a path there was nothing to resolve (`invalid`). */
      readonly resolved?: string;
    };

/**
 * The filesystem, as containment needs to see it.
 *
 * A port so the unit suite can construct route 4 exactly — one symlink, no
 * ambient state — while the integration suite runs the same code against real
 * symlinks in a real tmpdir. It is *not* a mocking seam for `node:fs`: the
 * shipped default below is the real thing, and both suites exist.
 */
export interface PathFs {
  /** Fully resolved real path, or a rejection when it does not exist. */
  realpath(path: string): Promise<string>;
  /** Whether two paths name the same directory entry — how the case rule is
   * probed without writing anything. */
  sameEntry(a: string, b: string): Promise<boolean>;
}

export const nodePathFs: PathFs = {
  realpath: (path) => realpath(path),
  sameEntry: async (a, b) => {
    try {
      const [left, right] = await Promise.all([stat(a), stat(b)]);
      return left.ino === right.ino && left.dev === right.dev;
    } catch {
      // One of them does not exist, so they are not the same entry. That is
      // also the answer on a case-sensitive filesystem, which is the whole
      // point of the probe.
      return false;
    }
  },
};

export interface PathMediatorPorts {
  readonly level: PermissionLevel;
  readonly scope: PermissionScope;
  readonly fs?: PathFs;
  /** Where a leading `~` points. Injected so a spec never depends on the
   * machine's own home directory. */
  readonly home?: string;
  /** Stated only by tests that are *about* the case rule; otherwise probed
   * from the worktree, once. */
  readonly caseInsensitive?: boolean;
}

export interface PathMediator {
  /** Resolves `requested` against the node's worktree and decides it. */
  mediate(method: PathMethod, requested: string): Promise<PathMediation>;
  /** The containment half alone, for callers whose level row is elsewhere. */
  contain(requested: string): Promise<PathContainment>;
}

/** A path with no NUL and something in it. Everything else — including a
 * newline, which POSIX allows in a filename — is a path this can reason
 * about. */
const isUsable = (path: string): boolean =>
  path !== '' && !path.includes('\0') && path.length <= REQUESTED_PATH_MAX;

/**
 * `~` and `~/…` mean the user's home directory to every shell, and to no
 * filesystem API. Resolved against the worktree they would become a directory
 * literally called `~` *inside* it — so `~/.aws/credentials` would be
 * **allowed**, which is EPIC-08-S10's exact attack. Expanded here, it is an
 * absolute path outside the worktree and is denied like any other.
 *
 * `~user` is deliberately not expanded: it is not a form ACP carries, and
 * guessing another account's home directory from this one's is worse than
 * treating it as the ordinary relative path it looks like.
 */
function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  return path.startsWith('~/') ? `${home}${path.slice(1)}` : path;
}

interface Resolution {
  /** Absolute and lexically normalised, or `''` when the path is unusable. */
  readonly path: string;
  /** How it left the worktree, if the lexical check says it did. */
  readonly route: PathEscapeRoute;
}

function resolveLexically(requested: string, root: string, home: string): Resolution {
  if (!isUsable(requested)) return { path: '', route: 'invalid' };
  const expanded = expandHome(requested, home);
  const path = isAbsolute(expanded) ? resolve(expanded) : resolve(root, expanded);
  // The route is what the agent *used*, which is what the operator is being
  // told: an absolute path containing `..` is a traversal, and a plain one
  // outside the worktree is an absolute-path escape.
  return { path, route: expanded.split('/').includes('..') ? 'traversal' : 'absolute' };
}

/**
 * The real path of the deepest ancestor that exists, with the not-yet-existing
 * tail put back on.
 *
 * The tail cannot contain a symlink — it does not exist — and cannot contain
 * `..`, because the input is already lexically normalised. So this is the
 * strongest statement available about where the write would actually land.
 */
async function realpathDeepest(fs: PathFs, path: string): Promise<string> {
  const tail: string[] = [];
  let head = path;
  for (;;) {
    try {
      const real = await fs.realpath(head);
      // `tail` was collected leaf-first, so it goes back on in reverse.
      return tail.length === 0
        ? real
        : `${real === '/' ? '' : real}/${tail.toReversed().join('/')}`;
    } catch {
      const at = head.lastIndexOf('/');
      if (at <= 0) return path;
      tail.push(head.slice(at + 1));
      head = head.slice(0, at);
    }
  }
}

export function createPathMediator(ports: PathMediatorPorts): PathMediator {
  const fs = ports.fs ?? nodePathFs;
  const home = ports.home ?? homedir();
  const root = resolve(ports.scope.worktree);

  /**
   * Whether this filesystem folds case, decided once and remembered.
   *
   * Probed by asking whether the worktree and a case-flipped spelling of it
   * are the same directory entry, which is the only question that has the
   * right answer on a case-sensitive volume mounted on a Mac.
   */
  let caseRule: Promise<boolean> | null =
    ports.caseInsensitive === undefined ? null : Promise.resolve(ports.caseInsensitive);
  const foldsCase = (): Promise<boolean> => {
    caseRule ??= (async () => {
      const flipped = root.replaceAll(/[a-z]/g, (letter) => letter.toUpperCase());
      return flipped === root ? false : await fs.sameEntry(root, flipped);
    })();
    return caseRule;
  };

  const contain = async (requested: string): Promise<PathContainment> => {
    const insensitive = await foldsCase();
    const fold = (path: string): string => (insensitive ? path.toLowerCase() : path);
    const resolution = resolveLexically(requested, root, home);
    // A path this layer refuses to guess about — empty, or carrying a NUL that
    // every C-level filesystem API would truncate at. `resolve()` turns both
    // into the worktree root, so a containment check alone would call them
    // *inside* it.
    if (resolution.path === '') return { outcome: 'outside', route: resolution.route };

    // Routes 1 and 2, lexically. Both sides of the comparison are folded when
    // the filesystem folds, which is the only place the case rule can be
    // applied without duplicating the predicate.
    //
    // The target is resolved even though the lexical check has already decided
    // it: KAR-13.4 AC3 wants the *fact the decision turns on* in the record,
    // and `../../etc/passwd` resolved is what a reader three days later needs.
    // One `realpath` on a path that is being refused anyway.
    if (!pathIsInside(fold(root), fold(resolution.path))) {
      return {
        outcome: 'outside',
        route: resolution.route,
        resolved: await realpathDeepest(fs, resolution.path),
      };
    }

    // Route 3 and route 4: lexically inside, really somewhere else. The root
    // is realpath'd too — `/var` is a symlink to `/private/var` on macOS, so
    // comparing a resolved target against an unresolved root would deny every
    // write DeFlow makes on a developer's laptop.
    const [rootReal, target] = await Promise.all([
      realpathDeepest(fs, root),
      realpathDeepest(fs, resolution.path),
    ]);
    if (!pathIsInside(fold(rootReal), fold(target))) {
      return { outcome: 'outside', route: 'symlink', resolved: target };
    }
    return { outcome: 'inside', path: resolution.path };
  };

  return {
    contain,

    async mediate(method, requested) {
      const insensitive = await foldsCase();
      const fold = (path: string): string => (insensitive ? path.toLowerCase() : path);
      const resolution = resolveLexically(requested, root, home);
      const deny = (
        reason: PermissionReason<PermissionDenyCode>,
        resolved?: string,
      ): PathMediation => ({
        outcome: 'deny',
        denial: {
          level: ports.level,
          method,
          requested,
          ...(resolved === undefined ? {} : { resolved }),
          reason,
        },
      });

      // KAR-08.1's ordering, re-used rather than restated: the level row runs
      // first, and only then does anything look at where the path points. A
      // `read` node's write is `level-read` whatever path it named.
      const lexical = decidePermission(
        ports.level,
        { method, path: fold(resolution.path) },
        { ...ports.scope, worktree: fold(root) },
      );
      if (lexical.outcome === 'deny' && lexical.reason.code !== 'path-escape') {
        return deny(lexical.reason);
      }

      const contained = await contain(requested);
      return contained.outcome === 'inside'
        ? { outcome: 'allow', path: contained.path }
        : deny({ code: 'path-escape', detail: contained.route }, contained.resolved);
    },
  };
}

// ── what the rest of the daemon sees ─────────────────────────────────────────

/**
 * A mediated request the ladder refused.
 *
 * Carries the structured denial rather than a formatted sentence: the ACP
 * front turns it into a JSON-RPC error, the ledger turns it into a
 * `permission.denied` payload, and neither should have to parse a message to
 * do it.
 */
export class PermissionDeniedError extends Error {
  readonly denial: MediationDenial;

  constructor(denial: MediationDenial) {
    const { code, detail } = denial.reason;
    super(`${denial.method} denied: ${detail === undefined ? code : `${code}:${detail}`}`);
    this.name = 'PermissionDeniedError';
    this.denial = denial;
  }
}

export interface WorktreePathPolicyOptions {
  /**
   * Called once per denial, before it is thrown — where the
   * `permission.denied` event is appended. Absent means nothing is recorded,
   * which is honest for a spec and wrong for a run: a denial nobody can see
   * afterwards is indistinguishable from a request the agent never made.
   */
  readonly onDenied?: (denial: PathDenial) => void;
}

/** The `PathPolicy` ./fs-service.ts takes, backed by the mediator. */
export function worktreePathPolicy(
  mediator: PathMediator,
  options: WorktreePathPolicyOptions = {},
): PathPolicy {
  return {
    async resolve(operation, requested) {
      const method: PathMethod = operation === 'read' ? 'fs/read_text_file' : 'fs/write_text_file';
      const mediation = await mediator.mediate(method, requested);
      if (mediation.outcome === 'allow') return mediation.path;
      options.onDenied?.(mediation.denial);
      throw new PermissionDeniedError(mediation.denial);
    },
  };
}

/**
 * The `permission.denied` payload, in the shape @DeFlow/core's schema accepts.
 *
 * The agent's string is clamped rather than rejected: a denial that could not
 * be recorded because the attacker chose a 9 KiB filename would be a hole in
 * the audit trail, and the audit trail is most of the point.
 */
export function permissionDeniedPayload(
  denial: MediationDenial,
  node: { readonly node: NodeId; readonly attempt: number },
): {
  node: NodeId;
  attempt: number;
  permission: PermissionLevel;
  method: MediationDenial['method'];
  requested: string;
  reason: { code: string; detail?: string };
} {
  return {
    node: node.node,
    attempt: node.attempt,
    permission: denial.level,
    method: denial.method,
    requested: denial.requested.slice(0, REQUESTED_PATH_MAX),
    reason:
      denial.reason.detail === undefined
        ? { code: denial.reason.code }
        : { code: denial.reason.code, detail: denial.reason.detail },
  };
}
