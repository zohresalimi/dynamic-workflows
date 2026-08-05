/**
 * KAR-05.8 AC8 — mediation is lost on this path, and that is refused rather
 * than hidden.
 *
 * The exec shim's real cost is not the parsing. It is that DeFlow stops
 * sitting in front of every file access and every command execution: the
 * agent's permission level is expressed through the vendor's own flags, which
 * DeFlow cannot verify and cannot revoke mid-turn. So the shim adapter's
 * capability row says `mediatedExecution: false` — honestly, at the source —
 * and admission does the rest.
 *
 * That the *refusal* works is KAR-05.2's claim and is proved in
 * `admission.test.ts`. What is new here is that the shim's own row makes the
 * claim about itself, so no caller has to remember to set it.
 *
 * Verifies: EPIC-05-S29 · KAR-05.8 AC8 · test plan #9
 */
import { NodeIdSchema, PERMISSION_LEVELS, ProviderIdSchema } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { admit, capability, shimCapabilityRow } from '../src/index.ts';

const NODE = NodeIdSchema.parse('n1');

const row = shimCapabilityRow({
  provider: ProviderIdSchema.parse('claude'),
  version: '2.1.220',
  binaryPath: '/opt/DeFlow/bin/claude',
  binarySha256: 'a'.repeat(64),
  probedAt: 1_700_000_000_000,
});

suite('the shim adapter’s row reports mediatedExecution false', () => {
  it('says so explicitly, because absent would mean "not advertised"', () => {
    // KAR-05.2's rule: an *absent* `mediatedExecution` is not a denial, or the
    // entire installed ACP fleet would be unschedulable above `read`. Only an
    // explicit `false` refuses — so the shim has to say it out loud.
    const answer = capability(row, 'mediatedExecution');
    expect(answer.supported).toBe(false);
    expect(answer.reason).toBe('capability-denied');
  });

  it('is a row the rest of the routing layer can read like any other', () => {
    expect(row.provider).toBe('claude');
    expect(row.version).toBe('2.1.220');
    // At the path `capabilities.ts` actually reads. Anywhere else and the row
    // reads as "not advertised", which is admitted rather than refused.
    expect(JSON.parse(row.capsJson)).toMatchObject({
      agentCapabilities: { _meta: { mediatedExecution: false } },
    });
  });
});

suite('a node requiring mediated execution is refused scheduling', () => {
  it('refuses a worktree node with safety.permission-unschedulable', () => {
    const refusal = admit({ node: NODE, requires: [], permission: 'worktree' }, row);
    expect(refusal?.deflowFailure.reason).toBe('safety.permission-unschedulable');
    expect(refusal?.deflowFailure.class).toBe('permanent');
  });

  it('refuses every level above read, and admits read itself', () => {
    for (const permission of PERMISSION_LEVELS) {
      const refusal = admit({ node: NODE, requires: [], permission }, row);
      if (permission === 'read') expect(refusal).toBeNull();
      else expect(refusal?.deflowFailure.reason).toBe('safety.permission-unschedulable');
    }
  });
});
