/**
 * KAR-05.3 — the verified provider table, encoded once.
 *
 * **This is the one file in `packages/adapters/src/` allowed to name vendors**,
 * and the exemption is narrow on purpose. KAR-05.2 AC5 forbids a per-vendor
 * *capability* matrix anywhere in this package, because a stale one does not
 * produce an error — it produces a wrong routing decision hours into a run, and
 * two of the five versions measured on 2026-08-02 were published that same day.
 * That rule is about what an agent can *do*, which is always read from a row
 * probed on this machine (`capabilities.ts`). This file is about how each
 * vendor is *invoked*, which cannot be probed: you have to know that OpenCode
 * takes a subcommand before you can ask it anything at all.
 *
 * So the trade is explicit. Invocation is a table here; capability is never a
 * table anywhere. `test/no-capability-table.test.ts` holds both halves — it
 * exempts this file from the vendor-name rule and, in exchange, asserts that
 * this file names no capability and imports nothing from `capabilities.ts`.
 *
 * **The finding that shapes the table** (verified 2026-08-02 by running a real
 * `initialize` handshake against each binary):
 *
 * | Vendor              | Kind    | Spawn                                    |
 * | ------------------- | ------- | ---------------------------------------- |
 * | Gemini CLI 0.53.1   | native  | `<abs>/gemini --acp`                     |
 * | Copilot CLI 1.0.77  | native  | `<abs>/copilot --acp`                    |
 * | OpenCode 1.18.11    | native  | `<abs>/opencode acp --cwd <worktree>`    |
 * | Claude Code 2.1.220 | adapter | `<abs>/claude-agent-acp`                 |
 * | Codex CLI 0.146.0   | adapter | `CODEX_PATH=<abs>/codex <abs>/codex-acp` |
 *
 * Claude Code and Codex **do not speak ACP** — verified absent from
 * `claude --help` (v2.1.220) and `codex --help` (v0.146.0), grepped, zero hits
 * — and the PRD's §4.7 claim that they do is contradicted as stated. They reach
 * ACP only through the `@agentclientprotocol/*` bridge packages, which is why
 * `kind` exists: an `adapter` entry spawns something the vendor did not write,
 * and KAR-05.7's conformance battery has to target those, not the natively-ACP
 * agents.
 *
 * Adding a vendor is one entry in `PROVIDER_SPECS`. If it ever needs a new
 * field on `ProviderSpec`, that is the signal that the assumption "every agent
 * speaks ACP the same way" leaked somewhere else too.
 *
 * Verifies: EPIC-05-S10 · AC1, AC2, AC3
 */
import type {
  ClaudeSandboxInput,
  PermissionLevel,
  ProviderId,
  SandboxDegradation,
  TokenAccounting,
} from '@DeFlow/core';
import { claudeSandboxPolicy, ProviderIdSchema } from '@DeFlow/core';
import { MOCK_PROMPT_FLAG, MOCK_STRUCTURED_OUTPUT_FLAG } from '@DeFlow/mock-agent';
import { Buffer } from 'node:buffer';
import {
  type ArgumentAuditRow,
  type ArgumentProvenance,
  auditArgv,
  MAX_ARGV_ELEMENT_BYTES,
  type ShimArgument,
} from './argument-forms.ts';
import {
  type ResolveContext,
  type ResolvedProvider,
  resolveExecutable,
} from './binary-resolver.ts';
import { permissionInexpressible, registryRefused, unsupportedOutputFormat } from './failures.ts';
import type { SessionIdSpec } from './vendor-session.ts';

/**
 * `native` speaks ACP itself; `adapter` reaches it through a bridge package
 * that drives the vendor CLI underneath.
 *
 * Load-bearing rather than descriptive: an adapter's fidelity to the CLI it
 * wraps is A0-2's risk to the whole ACP-first thesis, and the conformance
 * suite selects on this.
 */
export type ProviderKind = 'native' | 'adapter';

/** Everything the invocation of one vendor can depend on. */
export interface SpawnContext {
  readonly resolved: ResolvedProvider;
  /** The node's worktree. The one vendor that takes it takes it in argv. */
  readonly worktree: string;
  /**
   * Which argv variant to build, 0-based and defaulting to 0.
   *
   * Exactly one vendor has more than one, and only while a flag of its is
   * mid-deprecation. It is a number rather than a boolean so that "exactly one
   * retry" is a bound the launcher reads off the spec (`argvVariants`) instead
   * of a rule it remembers.
   */
  readonly variant?: number;
}

/** One resolved invocation: what to run, with what, and with what environment. */
export interface SpawnPlan {
  /** Absolute. Never a bare name for `PATH` to answer at spawn time. */
  readonly command: string;
  readonly argv: readonly string[];
  /** The **vendor-specific** entries only, merged over the daemon's own env by
   * whoever spawns. Empty for every vendor that needs none. */
  readonly env: NodeJS.ProcessEnv;
}

/**
 * The wire an exec-shim invocation asks the vendor for (KAR-05.8).
 *
 * `jsonl` is not a fourth spelling of `stream-json`: the two are both
 * one-JSON-object-per-line and are still not the same format, and collapsing
 * them in the type is how a shim ends up parsing one as the other.
 */
export const SHIM_FORMATS = ['text', 'json', 'stream-json', 'jsonl'] as const;
export type ShimFormat = (typeof SHIM_FORMATS)[number];

/**
 * Which parser family reads the vendor's output.
 *
 * `document` is a single JSON object for the whole invocation rather than a
 * stream of lines, and it is what a vendor with no streaming format leaves you
 * with — no incremental progress, and one `uuid`-less result to file.
 */
export type ShimDialect = 'stream-json' | 'jsonl' | 'document';

/** Everything one shim invocation can depend on. */
export interface ShimContext {
  /** The **vendor CLI** itself, not the ACP bridge — the shim needs no bridge. */
  readonly resolved: ResolvedProvider;
  readonly worktree: string;
  readonly prompt: string;
  /** Client-chosen, and verified honoured verbatim in every emitted frame. */
  readonly sessionId: string;
  readonly permission: PermissionLevel;
  /** Omitted means the vendor's richest streaming format. */
  readonly format?: ShimFormat;
  /**
   * KAR-09.9 AC2 — the emitted JSON Schema document this turn must return
   * against, as an absolute path under `.DeFlow/schemas/`.
   *
   * Omitted means no return contract was declared, or the vendor has no flag
   * for one — and in the second case the argv is unchanged rather than
   * approximated, because the schema then travels in the prompt instead
   * (`structured-output.ts`). A path here on a vendor with no
   * `structuredOutputFlag` is silently *not* passed, which is the one place
   * that would be a lie if the mechanism were not also recorded.
   *
   * **KAR-19.11 — still supplied for every vendor, still written to disk, and
   * no longer automatically what goes on the flag.** Whether the path or the
   * document below reaches the command line is the entry's declared form, and
   * the file is written either way so that an operator can read afterwards what
   * the turn was asked for (NF8).
   */
  readonly schemaPath?: string;
  /**
   * KAR-19.11 AC1 — the schema document's own bytes, for a vendor whose entry
   * declares its structured-output argument `inline-json`.
   *
   * Claude Code 2.1.220 `JSON.parse`s the value of `--json-schema` and exits 1
   * when it does not parse: on 2026-08-13 it was handed an absolute path and
   * said so, `Unrecognized token '/'`. The document is carried here rather than
   * read from `schemaPath` because this package performs no I/O — and because a
   * registry that opened files would turn a construction-time refusal into an
   * `ENOENT` at the least convenient moment.
   *
   * Omitting it for a vendor that wants the document inline is a **refusal**,
   * not a fallback to the path. Falling back is precisely the bug.
   */
  readonly schemaDocument?: string;
  /**
   * KAR-14.2 AC9 — the node's own cost ceiling, in USD, armed on the vendor's
   * *own* budget flag as defence in depth below DeFlow's.
   *
   * Omitted means no ceiling was set for this node, and the argv is unchanged.
   * A vendor with no `costCeilingFlag` is also unchanged rather than
   * approximated: DeFlow's ceiling still applies either way, and a spawn that
   * dies on an unknown option is a worse outcome than an unarmed second line of
   * defence.
   */
  readonly costCeilingUsd?: number;
}

/**
 * How one vendor is driven headlessly, as data.
 *
 * Separate from the ACP `bin`/`argv` above because the two are genuinely
 * different invocations of different binaries: KAR-05.3 spawns the bridge that
 * speaks ACP, and this spawns the CLI the bridge would have driven.
 */
export interface ShimSpec {
  readonly bin: string;
  /** Every `--output-format` value this vendor accepts. Not uniform. */
  readonly formats: readonly ShimFormat[];
  /** The default: the richest streaming format the vendor has. */
  readonly stream: ShimFormat;
  readonly dialect: ShimDialect;
  /**
   * The permission levels this vendor's own flags can express.
   *
   * A level absent from this list is **refused**, never approximated. On the
   * shim path DeFlow is not in front of the agent's file access, so the
   * vendor's flag is the only enforcement there is; picking the nearest one
   * would run the node at a level nobody chose.
   */
  readonly permissions: readonly PermissionLevel[];
  /**
   * KAR-08.5 — how this vendor takes a complete sandbox policy inline, when it
   * can take one at all.
   *
   * Absent for every vendor but Claude Code, whose acceptance of a whole
   * settings document *as a string on the argv* is what makes per-node policy
   * possible without DeFlow reading or writing the operator's own settings
   * files. Both halves live here for the same reason the argv builders do —
   * which flag a vendor accepts, and which dialect it speaks, cannot be
   * probed, and this is the one file allowed to know either.
   */
  readonly sandbox?: SandboxSettingsInjection;
  /**
   * KAR-09.9 AC2 — the flag this vendor takes a JSON Schema file on, so a
   * return contract is enforced by the CLI rather than by a paragraph of
   * prompt.
   *
   * Absent for every vendor that has none, and absence is the *answer* rather
   * than a gap: `structured-output.ts` reads it to decide between `'native'`
   * and `'prompt-only'`, and the manifest records which was used. It is
   * invocation knowledge like every other field here — nothing in an ACP
   * `initialize` response advertises structured output, which is precisely why
   * it cannot be probed.
   */
  readonly structuredOutputFlag?: string;
  /**
   * KAR-11.1 AC8 — the flag this vendor takes a reasoning-effort setting on,
   * and the ladder of values it accepts, weakest to strongest.
   *
   * Absent for every vendor that exposes no such control, and the absence is
   * the *answer* rather than a gap: `planner-effort.ts` reads it to resolve
   * "strongest available" for the initial `PlanGraph` (06 §6), and a vendor
   * without one plans at whatever its default is. Invocation knowledge like
   * every other field here — no ACP `initialize` response mentions a reasoning
   * effort, which is precisely why it cannot be probed.
   *
   * Both halves are stated because neither implies the other: a flag with no
   * ladder gives nothing to pass, and a ladder with no flag gives nowhere to
   * pass it.
   */
  readonly effortFlag?: string;
  readonly efforts?: readonly string[];
  /**
   * KAR-14.2 AC9 — the flag this vendor takes its own spend ceiling on.
   *
   * Only Claude Code has one (`--max-budget-usd <amt>`, verified 2026-08-02
   * from the 2.1.220 flag table). Copilot CLI's `--max-ai-credits` is the same
   * shape in a different unit and belongs here once its exit behaviour has been
   * verified — an unverified row would arm a ceiling nobody has watched fire.
   */
  readonly costCeilingFlag?: string;
  /**
   * KAR-08.5 / EPIC-08-S23 — the flag this vendor takes a list of variable
   * names to strip from the environments of processes *it* spawns (and to
   * redact from its output).
   *
   * Only Copilot CLI has one. It is one more enforcement point on the same
   * secret, past the boundary `buildChildEnv()` can see.
   */
  readonly secretEnvFlag?: string;
  /**
   * KAR-19.8 AC8 — the flag this vendor takes a client-chosen session id on,
   * and **the form it must be in**.
   *
   * Absent for every entry whose `build` passes no session id, and the absence
   * is checked rather than assumed (`test/exec-shim-session-id.test.ts`
   * asserts that an entry declaring nothing puts nothing on the argv).
   *
   * The form is here rather than in a test because it is invocation knowledge
   * like every other field on this interface: nothing probes it, and on
   * 2026-08-13 the one value nobody had written down — Claude Code 2.1.220
   * validates `--session-id` as a UUID and exits 1 otherwise — cost an operator
   * their afternoon.
   */
  readonly sessionId?: SessionIdSpec;
  /**
   * KAR-19.11 AC3 — **the audit**: every element this entry's `build` can put
   * on the command line, with the shape it must be in and how that shape is
   * known.
   *
   * The artefact of an audit that would otherwise have been a reading exercise.
   * Two arguments in two days were found wrong by running the product, so the
   * interesting question was how many were left — and nothing in the repository
   * could answer it, because no argument had a declared shape and no test could
   * fail on one. Now `shimInvocation` positions the structured-output argument
   * *from this table* rather than assuming a path, and
   * `test/exec-shim-argument-forms.test.ts` fails any element the table does
   * not declare.
   *
   * Every row carries provenance, and the three claims are kept apart: read
   * from `--help`, decoded from the bundle, or executed against the real
   * binary. The rows that have never been executed are the work list for the
   * opt-in vendor-CLI battery (EPIC-19-S77).
   */
  readonly arguments: readonly ShimArgument[];
  /** Absolute paths for the vendor CLI, or a tagged `adapter.spawn-failed`. */
  resolve(ctx: ResolveContext): ResolvedProvider;
  /**
   * The validated argv for one invocation.
   *
   * Refuses an unsupported format and an inexpressible permission level before
   * returning a single string, which is what makes AC3's rejection a
   * construction-time fact rather than a stderr line from a spawned process.
   */
  argv(ctx: ShimContext): readonly string[];
}

/**
 * KAR-08.5 — one vendor's inline sandbox policy: the flag, and the generator
 * that speaks its dialect.
 *
 * The generator lives in `@DeFlow/core` (pure, golden-filed); what is recorded
 * here is only *which* one this vendor understands, which is invocation
 * knowledge like every other field on `ShimSpec`.
 */
export interface SandboxSettingsInjection {
  /** The flag the document rides on. One argument follows it: the JSON. */
  readonly flag: string;
  build(input: ClaudeSandboxInput): {
    readonly settings: unknown;
    readonly degraded: readonly SandboxDegradation[];
  };
}

/** One resolved shim invocation, plus what the parser needs to read it back. */
export interface ShimPlan extends SpawnPlan {
  readonly format: ShimFormat;
  readonly dialect: ShimDialect;
}

interface ShimEntry {
  readonly bin: string;
  readonly formats: readonly ShimFormat[];
  readonly stream: ShimFormat;
  readonly dialect: ShimDialect;
  /**
   * The flags that express each level. A level missing from the record is one
   * this vendor cannot express; an empty array is one its **default** already
   * is, which is not the same claim and is why the two are spelled apart.
   */
  readonly permissions: Partial<Record<PermissionLevel, readonly string[]>>;
  readonly sandbox?: SandboxSettingsInjection;
  readonly structuredOutputFlag?: string;
  /** KAR-11.1 AC8 — the reasoning-effort flag and ladder; see `ShimSpec`. */
  readonly effortFlag?: string;
  readonly efforts?: readonly string[];
  /** KAR-14.2 AC9 — the vendor's own spend ceiling flag; see `ShimSpec`. */
  readonly costCeilingFlag?: string;
  readonly secretEnvFlag?: string;
  /** KAR-19.8 AC8 — the session-id flag and its form; see `ShimSpec`. */
  readonly sessionId?: SessionIdSpec;
  /** KAR-19.11 AC3 — the declared shape of every element; see `ShimSpec`. */
  readonly arguments: readonly ShimArgument[];
  build(
    ctx: ShimContext,
    format: ShimFormat,
    permissionFlags: readonly string[],
  ): readonly string[];
}

export interface ProviderSpec {
  readonly id: ProviderId;
  readonly kind: ProviderKind;
  /**
   * KAR-09.7 — which model family this vendor's CLI drives, and therefore
   * which token-estimate seed applies before measurement replaces it.
   *
   * Here rather than in `capabilities.ts` because it is not a capability: it
   * cannot be probed, it does not change when the binary is upgraded, and it
   * is the same kind of fact as "OpenCode takes a subcommand". `'default'` is
   * a real answer and the honest one for every vendor whose token accounting
   * is Unverified (roadmap A4-3) — it selects a 1.05 correction that five
   * completed nodes then replace with the measured ratio.
   */
  readonly family: string;
  /**
   * KAR-14.1 AC4 — what this vendor's CLI reports about what a turn cost, and
   * therefore whether a cost figure attributed to it means anything.
   *
   * Here for the same reason `family` is: it cannot be probed. An `initialize`
   * response describes what an agent can *do*; nothing in it says whether the
   * binary underneath prints a token count when it finishes. It is also not a
   * capability — nothing routes on it, and a provider that reports nothing is
   * scheduled exactly as before; what changes is that its cost cell is blank
   * instead of zero.
   *
   * `'none'` is the honest default and the one this table mostly holds:
   * roadmap A4-3 records that only two of the five adapters were ever checked.
   */
  readonly tokenAccounting: TokenAccounting;
  /**
   * KAR-09.6 AC7, AC8 — how this vendor's own auto-compaction is steered, or
   * absent for a vendor that exposes no such lever.
   *
   * It belongs in this file for the same reason argv does: it is a fact about
   * *invocation* that cannot be probed. It is not a capability — nothing routes
   * on it, and a vendor without it degrades to "the vendor's own defaults",
   * which is what every provider got before this existed.
   */
  readonly compaction?: CompactionSpec;
  /**
   * KAR-19.7 AC8 — true for a binary that ships inside DeFlow's own tarball
   * rather than being installed by the operator.
   *
   * Two things read it, and both are about not lying to the operator.
   * `providerVerdict` must never offer `npm install -g` for a package they
   * already have (KAR-18.8's rule that the words have to fit the machine), and
   * `usableProviders` puts bundled entries **last**, so a machine with a real
   * vendor installed never quietly routes a run onto the test double. Absent
   * means `false`, which is the answer for every vendor.
   */
  readonly bundled?: boolean;
  /** The bin name of the package that actually speaks ACP. */
  readonly bin: string;
  /** That package, at the version the spawn was verified against. */
  readonly package: string;
  /** The vendor CLI an adapter drives, where the adapter is not the CLI. */
  readonly companionBin?: string;
  /** How many argv variants exist. More than one only mid-deprecation. */
  readonly argvVariants: number;
  /** Absolute paths for this provider, or a tagged `adapter.spawn-failed`. */
  resolve(ctx: ResolveContext): ResolvedProvider;
  argv(ctx: SpawnContext): readonly string[];
  env(ctx: SpawnContext): NodeJS.ProcessEnv;
  /** KAR-05.8 — the non-ACP fallback: the same vendor, driven by flags. */
  readonly shim: ShimSpec;
}

/**
 * One vendor's compaction lever, decoded from its shipping bundle.
 *
 * **Every number and name here came from Claude Code 2.1.220**, they are
 * private implementation details with no compatibility guarantee, and they will
 * change. Nothing derived from them hardcodes a *window*: `contextWindow` and
 * `maxOutputTokens` are read off the turn's `modelUsage` at runtime, and these
 * two constants are the offsets applied to whatever the turn reported. That is
 * why they sit in the registry beside the flags rather than in `@DeFlow/core`,
 * and why `checkCompactionShape` exists to catch the day they stop being true.
 */
export interface CompactionSpec {
  /** The variable that moves the auto-compaction threshold (AC7). */
  readonly pctEnv: string;
  /**
   * Where this vendor keeps a session's own transcript, as path segments under
   * `$HOME`, or absent for a vendor that documents none.
   *
   * **Unverified** (AC6): the convention was read from the bundle and never
   * exercised against a live authenticated session, so a caller treats a
   * missing file as `originalHandle: null` rather than as an error.
   */
  readonly transcriptDir?: readonly string[];
  /** The variable that turns auto-compaction off entirely (AC8). */
  readonly disableEnv: string;
  /** The largest output reservation subtracted from the reported window. */
  readonly outputReserve: number;
  /** How far below the effective window auto-compaction fires. */
  readonly autoCompactOffset: number;
}

interface SpecEntry {
  readonly id: string;
  readonly kind: ProviderKind;
  /** Absent means `false` — see `ProviderSpec.bundled`. */
  readonly bundled?: boolean;
  readonly compaction?: CompactionSpec;
  /** Absent means `'default'` — see `ProviderSpec.family`. */
  readonly family?: string;
  /** Absent means `'none'` — see `ProviderSpec.tokenAccounting`. */
  readonly tokenAccounting?: TokenAccounting;
  readonly bin: string;
  readonly package: string;
  readonly companionBin?: string;
  /**
   * One argv builder per variant, in the order they are attempted. Data rather
   * than a branch inside `argv`, so "the deprecated flag is tried second and
   * only second" is visible in the entry.
   */
  readonly variants: readonly ((ctx: SpawnContext) => readonly string[])[];
  readonly env?: (ctx: SpawnContext) => NodeJS.ProcessEnv;
  readonly shim: ShimEntry;
}

const NO_ENV: NodeJS.ProcessEnv = {};

/** The family a vendor nobody has measured belongs to (KAR-09.7 AC5). */
export const DEFAULT_MODEL_FAMILY = 'default';

/**
 * What an unstated accounting fidelity means: DeFlow cannot price this
 * provider's turns.
 *
 * Not `'estimated'`. An estimate is a number somebody would chart, and
 * charting a number for a vendor nobody has measured is how an F4.6 ceiling
 * ends up enforced against fiction. `'none'` produces a blank cost cell, which
 * is recoverable — the operator sees that DeFlow does not know.
 */
export const UNMEASURED_TOKEN_ACCOUNTING: TokenAccounting = 'none';

/** The declaration this entry carries for `flag`, or `undefined`. */
function declaredArgument(entry: ShimEntry, flag: string): ShimArgument | undefined {
  return entry.arguments.find((argument) => argument.flag === flag);
}

/**
 * The schema id a document names itself by, for a message and for a log line.
 *
 * Read from the document's own `title` — which is what
 * `@DeFlow/core`'s emitter writes and what `deflow-mock-agent` reads back — and
 * falling back to the file name the contract chose. Never invented: a refusal
 * that named the wrong schema would be worse than one that named none.
 */
export function schemaIdOf(input: {
  readonly schemaDocument?: string;
  readonly schemaPath?: string;
}): string | null {
  if (input.schemaDocument !== undefined) {
    try {
      const parsed = JSON.parse(input.schemaDocument) as Record<string, unknown>;
      const title = parsed['title'];
      if (typeof title === 'string' && title !== '') return title;
    } catch {
      // Unparseable is exactly the case this whole story is about, and it is
      // the path's turn to answer.
    }
  }
  if (input.schemaPath === undefined) return null;
  const file = input.schemaPath.split('/').at(-1) ?? '';
  return file.replace(/\.json$/, '') || null;
}

/**
 * KAR-19.11 AC1, AC2, AC8 — the structured-output argument, positioned from the
 * form its own entry declares.
 *
 * The line this replaces was `[entry.structuredOutputFlag, ctx.schemaPath]`,
 * for every vendor, from one place — and that single unexamined assumption is
 * the whole defect. Codex CLI documents `--output-schema <FILE>` and the bundled
 * agent takes a path; Claude Code 2.1.220 `JSON.parse`s what it is handed. Both
 * are now data on the entry rather than a branch here, so the fix cannot swing
 * the assumption the other way and break the two entries that were right.
 *
 * Three refusals, all at construction, none of them an errno:
 *
 * - an entry whose structured-output flag has **no declared form** does not
 *   fall back to a path (falling back is the bug);
 * - a vendor that wants the document inline and was handed only a path is
 *   refused by name, rather than sending the path and learning from the child;
 * - a document larger than one argv element is refused naming the limit and the
 *   schema id, rather than arriving as `E2BIG` from `spawn` on the largest and
 *   most important turn of the run.
 */
function schemaArgument(id: string, entry: ShimEntry, ctx: ShimContext): readonly string[] {
  const flag = entry.structuredOutputFlag;
  if (flag === undefined) return [];

  const declared = declaredArgument(entry, flag);
  if (declared === undefined) {
    throw registryRefused(
      `${id} declares ${flag} as its structured-output flag but no form for it, and there is no ` +
        'default: assuming a schema argument is a path is the assumption that made claude exit 1 ' +
        'on "--json-schema is not valid JSON" — declare the form on the entry',
      { provider: id, flag },
    );
  }

  if (declared.form === 'abs-path') {
    return ctx.schemaPath === undefined ? [] : [flag, ctx.schemaPath];
  }

  if (declared.form !== 'inline-json') {
    throw registryRefused(
      `${id} declares ${flag} as ${declared.form}, which is not a shape a schema can be sent in`,
      { provider: id, flag, form: declared.form },
    );
  }

  if (ctx.schemaDocument === undefined) {
    // No contract at all: the argv is unchanged, exactly as before.
    if (ctx.schemaPath === undefined) return [];
    throw registryRefused(
      `${id} takes its schema document inline on ${flag} and was given only the path ` +
        `${ctx.schemaPath}. It parses the value as JSON and exits 1 on a leading "/", which is ` +
        'the failure of 2026-08-13 19:59 — supply ShimContext.schemaDocument',
      { provider: id, flag, schemaPath: ctx.schemaPath },
    );
  }

  const document = strippedForVendor(id, declared, ctx.schemaDocument);

  const bytes = Buffer.byteLength(document, 'utf8');
  if (bytes > MAX_ARGV_ELEMENT_BYTES) {
    const schemaId = schemaIdOf(ctx) ?? 'an unnamed schema';
    throw registryRefused(
      `the ${schemaId} document is ${bytes} bytes and one argv element holds at most ` +
        `${MAX_ARGV_ELEMENT_BYTES}, so ${id} cannot be handed it on ${flag}. Refused here rather ` +
        'than as an E2BIG errno from spawn, which is what the kernel would have said instead',
      { provider: id, flag, schemaId, bytes, limit: MAX_ARGV_ELEMENT_BYTES },
    );
  }

  // One argv element, never shell-interpolated: `spawn` without a shell is what
  // makes quoting a non-issue for a document full of braces and quotes.
  return [flag, document];
}

/**
 * KAR-19.11 — the schema document as *this vendor's* validator will accept it.
 *
 * The third finding of the same evening, and the reason the audit is worth more
 * than either fix. With the document sent inline, Claude Code 2.1.220 got past
 * its `JSON.parse` and refused the layer below: `Error: --json-schema is not a
 * valid JSON Schema: no schema with key or ref
 * "https://json-schema.org/draft/2020-12/schema"`. Its bundled validator has no
 * 2020-12 meta-schema registered, so the dialect DeFlow declares is a ref it
 * cannot resolve, and the same document without that one key completes the turn.
 *
 * Only the vendor's copy is changed. The file under the run's `.DeFlow/schemas/`
 * is written whole and named by schema id, so what an operator reads afterwards
 * is exactly what `deflow init` emitted (NF8).
 */
function strippedForVendor(id: string, declared: ShimArgument, document: string): string {
  const strip = declared.stripKeys ?? [];
  if (strip.length === 0) return document;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(document) as Record<string, unknown>;
  } catch (error) {
    throw registryRefused(
      `${id} takes its schema inline on ${declared.flag} and the document supplied is not JSON ` +
        `(${(error as Error).message})`,
      { provider: id, flag: declared.flag },
    );
  }

  const kept = Object.fromEntries(Object.entries(parsed).filter(([key]) => !strip.includes(key)));
  return JSON.stringify(kept);
}

/**
 * The two refusals every shim invocation is checked against, in one place.
 *
 * Both are construction-time on purpose. A format the vendor does not have
 * becomes a stderr line and a non-zero exit if it reaches the process, which
 * costs a spawn to learn something the table already knew; and a permission
 * level the vendor cannot express must never reach a process at all, because
 * the process is the thing that would then run at the wrong level.
 */
function shimInvocation(
  id: string,
  entry: ShimEntry,
  ctx: ShimContext,
): { format: ShimFormat; argv: readonly string[] } {
  const format = ctx.format ?? entry.stream;
  if (!entry.formats.includes(format)) {
    throw unsupportedOutputFormat(id, format, entry.formats);
  }

  const flags = entry.permissions[ctx.permission];
  if (flags === undefined) {
    throw permissionInexpressible(id, ctx.permission, Object.keys(entry.permissions));
  }

  // The schema rides in beside the permission flags rather than being placed by
  // each vendor's own `build`, because every builder already positions `flags`
  // where the vendor accepts options — Codex takes its prompt as a trailing
  // positional, so a flag appended after the whole argv would land as prompt
  // text. One insertion point, and no builder to forget it.
  const schema = schemaArgument(id, entry, ctx);

  // KAR-14.2 AC9, and it rides in beside the schema for the same reason: one
  // insertion point, and no vendor builder to forget it.
  const ceiling =
    entry.costCeilingFlag !== undefined && ctx.costCeilingUsd !== undefined
      ? [entry.costCeilingFlag, String(ctx.costCeilingUsd)]
      : [];

  return { format, argv: entry.build(ctx, format, [...flags, ...schema, ...ceiling]) };
}

function defineShim(rawId: string, entry: ShimEntry): ShimSpec {
  const id = ProviderIdSchema.parse(rawId);
  return {
    bin: entry.bin,
    formats: entry.formats,
    stream: entry.stream,
    dialect: entry.dialect,
    permissions: Object.keys(entry.permissions) as readonly PermissionLevel[],
    ...(entry.sandbox === undefined ? {} : { sandbox: entry.sandbox }),
    ...(entry.structuredOutputFlag === undefined
      ? {}
      : { structuredOutputFlag: entry.structuredOutputFlag }),
    ...(entry.effortFlag === undefined ? {} : { effortFlag: entry.effortFlag }),
    ...(entry.efforts === undefined ? {} : { efforts: entry.efforts }),
    ...(entry.costCeilingFlag === undefined ? {} : { costCeilingFlag: entry.costCeilingFlag }),
    ...(entry.secretEnvFlag === undefined ? {} : { secretEnvFlag: entry.secretEnvFlag }),
    ...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
    arguments: entry.arguments,
    resolve: (ctx: ResolveContext): ResolvedProvider => ({
      provider: id,
      path: resolveExecutable(id, entry.bin, ctx),
    }),
    argv: (ctx: ShimContext): readonly string[] => shimInvocation(id, entry, ctx).argv,
  };
}

function defineSpec(entry: SpecEntry): ProviderSpec {
  const id = ProviderIdSchema.parse(entry.id);
  return {
    shim: defineShim(entry.id, entry.shim),
    id,
    kind: entry.kind,
    ...(entry.bundled === undefined ? {} : { bundled: entry.bundled }),
    family: entry.family ?? DEFAULT_MODEL_FAMILY,
    tokenAccounting: entry.tokenAccounting ?? UNMEASURED_TOKEN_ACCOUNTING,
    ...(entry.compaction === undefined ? {} : { compaction: entry.compaction }),
    bin: entry.bin,
    package: entry.package,
    ...(entry.companionBin === undefined ? {} : { companionBin: entry.companionBin }),
    argvVariants: entry.variants.length,
    resolve(ctx: ResolveContext): ResolvedProvider {
      const path = resolveExecutable(id, entry.bin, ctx);
      if (entry.companionBin === undefined) return { provider: id, path };
      const companionPath = resolveExecutable(id, entry.companionBin, {
        roots: ctx.companionRoots ?? ctx.roots,
        ...(ctx.companionPath === undefined ? {} : { binaryPath: ctx.companionPath }),
      });
      return { provider: id, path, companionPath };
    },
    argv(ctx: SpawnContext): readonly string[] {
      const variant = ctx.variant ?? 0;
      const build = entry.variants[variant];
      if (build === undefined) {
        throw registryRefused(
          `${entry.id} has ${entry.variants.length} argv variant(s) and was asked for variant ` +
            `${variant}; the bounded fallback is the point — an unbounded one turns a clear ` +
            'failure into a slow one',
          { provider: entry.id, variant, variants: entry.variants.length },
        );
      }
      return build(ctx);
    },
    env: entry.env ?? ((): NodeJS.ProcessEnv => NO_ENV),
  };
}

/**
 * The audit's three provenance stamps, spelled once so they read as the three
 * different claims they are (KAR-19.11 AC3).
 *
 * `HELP_2026_08_02` and `BUNDLE_2026_08_02` are what the table already had, and
 * neither is evidence about a parser: the note above `structuredOutputFlag`
 * said **Verified 2026-08-02** from a bundle read, and the form it recorded was
 * wrong. `EXECUTED_2026_08_13` is on the two rows a real binary has actually
 * ruled on, and it cost an operator an afternoon to earn each of them.
 */
const HELP_2026_08_02: ArgumentProvenance = {
  how: 'help',
  on: '2026-08-02',
  note: "read from the installed binary's own --help",
};
const BUNDLE_2026_08_02: ArgumentProvenance = {
  how: 'bundle',
  on: '2026-08-02',
  note: "decoded from the vendor's shipping bundle; never run",
};
const DOCS_2026_08_02: ArgumentProvenance = {
  how: 'help',
  on: '2026-08-02',
  note: 'read from published documentation; the binary was not installed on the capture machine',
};
const OWN_BINARY: ArgumentProvenance = {
  how: 'executed',
  on: '2026-08-13',
  note: 'DeFlow ships this binary and its own suite runs it on every commit',
};

/** The prompt, which every entry passes and no vendor validates. */
const promptFlag = (flag: string): ShimArgument => ({
  name: 'prompt',
  flag,
  form: 'free-text',
  provenance: HELP_2026_08_02,
});

/**
 * The five verified providers.
 *
 * The three natively-ACP entries pass a flag or a subcommand; the two adapter
 * entries spawn a bridge binary and, for the one that needs it, point the
 * bridge at the vendor CLI through the environment rather than letting it
 * search (§4.3).
 */
export const PROVIDER_SPECS = {
  gemini: defineSpec({
    id: 'gemini',
    kind: 'native',
    bin: 'gemini',
    package: '@google/gemini-cli',
    // `--experimental-acp` still exists, and `--help` marks it "(deprecated,
    // use --acp instead)". Current flag first, one bounded fallback second.
    variants: [(): readonly string[] => ['--acp'], (): readonly string[] => ['--experimental-acp']],
    // Gemini CLI 0.53.1: `-p/--prompt`, `-o/--output-format
    // text|json|stream-json`, `--approval-mode default|auto_edit|yolo|plan`,
    // `--session-id`, `-r/--resume latest|<index>`. `--allowed-tools` is marked
    // "[DEPRECATED: Use Policy Engine instead]" and is deliberately unused.
    shim: {
      bin: 'gemini',
      formats: ['text', 'json', 'stream-json'],
      stream: 'stream-json',
      dialect: 'stream-json',
      permissions: {
        read: [],
        worktree: ['--approval-mode', 'auto_edit'],
        full: ['--approval-mode', 'yolo'],
      },
      // KAR-19.8 AC8. The flag is verified (`--help`, 2026-08-02); the **form**
      // is not — this vendor documents none, and no turn has ever been run
      // against it with a session id of another shape. `uuid` is therefore a
      // floor rather than a claim about its parser: it is the strictest form
      // any entry in this table demands and DeFlow supplies one value to every
      // vendor, so declaring it here means the day this vendor starts
      // validating the flag is a diff in this row rather than another afternoon
      // lost to the failure claude produced.
      sessionId: { flag: '--session-id', form: 'uuid' },
      // KAR-19.11 AC3. Every element this `build` can emit. `--session-id` is
      // the one row this vendor shares with the entry that broke, and it is
      // declared `uuid` for the reason above rather than because Gemini has
      // been seen to demand one — the provenance says `help`, not `executed`.
      arguments: [
        promptFlag('-p'),
        {
          name: 'output-format',
          flag: '--output-format',
          form: 'enum',
          values: ['text', 'json', 'stream-json'],
          provenance: HELP_2026_08_02,
        },
        { name: 'session-id', flag: '--session-id', form: 'uuid', provenance: HELP_2026_08_02 },
        {
          name: 'approval-mode',
          flag: '--approval-mode',
          form: 'enum',
          values: ['default', 'auto_edit', 'yolo', 'plan'],
          provenance: HELP_2026_08_02,
        },
      ],
      build: (ctx, format, flags) => [
        '-p',
        ctx.prompt,
        '--output-format',
        format,
        '--session-id',
        ctx.sessionId,
        ...flags,
      ],
    },
  }),
  copilot: defineSpec({
    id: 'copilot',
    kind: 'native',
    bin: 'copilot',
    package: '@github/copilot',
    variants: [(): readonly string[] => ['--acp']],
    // Copilot CLI 1.0.77: `-p/--prompt`, `--output-format text|json` — **no
    // `stream-json`** — `--stream on|off`, `--session-id`, `--allow-all-tools`
    // (required for non-interactive), `--secret-env-vars`.
    //
    // `--allow-all-tools` is unconditional because the CLI does nothing
    // headless without it, which means this vendor cannot express a level
    // *below* all-tools at all. That is recorded here as "only `read` is
    // expressible" rather than papered over: on this path DeFlow cannot
    // mediate anyway, and `read` is the one level that needs no mediation.
    shim: {
      bin: 'copilot',
      formats: ['text', 'json'],
      stream: 'json',
      dialect: 'document',
      permissions: { read: [] },
      // Verified in `--help` on 2026-08-02. KAR-08.5 fills it from the names
      // `buildChildEnv()` dropped; the flag is stated here because whether a
      // vendor has one is invocation, not capability.
      secretEnvFlag: '--secret-env-vars',
      // KAR-19.11 AC3. `--secret-env-vars` is emitted by `sandbox.ts` rather
      // than by this `build`, and it is declared here anyway: the audit is over
      // every argument DeFlow puts on this vendor's command line, not over one
      // function's return value.
      arguments: [
        promptFlag('-p'),
        {
          name: 'output-format',
          flag: '--output-format',
          form: 'enum',
          values: ['text', 'json'],
          provenance: HELP_2026_08_02,
        },
        {
          name: 'allow-all-tools',
          flag: '--allow-all-tools',
          form: 'free-text',
          valueless: true,
          provenance: HELP_2026_08_02,
        },
        {
          name: 'secret-env-vars',
          flag: '--secret-env-vars',
          form: 'free-text',
          provenance: HELP_2026_08_02,
        },
      ],
      build: (ctx, format) => ['-p', ctx.prompt, '--output-format', format, '--allow-all-tools'],
    },
  }),
  opencode: defineSpec({
    id: 'opencode',
    kind: 'native',
    bin: 'opencode',
    package: 'opencode-ai',
    // A subcommand, not a flag — and it takes the worktree itself.
    variants: [(ctx): readonly string[] => ['acp', '--cwd', ctx.worktree]],
    // OpenCode 1.18.11: `opencode run [message..] --format default|json`,
    // `-c/--continue`, `-s/--session`, `--fork`. There is no permission flag of
    // any kind, so `read` is the only level it can be asked for.
    shim: {
      bin: 'opencode',
      formats: ['text', 'json'],
      stream: 'json',
      dialect: 'document',
      permissions: { read: [] },
      // KAR-19.11 AC3. Two positionals, declared rather than inferred: the
      // subcommand leads and the message trails, and the audit matches them in
      // this order among the tokens no flag claimed.
      arguments: [
        {
          name: 'subcommand',
          flag: null,
          form: 'enum',
          values: ['run'],
          provenance: HELP_2026_08_02,
        },
        {
          name: 'format',
          flag: '--format',
          form: 'enum',
          values: ['default', 'json'],
          provenance: HELP_2026_08_02,
        },
        { name: 'prompt', flag: null, form: 'free-text', provenance: HELP_2026_08_02 },
      ],
      // KAR-19.11 AC3 — **the audit's third finding.** This vendor's flag is
      // `--format default|json`; it has no value spelled `text`, and DeFlow's
      // own `ShimFormat` vocabulary calls that same thing `text`. The builder
      // used to pass DeFlow's spelling straight through, so `--format text`
      // would have been refused by the real binary the first time anyone asked
      // for a non-streaming turn on OpenCode — the same class of defect as
      // `--json-schema`, found by the same table rather than by an operator.
      build: (ctx, format, flags) => [
        'run',
        '--format',
        format === 'json' ? 'json' : 'default',
        ...flags,
        ctx.prompt,
      ],
    },
  }),
  claude: defineSpec({
    id: 'claude',
    // Verified 2026-08-02: the result envelope carries a typed `modelUsage`.
    tokenAccounting: 'exact',
    family: 'anthropic',
    kind: 'adapter',
    // Decoded from the 2.1.220 bundle: the CLI reserves
    // `min(maxOutputTokens, 20_000)` of the reported window and auto-compacts
    // 13_000 tokens below what is left, and it applies the percentage override
    // as `Math.min(pct × effectiveWindow, defaultThreshold)` — so the override
    // can only ever move compaction *earlier* (EPIC-09-S35).
    compaction: {
      pctEnv: 'CLAUDE_AUTOCOMPACT_PCT_OVERRIDE',
      disableEnv: 'DISABLE_AUTO_COMPACT',
      // `~/.claude/projects/<project>/<session_id>.jsonl`, where <project> is
      // the working directory with its separators replaced by dashes.
      transcriptDir: ['.claude', 'projects'],
      outputReserve: 20_000,
      autoCompactOffset: 13_000,
    },
    bin: 'claude-agent-acp',
    package: '@agentclientprotocol/claude-agent-acp',
    variants: [(): readonly string[] => []],
    // Claude Code 2.1.220: `-p/--print`, `--output-format
    // text|json|stream-json`, `--permission-mode
    // acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`, `--session-id`,
    // `-r/--resume [id]`, `--json-schema`, `--max-budget-usd`.
    // `--permission-prompt-tool` is no longer in `--help`.
    //
    // The shim drives the vendor CLI itself — `claude`, not the ACP bridge —
    // which is the whole point of a fallback for an agent with no ACP path.
    shim: {
      bin: 'claude',
      formats: ['text', 'json', 'stream-json'],
      stream: 'stream-json',
      dialect: 'stream-json',
      permissions: {
        read: [],
        worktree: ['--permission-mode', 'acceptEdits'],
        // Expressible only *because* of `--settings` (KAR-08.5): the flag is
        // the same as `worktree`, and what differs is the injected policy's
        // `sandbox.network.allowedDomains`. Without the injection this level
        // would be `worktree` with egress silently unconstrained, which is why
        // `sandboxedShimPlan` — not `shimPlan` — is what production spawns
        // through (`test/sandbox-plan-chokepoint.test.ts`).
        'worktree+net': ['--permission-mode', 'acceptEdits'],
        full: ['--permission-mode', 'bypassPermissions'],
      },
      // **The crucial integration fact of KAR-08.5.** The CLI accepts a whole
      // settings document as an inline JSON string, so a complete per-node
      // sandbox policy goes on the command line and no file under `~/.claude`
      // is ever opened (docs/09-workspace-and-safety.md §9.2).
      sandbox: { flag: '--settings', build: claudeSandboxPolicy },
      // KAR-09.9 AC2, corrected by KAR-19.11. The note that stood here said
      // *"**Verified 2026-08-02** from the 2.1.220 bundle's flag table and zod
      // schema: `--json-schema <file>` is accepted"* — verified by **reading**,
      // never by execution, and wrong. On 2026-08-13 at 19:59 the real binary
      // answered `Error: --json-schema is not valid JSON: JSON Parse error:
      // Unrecognized token '/'`: it wants the schema **document**, and the '/'
      // is the first character of the path DeFlow sent instead. The shape now
      // lives in the `arguments` table below, where it is `inline-json` and its
      // provenance is `executed`.
      structuredOutputFlag: '--json-schema',
      // KAR-11.1 AC8. **Verified 2026-08-02** from the same 2.1.220 flag table:
      // `--effort low|medium|high|xhigh|max`. 06 §6 wants the initial PlanGraph
      // planned at the strongest available setting — it is one call per run and
      // the single highest-leverage inference in the system — so the ladder is
      // recorded in order and `planner-effort.ts` takes its last member.
      effortFlag: '--effort',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      // KAR-19.8 AC8. **Verified by execution on 2026-08-13**, the expensive
      // way: this vendor exits 1 printing `Error: Invalid session ID. Must be a
      // valid UUID.` for anything else, and did so on every attempt of a real
      // operator's run. The form is declared here so the check is a table row
      // rather than the next by-hand run.
      sessionId: { flag: '--session-id', form: 'uuid' },
      // KAR-14.2 AC9. **Verified 2026-08-02** from the same 2.1.220 flag table:
      // `--max-budget-usd <amt>`, whose refusal comes back as the
      // `error_max_budget_usd` result subtype the classifier maps to `gate`.
      costCeilingFlag: '--max-budget-usd',
      // KAR-19.11 AC3 — **the audit, for the entry that produced both defects.**
      // Every element that can reach this vendor's command line, whether it is
      // placed by the `build` below, by `shimInvocation`'s insertion point or by
      // `sandbox.ts`. Two rows are stamped `executed`, and those two are the
      // only forms on this entry any binary has ever ruled on; the rest are
      // reads, and EPIC-19-S77's opt-in battery is where they get run.
      arguments: [
        promptFlag('-p'),
        {
          name: 'output-format',
          flag: '--output-format',
          form: 'enum',
          values: ['text', 'json', 'stream-json'],
          provenance: {
            how: 'executed',
            on: '2026-08-02',
            note: 'stream-json without --verbose exits 1, which is how the pairing was found',
          },
        },
        {
          name: 'verbose',
          flag: '--verbose',
          form: 'free-text',
          valueless: true,
          provenance: {
            how: 'executed',
            on: '2026-08-02',
            note: 'required alongside -p --output-format stream-json; the binary exits 1 without it',
          },
        },
        {
          name: 'session-id',
          flag: '--session-id',
          form: 'uuid',
          provenance: {
            how: 'executed',
            on: '2026-08-13',
            note: 'exits 1 on "Error: Invalid session ID. Must be a valid UUID." for anything else',
          },
        },
        {
          name: 'permission-mode',
          flag: '--permission-mode',
          form: 'enum',
          values: ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'],
          provenance: HELP_2026_08_02,
        },
        {
          name: 'json-schema',
          flag: '--json-schema',
          form: 'inline-json',
          // The third finding, minutes after the second: with the document
          // inline the vendor got past `JSON.parse` and refused
          // `Error: --json-schema is not a valid JSON Schema: no schema with
          // key or ref "https://json-schema.org/draft/2020-12/schema"`. Its
          // validator has no 2020-12 meta-schema registered. The same document
          // without that key completes the turn — verified by a real run.
          stripKeys: ['$schema'],
          provenance: {
            how: 'executed',
            on: '2026-08-13',
            note:
              'exits 1 on "JSON Parse error: Unrecognized token \'/\'" when handed a path, and ' +
              'on "no schema with key or ref \\"https://json-schema.org/draft/2020-12/schema\\"" ' +
              'when the inline document declares that dialect; accepted without $schema',
          },
        },
        {
          name: 'settings',
          flag: '--settings',
          form: 'inline-json',
          provenance: {
            how: 'executed',
            on: '2026-08-02',
            note: 'KAR-08.5 — a whole settings document is accepted as one inline JSON argument',
          },
        },
        {
          name: 'effort',
          flag: '--effort',
          form: 'enum',
          values: ['low', 'medium', 'high', 'xhigh', 'max'],
          provenance: BUNDLE_2026_08_02,
        },
        {
          name: 'max-budget-usd',
          flag: '--max-budget-usd',
          form: 'number',
          provenance: BUNDLE_2026_08_02,
        },
      ],
      // `--verbose` is **required** alongside `-p --output-format stream-json`
      // or the process exits printing
      // `Error: When using --print, --output-format=stream-json requires
      // --verbose`. It is emitted from the format rather than from a caller's
      // flag so that the requirement cannot be forgotten at a call site (AC2).
      build: (ctx, format, flags) => [
        '-p',
        ctx.prompt,
        '--output-format',
        format,
        // KAR-12.2 AC5. **Verified 2026-08-02** from the same 2.1.220 flag
        // table: a client-chosen `--session-id <uuid>` is honoured verbatim in
        // every emitted frame. Passed unconditionally rather than only for
        // review nodes, because the value of asserting on a minted uuid is that
        // the assertion is available on every node — a node whose session id
        // DeFlow had to parse back out of a frame is a node whose independence
        // nobody can check afterwards.
        '--session-id',
        ctx.sessionId,
        ...(format === 'stream-json' ? ['--verbose'] : []),
        ...flags,
      ],
    },
  }),
  codex: defineSpec({
    id: 'codex',
    // Verified 2026-08-02: `turn.completed` carries a typed `usage`.
    tokenAccounting: 'exact',
    family: 'openai',
    kind: 'adapter',
    bin: 'codex-acp',
    package: '@agentclientprotocol/codex-acp',
    companionBin: 'codex',
    variants: [(): readonly string[] => []],
    // Codex CLI 0.146.0: `codex exec [PROMPT]`, `--json`,
    // `-o/--output-last-message`, `--output-schema <FILE>`, `-s/--sandbox
    // read-only|workspace-write|danger-full-access`, `-C/--cd`,
    // `--skip-git-repo-check`, `--ephemeral`. `--full-auto` is gone.
    //
    // `--skip-git-repo-check` is unconditional: a DeFlow worktree is a real
    // git worktree, but the CLI's own check has refused often enough on
    // detached-HEAD checkouts that relying on it is a coin toss.
    shim: {
      bin: 'codex',
      formats: ['text', 'jsonl'],
      stream: 'jsonl',
      dialect: 'jsonl',
      permissions: {
        read: [],
        worktree: ['--sandbox', 'workspace-write'],
        full: ['--sandbox', 'danger-full-access'],
      },
      // KAR-09.9 AC2 — the same mechanism under a different spelling. Read from
      // `codex exec --help` on 2026-08-02; unlike Claude Code's, the *shape* of
      // what comes back has never been exercised here, so nothing downstream
      // may assume it arrives in a field named `structured_output`.
      structuredOutputFlag: '--output-schema',
      // KAR-19.11 AC3 — and the reason the fix is a form per entry rather than
      // "send the document everywhere". Codex CLI documents `--output-schema
      // <FILE>`, so this row stays `abs-path`; swinging the assumption the
      // other way would break the two entries that were right all along.
      arguments: [
        {
          name: 'subcommand',
          flag: null,
          form: 'enum',
          values: ['exec'],
          provenance: DOCS_2026_08_02,
        },
        {
          name: 'json',
          flag: '--json',
          form: 'free-text',
          valueless: true,
          provenance: DOCS_2026_08_02,
        },
        {
          name: 'skip-git-repo-check',
          flag: '--skip-git-repo-check',
          form: 'free-text',
          valueless: true,
          provenance: DOCS_2026_08_02,
        },
        { name: 'cd', flag: '-C', form: 'abs-path', provenance: DOCS_2026_08_02 },
        {
          name: 'sandbox',
          flag: '--sandbox',
          form: 'enum',
          values: ['read-only', 'workspace-write', 'danger-full-access'],
          provenance: DOCS_2026_08_02,
        },
        {
          name: 'output-schema',
          flag: '--output-schema',
          form: 'abs-path',
          provenance: DOCS_2026_08_02,
        },
        { name: 'prompt', flag: null, form: 'free-text', provenance: DOCS_2026_08_02 },
      ],
      build: (ctx, format, flags) => [
        'exec',
        ...(format === 'jsonl' ? ['--json'] : []),
        '--skip-git-repo-check',
        '-C',
        ctx.worktree,
        ...flags,
        ctx.prompt,
      ],
    },
    // The bridge honours CODEX_PATH to select the CLI it drives. Using it is
    // what keeps the resolution DeFlow already did from being redone against a
    // PATH DeFlow does not control.
    env: (ctx): NodeJS.ProcessEnv => {
      if (ctx.resolved.companionPath === undefined) {
        throw registryRefused(
          'codex-acp needs CODEX_PATH set to the resolved absolute codex binary; resolving the ' +
            'bridge without its companion would leave the bridge to search PATH, which is the ' +
            'one thing §4.3 forbids',
          { provider: 'codex', missing: 'companionPath' },
        );
      }
      return { CODEX_PATH: ctx.resolved.companionPath };
    },
  }),
  /**
   * KAR-19.7 — the bundled agent, and the only entry here that is not a vendor.
   *
   * It is in this table for a behavioural reason rather than a convenient one.
   * Every schema-bearing turn is admitted only onto a provider whose entry
   * declares a `structuredOutputFlag` (`structured-output.ts`, read by
   * `admitFraming`), and before this entry existed the only two that declared
   * one were vendor exec-shim paths. So a machine with no vendor CLI could not
   * get past framing at all, and *"`deflow run` works end to end with only the
   * bundled agent"* — this epic's Definition of Done — was not testable.
   *
   * **The declaration is true, and that is the whole point.** The flag below is
   * imported from the binary rather than spelled again, so a rename cannot
   * leave this table claiming a capability the binary does not have; the binary
   * parses that same constant, reads the schema file, and writes one document
   * that validates against it. Nothing in `admitFraming` knows this provider
   * exists.
   *
   * **`bundled: true` is what stops it becoming a routing hazard.** It ships in
   * the same tarball as `DeFlow` itself, so `doctor` never offers to
   * `npm install -g` it, and `usableProviders` puts it behind every real
   * adapter — a run reaches it only where the operator's own `PATH` or
   * configuration puts it there.
   */
  mock: defineSpec({
    id: 'mock',
    kind: 'native',
    bundled: true,
    bin: 'deflow-mock-agent',
    // The published CLI, which carries this bin. Named honestly even though
    // nothing will ever print an install command for it: a package field that
    // said "@DeFlow/mock-agent" would name something npm cannot resolve.
    package: 'deflow',
    // It speaks ACP with no flag at all, which is what it has always done.
    variants: [(): readonly string[] => []],
    shim: {
      bin: 'deflow-mock-agent',
      // One format, because there is one: the structured turn writes a single
      // JSON document for the whole invocation and nothing else. Declaring a
      // streaming format it does not have is the class of lie this table is
      // otherwise careful about.
      formats: ['json'],
      stream: 'json',
      dialect: 'document',
      // `read` only, and stated rather than defaulted. The shim path puts
      // nothing in front of the agent's file access, and this agent expresses
      // no permission flags of its own — so any level above `read` is refused
      // at construction time rather than run at whatever the default is.
      permissions: { read: [] },
      structuredOutputFlag: MOCK_STRUCTURED_OUTPUT_FLAG,
      // KAR-19.11 AC3. The one entry whose provenance can honestly be
      // `executed` on every row without a vendor CLI: DeFlow ships the binary,
      // its argument parser is in this repository, and
      // `test/integration/exec-shim-conformance.test.ts` runs it on every
      // commit. It takes its schema as a **file**, like Codex and unlike Claude
      // Code — which is why the form is per entry.
      arguments: [
        {
          name: 'return-schema',
          flag: MOCK_STRUCTURED_OUTPUT_FLAG,
          form: 'abs-path',
          provenance: OWN_BINARY,
        },
        { name: 'prompt', flag: MOCK_PROMPT_FLAG, form: 'free-text', provenance: OWN_BINARY },
      ],
      build: (ctx, _format, flags) => [...flags, MOCK_PROMPT_FLAG, ctx.prompt],
    },
  }),
} as const satisfies Record<string, ProviderSpec>;

export type KnownProviderId = keyof typeof PROVIDER_SPECS;

/**
 * KAR-19.11 AC4 — what each element of `argv` is, according to `spec`'s own
 * declarations.
 *
 * The guard the repository did not have. An element with no declared
 * argument comes back with `argument: null` and a problem naming it, so
 * *"DeFlow builds an argument nobody wrote a shape for"* is a failure rather
 * than something outside every test in the tree.
 */
export function auditShimArgv(
  spec: ProviderSpec,
  argv: readonly string[],
): readonly ArgumentAuditRow[] {
  return auditArgv(spec.shim.arguments, argv);
}

/**
 * KAR-19.11 AC8 — `argv` with every inline document reduced to its schema id.
 *
 * Inlining the schema changes the command line and nothing else. A `node.failed`
 * payload the ledger keeps for ever, a log line, a terminal message: none of
 * them may become a paste of the whole schema, and *"the DeFlow.plangraph.v1
 * document"* is the thing an operator actually wants to read there anyway. The
 * file is still on disk under the run's `.DeFlow/schemas/`, named by schema id,
 * which is where they go to see the bytes (NF8).
 */
export function redactedShimArgv(spec: ProviderSpec, argv: readonly string[]): readonly string[] {
  const inline = new Set(
    spec.shim.arguments
      .filter((argument) => argument.form === 'inline-json' && argument.flag !== null)
      .map((argument) => argument.flag as string),
  );
  if (inline.size === 0) return argv;

  return argv.map((element, index) => {
    const flag = index === 0 ? undefined : argv[index - 1];
    if (flag === undefined || !inline.has(flag)) return element;
    return redactedInline(flag, element);
  });
}

/** One inline document, as a log line records it. */
export function redactedInline(flag: string, document: string): string {
  const schemaId = schemaIdOf({ schemaDocument: document });
  const bytes = Buffer.byteLength(document, 'utf8');
  return schemaId === null
    ? `<${flag} document, ${bytes} bytes>`
    : `<${flag} document: ${schemaId}, ${bytes} bytes>`;
}

/** The spec for `id`, or `undefined` — an unknown provider is a planning
 * question, answered by the caller, not an exception thrown from a lookup. */
export function providerSpec(id: string): ProviderSpec | undefined {
  return Object.hasOwn(PROVIDER_SPECS, id)
    ? (PROVIDER_SPECS as Record<string, ProviderSpec>)[id]
    : undefined;
}

/**
 * KAR-09.7 AC5 — the model family whose token-estimate seed applies to this
 * provider, or `'default'` for one that is not registered at all.
 *
 * A total function rather than an optional lookup: a caller budgeting a node's
 * packet needs a number, and `undefined` here would push a fallback decision
 * onto every call site — which is how two of them end up disagreeing about
 * what an unmeasured vendor should be corrected by.
 */
export function providerFamily(id: string): string {
  return providerSpec(id)?.family ?? DEFAULT_MODEL_FAMILY;
}

/**
 * KAR-14.1 AC4 — this provider's accounting fidelity, or `'none'` for one that
 * is not registered at all.
 *
 * Total for the same reason `providerFamily` is, and the fallback matters more
 * here: a caller that had to invent one for an unknown provider would sooner or
 * later invent `'exact'`, and every zero-cost turn on that provider would be
 * charted as free rather than as unknown.
 */
export function providerTokenAccounting(id: string): TokenAccounting {
  return providerSpec(id)?.tokenAccounting ?? UNMEASURED_TOKEN_ACCOUNTING;
}

/** The complete invocation for one attempt: command, argv and env overlay. */
export function spawnPlan(spec: ProviderSpec, ctx: SpawnContext): SpawnPlan {
  return {
    command: ctx.resolved.path,
    argv: spec.argv(ctx),
    env: spec.env(ctx),
  };
}

/**
 * KAR-05.8 — the complete **exec-shim** invocation, or a refusal.
 *
 * Throws before it returns anything when the vendor has no such
 * `--output-format` (AC3) or no flag for the requested permission level. Both
 * refusals are tagged `NodeFailureError`s, so a caller that wants them as a
 * `NodeFailure` rather than as a throw sends them through
 * `toAdapterFailure` like every other adapter failure.
 *
 * The shim needs no vendor environment: everything a headless invocation
 * depends on is in the argv, which is what makes the argv snapshot the whole
 * review surface for a flag change.
 */
export function shimPlan(spec: ProviderSpec, ctx: ShimContext): ShimPlan {
  return {
    command: ctx.resolved.path,
    argv: spec.shim.argv(ctx),
    env: NO_ENV,
    format: ctx.format ?? spec.shim.stream,
    dialect: spec.shim.dialect,
  };
}
