/**
 * KAR-05.6 — the MCP transport choice, held in place by the repository rather
 * than by a paragraph in an architecture document.
 *
 * Three of the four `McpServer` arms are wrong for DeFlow and one of them is
 * wrong for a reason nobody would rediscover from the type: the elegant
 * "tunnel MCP over the existing ACP pipe" variant, `{ type: "acp", serverId }`,
 * is specified but implemented nowhere — **not one probed agent advertised
 * `mcpCapabilities.acp`**, and codex-acp returned an explicit `false`. The
 * probe evidence is the mock agent's capability matrix, which is the recorded
 * form of what the five real CLIs answered on 2026-08-02.
 *
 * The weight half is `checkMcpSdkImports`: the SDK drags in express, hono,
 * cors, jose and eventsource, so a root import turns a stdio-only server into
 * an HTTP stack that `npx deflowai up` loads on every start (NF6).
 *
 * Verifies: EPIC-05-S22 (scenarios 3 and 4) · AC4
 */
import { expect, it, describe as suite } from 'vitest';
import { checkMcpSdkImports, describe as render } from './support/guards.ts';
import { readSources, readText, repoTypeScriptFiles } from './support/workspace.ts';

const sources = readSources(repoTypeScriptFiles());

/** What the five real vendor CLIs answered when they were probed. The sixth
 * entry, `mock-full`, is a synthetic maximal profile and not a probed agent. */
const PROBED_AGENTS = ['claude', 'codex', 'opencode', 'copilot', 'gemini'] as const;

interface CapabilityProfile {
  readonly mcpCapabilities?: { readonly acp?: unknown; readonly sse?: unknown };
}

const matrix = JSON.parse(
  readText('packages/mock-agent/fixtures/capability-matrix.json'),
) as Record<string, CapabilityProfile>;

suite('the ACP tunnel variant is not built on (EPIC-05-S22 scenario 3)', () => {
  it('records that mcpCapabilities.acp was advertised true by zero probed agents', () => {
    const advertised = PROBED_AGENTS.filter(
      (agent) => matrix[agent]?.mcpCapabilities?.acp === true,
    );
    expect(advertised).toEqual([]);
  });

  it('has the one agent that answered the question at all answering "false"', () => {
    expect(matrix.codex?.mcpCapabilities?.acp).toBe(false);
  });

  it('names no tagged McpServer variant anywhere in the workspace', () => {
    const tagged = sources.filter((file) =>
      /type:\s*'(?:acp|http|sse)'[^\n]*serverId|serverId:\s*[^\n]*type:\s*'acp'/.test(file.text),
    );
    expect(tagged.map((file) => file.path)).toEqual([]);
  });
});

suite('the MCP SDK is reached through two deep subpaths (EPIC-05-S22 scenario 4, AC4)', () => {
  it('no file in the tree imports the package root or an unlisted subpath', () => {
    expect(render(checkMcpSdkImports(sources))).toBe('');
  });
});
