/**
 * KAR-18.4, category 3 — Sandboxing (docs/09-workspace-and-safety.md §8).
 *
 * EPIC-18-S29's note calls this the highest-value check in the whole command,
 * and the reasoning is worth restating where the code is: **Claude Code's
 * sandbox silently falls back to running unsandboxed when its dependencies are
 * missing**, and on Ubuntu 24.04 and later AppArmor blocks bubblewrap's
 * unprivileged user namespaces by default. In both cases the F5.4 permission
 * ladder becomes decorative and nothing else in the system notices.
 *
 * So the output is **the list of levels this machine could honour**, not
 * "sandbox: ok". A level DeFlow cannot enforce is a level DeFlow will refuse
 * to run at — `sandbox.failIfUnavailable: true` and
 * `allowUnsandboxedCommands: false` are set for every non-`full` level so the
 * ladder fails closed — and an operator reading "read only" knows both what
 * they have and what to install. "ok" tells them neither.
 *
 * `platform` and `readSysctl` are inputs rather than reads of `process` and
 * `/proc`, so the Linux ladder is exercisable from macOS. That is not a
 * testing convenience: it is the only way this check gets covered at all on a
 * project whose developers are on macOS and whose users are not.
 *
 * Verifies: EPIC-18-S26, EPIC-18-S27, EPIC-18-S29 · AC4
 */
import { LINUX_SANDBOX_DEPENDENCIES, type PermissionLevel } from '@DeFlow/core';
import { resolveOnPath } from './paths.ts';
import type { DoctorCheck } from './report.ts';

/** The F5.4 ladder, in order. */
export const PERMISSION_LADDER: readonly PermissionLevel[] = [
  'read',
  'worktree',
  'worktree+net',
  'full',
];

/** The one level that needs no enforcement machinery to be honest. */
const READ_ONLY: readonly PermissionLevel[] = ['read'];

/** The sysctl whose `1` means bubblewrap's user namespaces are blocked. */
export const APPARMOR_USERNS_SYSCTL = 'kernel.apparmor_restrict_unprivileged_userns';

/** The AppArmor profile that re-permits it, named so the fix is actionable. */
export const APPARMOR_PROFILE_PATH = '/etc/apparmor.d/bwrap';

export const SANDBOX_INSTALL_HINT = 'sudo apt install bubblewrap socat';

/**
 * The sentence AC4 requires, verbatim in both the degraded and the healthy
 * report: whatever the ladder can honour, the fail-closed policy is the same.
 */
export const FAIL_CLOSED_POLICY =
  'DeFlow sets sandbox.failIfUnavailable: true and allowUnsandboxedCommands: false for every ' +
  'non-"full" level, so a level it cannot enforce is refused before a process exists rather ' +
  'than run unsandboxed. Without those two settings the vendor CLI silently runs unsandboxed ' +
  'and nothing in the system notices.';

export interface SandboxInput {
  readonly platform: NodeJS.Platform;
  readonly roots: readonly string[];
  /** Reads a sysctl by name; `null` when it cannot be read at all. */
  readonly readSysctl: (key: string) => string | null;
}

export interface SandboxAssessment {
  readonly honourable: readonly PermissionLevel[];
  readonly missing: readonly string[];
  readonly usernsRestricted: boolean;
}

/** The pure decision, so the ladder can be reasoned about without a machine. */
function assessSandbox(input: SandboxInput): SandboxAssessment {
  if (input.platform === 'darwin') {
    // Seatbelt ships with macOS; there is nothing to install and nothing that
    // can be switched off underneath it.
    return { honourable: PERMISSION_LADDER, missing: [], usernsRestricted: false };
  }

  if (input.platform !== 'linux') {
    return { honourable: READ_ONLY, missing: [], usernsRestricted: false };
  }

  const missing = LINUX_SANDBOX_DEPENDENCIES.filter(
    (name) => resolveOnPath(input.roots, name) === null,
  );
  const usernsRestricted = (input.readSysctl(APPARMOR_USERNS_SYSCTL) ?? '0').trim() === '1';

  return {
    honourable: missing.length === 0 && !usernsRestricted ? PERMISSION_LADDER : READ_ONLY,
    missing,
    usernsRestricted,
  };
}

function reason(input: SandboxInput, assessment: SandboxAssessment): string {
  if (input.platform === 'darwin') {
    return 'macOS ships Seatbelt, so every level is enforceable with nothing to install.';
  }
  if (input.platform !== 'linux') {
    return (
      `${input.platform} has no sandbox DeFlow knows how to drive, so only "read" — the one ` +
      'level that needs no enforcement — is honourable here.'
    );
  }
  if (assessment.honourable.length > 1) {
    return `bubblewrap and socat are both on PATH and ${APPARMOR_USERNS_SYSCTL} is 0.`;
  }

  const causes: string[] = [];
  if (assessment.missing.length > 0) {
    causes.push(
      `${assessment.missing.join(' and ')} ${
        assessment.missing.length === 1 ? 'is' : 'are'
      } not on PATH — install with "${SANDBOX_INSTALL_HINT}"`,
    );
  }
  if (assessment.usernsRestricted) {
    causes.push(
      `${APPARMOR_USERNS_SYSCTL} is 1, which is the Ubuntu 24.04+ default and blocks ` +
        "bubblewrap's unprivileged user namespaces — add a profile at " +
        `${APPARMOR_PROFILE_PATH} to re-permit it`,
    );
  }
  // AC4 names `/etc/apparmor.d/bwrap` as the fix for every degraded Linux
  // ladder, not only for the one the sysctl caused: on Ubuntu 24.04 and later
  // installing the packages is not enough on its own, and an operator who
  // `apt install`s bubblewrap and finds the ladder still collapsed has been
  // told half a fix. The sentence is skipped only when the restriction is
  // already in effect and the cause above has just named the same file.
  return assessment.usernsRestricted
    ? `${causes.join('; ')}.`
    : `${causes.join('; ')}. On Ubuntu 24.04 and later a profile at ${APPARMOR_PROFILE_PATH} is ` +
        'needed as well as the packages, because AppArmor blocks unprivileged user namespaces by ' +
        'default there.';
}

export function sandboxChecks(input: SandboxInput): readonly DoctorCheck[] {
  const assessment = assessSandbox(input);
  const degraded = assessment.honourable.length === 1;

  return [
    {
      id: 'sandboxing.levels',
      // A degraded ladder is a `warn`, never a `fail`: `read` is a level DeFlow
      // can honestly offer, so the machine is usable — it is the *silence*
      // about the missing levels that would be the failure.
      status: degraded ? 'warn' : 'ok',
      detail:
        `honourable permission levels on this machine: ${assessment.honourable.join(', ')}. ` +
        reason(input, assessment),
      // KAR-18.9 AC5 — the packages are the fix on every degraded Linux ladder,
      // and on a platform with no sandbox at all there is nothing to run, so
      // the action is left off and the summary falls back.
      ...(degraded && assessment.missing.length > 0 ? { action: SANDBOX_INSTALL_HINT } : {}),
      data: {
        platform: input.platform,
        honourable: [...assessment.honourable],
        missing: [...assessment.missing],
        usernsRestricted: assessment.usernsRestricted,
      },
    },
    {
      id: 'sandboxing.policy',
      status: 'ok',
      detail: FAIL_CLOSED_POLICY,
    },
  ];
}
