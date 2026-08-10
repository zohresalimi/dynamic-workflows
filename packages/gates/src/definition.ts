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
import { type Document, LineCounter, parseDocument } from 'yaml';
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
 * KAR-12.6 AC2 — the line a schema issue's path points at, when one is
 * derivable.
 *
 * Walks from the full path up to the root: a missing field (`effect` on a
 * document that never declared one) resolves to nothing at its own path, so
 * the search backs off to the nearest ancestor that exists — the map the
 * field would have lived in — rather than giving up. The document root
 * always resolves, so this only returns `undefined` for a source with no
 * content at all.
 */
function lineForPath(
  document: Document,
  path: readonly PropertyKey[],
  counter: LineCounter,
): number | undefined {
  for (let end = path.length; end >= 0; end -= 1) {
    const node =
      end === 0
        ? document.contents
        : document.getIn(path.slice(0, end) as (string | number)[], true);
    const range = (node as { range?: readonly [number, number, number] } | null | undefined)?.range;
    if (range !== undefined) return counter.linePos(range[0]).line;
  }
  return undefined;
}

const withLine = (detail: string, line: number | undefined): string =>
  line === undefined ? detail : `${detail} (line ${line})`;

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
  const lineCounter = new LineCounter();
  const document = parseDocument(source, { lineCounter });

  if (document.errors.length > 0) {
    const [error] = document.errors;
    const line = error?.linePos?.[0]?.line;
    throw new GateLoadError(
      'GATE_DEFINITION_INVALID',
      file,
      withLine(`not parseable as YAML — ${error?.message ?? 'unknown syntax error'}`, line),
    );
  }

  const parsed = GateDefinitionSchema.safeParse(document.toJS());
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const line = first === undefined ? undefined : lineForPath(document, first.path, lineCounter);
    throw new GateLoadError(
      'GATE_DEFINITION_INVALID',
      file,
      first === undefined
        ? 'did not match the gate definition schema'
        : withLine(`${issuePath(first.path)}: ${first.message}`, line),
    );
  }

  const definition = parsed.data;

  if (definition.effect !== 'pure') {
    const line = lineForPath(document, ['effect'], lineCounter);
    throw new GateLoadError(
      'GATE_MUST_BE_PURE',
      file,
      withLine(
        definition.effect === undefined
          ? 'no `effect` declared. A gate must state `effect: pure`: a gate that mutates the ' +
              'repository cannot be re-run to confirm a fix, and defaulting the one property ' +
              'the ladder rests on would mean nobody ever states it.'
          : 'declares `effect: mutating`. A gate must be pure — re-running it to confirm a fix ' +
              'is its entire job, and a gate that changes the tree cannot do that.',
        line,
      ),
    );
  }

  if (definition.cwd === 'repo' && options.repoCwdPermitted !== true) {
    const line = lineForPath(document, ['cwd'], lineCounter);
    throw new GateLoadError(
      'GATE_REPO_CWD_NOT_PERMITTED',
      file,
      withLine(
        'declares `cwd: repo`, which needs an explicit opt-in in .DeFlow/config.yaml. A gate ' +
          "running in the repository root sees other nodes' work in flight, so its verdict is " +
          'about a tree that will never exist again.',
        line,
      ),
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
