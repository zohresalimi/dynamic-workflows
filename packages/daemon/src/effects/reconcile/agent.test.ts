/**
 * KAR-06.4 — the `agent` probe, driven by the measured capability matrix
 * rather than by an assumption (docs/05-durable-execution.md §8.3).
 *
 * The Scenario Outline of EPIC-06-S12 is worth writing precisely because the
 * five adapters do **not** agree: `claude-agent-acp@0.64.1`, `codex-acp@1.1.9`
 * and `opencode acp@1.18.11` advertise `session.resume`; `copilot --acp@1.0.77`
 * and `gemini --acp@0.53.1` do not (Verified 2026-08-02). Two of five cannot
 * resume at all, and a probe that assumed `supportsResume` was uniform would
 * be wrong for 40% of the matrix — not by crashing, but by resuming a session
 * the agent has no idea about.
 *
 * The rows come from `@DeFlow/mock-agent`'s capability fixture, which is the
 * verbatim `initialize` response each real binary returned. Reading them here
 * turns the whole matrix into a 40 ms unit test instead of five integration
 * tests that need five installed, authenticated vendor CLIs.
 *
 * Verifies: EPIC-06-S12 (agent rows) · AC3
 */
import type { CapabilityRow } from '@DeFlow/adapters';
import { ProviderIdSchema } from '@DeFlow/core';
import { CAPABILITY_PROFILES } from '@DeFlow/mock-agent';
import { expect, it, describe as suite } from 'vitest';
import { reconcileAgent } from './agent.ts';

const rowFor = (profile: keyof typeof CAPABILITY_PROFILES): CapabilityRow => ({
  provider: ProviderIdSchema.parse(profile === 'mock-full' ? 'mock' : profile),
  version: '0.0.0',
  binarySha256: 'a'.repeat(64),
  binaryPath: '/opt/bin/agent',
  capsJson: JSON.stringify({
    protocolVersion: 1,
    agentCapabilities: CAPABILITY_PROFILES[profile],
    authMethods: [],
  }),
  probedAt: 1_754_313_093_000,
});

const SESSION = 'sess_5c1d2e';

suite('a completed turn needs no probing at all', () => {
  it('is done, with nothing to resume', () => {
    expect(
      reconcileAgent({
        turn: 'complete',
        sessionId: SESSION,
        capabilities: rowFor('claude'),
      }),
    ).toEqual({ verdict: 'done', strategy: 'none', sessionId: SESSION });
  });
});

suite('the five-adapter matrix decides the strategy (EPIC-06-S12, AC3)', () => {
  const resumeCapable = ['claude', 'codex', 'opencode', 'mock-full'] as const;
  const replayOnly = ['copilot', 'gemini'] as const;

  for (const profile of resumeCapable) {
    it(`${profile}: a journalled session id is out there and reusable ⇒ done + ResumeNative`, () => {
      expect(
        reconcileAgent({
          turn: 'incomplete',
          sessionId: SESSION,
          capabilities: rowFor(profile),
        }),
      ).toEqual({ verdict: 'done', strategy: 'ResumeNative', sessionId: SESSION });
    });
  }

  for (const profile of replayOnly) {
    it(`${profile}: the session out there cannot be re-entered ⇒ not-started + ResumeByReplay`, () => {
      expect(
        reconcileAgent({
          turn: 'incomplete',
          sessionId: SESSION,
          capabilities: rowFor(profile),
        }),
      ).toEqual({ verdict: 'not-started', strategy: 'ResumeByReplay', sessionId: SESSION });
    });
  }
});

suite('no journalled session id means a clean restart is safe (EPIC-06-S12)', () => {
  it('is not-started and replays, even on a resume-capable adapter', () => {
    expect(
      reconcileAgent({
        turn: 'incomplete',
        sessionId: null,
        capabilities: rowFor('claude'),
      }),
    ).toEqual({ verdict: 'not-started', strategy: 'ResumeByReplay', sessionId: null });
  });

  it('is not-started when nothing was ever probed: "advertised nothing" is not "can resume"', () => {
    expect(reconcileAgent({ turn: 'incomplete', sessionId: SESSION, capabilities: null })).toEqual({
      verdict: 'not-started',
      strategy: 'ResumeByReplay',
      sessionId: SESSION,
    });
  });

  it('honours a node that insists on replay even where the adapter could resume', () => {
    // `always-replay` can only ever narrow: the ledger is the durability
    // mechanism and replaying it is always correct, so a plan is allowed to
    // pay the tokens for it.
    expect(
      reconcileAgent({
        turn: 'incomplete',
        sessionId: SESSION,
        capabilities: rowFor('claude'),
        policy: 'always-replay',
      }),
    ).toEqual({ verdict: 'not-started', strategy: 'ResumeByReplay', sessionId: SESSION });
  });
});

suite('the replay cost is made visible, not swallowed (AC3)', () => {
  it('is never `unknown`: the ledger always reconstructs the prompt', () => {
    // The whole point of §5.1. A missing resume capability is a cost-model
    // difference, not a correctness one, so the agent probe has no third
    // answer to give.
    for (const profile of ['claude', 'codex', 'opencode', 'copilot', 'gemini'] as const) {
      for (const sessionId of [SESSION, null]) {
        const outcome = reconcileAgent({
          turn: 'incomplete',
          sessionId,
          capabilities: rowFor(profile),
        });
        expect(['done', 'not-started']).toContain(outcome.verdict);
      }
    }
  });
});
