/**
 * KAR-05.3 AC6/AC7 — "can this provider be used, and if not, what should the
 * operator run?"
 *
 * Two rules, both from AR-1 and NF7.
 *
 * **A missing or unauthenticated provider degrades the plan, it does not kill
 * the run.** Availability is reported as a value the planner can route around
 * (NF7); nothing here throws, because "gemini is not installed" is a fact about
 * the machine and not a failure of anything that was running.
 *
 * **DeFlow never runs a vendor's login flow and never captures its output.**
 * Copilot's `initialize` hands back an `authMethods` entry carrying a literal
 * `_meta["terminal-auth"]` block: `{command, args}`, ready to execute. Running
 * it would be one plausible, helpful-looking line — and it would put DeFlow
 * inside the credential path that AR-1 exists to keep it out of, holding
 * whatever the login flow printed. So this module renders a **string**, and
 * `test/no-path-lookup.test.ts` mechanically forbids any file that reads an
 * `authMethods` payload from importing a process-spawning API at all.
 *
 * `claude-agent-acp` answered `"authMethods": []` on 2026-08-02 — already
 * authenticated from the user's own credential store, needing nothing from
 * DeFlow. That is AR-1 working exactly as intended, and it is why an empty
 * array means available rather than unknown.
 *
 * Verifies: EPIC-05-S10 · AC6, AC7
 */
import type { ProviderId } from '@DeFlow/core';
import type { ProviderSpec } from './provider-registry.ts';

/** One way an agent says it can be logged in, rendered for a human. */
export interface AuthInstruction {
  readonly methodId: string;
  readonly name: string;
  readonly description?: string;
  /**
   * The command to paste into a terminal, or `null` where the agent named a
   * method without giving one (an OAuth flow it drives itself, say).
   *
   * A string, and only ever a string. Nothing in this package turns it back
   * into an argv.
   */
  readonly command: string | null;
}

export type AvailabilityStatus = 'available' | 'not-installed' | 'unauthenticated';

export interface ProviderAvailability {
  readonly provider: ProviderId;
  readonly status: AvailabilityStatus;
  /** The resolved absolute path, or `null` when nothing resolved. */
  readonly binaryPath: string | null;
  /** One human-readable line, naming the vendor. */
  readonly detail: string;
  /** What the operator can run themselves. Empty unless `unauthenticated`. */
  readonly login: readonly AuthInstruction[];
}

/** What the last probe of this provider left behind, if anything did. */
export interface AvailabilityInput {
  readonly binaryPath?: string | null;
  /** The `initialize` result as it arrived, byte-for-byte (KAR-05.2). */
  readonly capsJson?: string | null;
}

/** POSIX-safe when pasted into a shell, and unchanged when it needs nothing. */
const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

function shellQuote(word: string): string {
  if (word !== '' && SAFE.test(word)) return word;
  return `'${word.replaceAll("'", "'\\''")}'`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function parse(capsJson: string): unknown {
  try {
    return JSON.parse(capsJson) as unknown;
  } catch {
    // A capability blob that will not parse is a fact about the agent, not a
    // reason to fail a routing question. Nothing to render is the answer.
    return null;
  }
}

/** The `{command, args}` block a terminal-auth method carries, rendered. */
function terminalCommand(method: Record<string, unknown>): string | null {
  const meta = asRecord(method._meta);
  const terminal = asRecord(meta?.['terminal-auth']);
  const command = terminal?.command;
  if (typeof command !== 'string' || command === '') return null;
  const args = Array.isArray(terminal?.args) ? terminal.args : [];
  return [command, ...args.filter((arg): arg is string => typeof arg === 'string')]
    .map(shellQuote)
    .join(' ');
}

/**
 * Every login method the agent advertised, as text for a human.
 *
 * Tolerant by construction: a blob that is not JSON, is not an object, or
 * carries no `authMethods` renders nothing rather than throwing, because this
 * is called while answering "what can the operator do about it".
 */
export function renderAuthMethods(capsJson: string): readonly AuthInstruction[] {
  const result = asRecord(parse(capsJson));
  const methods = result?.authMethods;
  if (!Array.isArray(methods)) return [];
  return methods.flatMap((entry): AuthInstruction[] => {
    const method = asRecord(entry);
    if (method === null) return [];
    const methodId = typeof method.id === 'string' ? method.id : '';
    const name = typeof method.name === 'string' ? method.name : methodId;
    const description = typeof method.description === 'string' ? method.description : undefined;
    return [
      {
        methodId,
        name,
        ...(description === undefined ? {} : { description }),
        command: terminalCommand(method),
      },
    ];
  });
}

/**
 * Whether a node routed to this provider can be scheduled, and what to tell
 * the operator when it cannot.
 *
 * Deliberately takes the probe's leftovers rather than doing a probe: this is
 * asked while planning, potentially for every provider at once, and a planner
 * that spawned five agents to answer it would cost quota to answer a question
 * the manifest already answered.
 */
export function reportAvailability(
  spec: ProviderSpec,
  input: AvailabilityInput,
): ProviderAvailability {
  const binaryPath = input.binaryPath ?? null;
  if (binaryPath === null) {
    return {
      provider: spec.id,
      status: 'not-installed',
      binaryPath: null,
      detail:
        `${spec.id} is not installed here: no executable "${spec.bin}" has been resolved on this ` +
        `machine, so nodes routed to it are unschedulable — the plan degrades, the run does not fail`,
      login: [],
    };
  }

  const login = input.capsJson == null ? [] : renderAuthMethods(input.capsJson);
  if (login.length === 0) {
    return {
      provider: spec.id,
      status: 'available',
      binaryPath,
      detail: `${spec.id} resolved to ${binaryPath} and advertised no outstanding auth method`,
      login: [],
    };
  }

  const runnable = login.filter((method) => method.command !== null);
  return {
    provider: spec.id,
    status: 'unauthenticated',
    binaryPath,
    detail:
      `${spec.id} answered initialize with ${login.length} auth method` +
      `${login.length === 1 ? '' : 's'} still outstanding` +
      (runnable.length === 0
        ? '; log in with the vendor CLI yourself — DeFlow never runs a login flow (AR-1)'
        : `; run it yourself — DeFlow never runs a login flow and never captures its output (AR-1)`),
    login,
  };
}
