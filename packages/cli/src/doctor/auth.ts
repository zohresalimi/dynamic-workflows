/**
 * KAR-18.4, category 7 — Auth shadowing (docs/15-security-model.md §2.3).
 *
 * The failure this exists for is one sentence in the PRD: *"you thought you
 * were on your subscription and you were being billed."* Nothing else in the
 * system can detect it, because from the vendor CLI's point of view nothing is
 * wrong — `ANTHROPIC_API_KEY` in the environment simply wins over the
 * subscription credential, silently.
 *
 * **This module opens no credential file and captures no login output** (AR-1,
 * AC5). Everything below is decided from the *names* of variables present in
 * an environment the caller passed, and from `authMethods` blocks a probe
 * already recorded. Where a vendor CLI names a login command, it is rendered
 * as a string for the operator to paste — never executed.
 * `test/doctor-ar1-guard.test.ts` is the mechanical check that keeps it so,
 * because the tempting line here ("…and are you actually logged in?") would
 * break AR-1 while looking like an improvement.
 *
 * Verifies: EPIC-18-S26, EPIC-18-S30 · AC5
 */
import { checkAuthShadowing } from '@DeFlow/daemon';
import type { DoctorCheck } from './report.ts';

/** What the daemon does with a shadowing variable at run start (KAR-08.4). */
const STRIPPED_AT_RUN_START =
  'At run start the variable is stripped from the child environment by the allowlist in ' +
  'buildChildEnv(), and a "provider.auth_shadow_stripped" event is recorded against the node so ' +
  'the decision is in the ledger rather than inferred from a bill.';

export interface AuthInput {
  /** The environment doctor was invoked with — never `process.env` read here. */
  readonly env: NodeJS.ProcessEnv;
  /**
   * A login command a probed adapter reported, per provider — already rendered
   * as a string by `@DeFlow/adapters`' `reportAvailability`. A string, and only
   * ever a string: nothing in this file turns one back into an argv.
   */
  readonly loginCommands?: ReadonlyMap<string, readonly string[]>;
}

export function authChecks(input: AuthInput): readonly DoctorCheck[] {
  const rows = checkAuthShadowing(input.env);
  const checks: DoctorCheck[] = [];

  if (rows.length === 0) {
    checks.push({
      id: 'auth.shadowing',
      status: 'ok',
      detail:
        'no shadowing variable is set: every provider will use the credential its own CLI ' +
        'holds, which is the subscription in all five measured cases. DeFlow never possesses a ' +
        'model credential (AR-1), so this is read from variable names alone — no credential ' +
        'file was opened and no login command was run.',
    });
  }

  for (const row of rows) {
    checks.push({
      id: `auth.shadowing.${row.provider}`,
      status: 'warn',
      detail: `${row.detail} ${STRIPPED_AT_RUN_START} Effective auth mode: ${row.effectiveMode}.`,
      action: `unset ${row.variable} in the shell you run DeFlow from, if you meant to use the subscription`,
      data: { provider: row.provider, variable: row.variable, effectiveMode: row.effectiveMode },
    });
  }

  const logins: ReadonlyMap<string, readonly string[]> = input.loginCommands ?? new Map();
  for (const [provider, commands] of logins) {
    if (commands.length === 0) continue;
    checks.push({
      id: `auth.login.${provider}`,
      status: 'warn',
      detail:
        `${provider} reported that it is not authenticated. Run this yourself — DeFlow prints ` +
        `it and never executes it (AR-1): ${commands.join(' ; ')}`,
      action: commands.join(' ; '),
      data: { provider, commands: [...commands] },
    });
  }

  return checks;
}
