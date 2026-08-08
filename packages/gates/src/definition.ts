/**
 * KAR-12.1 — the gate definition and the two things that stop one loading
 * (docs/10-verification-gates.md §2).
 *
 * The schema is the worked examples in §2, made executable. Two rules in it are
 * not validation in the ordinary sense — they are the design:
 *
 * **A gate must be `pure`, and `effect` has no default.** A gate that mutates
 * the repository cannot be re-run to confirm a fix, which is its entire job. So
 * `effect: mutating` is a *load* error rather than a runtime surprise, and an
 * omitted `effect` is the same error: defaulting it to `pure` would mean the
 * one property the ladder depends on is the one property nobody ever states.
 *
 * **`cwd: repo` needs an explicit opt-in.** A gate running in the repository
 * root rather than the node's worktree sees other nodes' work in flight, which
 * makes its verdict about a tree that will never exist again. `worktree` is the
 * default and needs no ceremony; `repo` is a decision somebody records in
 * `.DeFlow/config.yaml`.
 *
 * Discovery from `.DeFlow/gates/*.{yaml,yml}`, the manifest hash and the
 * mid-run divergence path are KAR-12.6's. This file is the parser and validator
 * both of them go through, so there is one of each rather than two.
 */
import { CriterionIdSchema, GATE_CLASSES, GateIdSchema, PermissionLevelSchema } from '@DeFlow/core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { GATE_SEVERITIES } from './finding.ts';
import { GATE_PARSERS } from './parsers.ts';

/** Why a definition did not load. Each arm is a different author action. */
export const GATE_LOAD_CODES = [
  /** `effect` is absent or `mutating` (AC3). */
  'GATE_MUST_BE_PURE',
  /** `cwd: repo` without the opt-in (S10, second scenario). */
  'GATE_REPO_CWD_NOT_PERMITTED',
  /** Unparseable YAML, or a field the schema refuses. */
  'GATE_DEFINITION_INVALID',
] as const;

export type GateLoadCode = (typeof GATE_LOAD_CODES)[number];

/**
 * A definition that did not load, naming the file.
 *
 * The file path is a field rather than only a substring of the message: the run
 * refuses to start on one of these, and the operator's next action is to open
 * exactly that file.
 */
export class GateLoadError extends Error {
  readonly code: GateLoadCode;
  readonly file: string;

  constructor(code: GateLoadCode, file: string, detail: string) {
    super(`${file}: ${detail}`);
    this.name = 'GateLoadError';
    this.code = code;
    this.file = file;
  }
}

const DURATION = /^(\d+)(ms|s|m)$/;

const UNIT_MS: Readonly<Record<string, number>> = { ms: 1, s: 1_000, m: 60_000 };

/**
 * `300s`, `120s`, `750ms`, `2m`.
 *
 * A string with a unit rather than a number, because a bare `300` in a YAML
 * file is a coin flip between seconds and milliseconds and the two failure
 * modes — a gate that times out instantly, a gate that never times out — are
 * both silent.
 */
export const GateTimeoutSchema = z
  .string()
  .regex(DURATION, 'timeout must be a duration such as 300s, 2m or 750ms')
  .transform((value) => {
    const match = DURATION.exec(value);
    const amount = Number(match?.[1] ?? 0);
    const unit = match?.[2] ?? 'ms';
    return amount * (UNIT_MS[unit] ?? 1);
  });

/** The `findings` block: which parser, and — for `jsonl` — where in each line. */
export const GateFindingsSchema = z.strictObject({
  parser: z.enum(GATE_PARSERS),
  /** `$.violations`. Only meaningful for `jsonl`; harmless elsewhere. */
  path: z.string().min(1).optional(),
});

export const GateDefinitionSchema = z.strictObject({
  id: GateIdSchema,
  kind: z.enum(GATE_CLASSES),
  title: z.string().min(1),
  run: z.string().min(1),
  cwd: z.enum(['worktree', 'repo']).default('worktree'),
  timeout: GateTimeoutSchema,
  /** Deliberately optional in the schema and mandatory in `loadGateDefinition`
   * — see the header. The schema is what says "this field exists"; the loader
   * is what says "and it must say `pure`". */
  effect: z.enum(['pure', 'mutating']).optional(),
  permission: PermissionLevelSchema.default('worktree'),
  expect: z.strictObject({ exitCode: z.int() }).default({ exitCode: 0 }),
  findings: GateFindingsSchema,
  satisfies: z.array(CriterionIdSchema).default([]),
  severityFloor: z.enum(GATE_SEVERITIES).default('error'),
});

/** A loaded definition: validated, with its timeout in milliseconds and its
 * purity already proven, so nothing downstream re-checks either. */
export interface GateDefinition {
  readonly file: string;
  readonly id: z.infer<typeof GateIdSchema>;
  readonly kind: (typeof GATE_CLASSES)[number];
  readonly title: string;
  readonly run: string;
  readonly cwd: 'worktree' | 'repo';
  readonly timeoutMs: number;
  readonly effect: 'pure';
  readonly permission: z.infer<typeof PermissionLevelSchema>;
  readonly expect: { readonly exitCode: number };
  readonly findings: z.infer<typeof GateFindingsSchema>;
  readonly satisfies: readonly z.infer<typeof CriterionIdSchema>[];
  readonly severityFloor: (typeof GATE_SEVERITIES)[number];
}

export interface LoadGateOptions {
  /** `.DeFlow/config.yaml`'s opt-in for `cwd: repo`. Absent means no. */
  readonly repoCwdPermitted?: boolean;
}

/** `findings.parser` rather than `findings, parser` — the field the author edits. */
const issuePath = (path: readonly PropertyKey[]): string => path.map(String).join('.');

/**
 * Parses one gate definition file's bytes.
 *
 * Takes the source rather than reading it, so the hash KAR-12.6 puts in the run
 * manifest is over the same bytes this parsed — a loader that re-read the file
 * would leave a window in which the two disagree, which is precisely the
 * divergence that story exists to detect.
 */
export function loadGateDefinition(
  file: string,
  source: string,
  options: LoadGateOptions = {},
): GateDefinition {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (error) {
    throw new GateLoadError(
      'GATE_DEFINITION_INVALID',
      file,
      `not parseable as YAML — ${(error as Error).message}`,
    );
  }

  const parsed = GateDefinitionSchema.safeParse(document);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new GateLoadError(
      'GATE_DEFINITION_INVALID',
      file,
      first === undefined
        ? 'did not match the gate definition schema'
        : `${issuePath(first.path)}: ${first.message}`,
    );
  }

  const definition = parsed.data;

  if (definition.effect !== 'pure') {
    throw new GateLoadError(
      'GATE_MUST_BE_PURE',
      file,
      definition.effect === undefined
        ? 'no `effect` declared. A gate must state `effect: pure`: a gate that mutates the ' +
            'repository cannot be re-run to confirm a fix, and defaulting the one property the ' +
            'ladder rests on would mean nobody ever states it.'
        : 'declares `effect: mutating`. A gate must be pure — re-running it to confirm a fix is ' +
            'its entire job, and a gate that changes the tree cannot do that.',
    );
  }

  if (definition.cwd === 'repo' && options.repoCwdPermitted !== true) {
    throw new GateLoadError(
      'GATE_REPO_CWD_NOT_PERMITTED',
      file,
      'declares `cwd: repo`, which needs an explicit opt-in in .DeFlow/config.yaml. A gate ' +
        "running in the repository root sees other nodes' work in flight, so its verdict is " +
        'about a tree that will never exist again.',
    );
  }

  return {
    file,
    id: definition.id,
    kind: definition.kind,
    title: definition.title,
    run: definition.run,
    cwd: definition.cwd,
    timeoutMs: definition.timeout,
    effect: 'pure',
    permission: definition.permission,
    expect: definition.expect,
    findings: definition.findings,
    satisfies: definition.satisfies,
    severityFloor: definition.severityFloor,
  };
}
