/**
 * What the harness observed, in the shape AC1 asks for: one row per step, with
 * the evidence that step produced. Rendered as a table by default and as JSON
 * for the assertions in test/integration/spike-s1-acp.test.ts.
 */

export const STEPS = [
  'initialize',
  'session/new',
  'session/prompt',
  'session/update',
  'session/request_permission',
  'session/cancel',
] as const;

export type StepName = (typeof STEPS)[number];

/** `blocked` means an earlier step failed, so this one never got its chance. */
export type StepStatus = 'ok' | 'failed' | 'blocked';

export interface StepObservation {
  readonly step: StepName;
  readonly status: StepStatus;
  readonly observed: string;
}

export interface CapabilityMatrix {
  readonly resume: boolean;
  readonly list: boolean;
  readonly loadSession: boolean;
  readonly mcpHttp: boolean;
  readonly mcpSse: boolean;
  readonly mcpAcp: boolean;
  readonly promptImage: boolean;
  readonly promptAudio: boolean;
  readonly promptEmbeddedContext: boolean;
}

export interface RunReport {
  readonly agent: string;
  readonly version: string;
  readonly mode: 'live' | 'replay';
  readonly recordingPath: string;
  /**
   * Where the generated capability fixture was written, or null if
   * `initialize` never completed. A replay's copy lands outside the working
   * tree — test/integration/no-tracked-file-churn.test.ts is what holds it
   * there.
   */
  readonly fixturePath: string | null;
  readonly frameCapBytes: number;
  readonly steps: StepObservation[];
  readonly protocolVersion: number | null;
  readonly agentCapabilities: unknown;
  readonly capabilityMatrix: CapabilityMatrix | null;
  readonly capabilityDivergence: string[];
  readonly sessionId: string | null;
  readonly mcp: {
    readonly declared: boolean;
    readonly accepted: boolean;
    readonly error: string | null;
    readonly handshake: string[];
  };
  readonly streaming: {
    readonly count: number;
    readonly spreadMs: number;
    readonly interArrivalMs: number[];
  };
  readonly permission: {
    readonly requested: boolean;
    readonly optionKinds: string[];
    readonly answeredWith: string | null;
    readonly actionPerformed: boolean;
    readonly evidence: string;
  };
  readonly cancellation: {
    readonly sent: boolean;
    readonly stopReason: string | null;
    readonly settledMs: number | null;
    readonly trailingUpdatesAccepted: number;
    readonly readLoopAliveAfter: boolean;
    readonly verdict: string;
  };
  readonly tokenAccounting: {
    readonly usageUpdates: number;
    readonly promptResultUsage: unknown;
    readonly verdict: 'exact' | 'estimated' | 'none';
  };
  readonly compaction: { readonly observed: boolean; readonly evidence: string };
  readonly structuredOutput: { readonly present: boolean; readonly evidence: string };
  readonly framing: {
    readonly failed: boolean;
    readonly code: string | null;
    readonly capBytes: number;
    readonly bytesAtFailure: number | null;
  };
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** AC1's table: one row per step, with what was observed at each. */
export function renderTable(report: RunReport): string {
  const rows = report.steps.map((step) => [step.step, step.status, step.observed]);
  const head = ['step', 'status', 'observed'];
  const widths = head.map((_, column) =>
    Math.max(head[column]?.length ?? 0, ...rows.map((row) => (row[column] ?? '').length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, column) => pad(cell, widths[column] ?? 0)).join('  ');
  return [
    `${report.agent}@${report.version}  (${report.mode})`,
    line(head),
    widths.map((width) => '-'.repeat(width)).join('  '),
    ...rows.map(line),
  ].join('\n');
}
