/**
 * KAR-02.7 — the boot preflight over the event schema registry.
 *
 * docs/delivery/flows/EPIC-02-domain-model-flows.md, EPIC-02-S21: DeFlowd
 * calls this during startup, before opening the ledger, and a failure exits
 * with a typed error naming the gap rather than a stack trace. The check is
 * O(kinds × versions) over a static table, so it costs nothing to run on
 * every boot — and the alternative is finding the hole during the replay of a
 * nine-hour run.
 *
 * It returns a value rather than throwing, because "exit with a message" and
 * "throw at the top level" produce very different things on a user's terminal.
 */
import {
  assertUpcasterChainsComplete,
  eventUpcasters,
  UpcasterChainIncomplete,
  type UpcasterRegistry,
} from '@DeFlow/core';

export type SchemaRegistryCheck =
  | { ok: true }
  | { ok: false; kind: string; version: number; message: string };

/** Exit code for a configuration/consistency failure, per sysexits' EX_CONFIG. */
export const EX_CONFIG = 78;

export function checkSchemaRegistry(
  registry: UpcasterRegistry = eventUpcasters,
): SchemaRegistryCheck {
  try {
    assertUpcasterChainsComplete(registry);
    return { ok: true };
  } catch (thrown) {
    if (thrown instanceof UpcasterChainIncomplete) {
      return {
        ok: false,
        kind: thrown.kind,
        version: thrown.version,
        message: thrown.message,
      };
    }
    throw thrown;
  }
}
