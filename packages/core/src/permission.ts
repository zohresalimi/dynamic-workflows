/**
 * KAR-08.1 — the F5.4 permission ladder as one pure function
 * (docs/09-workspace-and-safety.md §8).
 *
 * DeFlow is the ACP *client*, so it implements `fs/read_text_file`,
 * `fs/write_text_file`, `terminal/create` and the rest of `CLIENT_METHODS`
 * itself. It therefore sits in the path of every file access and every command
 * execution, **for every vendor**. That collapses the ladder from an
 * N-vendors × M-levels flag-mapping matrix — the PRD's own G7 adapter-churn gap
 * reintroduced inside the safety layer — into the table below, which is a fast
 * unit test with no vendor CLI installed at all.
 *
 * | Level          | `fs/write_text_file` | `terminal/create`  | Network                |
 * | -------------- | -------------------- | ------------------ | ---------------------- |
 * | `read`         | reject all           | read-only subset   | deny                   |
 * | `worktree`     | inside the worktree  | allowlist          | deny                   |
 * | `worktree+net` | inside the worktree  | allowlist          | domain allowlist       |
 * | `full`         | inside the worktree  | allow              | allow                  |
 *
 * Four decisions in here are load-bearing and none of them is obvious from the
 * table alone.
 *
 * **The level decides before the path does.** A `read` node's write is denied
 * `level-read` even for a path inside its own worktree. Implementing `read` as
 * "worktree minus network" gives the same *verdict* for a path outside and the
 * wrong one for a path inside, and it makes the reason code a function of
 * which path the agent happened to try rather than of the level — so the node
 * inspector renders something different every time.
 *
 * **`full` is "allow within the worktree", not "allow anything".** It relaxes
 * the command and the network rows; the worktree containment on `fs/*` stays.
 * The run-level opt-in (./full-permission.ts) is what the operator consented
 * to, and they did not consent to a write into `/etc`.
 *
 * **The syntactic checks run before the network row, and apply at every
 * level.** `worktree` + `curl https://example.com` is a *deny*
 * (`level-no-network`) while `worktree` + `psql postgres://db.prod/main` is a
 * *gate*: both are egress at the same level, and the only reading that
 * satisfies both is that identity- and infrastructure-boundary operations are
 * orthogonal to the ladder. §10.5 puts human gates exactly there. That is also
 * why `full` still gates `terraform destroy`: `full` means "the provider
 * allows it", not "DeFlow stops looking".
 *
 * **A reason is a code plus an optional detail, never a sentence.** The node
 * inspector renders `path-escape` differently from `not-allowlisted`, and the
 * gate budget in KAR-08.3 counts by code. A prose blob makes both impossible.
 *
 * What is deliberately *not* here, because it needs a filesystem and this file
 * has none: `realpath()`. The containment check below is lexical, which
 * catches `..` traversal and absolute paths but **not** a symlink pointing out
 * of the worktree. KAR-08.2 resolves the deepest existing ancestor and applies
 * *this* predicate to the result; that story owns the four escape routes and
 * their `path-escape:<route>` details. Nor is the syntactic set here —
 * KAR-08.3 owns it, in ./destructive-command.ts, and this file calls it at the
 * one point in the ordering where it belongs.
 *
 * Verifies: EPIC-08-S1, EPIC-08-S2 · AC1, AC2, AC3
 */
import { type CommandContext, destructiveCommand } from './destructive-command.ts';
import type { PermissionLevel } from './plan-graph.ts';
import { binaryName, domainAllowed, hostOf, isLoopback, pathIsInside } from './scope.ts';

/** AC2 — exactly three, and the union below has no fourth arm. */
export const PERMISSION_OUTCOMES = ['allow', 'deny', 'gate'] as const;

export type PermissionOutcomeKind = (typeof PERMISSION_OUTCOMES)[number];

/**
 * Why a request was refused outright.
 *
 * - `level-read` — the level itself said no, before any path or command was
 *   examined.
 * - `level-no-network` — egress below `worktree+net`. The domain allowlist is
 *   not consulted, because it does not apply at that level.
 * - `path-escape` — the path resolves outside the node's worktree. The detail
 *   names the route (`cwd`, `not-absolute`, and KAR-08.2's `traversal`,
 *   `symlink`, `absolute`).
 */
export const PERMISSION_DENY_CODES = ['level-read', 'level-no-network', 'path-escape'] as const;

export type PermissionDenyCode = (typeof PERMISSION_DENY_CODES)[number];

/**
 * Why a request needs a human.
 *
 * - `not-allowlisted` — default-deny at `terminal/create`; the detail is the
 *   resolved binary name, which is what the operator is being asked about.
 * - `domain-not-allowlisted` — egress at `worktree+net` to a host outside the
 *   domain allowlist; the detail is the host.
 * - `destructive-command` — the cheap syntactic second layer (§10.4): an
 *   identity- or infrastructure-boundary operation, gated regardless of level.
 *   The detail names the rule that fired (`git-push-force`, `terraform-apply`).
 * - `scrubbed-env` — the command references a variable KAR-08.4 removed from
 *   the child environment; the detail is the variable name. It cannot work, so
 *   the operator is asked rather than shown a confusing failure.
 */
export const PERMISSION_GATE_CODES = [
  'not-allowlisted',
  'domain-not-allowlisted',
  'destructive-command',
  'scrubbed-env',
] as const;

export type PermissionGateCode = (typeof PERMISSION_GATE_CODES)[number];

export interface PermissionReason<Code extends string = PermissionDenyCode | PermissionGateCode> {
  readonly code: Code;
  /** The specific route, binary or host. Absent when the code says it all. */
  readonly detail?: string;
}

/** The renderable form: `path-escape` or `path-escape:symlink`. Reason codes
 * travel into ledger payloads and onto the wire this way, so the structured
 * pair stays the record and this stays a projection of it. */
export function reasonCode(reason: PermissionReason): string {
  return reason.detail === undefined ? reason.code : `${reason.code}:${reason.detail}`;
}

export type PermissionAnswer =
  | { readonly outcome: 'allow' }
  | { readonly outcome: 'deny'; readonly reason: PermissionReason<PermissionDenyCode> }
  | { readonly outcome: 'gate'; readonly reason: PermissionReason<PermissionGateCode> };

/**
 * What the agent is asking to do, in the vocabulary of the ACP methods DeFlow
 * mediates.
 *
 * `network` is its own member rather than a property of a command because the
 * ladder has a network *row*: egress is denied at `worktree` whoever attempts
 * it and however they spell it, and modelling it as a flag on `terminal/create`
 * would leave `fetch`-kind tool calls with nowhere to be decided.
 */
export type PermissionRequest =
  | { readonly method: 'fs/write_text_file'; readonly path: string }
  | { readonly method: 'fs/read_text_file'; readonly path: string }
  | {
      readonly method: 'terminal/create';
      readonly command: string;
      readonly args?: readonly string[];
      /** ACP defaults it to the session's `cwd`, which is the worktree. */
      readonly cwd?: string;
    }
  | { readonly method: 'network'; readonly url: string };

export type PermissionMethod = PermissionRequest['method'];

/**
 * The node's own boundary: everything the ladder compares a request against.
 *
 * Sourced per repository from `DeFlow.config.ts` (§10.3) and per node from the
 * plan, and passed in rather than read, because a policy function that reads
 * configuration is a policy function that cannot be tabulated.
 */
export interface PermissionScope {
  /** The worktree root, absolute. EPIC-07 owns creating it. */
  readonly worktree: string;
  /** The repository's own verbs, matched on the resolved binary name. */
  readonly allowlist: readonly string[];
  /** The subset a `read`-level node may run. Entries may be multi-word
   * (`git status`), matched as a prefix of the command line. */
  readonly readOnlyCommands: readonly string[];
  /** Consulted only at `worktree+net`. A bare domain matches itself and any
   * subdomain of it. */
  readonly allowedDomains: readonly string[];
  /**
   * The variable names KAR-08.4 removed from the child environment, so a
   * command that needs one can be gated with `scrubbed-env:<VARNAME>` instead
   * of running and failing confusingly (AC5).
   *
   * Empty means nothing was removed — which is the truth at `full`, and the
   * truth for a node whose level asked for no scrubbing — not "the check is
   * off". Stated rather than defaulted: this is a safety boundary, and a scope
   * that silently omits half of one is how a check stops being applied without
   * anybody deciding to stop applying it.
   */
  readonly scrubbedEnv: readonly string[];
}

/**
 * `DeFlow.config.ts`'s `commands` block (§10.3) — the repository's own verbs.
 *
 * The two optional members are optional because most repositories have nothing
 * to say about them, and their absent value is the *closed* one: no read-only
 * subset and no reachable domain.
 */
export interface CommandsConfig {
  /** The project's actual verbs: `git`, `pnpm`, `pytest`, `cargo`, … */
  readonly allow: readonly string[];
  /** The subset a `read`-level node may run. Entries may be multi-word. */
  readonly readOnly?: readonly string[];
  /** Domains reachable at `worktree+net`. */
  readonly allowDomains?: readonly string[];
}

/**
 * KAR-08.4 AC6/EPIC-08-S19 scenario 3 — a node may declare a scrubbed
 * environment variable only if it can execute at all.
 *
 * `read` never runs a command (§8's table), so a `read` node declaring
 * `NPM_TOKEN` cannot mean anything: nothing at `read` will ever spend it.
 * Refusing it here, at plan-validation time, is what turns a silently-ignored
 * declaration into a rejected plan the operator can fix before the run
 * starts, rather than a token quietly never reaching the one command that
 * needed it.
 *
 * Pure and total, like the rest of this file: no plan schema depends on it
 * yet (declared-env is not a `PlanGraph` field at M1), but the check is ready
 * to be called from wherever that validation lands.
 */
export class EnvDeclarationAtReadLevelError extends Error {
  /** The declared variable names, verbatim — never a value. */
  readonly declared: readonly string[];

  constructor(declared: readonly string[]) {
    super(
      `a node at level "read" cannot declare env vars (declared: ${declared.join(', ')}); ` +
        'read-level nodes never run a command that could spend one',
    );
    this.name = 'EnvDeclarationAtReadLevelError';
    this.declared = declared;
  }
}

export function validateEnvDeclaration(level: PermissionLevel, declared: readonly string[]): void {
  if (level === 'read' && declared.length > 0) {
    throw new EnvDeclarationAtReadLevelError(declared);
  }
}

/** The node's boundary, assembled from the repository's config and the two
 * things only the run knows: where its worktree is, and what was scrubbed. */
export function permissionScopeFrom(
  commands: CommandsConfig,
  node: { readonly worktree: string; readonly scrubbedEnv: readonly string[] },
): PermissionScope {
  return {
    worktree: node.worktree,
    allowlist: commands.allow,
    readOnlyCommands: commands.readOnly ?? [],
    allowedDomains: commands.allowDomains ?? [],
    scrubbedEnv: node.scrubbedEnv,
  };
}

// ── paths ────────────────────────────────────────────────────────────────────

/** ACP's fs methods carry absolute paths. A relative one is not a path this
 * layer can reason about — notably `~/.aws/credentials`, which is a *shell*
 * construct and would otherwise resolve to a directory named `~` inside the
 * worktree and be allowed. */
function containment(root: string, path: string): PermissionReason<'path-escape'> | null {
  if (!path.startsWith('/')) return { code: 'path-escape', detail: 'not-absolute' };
  return pathIsInside(root, path) ? null : { code: 'path-escape' };
}

// ── commands ─────────────────────────────────────────────────────────────────

function matchesReadOnly(line: readonly string[], entries: readonly string[]): boolean {
  return entries.some((entry) => {
    const tokens = entry.split(' ').filter((token) => token !== '');
    if (tokens.length === 0) return false;
    return tokens.every((token, index) => line[index] === token);
  });
}

// ── network ──────────────────────────────────────────────────────────────────

/** The network row, shared by the `network` method and by a `terminal/create`
 * whose argv names a remote host. */
function networkRow(
  level: PermissionLevel,
  host: string,
  scope: PermissionScope,
): PermissionAnswer {
  if (isLoopback(host)) return { outcome: 'allow' };
  if (level === 'full') return { outcome: 'allow' };
  if (level !== 'worktree+net') return { outcome: 'deny', reason: { code: 'level-no-network' } };
  if (domainAllowed(host, scope.allowedDomains)) return { outcome: 'allow' };
  return { outcome: 'gate', reason: { code: 'domain-not-allowlisted', detail: host } };
}

// ── the ladder ───────────────────────────────────────────────────────────────

const ALLOW: PermissionAnswer = { outcome: 'allow' };

function decideFs(
  level: PermissionLevel,
  method: 'fs/read_text_file' | 'fs/write_text_file',
  path: string,
  scope: PermissionScope,
): PermissionAnswer {
  // The level decides before the path does, and only for writes: `read` level
  // reads inside the worktree are the entire point of the level.
  if (method === 'fs/write_text_file' && level === 'read') {
    return { outcome: 'deny', reason: { code: 'level-read' } };
  }
  const escape = containment(scope.worktree, path);
  return escape === null ? ALLOW : { outcome: 'deny', reason: escape };
}

function decideTerminal(
  level: PermissionLevel,
  request: Extract<PermissionRequest, { method: 'terminal/create' }>,
  scope: PermissionScope,
): PermissionAnswer {
  const binary = binaryName(request.command);
  const args = request.args ?? [];

  if (level === 'read' && !matchesReadOnly([binary, ...args], scope.readOnlyCommands)) {
    return { outcome: 'deny', reason: { code: 'level-read' } };
  }

  // §10.4's second layer, orthogonal to the ladder: an identity- or
  // infrastructure-boundary operation is a question at every level, `full`
  // included — `full` means "the provider allows it", not "DeFlow stops
  // looking". Relative arguments resolve against where the command would
  // actually run, which is the worktree unless the agent named another cwd.
  const context: CommandContext = {
    worktree: scope.worktree,
    cwd: request.cwd ?? scope.worktree,
    scrubbedEnv: scope.scrubbedEnv,
  };
  const boundary = destructiveCommand(request.command, args, context);
  if (boundary !== null) return { outcome: 'gate', reason: boundary };

  // An allowlisted `git` with a cwd outside the worktree is a full escape with
  // no exotic syntax at all, and the command and args get all the attention.
  if (level !== 'full' && request.cwd !== undefined) {
    const escape = containment(scope.worktree, request.cwd);
    if (escape !== null) {
      return { outcome: 'deny', reason: { code: 'path-escape', detail: escape.detail ?? 'cwd' } };
    }
  }

  // A command whose argv names a remote host **is** an egress request, so the
  // network row is its decision and the binary allowlist is not consulted:
  // EPIC-08-S2 has `worktree+net` + `curl https://registry.npmjs.org` as an
  // allow, and `curl` is not one of the repository's own verbs. At
  // `worktree+net` the granted capability is network access and the domain
  // allowlist is its gate. A loopback host is not egress at all, so it falls
  // through to the allowlist like any other local command.
  const remote = args.map(hostOf).find((host) => host !== null && !isLoopback(host));
  if (remote !== undefined && remote !== null) return networkRow(level, remote, scope);

  if (level === 'full') return ALLOW;
  if (scope.allowlist.includes(binary)) return ALLOW;
  return { outcome: 'gate', reason: { code: 'not-allowlisted', detail: binary } };
}

/**
 * The whole safety model, as one total function of `(level, request, scope)`.
 *
 * Pure: no clock, no filesystem, no configuration read, no exception. Every
 * input is a value and every answer is one of three shapes, which is what
 * makes the ladder a table in a test file rather than a matrix of vendor flags
 * that decays with every CLI release.
 */
export function decidePermission(
  level: PermissionLevel,
  request: PermissionRequest,
  scope: PermissionScope,
): PermissionAnswer {
  if (request.method === 'fs/read_text_file' || request.method === 'fs/write_text_file') {
    return decideFs(level, request.method, request.path, scope);
  }
  if (request.method === 'terminal/create') return decideTerminal(level, request, scope);
  // The remaining arm, narrowed structurally: adding a method to the union
  // makes this line a type error rather than a silent allow.
  return networkRow(level, hostOf(request.url) ?? '', scope);
}

// ── what DeFlow offers back ──────────────────────────────────────────────────

/**
 * ACP's `PermissionOptionKind`, **verified 2026-08-02** from the shipped type
 * definitions of `@agentclientprotocol/sdk@1.3.0`. AC8 holds the outgoing
 * frame against the vendored `schema/schema.json` with ajv, so this list
 * cannot drift from the SDK without a test saying so.
 */
export const PERMISSION_OPTION_KINDS = [
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
] as const;

export type PermissionOptionKind = (typeof PERMISSION_OPTION_KINDS)[number];

export interface OfferedPermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: PermissionOptionKind;
}

/**
 * The four options DeFlow offers on a `session/request_permission`.
 *
 * `optionId` is the kind, deliberately: the agent echoes the id back and the
 * ledger records it, and an opaque id would make both unreadable for no gain.
 */
export const OFFERED_PERMISSION_OPTIONS: readonly OfferedPermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow_always', name: 'Allow for this run', kind: 'allow_always' },
  { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
  { optionId: 'reject_always', name: 'Reject for this run', kind: 'reject_always' },
];

/**
 * The option id to answer with, given what the ladder said and what the agent
 * offered.
 *
 * The agent's own option list is authoritative — an agent that offers only
 * `allow_once` and `reject_always` must be answered with one of those two —
 * so the kind is what is looked up and the id travels back verbatim. `null`
 * means the agent offered nothing of the required polarity, which is the
 * caller's cue to cancel rather than to guess.
 */
export function optionIdFor(
  outcome: PermissionOutcomeKind,
  options: readonly { readonly optionId: string; readonly kind: string }[],
): string | null {
  const wanted: readonly string[] =
    outcome === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  for (const kind of wanted) {
    const option = options.find((candidate) => candidate.kind === kind);
    if (option !== undefined) return option.optionId;
  }
  return null;
}
