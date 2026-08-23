/**
 * Connector tool policy — what a spawned agent may touch on the operator's
 * connected systems (Linear, GitHub, Jira, …) without asking anybody.
 *
 * **The defect this exists to close.** On 2026-08-23 a framing turn called
 * `mcp__claude_ai_Linear__list_issues` — the right call for the task "find the
 * next available task on linear" — and the vendor's headless permission layer
 * auto-rejected it (`toolDenialKind: "user-rejected"`, no prompt ever shown,
 * because `-p` mode has nowhere to show one). The agent then recorded
 * *"Operator declined the Linear list_issues call"* in the spec's prior
 * decisions — the operator had declined nothing — fell back to a stale
 * repo-local file, and framed a story Linear had already marked Done that same
 * morning. The operator's instruction, verbatim in intent: connected systems
 * should be managed automatically as long as nothing destructive happens —
 * deleting issues, deleting repositories, force-pushing.
 *
 * **The rule forms are executed facts, not read ones.** Verified against
 * Claude Code 2.1.224 on 2026-08-23, each by spawning the binary headless with
 * an inline `--settings` document and watching the tool call land or die:
 *
 *  - `mcp__<server>__<tool>` (exact) allows the tool.
 *  - `mcp__<server>__list_*` (tool-segment glob) allows every match, and the
 *    glob matches anywhere in the segment (`*ist_team*` matched `list_teams`).
 *  - `mcp__<server>` (server-wide) allows every tool on that server.
 *  - `mcp__*` and `mcp__*__list_*` allow **nothing**: the server segment is
 *    matched literally, so a policy must name real servers, which is why
 *    {@link parseMcpListOutput} exists.
 *  - A `deny` rule beats an `allow` that covers the same call.
 *
 * **The shape of the policy.** At `read`, the agent gets the read verbs only —
 * framing and recon interrogate, they do not comment, label or file. At every
 * writing level the server is allowed whole and the destructive verbs are
 * denied by name, because the set of safe write verbs across vendors is
 * open-ended while the destructive vocabulary is small and stable. The deny
 * rows ride on **every** level, including `full`: `full` relaxes the sandbox
 * by explicit opt-in, not the connector policy, and a level that dropped the
 * denies would let "bypassPermissions" reach `delete_*` on the operator's
 * tracker.
 *
 * Only the vendor with a `--settings` document can express any of this today;
 * a vendor without one keeps its current behaviour (every connector call
 * denied), which is safe and loud rather than silently permissive.
 */
import type { PermissionLevel } from '@DeFlow/core';

/**
 * The verbs a read-level turn may call, matched as `mcp__<server>__<verb>*`.
 *
 * Prefix-anchored on purpose: an infix `*get*` would also match a tool that
 * merely contains the letters, and at read level the cost of a too-tight list
 * is a visible "unavailable by policy" — the recoverable direction — while a
 * too-loose one is a write nobody approved.
 */
export const CONNECTOR_READ_VERBS = [
  'list',
  'get',
  'search',
  'read',
  'fetch',
  'find',
  'query',
  'download',
  'describe',
  'check',
  'count',
  'status',
  'view',
  'show',
] as const;

/**
 * The verbs no spawned agent may ever call on a connector, at any level,
 * matched as `mcp__<server>__*<verb>*`.
 *
 * Infix-anchored on purpose — the opposite choice from the read verbs, for the
 * opposite reason: `notion-trash-page` and `trash_message` must both match,
 * and a destructive rule that missed a vendor's naming style fails in the
 * unrecoverable direction. These stay denied even where the server as a whole
 * is allowed, because a deny rule beats the allow that covers it (executed,
 * 2026-08-23).
 */
export const CONNECTOR_DESTRUCTIVE_VERBS = [
  'delete',
  'trash',
  'remove',
  'destroy',
  'drop',
  'purge',
  'force',
] as const;

/**
 * `claude mcp list` prints a server's *display* name (`claude.ai Linear`);
 * tool names carry the same name with every non-alphanumeric run collapsed to
 * `_` (`mcp__claude_ai_Linear__list_issues`). This is that mapping, verified
 * against the one server both forms were observed on (2026-08-23).
 */
export function mcpServerToolPrefix(displayName: string): string {
  return displayName.trim().replace(/[^A-Za-z0-9]+/g, '_');
}

/**
 * The server display names out of `claude mcp list`'s human output — there is
 * no `--json` (checked `--help`, 2.1.224). Lines look like:
 *
 *     claude.ai Linear: https://mcp.linear.app/mcp - ✔ Connected
 *
 * The name is everything before the first `: `, kept only when the line's tail
 * carries the connected check — a `⏸ Pending approval` server has no tools to
 * allow, and a failed one gets nothing either. Banner lines ("Checking MCP
 * server health…") carry no ` - ` separator and fall out on their own.
 */
export function parseMcpListOutput(stdout: string): readonly string[] {
  const servers: string[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^(.+?): .+ - (.+)$/.exec(line.trim());
    if (match === null) continue;
    const [, name, status] = match as unknown as [string, string, string];
    if (!status.includes('Connected')) continue;
    servers.push(name);
  }
  return servers;
}

/** The two rule lists a `--settings` document's `permissions` key carries. */
export interface ConnectorPermissionRules {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

/**
 * The connector rules for one turn: what its permission level allows on the
 * servers this machine actually has, and what no level allows.
 *
 * No servers means no rules — an empty document, not a guessed one. The deny
 * rows are emitted per named server rather than as `mcp__*__*delete*` because
 * the global server glob is one of the forms verified **not** to match.
 */
export function connectorPermissionRules(
  level: PermissionLevel,
  servers: readonly string[],
): ConnectorPermissionRules {
  const prefixes = servers.map(mcpServerToolPrefix).filter((prefix) => prefix !== '');
  const deny = prefixes.flatMap((server) =>
    CONNECTOR_DESTRUCTIVE_VERBS.map((verb) => `mcp__${server}__*${verb}*`),
  );
  const allow =
    level === 'read'
      ? prefixes.flatMap((server) => CONNECTOR_READ_VERBS.map((verb) => `mcp__${server}__${verb}*`))
      : prefixes.map((server) => `mcp__${server}`);
  return { allow, deny };
}

/**
 * The `--settings` argument pair a **pre-execution** turn appends for its
 * connector rules, or nothing.
 *
 * Pre-execution turns (framing, recon, planner) do not go through
 * `sandboxedShimPlan` — they run at `read`, where there is no sandbox to
 * apply — so the execution path's settings document never reaches them, and
 * without this they keep the exact failure this module exists to close. The
 * invariant both paths share: **one settings flag per invocation.** Here the
 * document carries only `permissions`; on the execution path
 * `claudeSandboxPolicy` merges the same rules into its own document, and no
 * invocation ever carries both.
 *
 * Empty for a vendor with no settings mechanism (nothing is expressible — the
 * calls stay denied, loudly) and for an empty server list (nothing to say).
 */
export function connectorSettingsArgument(
  spec: { readonly shim: { readonly sandbox?: { readonly flag: string } } },
  level: PermissionLevel,
  servers: readonly string[],
): readonly string[] {
  const flag = spec.shim.sandbox?.flag;
  if (flag === undefined || servers.length === 0) return [];
  const rules = connectorPermissionRules(level, servers);
  if (rules.allow.length === 0 && rules.deny.length === 0) return [];
  return [flag, JSON.stringify({ permissions: rules })];
}
