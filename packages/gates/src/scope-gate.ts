/**
 * KAR-12.5 AC10 — the structural path-scope gate and its promotion rule
 * (docs/10-verification-gates.md §6.2, §9.1).
 *
 * D14 demotes a declared path scope to a **prediction**: the violation set is
 * `changedFiles(nodeBranch) \ declaredScope`, and it is emitted as
 * `severity: 'warning'` under `rule: 'scope/undeclared-write'`. That default is
 * as load-bearing as the promotion beside it, and the reason is behavioural
 * rather than aesthetic: *"a write node that touched one extra import site is
 * normal and often correct. Hard-failing there teaches you to declare `src/**`
 * on every node, at which point path scopes mean nothing and you have lost both
 * the prediction and the ground truth."*
 *
 * §6.2 promotes to `error` in exactly three cases, and this module implements
 * all three:
 *
 *   1. `git merge-tree` reports a conflict at that path — the prediction was
 *      wrong *and* it cost something.
 *   2. The path is outside the node's worktree, or outside the repository.
 *   3. The path is in the run's **protected set**: `.DeFlow/**` (including gate
 *      definitions), lockfiles, CI configuration, and anything matching the
 *      F5.6 execution boundary deny list.
 *
 * The third is §9.1's real defence and the reason this file belongs to the
 * repair story: *"the classic failure is not a human overriding a gate, it is
 * an agent 'fixing' the check."* A fix node is precisely the node with a motive.
 *
 * **A protected path is an error whether or not the node declared it.** Every
 * other rule here compares a write against what the node said it would touch;
 * this one does not, and the asymmetry is the point. A declaration is a
 * prediction the node makes about itself, and §9.1's failure mode is an agent
 * that edits the check — which it would do by declaring the check's path first.
 * If the protected set could be opted out of by declaring it, it would protect
 * nothing.
 *
 * `merge/conflict` is deliberately **not** emitted here. A conflict at a
 * *declared* path is the merge gate's finding under its own rule; reporting it
 * a second time under `scope/undeclared-write` would show the reviewer one
 * problem twice under two names, and neither copy would be the one to act on.
 *
 * Pure: `changed` and `conflicts` are produced by whoever holds the worktree
 * (`git status --porcelain=v2`, `git merge-tree --write-tree`). Nothing here
 * spawns anything.
 *
 * Verifies: EPIC-12-S35 · AC10
 */
import {
  type GateId,
  NodeFailureError,
  type NodeId,
  pathScopeMatches,
  relativeToWorktree,
} from '@DeFlow/core';
import { findingId, type ParsedFinding } from './finding.ts';

/** §6.2's rule id, spelled once. */
export const SCOPE_UNDECLARED_WRITE = 'scope/undeclared-write';

/**
 * §6.2's protected set, as the default a run starts from.
 *
 * Four families, each with a distinct reason a fix node must not touch it:
 * `.DeFlow/**` is DeFlow's own configuration *and its gate definitions*, so
 * editing it is editing the check; CI configuration is the check that runs
 * after DeFlow is done with it; a lockfile decides what every later node
 * executes; and `.git/**` is the ledger of the branch the verdict is about.
 *
 * A run may replace this wholesale — the F5.6 deny list and a project's own
 * additions arrive from `.DeFlow/config.yaml` and are hashed into the run
 * manifest — which is why `scopeGateFindings` takes it as an argument rather
 * than reading this constant directly.
 */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = Object.freeze([
  '.DeFlow/**',
  '.git/**',
  '.github/workflows/**',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lockb',
]);

export interface ScopeGateInput {
  readonly gate: GateId;
  /** The node's worktree, absolute — what `changed` is made relative to. */
  readonly worktree: string;
  /** The node's declared `pathScopes.write`. */
  readonly declared: readonly string[];
  /** Everything the node's branch added, modified, renamed or left untracked. */
  readonly changed: readonly string[];
  /** Paths `git merge-tree --write-tree` reported as conflicting. */
  readonly conflicts?: readonly string[];
  /** The run's protected set. Defaults to `DEFAULT_PROTECTED_PATHS`. */
  readonly protectedPaths?: readonly string[];
  /**
   * Test files the plan marked as a **contract** — AC10's second half.
   *
   * Separate from `protectedPaths` because they arrive from a different place
   * (the plan, per run, rather than the safety configuration) and because a
   * reader of a failure wants to know which of the two fired: "you edited the
   * gate definition" and "you edited the test the gate is defined by" are
   * different conversations.
   */
  readonly contractPaths?: readonly string[];
}

/** Whole-file, because a scope violation is about the file existing in the
 * diff at all. Line 1 rather than 0 — 0 is not a line anybody can open. */
const WHOLE_FILE = Object.freeze({ startLine: 1 });

/**
 * §6.2's violation set, with each violation at the severity the promotion rule
 * gives it.
 *
 * Order follows `changed`, so two runs over the same diff read identically and
 * a snapshot of the result is a snapshot of the fact.
 */
export function scopeGateFindings(input: ScopeGateInput): readonly ParsedFinding[] {
  const protectedPaths = [
    ...(input.protectedPaths ?? DEFAULT_PROTECTED_PATHS),
    ...(input.contractPaths ?? []),
  ];
  const conflicts = new Set(
    (input.conflicts ?? []).map((path) => relativeToWorktree(input.worktree, path)),
  );

  const findings: ParsedFinding[] = [];
  for (const raw of input.changed) {
    const file = relativeToWorktree(input.worktree, raw);
    const isProtected = pathScopeMatches(protectedPaths, file);

    if (!isProtected && pathScopeMatches(input.declared, file)) continue;

    // A path `relativeToWorktree` could not relativize resolved outside the
    // worktree — §6.2's second promotion case, and the one a glob cannot
    // express because the path is not in the repository's namespace at all.
    const escaped = file.startsWith('/');
    const severity =
      isProtected || escaped || conflicts.has(file) ? ('error' as const) : ('warning' as const);
    const message = reasonFor({
      file,
      severity,
      isProtected,
      escaped,
      conflicted: conflicts.has(file),
      declared: input.declared,
    });

    findings.push({
      id: findingId(input.gate, file, SCOPE_UNDECLARED_WRITE, message),
      severity,
      file,
      range: WHOLE_FILE,
      rule: SCOPE_UNDECLARED_WRITE,
      message,
    });
  }

  return findings;
}

interface ReasonInput {
  readonly file: string;
  readonly severity: 'error' | 'warning';
  readonly isProtected: boolean;
  readonly escaped: boolean;
  readonly conflicted: boolean;
  readonly declared: readonly string[];
}

/**
 * The sentence the diff view renders. It always names the declared scope,
 * because the first question anybody asks of a scope warning is "what *was*
 * it allowed to write", and a message that made them go and look would be
 * read once and then ignored.
 */
function reasonFor(input: ReasonInput): string {
  const declared = input.declared.length === 0 ? '(nothing)' : input.declared.join(', ');
  const wrote = `wrote ${input.file}, which is outside the declared write scope [${declared}]`;

  if (input.isProtected) {
    return (
      `${wrote}, and the path is in the run's protected set — gate definitions, DeFlow's own ` +
      'configuration, CI configuration and lockfiles are never a repair target, because the ' +
      'classic failure is not a human overriding a gate but an agent "fixing" the check'
    );
  }
  if (input.escaped) return `${wrote}, and the path resolves outside the node's worktree`;
  if (input.conflicted) {
    return `${wrote}, and git merge-tree reports a conflict there — the prediction was wrong and it cost something`;
  }
  return `${wrote}. A single extra import site is normal; the violation is recorded, not fatal`;
}

/**
 * A repair node that wrote a path the run protects.
 *
 * `gate`-classed, like KAR-12.2's `SchedulingRefused`, and for the same reason:
 * a retry re-derives the same node and reaches the same answer, so a transient
 * class would spend an afternoon re-proving that the agent still wants to edit
 * the gate. The one useful action is a human's.
 */
export class RepairScopeViolation extends NodeFailureError {
  readonly node: NodeId | null;
  readonly findings: readonly ParsedFinding[];

  constructor(findings: readonly ParsedFinding[], node: NodeId | null = null) {
    const paths = findings.map((finding) => finding.file).join(', ');
    super(
      `the node wrote ${paths}, which the run protects. A repair that has to change the check ` +
        'is not a repair — the finding belongs in front of a human',
      {
        reason: 'gate.failed',
        class: 'gate',
        detail: { rule: SCOPE_UNDECLARED_WRITE, paths, ...(node === null ? {} : { node }) },
      },
    );
    this.name = 'RepairScopeViolation';
    this.node = node;
    this.findings = findings;
  }

  /** The scheduler's only question about a failure. `gate` means *suspend for
   * a human* (`@DeFlow/core`'s ./retry.ts). */
  get failureClass(): 'gate' {
    return 'gate';
  }
}

/**
 * AC10 — the check that runs **before** the node's verdict is considered.
 *
 * A throw rather than a returned verdict, and the ordering is the requirement:
 * a node that wrote the gate definition must fail *before* `gate.evaluated`,
 * because a verdict recorded from a run in which the check was edited is a
 * verdict about nothing. The warnings are returned rather than thrown, so a
 * caller still records them — §6.2 is explicit that violations are never free
 * even when they do not fail a gate.
 */
export function assertRepairScope(input: ScopeGateInput, node?: NodeId): readonly ParsedFinding[] {
  const findings = scopeGateFindings(input);
  const blocking = findings.filter((finding) => finding.severity === 'error');
  if (blocking.length > 0) throw new RepairScopeViolation(blocking, node ?? null);
  return findings;
}
