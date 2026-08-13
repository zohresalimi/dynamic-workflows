/**
 * The one place a sentence about *what this machine has installed* is written,
 * and the admission decision that reads it.
 *
 * ## Why it lives here rather than in `DeFlow doctor`
 *
 * KAR-18.8 wrote these sentences and put them in `@DeFlow/cli`, which was right
 * while `doctor` was their only reader. KAR-19.2 gave them a second one — the
 * daemon, refusing a submission — and a daemon cannot import the CLI. The
 * options were a second wording or a move, and KAR-19.2 AC3 settles it: *"a
 * second wording is a second thing to keep true"*. So the pure half moved down
 * to the package that already owns `PROVIDER_SPECS` and `resolveExecutable`,
 * and `packages/cli/src/doctor/agent-install.ts` — which still owns the
 * `npm install -g` subprocess and the prompt — re-exports it. There is one
 * renderer; `test/one-install-renderer.test.ts` at the repository root is what
 * keeps it that way.
 *
 * ## The four states, and why the fourth exists
 *
 * `installed`, `adapter-missing` and `not-installed` are KAR-18.8's, derived
 * from resolving *both* of a provider's binaries — the vendor CLI
 * (`spec.shim.bin`, `claude`) and the thing DeFlow actually spawns (`spec.bin`,
 * `claude-agent-acp`). `handshake-failed` is KAR-19.2 AC7's and is not
 * resolvable from the filesystem at all: it is an adapter that is present and
 * did not answer ACP `initialize`, which only a probe can find out. It is a
 * separate state rather than folded into `not-installed` because a broken
 * bridge reported as an absent one makes the operator uninstall and reinstall a
 * package that was already there — twice — before suspecting DeFlow.
 *
 * ## Admission is a read, never a probe
 *
 * `admitRun` takes resolutions and returns a verdict. It spawns nothing, reads
 * no credential and touches no network: everything it needs was established at
 * boot, which is what keeps a submission instant (KAR-19.2 AC6) and what keeps
 * AR-1 true on the one path an "is it logged in?" convenience check would be
 * most tempting to add.
 *
 * Verifies: EPIC-19-S9, EPIC-19-S11, EPIC-19-S13, EPIC-19-S14 · AC2, AC3, AC4,
 * AC6, AC7
 */

import { resolveExecutable } from './binary-resolver.ts';
import { PROVIDER_SPECS, type ProviderSpec } from './provider-registry.ts';

/**
 * What the machine has, per provider.
 *
 * `adapter-missing` is KAR-18.8's addition. `not-installed` covers a vendor CLI
 * that is absent *and* the degenerate case of a bridge with nothing to bridge —
 * a `claude-agent-acp` with no `claude` underneath it is not an installation,
 * and calling it one would move the same confusion along by one binary.
 */
export type AgentInstallState =
  | 'installed'
  | 'adapter-missing'
  | 'not-installed'
  | 'handshake-failed';

export interface ProviderResolution {
  readonly provider: string;
  readonly state: AgentInstallState;
  /** `'native'` providers have one executable under one name; `'adapter'` ones
   * have a vendor CLI and a separate ACP bridge, and that is the whole seam. */
  readonly kind: ProviderSpec['kind'];
  /** The vendor CLI the operator installed: `spec.shim.bin`. */
  readonly vendorBin: string;
  /** Absolute, or `null` when nothing on `roots` resolved it. */
  readonly vendorPath: string | null;
  /** The binary DeFlow spawns: `spec.bin`. The same file for a native vendor. */
  readonly adapterBin: string;
  readonly adapterPath: string | null;
  /** The npm package that provides `adapterBin`. */
  readonly package: string;
  /**
   * KAR-19.7 AC8 — this binary ships inside DeFlow's own tarball.
   *
   * Carried on the resolution rather than looked up from the registry at each
   * reading, so `providerVerdict` stays a pure function of what it was handed
   * — which is what makes "*is not installed* never co-occurs with a resolved
   * path" a table-driven unit test rather than a sentence someone re-reads.
   */
  readonly bundled: boolean;
  /**
   * KAR-19.2 AC7 — the child's own stderr from the `initialize` that failed,
   * trimmed and never paraphrased. Present only for `handshake-failed`, and
   * only when the child said anything at all.
   */
  readonly handshakeStderr?: string;
}

/** The first root holding an executable called `bin`, or `null`. */
function tryResolve(spec: ProviderSpec, bin: string, roots: readonly string[]): string | null {
  try {
    // The registry's own resolver rather than a second `statSync` loop: it
    // follows symlinks, checks X_OK and distinguishes EISDIR from ENOENT, and
    // "does it resolve?" has to mean exactly what it means at spawn time.
    return resolveExecutable(spec.id, bin, { roots });
  } catch {
    return null;
  }
}

/**
 * One provider's state, from resolving both of its binaries.
 *
 * Never returns `handshake-failed`: nothing about the filesystem can tell you
 * that a program answers ACP. `admissionResolutions` in `@DeFlow/daemon` is
 * what folds the boot probe's answer in on top of this.
 */
export function resolveProviderState(
  spec: ProviderSpec,
  roots: readonly string[],
): ProviderResolution {
  const vendorPath = tryResolve(spec, spec.shim.bin, roots);
  const adapterPath = tryResolve(spec, spec.bin, roots);

  // For a `kind: 'native'` provider the two names are the same executable, so
  // the third branch is unreachable there — and it is written as a condition on
  // `kind` rather than left to the coincidence, because a native provider has
  // no adapter package to offer and claiming one would name something that does
  // not exist.
  const state: AgentInstallState =
    vendorPath === null
      ? 'not-installed'
      : adapterPath !== null
        ? 'installed'
        : spec.kind === 'adapter'
          ? 'adapter-missing'
          : 'not-installed';

  return {
    provider: spec.id,
    state,
    kind: spec.kind,
    vendorBin: spec.shim.bin,
    vendorPath,
    adapterBin: spec.bin,
    adapterPath,
    package: spec.package,
    bundled: spec.bundled ?? false,
  };
}

/** Every registered provider, in id order — the order the report prints. */
export function resolveProviderStates(roots: readonly string[]): readonly ProviderResolution[] {
  return Object.values(PROVIDER_SPECS)
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .map((spec) => resolveProviderState(spec, roots));
}

/** The state, the check status and the sentence — from the resolution alone. */
export interface ProviderVerdict {
  readonly state: AgentInstallState;
  readonly status: 'ok' | 'warn';
  readonly detail: string;
  /** KAR-18.9 AC5 — the one command to run when this provider is the worst
   * thing in the report. Absent for `installed`, which needs nothing. */
  readonly action?: string;
}

/** The command that is offered, and — verbatim — the command that is run. */
export const installCommand = (pkg: string): string => `npm install -g ${pkg}`;

/**
 * Enough of a child's output to diagnose it, without pasting a whole log.
 *
 * The same cap the `npm install` path uses, for the same reason: an operator
 * reading a refusal in a terminal has one screen, and the first four thousand
 * characters of a stack are the ones that name the module.
 */
const STDERR_CAP = 4000;

function trimChildStderr(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length <= STDERR_CAP
    ? trimmed
    : `${trimmed.slice(0, STDERR_CAP)}\n… (truncated at ${STDERR_CAP} characters)`;
}

/**
 * What the operator is told about one provider (KAR-18.8 AC1, AC2).
 *
 * One function so that the sentences cannot drift apart, and a pure one so the
 * invariant this whole family of stories is about — *"is not installed" never
 * co-occurs with a resolved vendor-CLI path* — is a table-driven unit test over
 * the registry rather than a sentence someone remembered to re-read.
 *
 * Neither of the two absences is a `fail`: DeFlow not being able to route
 * through one provider is not DeFlow being unable to run here, so this never
 * moves `doctor`'s exit code (KAR-18.8 AC3).
 */
export function providerVerdict(resolution: ProviderResolution): ProviderVerdict {
  if (resolution.state === 'installed') {
    return {
      state: 'installed',
      status: 'ok',
      detail:
        `"${resolution.adapterBin}" — the binary DeFlow spawns — resolves at ` +
        `${resolution.adapterPath}, the absolute path DeFlowd would use rather than one looked ` +
        "up on the daemon's own PATH later.",
    };
  }

  if (resolution.state === 'handshake-failed') {
    // KAR-19.2 AC7. Every clause here is chosen against one failure mode: the
    // operator concluding the package is absent and reinstalling it. So the
    // path that failed is named, the vendor CLI is explicitly defended, and the
    // child's own words are quoted rather than summarised — a paraphrase of
    // "Cannot find module" is what turns a five-second reading into an hour.
    const said =
      resolution.handshakeStderr === undefined || resolution.handshakeStderr === ''
        ? 'and said nothing on stderr while doing so'
        : `and said:\n${trimChildStderr(resolution.handshakeStderr)}`;
    return {
      state: 'handshake-failed',
      status: 'warn',
      detail:
        `"${resolution.adapterBin}" resolves at ${resolution.adapterPath} — it is present — but ` +
        `it did not answer ACP initialize ${said}\nThis is a broken bridge rather than an absent ` +
        `one, so do not remove "${resolution.vendorBin}" at ${resolution.vendorPath}. Reinstall ` +
        `the adapter with "${installCommand(resolution.package)}".`,
      action: installCommand(resolution.package),
    };
  }

  if (resolution.state === 'adapter-missing') {
    // The one sentence this must never contain is "<provider> is not
    // installed", because the operator can see that it is. It names the
    // resolved path of the binary they have, the package that provides the one
    // they do not, and the command — so the fix is a copy of one line rather
    // than a package name reconstructed out of a paragraph.
    return {
      state: 'adapter-missing',
      status: 'warn',
      detail:
        `"${resolution.vendorBin}" is installed at ${resolution.vendorPath}, so this vendor CLI ` +
        'is present and working. What is missing is its ACP adapter: DeFlow spawns ' +
        `"${resolution.adapterBin}", which comes from ${resolution.package}, and nothing on PATH ` +
        `resolves it. Install it with "${installCommand(resolution.package)}", or re-run ` +
        '"DeFlow doctor --fix" and answer yes.',
      action: `${installCommand(resolution.package)} (or run 'DeFlow doctor --fix')`,
    };
  }

  // KAR-19.7 AC8 — a binary that shipped in the same tarball as the command the
  // operator just ran cannot be installed from npm, and telling them to try is
  // the same class of wrong as "claude is not installed" on a machine where it
  // resolves. What it needs is to be on `PATH`, which is a different sentence
  // and a different action.
  if (resolution.bundled) {
    return {
      state: 'not-installed',
      status: 'warn',
      detail:
        `"${resolution.vendorBin}" ships with DeFlow — there is nothing to install — but nothing ` +
        'on PATH resolves it here. Put the one from this installation on PATH: ' +
        `ln -s "$(command -v ${resolution.vendorBin})" "$(npm prefix -g)/bin/${resolution.vendorBin}".`,
      action: `put "${resolution.vendorBin}" on PATH (it ships with DeFlow; nothing to install)`,
    };
  }

  // A native provider's vendor CLI *is* the ACP agent, so there is one package
  // to name. An adapter-kind one needs the vendor CLI first and the bridge
  // second, and saying only the second is how an operator ends up with a bridge
  // to nothing.
  const next =
    resolution.kind === 'native'
      ? `install it with "${installCommand(resolution.package)}".`
      : `DeFlow spawns "${resolution.adapterBin}" from ${resolution.package}, so this machine ` +
        `needs that vendor CLI and then its ACP adapter — "${installCommand(resolution.package)}" ` +
        `once "${resolution.vendorBin}" is on PATH.`;

  return {
    state: 'not-installed',
    status: 'warn',
    detail:
      `${resolution.provider} is not installed here: no executable "${resolution.vendorBin}" was ` +
      `found on PATH — ${next}`,
    action:
      resolution.kind === 'native'
        ? installCommand(resolution.package)
        : `install "${resolution.vendorBin}", then ${installCommand(resolution.package)}`,
  };
}

/** The sentence the operator answers, with the command in it before the yes. */
export function installPrompt(resolution: ProviderResolution): string {
  return (
    `${resolution.provider}: "${resolution.vendorBin}" is installed at ${resolution.vendorPath}, ` +
    `but the ACP adapter DeFlow spawns ("${resolution.adapterBin}", from ` +
    `${resolution.package}) is not. Run "${installCommand(resolution.package)}" now? [y/N] `
  );
}

// ── admission ────────────────────────────────────────────────────────────────

/**
 * KAR-19.2 AC4 — the flag the mock agent takes, named in every refusal.
 *
 * It is `DeFlow-mock-agent`'s own flag rather than a `DeFlow run` one, and it
 * still is after KAR-19.7 gave the binary a `mock` entry in `PROVIDER_SPECS`.
 * The entry means a run *can* now be served by the bundled agent under its own
 * name; what has deliberately not been invented is a `DeFlow run --mock-agent`
 * switch, because a run reaches the bundled agent only where the operator's own
 * `PATH` or configuration puts it (AC8) rather than where a flag overrides the
 * machine. What works, and what every test in this repository does, is to put
 * the bundled binary on `PATH` — under its own name, or under the adapter name
 * DeFlow spawns for a vendor whose profile you want it to answer with, which is
 * what the flag below selects.
 */
export const MOCK_AGENT_FLAG = '--capabilities <vendor>';

/**
 * KAR-19.2 AC4 — the last thing every refusal says.
 *
 * The mock agent is how a person evaluates DeFlow before installing anything.
 * Attaching this only to the zero-providers case — the tempting shortcut, since
 * that reads as the "new user" case — sends the far more common
 * `adapter-missing` operator to npm before they have any evidence the tool is
 * worth it. So it is appended to every refusal, whatever the code.
 */
export const MOCK_AGENT_SENTENCE =
  'Nothing needs installing to try this: DeFlow-mock-agent ships in this package, and a run ' +
  'against it needs no vendor CLI, no credential and no network. Put it on PATH under the ' +
  'adapter binary name printed above — ln -s "$(command -v DeFlow-mock-agent)" ' +
  '"$(npm prefix -g)/bin/<that name>" — and use its "--capabilities <vendor>" flag to choose ' +
  'which vendor profile it answers as.';

/**
 * The two ways a machine can fail admission, as the codes the wire carries.
 *
 * A closed pair, and deliberately not one code with a `reason`: the operator's
 * next action is completely different — install something, versus repair
 * something that is already installed — and a client that had to unpick a
 * detail string to tell them apart would not.
 */
export const RUN_REFUSAL_CODES = {
  noUsableProvider: 'no_usable_provider',
  handshakeFailed: 'provider_handshake_failed',
} as const;

export type RunRefusalCode = (typeof RUN_REFUSAL_CODES)[keyof typeof RUN_REFUSAL_CODES];

/** True for a code this refusal vocabulary owns, and for nothing else. */
export function isRunRefusalCode(code: string): code is RunRefusalCode {
  return (Object.values(RUN_REFUSAL_CODES) as readonly string[]).includes(code);
}

/** AC2's wire shape, per provider — four fields and no more, because this is
 * what a UI branches on rather than what a human reads. */
export interface RefusedProvider {
  readonly id: string;
  readonly state: AgentInstallState;
  readonly vendorPath: string | null;
  readonly adapterPackage: string;
}

export type RunAdmission =
  | { readonly outcome: 'admitted' }
  | {
      readonly outcome: 'refused';
      readonly code: RunRefusalCode;
      /** Rendered by `providerVerdict`, the same function `doctor` prints (AC3). */
      readonly message: string;
      readonly providers: readonly RefusedProvider[];
      /** Everything the ledger records, so the refusal is answerable six weeks
       * later without re-probing the machine it happened on (AC1, NF8). */
      readonly resolutions: readonly ProviderResolution[];
    };

const ADMITTED: RunAdmission = { outcome: 'admitted' };

/**
 * Which providers are worth printing.
 *
 * Everything the machine has *something* of, or — on a machine with nothing at
 * all — all of them, because then the list is the menu. Printing all five to an
 * operator who has `claude` installed buries the one actionable line under four
 * that are not.
 */
function worthNaming(resolutions: readonly ProviderResolution[]): readonly ProviderResolution[] {
  const present = resolutions.filter((entry) => entry.state !== 'not-installed');
  return present.length > 0 ? present : resolutions;
}

/**
 * The whole refusal message: what is wrong, per provider, in `doctor`'s own
 * words, and then the way to proceed with nothing installed.
 *
 * Exported because `GET /api/runs/:id` re-renders it from the recorded
 * resolutions rather than storing the prose in the ledger — a stored sentence
 * is a sentence that cannot be improved, and re-rendering is what makes "the
 * same renderer" true for the read path as well as the write path.
 */
export function renderRefusal(resolutions: readonly ProviderResolution[]): string {
  const lines = worthNaming(resolutions).map((entry) => providerVerdict(entry).detail);
  return [
    // The parenthesis is the one thing a reader cannot work out for themselves:
    // admission is a read of what the daemon found when it started (AC6), so an
    // adapter installed since then is invisible until it restarts. Without this
    // sentence the operator's next move after a successful `npm install -g` is
    // to run the same command again and be refused again.
    'DeFlow cannot start this run: no agent adapter on this machine can serve it. ' +
      '(This is what DeFlowd found when it started — if you have installed one since, restart it ' +
      'with "DeFlow up".)',
    ...lines,
    MOCK_AGENT_SENTENCE,
  ].join('\n\n');
}

/**
 * KAR-19.7 AC8 — the providers a run may be routed onto, best first.
 *
 * The order is the whole of it. A bundled agent is a real answer on a machine
 * that has nothing else — that is why it is in the registry — and it must never
 * be the answer on a machine that has a vendor adapter sitting right there. A
 * run that "succeeded" against an agent nobody chose is the quietest and most
 * expensive failure this entry could introduce, so the preference is a function
 * with a test rather than a comment beside the table.
 *
 * Real adapters keep the order they arrived in (registry id order, which is
 * what `resolveProviderStates` produces); bundled ones follow, in the same
 * order among themselves. Nothing here reads a provider's name.
 */
export function usableProviders(
  resolutions: readonly ProviderResolution[],
): readonly ProviderResolution[] {
  const installed = resolutions.filter((entry) => entry.state === 'installed');
  return [...installed.filter((e) => !e.bundled), ...installed.filter((e) => e.bundled)];
}

/**
 * Can anything here serve a run? — answered before the 201, from the manifest.
 *
 * One installed adapter is enough. The bug this exists to stop is the *other*
 * reduction: inferring admission from "is any binary on `PATH`", which admits
 * the machine that has a vendor CLI and no bridge — the common machine, and the
 * one whose run then did nothing at all.
 */
export function admitRun(resolutions: readonly ProviderResolution[]): RunAdmission {
  if (usableProviders(resolutions).length > 0) return ADMITTED;

  // A bridge that is installed and broken is a different sentence and a
  // different next action from one that was never installed, and it wins the
  // code: it is the more specific fact about this machine.
  const code = resolutions.some((entry) => entry.state === 'handshake-failed')
    ? RUN_REFUSAL_CODES.handshakeFailed
    : RUN_REFUSAL_CODES.noUsableProvider;

  return {
    outcome: 'refused',
    code,
    message: renderRefusal(resolutions),
    providers: resolutions.map((entry) => ({
      id: entry.provider,
      state: entry.state,
      vendorPath: entry.vendorPath,
      adapterPackage: entry.package,
    })),
    resolutions,
  };
}
