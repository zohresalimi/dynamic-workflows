/**
 * The connector tool policy: the rule shapes are the executed facts of
 * 2026-08-23 (see connector-policy.ts's header), and these tests pin the
 * *derivation* — which rules a level gets for which servers — so a verb list
 * edited carelessly shows up as a readable diff here rather than as a spawned
 * agent silently gaining `delete_*` on the operator's tracker.
 */
import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_DESTRUCTIVE_VERBS,
  CONNECTOR_READ_VERBS,
  connectorPermissionRules,
  connectorSettingsArgument,
  mcpServerToolPrefix,
  parseMcpListOutput,
} from './connector-policy.ts';

describe('mcpServerToolPrefix', () => {
  it('collapses every non-alphanumeric run to one underscore, as the vendor does', () => {
    // The one server both forms were observed on: display "acme.example Tracker",
    // tools "mcp__acme_example_Tracker__…".
    expect(mcpServerToolPrefix('acme.example Tracker')).toBe('acme_example_Tracker');
  });

  it('trims before mapping, so a padded line cannot mint a leading underscore', () => {
    expect(mcpServerToolPrefix('  acme.example Tracker  ')).toBe('acme_example_Tracker');
  });
});

describe('parseMcpListOutput', () => {
  const OUTPUT = [
    'Checking MCP server health…',
    '',
    'acme.example Tracker: https://mcp.linear.app/mcp - ✔ Connected',
    'acme.example Code: https://mcp.example.com/mcp - ✔ Connected',
    'team-jira: https://jira.example.com/mcp - ✘ Failed to connect',
    'scratch: /tmp/x.mjs - ⏸ Pending approval',
  ].join('\n');

  it('keeps only connected servers and drops the banner', () => {
    expect(parseMcpListOutput(OUTPUT)).toEqual(['acme.example Tracker', 'acme.example Code']);
  });

  it('answers empty for empty or bannerless-garbage output', () => {
    expect(parseMcpListOutput('')).toEqual([]);
    expect(parseMcpListOutput('No MCP servers configured.')).toEqual([]);
  });
});

describe('connectorPermissionRules', () => {
  const SERVERS = ['acme.example Tracker'];

  it('read level allows the read verbs only, prefix-anchored per server', () => {
    const rules = connectorPermissionRules('read', SERVERS);
    expect(rules.allow).toEqual(
      CONNECTOR_READ_VERBS.map((verb) => `mcp__acme_example_Tracker__${verb}*`),
    );
    // Never the whole server at read: framing and recon interrogate, they do
    // not comment, label or file.
    expect(rules.allow).not.toContain('mcp__acme_example_Tracker');
  });

  it('every writing level allows the server whole', () => {
    for (const level of ['worktree', 'worktree+net', 'full'] as const) {
      expect(connectorPermissionRules(level, SERVERS).allow).toEqual(['mcp__acme_example_Tracker']);
    }
  });

  it('denies the destructive verbs infix-anchored at every level, read included', () => {
    for (const level of ['read', 'worktree', 'worktree+net', 'full'] as const) {
      expect(connectorPermissionRules(level, SERVERS).deny).toEqual(
        CONNECTOR_DESTRUCTIVE_VERBS.map((verb) => `mcp__acme_example_Tracker__*${verb}*`),
      );
    }
  });

  it('no servers means no rules — an empty document, not a guessed one', () => {
    expect(connectorPermissionRules('read', [])).toEqual({ allow: [], deny: [] });
    expect(connectorPermissionRules('read', ['   '])).toEqual({ allow: [], deny: [] });
  });
});

describe('connectorSettingsArgument', () => {
  const SETTINGS_CAPABLE = { shim: { sandbox: { flag: '--settings' } } };
  const NO_SETTINGS = { shim: {} };

  it('emits one flag and one JSON document carrying only permissions', () => {
    const argument = connectorSettingsArgument(SETTINGS_CAPABLE, 'read', ['acme.example Tracker']);
    expect(argument[0]).toBe('--settings');
    const document = JSON.parse(argument[1] as string) as Record<string, unknown>;
    expect(Object.keys(document)).toEqual(['permissions']);
    expect(document.permissions).toEqual(
      connectorPermissionRules('read', ['acme.example Tracker']),
    );
  });

  it('emits nothing for a vendor with no settings mechanism', () => {
    expect(connectorSettingsArgument(NO_SETTINGS, 'read', ['acme.example Tracker'])).toEqual([]);
  });

  it('emits nothing for an empty server list', () => {
    expect(connectorSettingsArgument(SETTINGS_CAPABLE, 'read', [])).toEqual([]);
  });
});
