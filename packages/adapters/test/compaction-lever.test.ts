/**
 * KAR-09.6 AC7, AC8 — the compaction lever as the vendor's own environment,
 * and the conformance check that says the lever still behaves as decoded.
 *
 * The arithmetic lives in `@DeFlow/core`; what is asserted here is the half
 * that is a fact about a *vendor*: which variables express the lever, what the
 * two decoded constants are, and that a stream still carries the frames the
 * whole mechanism reads. `EPIC-09-S35`'s footgun is the reason the last suite
 * exists — a policy that assumes `autocompactPct: 95` extends a session is
 * designed against a lever that does not exist, because the CLI applies
 * `Math.min(pct × effectiveWindow, defaultThreshold)`.
 *
 * Verifies: EPIC-09-S35 · AC7, AC8 · test plan #8
 */
import {
  compactionLever,
  defaultAutoCompactThreshold,
  overriddenAutoCompactThreshold,
} from '@DeFlow/core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import {
  autoCompactConstants,
  checkCompactionShape,
  compactionEnv,
  parseShimLine,
  providerSpec,
  vendorTranscriptPath,
} from '../src/index.ts';

const claude = providerSpec('claude');
if (claude === undefined) throw new Error('the registry has no claude entry');

const TURN = { contextWindow: 200_000, maxOutputTokens: 32_000 } as const;

suite('AC7 — the lever reaches the CLI as its own environment variable', () => {
  it('sets the override for a write-capable node, at the resolved percentage', () => {
    const env = compactionEnv(claude, compactionLever({ permission: 'worktree' }));

    expect(env).toEqual({ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' });
  });

  it('carries a configured percentage through verbatim', () => {
    const env = compactionEnv(claude, compactionLever({ permission: 'full', autocompactPct: 55 }));

    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('55');
  });

  it('AC8 — a read node opting out sets the disable flag and no percentage', () => {
    const env = compactionEnv(
      claude,
      compactionLever({ permission: 'read', disableAutoCompact: true }),
    );

    expect(env).toEqual({ DISABLE_AUTO_COMPACT: '1' });
  });

  it('sets nothing at all for a read node that asked for nothing', () => {
    expect(compactionEnv(claude, compactionLever({ permission: 'read' }))).toEqual({});
  });

  it('sets nothing for a vendor with no such lever, rather than inventing one', () => {
    const gemini = providerSpec('gemini');
    if (gemini === undefined) throw new Error('the registry has no gemini entry');

    expect(compactionEnv(gemini, compactionLever({ permission: 'worktree' }))).toEqual({});
    expect(autoCompactConstants(gemini)).toBeNull();
  });
});

suite('EPIC-09-S35 — the override can only move compaction earlier', () => {
  const constants = autoCompactConstants(claude);
  if (constants === null) throw new Error('the claude entry declares no compaction constants');

  it('derives the documented threshold from the reported window', () => {
    expect(defaultAutoCompactThreshold(TURN, constants)).toBe(167_000);
  });

  it.each([
    [70, 126_000],
    [90, 162_000],
    [95, 167_000],
    [100, 167_000],
  ])('autocompactPct %i produces a threshold of %i', (pct, threshold) => {
    expect(overriddenAutoCompactThreshold(pct, TURN, constants)).toBe(threshold);
  });
});

suite('the conformance check over the frames the mechanism reads', () => {
  const lines = readFileSync(
    fileURLToPath(
      new URL('../../../test/fixtures/streams/compact-boundary.stream-json.jsonl', import.meta.url),
    ),
    'utf8',
  )
    .split('\n')
    .filter((text) => text.trim() !== '')
    .map((text) => parseShimLine(text))
    .filter((line) => line !== null);

  it('passes on a stream carrying the boundary frame and the window fields', () => {
    expect(checkCompactionShape(lines)).toEqual([]);
  });

  it('names the boundary frame when a stream no longer carries one', () => {
    const withoutBoundary = lines.filter((line) => line.raw.subtype !== 'compact_boundary');

    expect(checkCompactionShape(withoutBoundary).join(' ')).toContain('compact_boundary');
  });

  it('names the window fields when modelUsage stops reporting them', () => {
    const stripped = lines.map((line) => {
      if (line.type !== 'result') return line;
      const entry = { inputTokens: 84_210, outputTokens: 612 };
      const raw = { ...line.raw, modelUsage: { 'a-model': entry } };
      return { ...line, raw };
    });

    const problems = checkCompactionShape(stripped).join(' ');
    expect(problems).toContain('contextWindow');
    expect(problems).toContain('maxOutputTokens');
  });
});

suite('AC6 — where the vendor keeps the session transcript (§6.3, Unverified)', () => {
  it('builds the documented path from the worktree and the session id', () => {
    expect(
      vendorTranscriptPath(claude, {
        home: '/home/dev',
        project: '/home/dev/code/checkout',
        sessionId: '8f1b0a3c-2d4e-4f60-9a71-5c3e2b8d0f11',
      }),
    ).toBe(
      '/home/dev/.claude/projects/-home-dev-code-checkout/8f1b0a3c-2d4e-4f60-9a71-5c3e2b8d0f11.jsonl',
    );
  });

  it('answers null for a vendor that documents no transcript location', () => {
    const gemini = providerSpec('gemini');
    if (gemini === undefined) throw new Error('the registry has no gemini entry');

    expect(
      vendorTranscriptPath(gemini, { home: '/home/dev', project: '/p', sessionId: 's' }),
    ).toBeNull();
  });

  it('answers null rather than guessing when the session id is not one', () => {
    // A path assembled from an empty or path-shaped session id would read
    // somewhere else on disk entirely, and the caller treats "no file" as
    // normal — so a wrong path would be indistinguishable from an absent one.
    for (const sessionId of ['', '../../etc/passwd', 'a/b']) {
      expect(
        vendorTranscriptPath(claude, { home: '/home/dev', project: '/p', sessionId }),
      ).toBeNull();
    }
  });
});
