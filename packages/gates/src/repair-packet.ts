/**
 * KAR-12.5 AC3, AC6 — the fix node's packet
 * (docs/10-verification-gates.md §7, docs/08-context-and-memory.md §5.2).
 *
 * §7 states the contents in one sentence: *"a narrow packet — pinned spec, one
 * `Finding`, the files it names, the failing command's output artifact — is
 * both cheaper and measurably more reliable"* than the producer's large,
 * mostly-irrelevant context. This module builds exactly that list and nothing
 * else.
 *
 * **The narrowness is structural, not a rule somebody follows.**
 * `buildRepairPacket` takes no `segments` array. There is no parameter through
 * which a producer transcript, a second finding, a session summary or a
 * "helpful" file could arrive, so *"the packet contains no producer
 * transcript"* is a property of the signature rather than a discipline to
 * remember three refactors from now. `buildPacket` is still the assembler — one
 * builder, one budget, one manifest — this only decides what it is given.
 *
 * **Attempt N+1 receives verdicts, never transcripts.** *"Attempt N+1 receives
 * the previous attempts' verdicts as findings — so it does not repeat a fix
 * already shown not to work — but not their transcripts."* The three reasons
 * are measured rather than aesthetic (§7): the producing session has committed
 * to the reasoning that produced the bug; it is the session most likely to have
 * compacted away the constraint the bug violates — omission compliance fell
 * from **73% at turn 5 to 33% at turn 16** while commission compliance held at
 * 100%, an asymmetry invisible to ordinary monitoring because the
 * healthy-looking signals stay healthy; and its context is large and mostly
 * irrelevant to a one-line null check. A fresh node is at turn 0.
 *
 * The verdict's *summary* is carried verbatim rather than paraphrased, because
 * EPIC-12-S31's second scenario asks for exactly that: the sentence naming what
 * the last attempt changed and why the gate still failed is the one piece of
 * text that stops attempt 3 re-applying attempt 2's fix.
 *
 * Pure, like `buildPacket` itself: it tokenises through the injected estimator
 * and hashes in memory. The bytes of the named files arrive from the caller,
 * which is the only component that holds the worktree.
 *
 * Verifies: EPIC-12-S30 (third scenario), EPIC-12-S31 · AC3, AC6
 */
import {
  buildPacket,
  contextSegment,
  EventSeqSchema,
  type FindingV2,
  type GateId,
  type Handle,
  type NodeId,
  type PacketBuild,
  type PacketTarget,
  READ_ARTIFACT_TOOL,
  type Segment,
  type TaskSpec,
  type TokenEstimator,
  type UnpinnedSegmentKind,
  type VerdictV3,
} from '@DeFlow/core';

/**
 * The four segment ids a repair packet can hold, as constants.
 *
 * Exported because they are the assertion surface: AC3 says the claim is
 * checked *"on the `context.built` manifest"*, and a test that matched on
 * prose would pass against a packet whose text happened to mention a finding.
 * `previousAttempt` is a **prefix** — one segment per earlier attempt, numbered
 * — so a caller filters rather than looks up.
 */
export const REPAIR_SEGMENT_IDS = Object.freeze({
  finding: 'repair-finding',
  evidence: 'repair-evidence',
  file: 'repair-file-',
  previousAttempt: 'repair-attempt-',
});

/** One file the finding names, with the bytes the caller read for it. */
export interface RepairFile {
  /** Repo-relative, POSIX. */
  readonly path: string;
  readonly text: string;
}

export interface RepairPacketInput {
  readonly runId: string;
  /** The fix node — `fix-<findingId>`. */
  readonly node: NodeId;
  /** 1-based, matching `RepairAttempt.attempt`. */
  readonly attempt: number;
  readonly builtAtEvent: number;
  readonly gate: GateId;
  /** The **pinned** spec, which is what the verdict was judged against. */
  readonly spec: TaskSpec;
  /** Exactly one. The type says so, and it is the whole design (§7). */
  readonly finding: FindingV2;
  /** The files that Finding names, already read. */
  readonly files: readonly RepairFile[];
  /** A handle to the failing command's output artifact. */
  readonly evidence: Handle;
  /** The fix node's declared write scope, pinned into the packet (F1.5). */
  readonly pathScopes: readonly string[];
  readonly permission: string;
  readonly target: PacketTarget;
  /**
   * The verdicts of attempts 1..n-1, in order — AC6.
   *
   * Verdicts, and only verdicts. The type is `VerdictV3[]` rather than
   * `unknown[]` or a "previous context" bag precisely so that there is nowhere
   * to put a transcript.
   */
  readonly previousVerdicts?: readonly VerdictV3[];
  readonly configuredFraction?: number;
  readonly estimate?: TokenEstimator;
}

/** The one finding, rendered so the id is legible and the location is a place
 * the agent can open. */
function findingText(gate: GateId, finding: FindingV2): string {
  const where =
    finding.location === undefined
      ? '(no location — the tool named no readable file)'
      : `${finding.location.file}:${finding.location.line} @ blob ${finding.location.blobSha}`;

  return [
    `The ${gate} gate reported exactly one finding for you to repair.`,
    '',
    `id:       ${finding.id}`,
    `severity: ${finding.severity}`,
    `where:    ${where}`,
    ...(finding.criterion === undefined ? [] : [`criterion: ${finding.criterion}`]),
    '',
    finding.message,
  ].join('\n');
}

/**
 * One earlier attempt's verdict, as findings.
 *
 * The summary comes first and verbatim: it is the sentence that says what the
 * attempt changed and why the gate still failed, and it is what stops this
 * attempt re-applying a fix already shown not to work.
 */
function previousVerdictText(attempt: number, verdict: VerdictV3): string {
  return [
    `Repair attempt ${attempt} did not fix it. The ${verdict.gate} gate returned "${verdict.outcome}".`,
    '',
    verdict.summary,
    '',
    verdict.findings.length === 0
      ? 'It reported no findings.'
      : `It reported ${verdict.findings.length} finding(s):`,
    ...verdict.findings.map(
      (finding) => `  - ${finding.id} (${finding.severity}) ${finding.message}`,
    ),
    '',
    'Do not repeat that change. This is the verdict, not the transcript: what that attempt was ' +
      'thinking is deliberately not here.',
  ].join('\n');
}

/**
 * AC3, AC6 — the fix node's packet.
 *
 * The fill order is the order §5.2 gives and the order a reader wants: the
 * pinned block, then the one finding, then the previous verdicts (so the model
 * knows what has been tried before it reads the code), then the files, then the
 * evidence handle.
 */
export async function buildRepairPacket(input: RepairPacketInput): Promise<PacketBuild> {
  const at = input.builtAtEvent;
  const estimate = input.estimate;
  const sourceEvent = EventSeqSchema.parse(at);
  const segment = (id: string, kind: UnpinnedSegmentKind, text: string): Promise<Segment> =>
    contextSegment({
      id,
      kind,
      text,
      sourceEvent,
      ...(estimate === undefined ? {} : { estimate }),
    });

  const segments: Segment[] = [
    await segment(REPAIR_SEGMENT_IDS.finding, 'fact', findingText(input.gate, input.finding)),
  ];

  for (const [index, verdict] of (input.previousVerdicts ?? []).entries()) {
    segments.push(
      await segment(
        `${REPAIR_SEGMENT_IDS.previousAttempt}${index + 1}-verdict`,
        'fact',
        previousVerdictText(index + 1, verdict),
      ),
    );
  }

  for (const [index, file] of input.files.entries()) {
    segments.push(
      await segment(
        `${REPAIR_SEGMENT_IDS.file}${index}`,
        'retrieved',
        `${file.path}\n\n${file.text}`,
      ),
    );
  }

  // A handle, never the body: the failing command's output is routinely a
  // whole test log, and the same log recurs on attempts 2 and 3 of one repair.
  // Content addressing makes those repeats free (§8) and inlining them is what
  // makes replay time explode.
  segments.push(
    await segment(
      REPAIR_SEGMENT_IDS.evidence,
      'artifact.handle',
      `${input.evidence}  the ${input.gate} gate's own output, which is what failed\n` +
        `  → pull with the \`${READ_ARTIFACT_TOOL}\` MCP tool: ${input.evidence}`,
    ),
  );

  return buildPacket({
    runId: input.runId,
    nodeId: input.node,
    attempt: input.attempt,
    builtAtEvent: at,
    target: input.target,
    ...(input.configuredFraction === undefined
      ? {}
      : { configuredFraction: input.configuredFraction }),
    pinned: {
      spec: input.spec,
      node: { pathScopes: [...input.pathScopes], permission: input.permission },
      sourceEvent: at,
    },
    segments,
    ...(estimate === undefined ? {} : { estimate }),
  });
}
