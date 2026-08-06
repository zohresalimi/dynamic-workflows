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
 * their `path-escape:<route>` details. Nor is the full syntactic set here —
 * KAR-08.3 owns `git push --force`, the `rm -r` depth rule, the non-localhost
 * database host and the scrubbed-variable check, and extends the small table
 * below in place.
 *
 * Verifies: EPIC-08-S1, EPIC-08-S2 · AC1, AC2, AC3
 */
import type { PermissionLevel } from './plan-graph.ts';

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
 */
export const PERMISSION_GATE_CODES = [
  'not-allowlisted',
  'domain-not-allowlisted',
  'destructive-command',
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
}

// ── paths ────────────────────────────────────────────────────────────────────

/**
 * POSIX `path.resolve` semantics, without `node:path` — core imports no
 * builtin (R1), and the containment rule is four lines of string handling.
 *
 * Windows is M3; the ACP fs methods carry POSIX-shaped absolute paths on the
 * two platforms M1 supports.
 */
function resolvePosix(base: string, path: string): string {
  const raw = path.startsWith('/') ? path : `${base}/${path}`;
  const out: string[] = [];
  for (const part of raw.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join('/')}`;
}

/**
 * Whether `path` is the worktree root or something beneath it, lexically.
 *
 * Segment-wise rather than by string prefix, so `<tmp>/wt-other` is not inside
 * `<tmp>/wt`. **Lexical only** — see the module note: a symlink inside the
 * worktree pointing at `/etc` satisfies this predicate, and KAR-08.2 is what
 * closes that by feeding it a `realpath`-resolved path.
 */
export function pathIsInside(root: string, path: string): boolean {
  const base = resolvePosix('/', root);
  const target = resolvePosix(base, path);
  return target === base || target.startsWith(base === '/' ? '/' : `${base}/`);
}

/** ACP's fs methods carry absolute paths. A relative one is not a path this
 * layer can reason about — notably `~/.aws/credentials`, which is a *shell*
 * construct and would otherwise resolve to a directory named `~` inside the
 * worktree and be allowed. */
function containment(root: string, path: string): PermissionReason<'path-escape'> | null {
  if (!path.startsWith('/')) return { code: 'path-escape', detail: 'not-absolute' };
  return pathIsInside(root, path) ? null : { code: 'path-escape' };
}

// ── commands ─────────────────────────────────────────────────────────────────

/**
 * The binary the operator would recognise: `./node_modules/.bin/vitest` is
 * `vitest`. Allowlist matching is on this and never on the raw string, or the
 * repository's own tooling gates on every invocation and the gate budget
 * (§10.5) is blown by the second node.
 */
export function binaryName(command: string): string {
  const at = command.lastIndexOf('/');
  return at === -1 ? command : command.slice(at + 1);
}

function matchesReadOnly(line: readonly string[], entries: readonly string[]): boolean {
  return entries.some((entry) => {
    const tokens = entry.split(' ').filter((token) => token !== '');
    if (tokens.length === 0) return false;
    return tokens.every((token, index) => line[index] === token);
  });
}

/**
 * The cheap syntactic second layer, as far as KAR-08.1 needs it.
 *
 * Deliberately **not** static analysis of shell strings — that is undecidable
 * and gives false confidence (§10.4). These are identity- and
 * infrastructure-boundary binaries: the operations where §10.5 says a human
 * gate belongs, whatever the level. A `null` `subcommands` gates every
 * invocation of the binary.
 *
 * KAR-08.3 extends this table with `git push --force`, the `rm -r` depth rule,
 * the non-localhost database host, `prisma migrate deploy`, `drizzle-kit push`
 * and `flyway migrate`, plus the `scrubbed-env:<VAR>` check.
 */
export const DESTRUCTIVE_COMMANDS: readonly {
  readonly binary: string;
  readonly subcommands: readonly string[] | null;
}[] = [
  { binary: 'terraform', subcommands: ['apply', 'destroy'] },
  { binary: 'kubectl', subcommands: ['delete', 'apply'] },
  { binary: 'aws', subcommands: null },
  { binary: 'gcloud', subcommands: null },
  { binary: 'az', subcommands: null },
];

function destructive(
  binary: string,
  args: readonly string[],
): PermissionReason<'destructive-command'> | null {
  for (const check of DESTRUCTIVE_COMMANDS) {
    if (check.binary !== binary) continue;
    if (check.subcommands === null) return { code: 'destructive-command', detail: binary };
    const subcommand = args.find((arg) => !arg.startsWith('-'));
    if (subcommand !== undefined && check.subcommands.includes(subcommand)) {
      return { code: 'destructive-command', detail: `${binary}-${subcommand}` };
    }
  }
  return null;
}

// ── network ──────────────────────────────────────────────────────────────────

const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i;

/** The host of a URL-shaped string, lowercased, port and userinfo removed, or
 * `null` when the string is not URL-shaped. Hand-rolled rather than `new URL`
 * because this must be total: an agent-supplied string that throws is a crash
 * on the safety path. */
export function hostOf(value: string): string | null {
  const match = URL_LIKE.exec(value);
  if (match === null) return null;
  const authority = (match[1] ?? '').slice((match[1] ?? '').lastIndexOf('@') + 1);
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');
    return (end === -1 ? authority : authority.slice(0, end + 1)).toLowerCase();
  }
  const colon = authority.indexOf(':');
  return (colon === -1 ? authority : authority.slice(0, colon)).toLowerCase();
}

/** §10.5's rule is "reaches a **non-localhost** host". A dev server on
 * 127.0.0.1 is inside the boundary, and gating it would be exactly the run
 * with 200 gates that the frequency argument forbids. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0', '[::]']);

function isLoopback(host: string): boolean {
  return LOOPBACK.has(host) || host.endsWith('.localhost');
}

function domainAllowed(host: string, allowed: readonly string[]): boolean {
  return allowed.some((domain) => {
    const entry = domain.toLowerCase();
    return host === entry || host.endsWith(`.${entry}`);
  });
}

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

  const boundary = destructive(binary, args);
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
