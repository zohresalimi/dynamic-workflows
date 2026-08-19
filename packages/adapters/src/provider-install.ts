/**
 * The one place a sentence about *what this machine has installed* is written,
 * and the admission decision that reads it.
 *
 * ## Why it lives here rather than in `deflow doctor`
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

import type { ProviderRoute, RouteState } from '@DeFlow/core';
import { routeLabel } from '@DeFlow/core';
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
  /**
   * KAR-25.3 AC3 — the operator disabled this provider in `/settings`.
   *
   * Optional and absent by default — `resolveProviderState` never sets it,
   * because resolving a binary knows nothing about a policy stored in the
   * ledger. It is stamped on afterwards, by whichever daemon-side caller has a
   * `Db` to read `provider_setting` from (`@DeFlow/daemon`'s
   * `packages/daemon/src/providers/settings.ts`), and every reducer below
   * treats it the same way once it is there: `providerRoutes` closes both
   * routes, which is what makes a disabled provider unusable to
   * `usableProviders`, `admitRun` and `providerOptions` **without any of them
   * being told about `provider_setting` directly** — the flag lives on the
   * value they already reduce, not beside it.
   */
  readonly disabled?: boolean;
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

// ── routes ───────────────────────────────────────────────────────────────────

/**
 * KAR-19.10 — provider state, as **one answer per route**.
 *
 * ## Why the shape changed
 *
 * On 2026-08-13 `doctor` reported `claude` as `adapter-missing` — one word,
 * which every reader takes to mean *unusable* — and the run selected `claude`
 * anyway, through `spec.shim.bin`, and spawned the vendor CLI. Neither half was
 * lying. `adapter-missing` was a true sentence about a machine and a false one
 * about a run, because one word per provider cannot say *"usable on one route,
 * not the other"*.
 *
 * It is not that selection was wrong. `chooseProvider` takes `spec.shim.bin` on
 * purpose: a pre-execution turn is driven through the vendor's own CLI because
 * the return contract rides on `structuredOutputFlag`, which only the CLI has.
 * Refusing to select it would mean deleting the path the whole chain runs on.
 * So the report is what had to become route-aware, and this is the one function
 * that answers it — `doctor`'s Agents section, `admitRun` and the chain's
 * selection all reduce this structure and nothing else
 * (`test/one-provider-route-reducer.test.ts` is what keeps that true).
 *
 * KAR-18.8's `AgentInstallState` survives unchanged: it is what the *install
 * sentence* is keyed on, and the sentence is still right. What it is no longer
 * allowed to be is the answer to *"can a run use this"*.
 *
 * `RouteState` and the route vocabulary itself live in `@DeFlow/core`, because
 * the ledger payload and the UI both have to spell them and neither may depend
 * on this package.
 */
export interface ProviderRoutes {
  /** DeFlow spawns `spec.bin` and opens an ACP session. */
  readonly acp: RouteState;
  /** DeFlow spawns `spec.shim.bin` — the vendor's own CLI — for one turn. */
  readonly shim: RouteState;
}

/**
 * The turns a run takes, and the route each one needs.
 *
 * The keys are what a refusal names, so they are the words an operator would
 * use rather than node ids. `node execution` is the one that needs the ACP
 * session: streaming, permission negotiation and cancellation are all session
 * concerns, and a turn driven through a one-shot CLI invocation has none of
 * them. The three pre-execution turns need the shim, because that is where the
 * `returns` contract lives.
 */
export const TURN_ROUTES = {
  framing: 'shim',
  recon: 'shim',
  planner: 'shim',
  'node execution': 'acp',
} as const satisfies Readonly<Record<string, ProviderRoute>>;

export type RunTurn = keyof typeof TURN_ROUTES;

/** Every turn, in the order a run reaches them. */
const ALL_TURNS = Object.keys(TURN_ROUTES) as readonly RunTurn[];

/**
 * Which routes this machine can open for one provider.
 *
 * The one asymmetry worth reading: the ACP route needs **both** binaries. A
 * bridge with no vendor CLI under it bridges to nothing — `claude-agent-acp`
 * spawns `claude` — so an ACP session cannot open there either, and calling
 * that route available would move the 2026-08-13 confusion along by one binary
 * instead of removing it. `handshake-failed` closes the ACP route for the same
 * reason at one remove: a bridge that did not answer `initialize` is present
 * and unusable, and only a probe can know it.
 *
 * **KAR-25.3 AC3 — a disabled provider has both routes closed, before either
 * binary is even looked at.** This is the one line the whole toggle stands on:
 * `usableProviders`, `admitRun`, `providerOptions` and the chain's own
 * selection all derive from this function and nothing else
 * (`test/one-provider-route-reducer.test.ts`), so a disabled provider
 * disappearing from every one of them is a property of this branch existing
 * once, not four call sites each remembering to check a flag.
 */
export function providerRoutes(resolution: ProviderResolution): ProviderRoutes {
  if (resolution.disabled === true) return { acp: 'missing', shim: 'missing' };
  const shim: RouteState = resolution.vendorPath === null ? 'missing' : 'available';
  const acp: RouteState =
    resolution.adapterPath !== null &&
    shim === 'available' &&
    resolution.state !== 'handshake-failed'
      ? 'available'
      : 'missing';
  return { acp, shim };
}

/** The turns these routes can serve, in run order. */
export function turnsServedBy(routes: ProviderRoutes): readonly RunTurn[] {
  return ALL_TURNS.filter((turn) => routes[TURN_ROUTES[turn]] === 'available');
}

/** The turns these routes cannot serve — what a partial machine is told at
 * admission rather than at the node three minutes later (AC7). */
export function unservedTurns(routes: ProviderRoutes): readonly RunTurn[] {
  return ALL_TURNS.filter((turn) => routes[TURN_ROUTES[turn]] !== 'available');
}

/** True when at least one turn can be served here. */
const hasUsableRoute = (resolution: ProviderResolution): boolean =>
  turnsServedBy(providerRoutes(resolution)).length > 0;

/**
 * The route the **next** turn of a fresh run takes, or `null` for a provider
 * that can serve nothing.
 *
 * A run's first turn is framing, so this is the shim wherever the shim is
 * open. It is computed from the turn rather than from the registry's
 * preference, because AC5's claim is that the announced route is the route
 * actually taken — and a preference is exactly what would lie on the one
 * machine where the two differ.
 */
export function routeForNextTurn(resolution: ProviderResolution): ProviderRoute | null {
  const served = turnsServedBy(providerRoutes(resolution));
  const first = served[0];
  return first === undefined ? null : TURN_ROUTES[first];
}

/** The absolute path the child on `route` is spawned from. */
export function binaryForRoute(
  resolution: ProviderResolution,
  route: ProviderRoute,
): string | null {
  return route === 'acp' ? resolution.adapterPath : resolution.vendorPath;
}

/**
 * KAR-19.10 AC6 — the two routes, as one line of `doctor`'s Agents section.
 *
 * The sentence `doctor` was missing on 2026-08-13. It printed one word per
 * provider, that word was `adapter-missing`, and every reader took it to mean
 * *this machine cannot use claude* — while a run was, correctly, using it. So
 * the report now says which routes are open and where each one's binary is,
 * from the same reducer admission and selection read.
 *
 * The install sentence is deliberately **not** duplicated here: `providerVerdict`
 * is still the one thing that says what to do about a route that is closed, and
 * `doctor` appends it after this line (KAR-19.2 AC3).
 */
export function renderRouteReport(resolution: ProviderResolution): string {
  const routes = providerRoutes(resolution);
  const where = (route: ProviderRoute): string => {
    const path = binaryForRoute(resolution, route);
    return routes[route] === 'available' && path !== null ? `available at ${path}` : 'missing';
  };
  const served = turnsServedBy(routes);
  return (
    `Routes — ${routeLabel('acp')}: ${where('acp')}; ${routeLabel('shim')}: ${where('shim')}. ` +
    (served.length === 0
      ? 'No turn of a run can be served here.'
      : `This machine can serve ${served.join(', ')} on it` +
        `${unservedTurns(routes).length === 0 ? '.' : `, but not ${unservedTurns(routes).join(', ')}.`}`)
  );
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
  // KAR-25.3 AC3 — checked first, and unconditionally, so an installed
  // provider the operator disabled in Settings never renders the "installed"
  // sentence below it: that sentence is true about the binary and false about
  // whether a run may use it, which is the exact confusion this branch exists
  // to stop before it starts. There is nothing to `npm install`, so `action`
  // is absent — the fix is a toggle, not a command.
  if (resolution.disabled === true) {
    return {
      state: resolution.state,
      status: 'warn',
      detail: `${resolution.provider} is disabled in Settings — enable it there to let DeFlow use it.`,
    };
  }

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
        '"deflow doctor --fix" and answer yes.',
      action: `${installCommand(resolution.package)} (or run 'deflow doctor --fix')`,
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
 * It is `deflow-mock-agent`'s own flag rather than a `deflow run` one, and it
 * still is after KAR-19.7 gave the binary a `mock` entry in `PROVIDER_SPECS`.
 * The entry means a run *can* now be served by the bundled agent under its own
 * name; what has deliberately not been invented is a `deflow run --mock-agent`
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
  'Nothing needs installing to try this: deflow-mock-agent ships in this package, and a run ' +
  'against it needs no vendor CLI, no credential and no network. Put it on PATH under the ' +
  'adapter binary name printed above — ln -s "$(command -v deflow-mock-agent)" ' +
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

/**
 * KAR-19.10 AC4 — the choice admission made, recorded so nothing downstream has
 * to make it again.
 *
 * The whole point is that this is *decided once*. The chain obeys the record
 * rather than re-reducing the machine on a later tick, which is what makes "the
 * run never silently falls back onto a different provider" (AC8) a property of
 * the code rather than a coincidence of two reductions agreeing.
 */
export interface ChosenProvider {
  readonly provider: string;
  /** The route the next turn takes. Announced, and asserted against the child. */
  readonly route: ProviderRoute;
  /** Absolute, and the path the child is actually spawned from. */
  readonly binaryPath: string;
  readonly routes: ProviderRoutes;
  /** The turns this provider cannot serve here. Empty is the ordinary case. */
  readonly unserved: readonly RunTurn[];
  /** What the machine looked like when the choice was made, carried whole so
   * the ledger row is answerable without re-probing (NF8). */
  readonly resolution: ProviderResolution;
}

export type RunAdmission =
  | {
      readonly outcome: 'admitted';
      /**
       * `null` only where nothing asked the question — a daemon booted without
       * `providerRoots`, a spec constructing intake ports by hand. Absent means
       * admitted has always meant "no honest basis on which to refuse", and it
       * has no honest basis on which to announce either.
       */
      readonly chosen: ChosenProvider | null;
      /** AC7 — what this machine will not be able to do, said now rather than
       * at the first agent node. `null` when there is nothing to warn about. */
      readonly limitation: string | null;
    }
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

  // KAR-25.3 AC3 — a machine where every candidate is disabled rather than
  // absent needs a different opening line: "restart it with deflow up" is
  // advice for a binary the daemon has not seen yet, and re-probing a
  // disabled provider finds exactly what it found before. The per-provider
  // sentences already say "disabled in Settings" (see the branch above); this
  // is only the summary line above them, so the two levels agree.
  const allDisabled =
    resolutions.length > 0 && resolutions.every((entry) => entry.disabled === true);

  return [
    allDisabled
      ? 'DeFlow cannot start this run: every provider registered here is disabled in Settings. ' +
        'Enable one at /settings to let DeFlow use it — reinstalling or restarting will not change this.'
      : // The parenthesis is the one thing a reader cannot work out for
        // themselves: admission is a read of what the daemon found when it
        // started (AC6), so an adapter installed since then is invisible
        // until it restarts. Without this sentence the operator's next move
        // after a successful `npm install -g` is to run the same command
        // again and be refused again.
        'DeFlow cannot start this run: no agent adapter on this machine can serve it. ' +
        '(This is what DeFlowd found when it started — if you have installed one since, restart it ' +
        'with "deflow up".)',
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
 *
 * **KAR-19.10 amended what "usable" means, not what the order is.** The filter
 * was `state === 'installed'`, which excluded a vendor CLI with no ACP bridge —
 * the exact machine whose run then selected it anyway through `spec.shim.bin`.
 * A provider with one open route is usable *for the turns that route serves*,
 * and admission says which; a provider with none is not here at all.
 */
export function usableProviders(
  resolutions: readonly ProviderResolution[],
): readonly ProviderResolution[] {
  const usable = resolutions.filter(hasUsableRoute);
  return [...usable.filter((e) => !e.bundled), ...usable.filter((e) => e.bundled)];
}

/**
 * KAR-22.2 AC2, AC3 — one row of the composer's adapter picker.
 *
 * Everything on it is read off the reduction above rather than decided here.
 * The picker is the **fourth** reader of this producer, after `doctor`,
 * admission and the chain's selection, and it is the one that arrived last and
 * with a probe of its own most readily to hand: a browser asking "which agents
 * can I use" looks exactly like a browser that should go and find out. It must
 * not, and this shape is what makes not doing so the easy path — there is
 * nothing here a caller could compute that it could not also read.
 */
export interface ProviderOption {
  readonly id: string;
  readonly state: AgentInstallState;
  /** Whether a run may be started on it — `usableProviders`' own answer. */
  readonly available: boolean;
  /** The route the run's next turn would take, or `null` for a dead end. */
  readonly route: ProviderRoute | null;
  readonly routes: ProviderRoutes;
  /** `providerVerdict`'s sentence — the one `doctor` prints (KAR-19.2 AC3). */
  readonly reason: string;
  /** The command that would fix it, or `null` where nothing needs fixing. */
  readonly action: string | null;
  /** KAR-19.10 AC7's sentence for a provider that is usable but partial. */
  readonly limitation: string | null;
}

/**
 * KAR-22.2 AC2 — every registered provider, as the picker shows it.
 *
 * **Ordered the way admission would choose**, usable first and in
 * `usableProviders`' own order, then everything else in the order it arrived.
 * That is not cosmetic: the first row is what the composer preselects, and a
 * preselection that differed from what a submission with no `provider` field
 * would land on is a picker that quietly disagrees with admission about the
 * default — the same class of mismatch as 2026-08-13, one field along.
 *
 * Nothing is filtered out. A provider this machine cannot serve is a row that
 * says so, with the reason and the command, because "why is it not in the list"
 * is the question AC3 exists to answer and an absent row answers it with
 * silence.
 */
export function providerOptions(
  resolutions: readonly ProviderResolution[],
): readonly ProviderOption[] {
  const usable = usableProviders(resolutions);
  const rest = resolutions.filter((entry) => !usable.includes(entry));
  return [...usable, ...rest].map((resolution) => {
    const verdict = providerVerdict(resolution);
    return {
      id: resolution.provider,
      state: verdict.state,
      available: usable.includes(resolution),
      route: routeForNextTurn(resolution),
      routes: providerRoutes(resolution),
      reason: verdict.detail,
      action: verdict.action ?? null,
      limitation: renderRouteLimitation(resolution),
    };
  });
}

/**
 * KAR-19.10 AC7 — what a partially-capable machine is told, at admission.
 *
 * The install sentence is KAR-18.8's and is unchanged; what this adds is *which
 * turn* the missing route costs. Discovering it at the first agent node instead
 * costs a framing turn, a recon turn, a planner turn and the operator's belief
 * that the run was working — all of it knowable before the 201.
 */
export function renderRouteLimitation(resolution: ProviderResolution): string | null {
  const routes = providerRoutes(resolution);
  const unserved = unservedTurns(routes);
  if (unserved.length === 0) return null;
  return (
    `${resolution.provider} can serve this run's ${turnsServedBy(routes).join(', ')} turns ` +
    `through its exec shim at ${resolution.vendorPath}, but not ${unserved.join(', ')}: that ` +
    'needs the ACP route, and this machine cannot open it. ' +
    // `providerVerdict` and not a second sentence composed here. A machine
    // whose bridge is *absent* and one whose bridge is *present and broken*
    // need opposite next actions — install versus repair — and KAR-19.2 AC3
    // already settled that there is one renderer of that difference. Writing
    // an install command here would have told the operator of a broken bridge
    // to install a package they already have, which is the exact failure
    // KAR-18.8 removed from `doctor`.
    providerVerdict(resolution).detail
  );
}

/** The choice, as the record everything downstream obeys. `null` for a
 * resolution with no open route — the caller refuses rather than announcing. */
function chooseFrom(resolution: ProviderResolution): ChosenProvider | null {
  const route = routeForNextTurn(resolution);
  if (route === null) return null;
  const binaryPath = binaryForRoute(resolution, route);
  if (binaryPath === null) return null;
  return {
    provider: resolution.provider,
    route,
    binaryPath,
    routes: providerRoutes(resolution),
    unserved: unservedTurns(providerRoutes(resolution)),
    resolution,
  };
}

/**
 * KAR-19.2 AC7's vocabulary, chosen from the machine rather than from the call
 * site.
 *
 * A bridge that is installed and broken is a different sentence and a different
 * next action from one that was never installed, and it wins the code wherever
 * it appears: it is the more specific fact about this machine. KAR-19.10 is why
 * this is a function — after the route amendment a broken bridge over a working
 * vendor CLI is *admitted* by default (it can still frame), so the only way
 * left to be refused by one is to name it, and the code has to be the same one
 * there or AC7 would have been deleted by a story that never mentioned it.
 */
const refusalCodeFor = (resolutions: readonly ProviderResolution[]): RunRefusalCode =>
  resolutions.some((entry) => entry.state === 'handshake-failed')
    ? RUN_REFUSAL_CODES.handshakeFailed
    : RUN_REFUSAL_CODES.noUsableProvider;

const refusedProvider = (entry: ProviderResolution): RefusedProvider => ({
  id: entry.provider,
  state: entry.state,
  vendorPath: entry.vendorPath,
  adapterPackage: entry.package,
});

/** A refusal over a chosen subset of the machine, with `doctor`'s own words. */
function refuse(
  resolutions: readonly ProviderResolution[],
  message: string,
  code: RunRefusalCode,
): RunAdmission {
  return {
    outcome: 'refused',
    code,
    message,
    providers: resolutions.map(refusedProvider),
    resolutions,
  };
}

/** KAR-19.10 AC1 — what the operator asked for, if they asked. */
export interface RunAdmissionRequest {
  /** A registry id. Validated before it gets here; an id nothing registers is
   * an argument error (`EX_USAGE`), never an admission decision. */
  readonly provider?: string | undefined;
}

/**
 * Can anything here serve a run, on which provider, and by which route? —
 * answered before the 201, from the manifest.
 *
 * The bug this exists to stop is the *other* reduction: inferring admission
 * from "is any binary on `PATH`", which admits the machine that has a vendor
 * CLI and no bridge and then does nothing at all. KAR-19.10 added the second
 * and third questions, and one rule about the difference between them:
 *
 * **An explicitly named provider is honoured exactly, or the run is refused.**
 * Without `--provider` a partial machine is admitted with its limitation
 * stated (AC7) — DeFlow chose the best of what was there and says what that
 * costs. With `--provider` it is refused with the turn named (AC8), because the
 * operator ruled out the alternative: admitting would mean either falling back
 * later, which is the defect this whole story is about, or dying at the node,
 * which is the defect the story before it was about.
 */
export function admitRun(
  resolutions: readonly ProviderResolution[],
  request: RunAdmissionRequest = {},
): RunAdmission {
  const requested = request.provider;

  if (requested !== undefined) {
    const named = resolutions.filter((entry) => entry.provider === requested);
    const only = named[0];
    // An id the registry does not hold never reaches here — the CLI refuses it
    // with `EX_USAGE` and the HTTP route rejects the body — so an empty list is
    // a registered provider this daemon has no resolution for, which is the
    // same fact as "not installed" and gets the same refusal.
    if (only === undefined || !hasUsableRoute(only)) {
      return refuse(named, renderRefusal(named), refusalCodeFor(named));
    }
    const limitation = renderRouteLimitation(only);
    if (limitation !== null) {
      return refuse(
        named,
        [
          `DeFlow cannot start this run on "${requested}": you named it explicitly, and it cannot ` +
            'serve every turn this run will take. DeFlow will not quietly run part of it on ' +
            'something else.',
          limitation,
          MOCK_AGENT_SENTENCE,
        ].join('\n\n'),
        refusalCodeFor(named),
      );
    }
    return { outcome: 'admitted', chosen: chooseFrom(only), limitation: null };
  }

  const [best] = usableProviders(resolutions);
  if (best !== undefined) {
    return {
      outcome: 'admitted',
      chosen: chooseFrom(best),
      limitation: renderRouteLimitation(best),
    };
  }

  return refuse(resolutions, renderRefusal(resolutions), refusalCodeFor(resolutions));
}
