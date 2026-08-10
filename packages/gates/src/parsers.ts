/**
 * KAR-12.1 — `findings.parser`: real tool output in, typed `Finding[]` out
 * (docs/10-verification-gates.md §2, §4).
 *
 * Every parser here was written against output captured from the tool this
 * workspace pins, committed under ../test/fixtures/parsers. That is not
 * ceremony: a parser written against an imagined shape passes its own test and
 * fails on the first real run, and the failure arrives an hour into a paid run
 * rather than in CI.
 *
 * Three things are normalised on the way out, because every consumer downstream
 * assumes them and none of the tools agree about them:
 *
 * - **`file` is repo-relative and POSIX.** `vitest --reporter=json` reports an
 *   absolute path; `tsc` on win32 reports backslashes.
 * - **`range.startLine` is 1-based.** biome reports `line: 0` for a whole-file
 *   diagnostic, which is not a line anybody can open, so it is anchored at 1.
 * - **`rule` is the bare rule id.** oxlint spells it `typescript(no-floating-
 *   promises)`; the diff view and the repair loop want `no-floating-promises`.
 *
 * A note on the name `eslint-json`: DeFlow's lint gate is oxlint, whose
 * `--format=json` is the oxc diagnostic document rather than ESLint's own
 * array. The parser is named for the *rule-id vocabulary* it produces —
 * `no-floating-promises`, `no-debugger` — which is what a gate author writing
 * `satisfies:` and a reader of the diff view both recognise. It is implemented
 * against the shape the pinned oxlint actually emits and nothing else.
 */
import type { GateId } from '@DeFlow/core';
import {
  findingId,
  type GateSeverity,
  type ParsedFinding,
  repoRelativePosix,
  toPosix,
} from './finding.ts';

/** §2's seven values, in the order the architecture lists them. */
export const GATE_PARSERS = [
  'tsc',
  'eslint-json',
  'biome-json',
  'vitest-json',
  'junit-xml',
  'jsonl',
  'none',
] as const;

export type GateParser = (typeof GATE_PARSERS)[number];

export interface ParseInput {
  readonly gate: GateId;
  /** Absolute. What `file` is made relative to. */
  readonly repoRoot: string;
  readonly stdout: string;
  readonly stderr: string;
  /** `$.violations` — `jsonl` only. */
  readonly path?: string;
}

/** Everything a parser needs to mint a finding, minus the finding's own fields. */
interface Mint {
  readonly gate: GateId;
  readonly repoRoot: string;
}

interface Raw {
  readonly severity: GateSeverity;
  readonly file: string;
  readonly rule: string;
  readonly message: string;
  readonly startLine: number;
  readonly startCol?: number;
  readonly endLine?: number;
  readonly endCol?: number;
}

function mint(context: Mint, raw: Raw): ParsedFinding {
  const file = repoRelativePosix(context.repoRoot, raw.file);
  return {
    id: findingId(context.gate, file, raw.rule, raw.message),
    severity: raw.severity,
    file,
    rule: raw.rule,
    message: raw.message,
    range: {
      // A tool that reports line 0 means "the whole file"; 0 is not openable.
      startLine: Math.max(1, raw.startLine),
      ...(raw.startCol === undefined ? {} : { startCol: raw.startCol }),
      ...(raw.endLine === undefined ? {} : { endLine: raw.endLine }),
      ...(raw.endCol === undefined ? {} : { endCol: raw.endCol }),
    },
  };
}

const jsonOrNull = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
};

// ── tsc ──────────────────────────────────────────────────────────────────────

/** `packages/ui/src/App.ts(4,25): error TS2345: Argument of type …` */
const TSC_LINE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;

function parseTsc(input: ParseInput): ParsedFinding[] {
  const findings: ParsedFinding[] = [];
  for (const line of `${input.stdout}\n${input.stderr}`.split('\n')) {
    const match = TSC_LINE.exec(line.trim());
    if (match === null) continue;
    const [, file, startLine, startCol, severity, code, message] = match;
    findings.push(
      mint(input, {
        severity: severity === 'warning' ? 'warning' : 'error',
        file: file ?? '',
        rule: (code ?? '').toLowerCase(),
        message: message ?? '',
        startLine: Number(startLine),
        startCol: Number(startCol),
      }),
    );
  }
  return findings;
}

// ── oxlint / the eslint rule-id vocabulary ───────────────────────────────────

interface OxcDiagnostic {
  readonly message?: string;
  readonly code?: string;
  readonly severity?: string;
  readonly filename?: string;
  readonly labels?: readonly {
    readonly span?: { readonly line?: number; readonly column?: number };
  }[];
}

/** `typescript(no-floating-promises)` → `no-floating-promises`. */
const unwrapRule = (code: string): string => {
  const match = /^[\w@/-]+\(([^)]+)\)$/.exec(code);
  return match?.[1] ?? code;
};

const OXC_SEVERITY: Readonly<Record<string, GateSeverity>> = {
  error: 'error',
  warning: 'warning',
  advice: 'info',
};

function parseEslintJson(input: ParseInput): ParsedFinding[] {
  const document = jsonOrNull(input.stdout);
  const diagnostics = (document as { diagnostics?: readonly OxcDiagnostic[] } | null)?.diagnostics;
  if (diagnostics === undefined) return [];

  return diagnostics.map((diagnostic) => {
    const span = diagnostic.labels?.[0]?.span;
    return mint(input, {
      severity: OXC_SEVERITY[diagnostic.severity ?? ''] ?? 'error',
      file: diagnostic.filename ?? '',
      rule: unwrapRule(diagnostic.code ?? ''),
      message: diagnostic.message ?? '',
      startLine: span?.line ?? 1,
      ...(span?.column === undefined ? {} : { startCol: span.column }),
    });
  });
}

// ── biome ────────────────────────────────────────────────────────────────────

interface BiomeDiagnostic {
  readonly severity?: string;
  readonly message?: unknown;
  readonly category?: string;
  readonly location?: {
    readonly path?: unknown;
    readonly start?: { readonly line?: number; readonly column?: number };
    readonly end?: { readonly line?: number; readonly column?: number };
  };
}

const BIOME_SEVERITY: Readonly<Record<string, GateSeverity>> = {
  error: 'error',
  warning: 'warning',
  information: 'info',
  hint: 'info',
};

/**
 * biome's `message` is a string in the pinned 2.5.6 JSON reporter and a markup
 * array in other shapes of the same document, so both are flattened rather than
 * one being assumed.
 */
function biomeText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) {
    return (message as unknown[])
      .map((part) =>
        typeof part === 'string' ? part : ((part as { content?: string }).content ?? ''),
      )
      .join('');
  }
  return '';
}

/** `location.path` is a string in the reporter output and `{ file: … }` in the
 * diagnostic printer's own serialisation. */
function biomePath(path: unknown): string {
  if (typeof path === 'string') return path;
  if (typeof path === 'object' && path !== null) {
    const file = (path as { file?: unknown }).file;
    if (typeof file === 'string') return file;
  }
  return '';
}

function parseBiomeJson(input: ParseInput): ParsedFinding[] {
  const document = jsonOrNull(input.stdout);
  const diagnostics = (document as { diagnostics?: readonly BiomeDiagnostic[] } | null)
    ?.diagnostics;
  if (diagnostics === undefined) return [];

  return diagnostics.map((diagnostic) =>
    mint(input, {
      severity: BIOME_SEVERITY[diagnostic.severity ?? ''] ?? 'error',
      file: biomePath(diagnostic.location?.path),
      rule: diagnostic.category ?? '',
      message: biomeText(diagnostic.message),
      startLine: diagnostic.location?.start?.line ?? 1,
      ...(diagnostic.location?.start?.column === undefined
        ? {}
        : { startCol: diagnostic.location.start.column }),
      ...(diagnostic.location?.end?.line === undefined
        ? {}
        : { endLine: Math.max(1, diagnostic.location.end.line) }),
    }),
  );
}

// ── vitest --reporter=json ───────────────────────────────────────────────────

interface VitestAssertion {
  readonly fullName?: string;
  readonly status?: string;
  readonly failureMessages?: readonly string[];
}

interface VitestSuite {
  readonly name?: string;
  readonly assertionResults?: readonly VitestAssertion[];
}

/** The rule every failing test carries. One value, so the diff view and the
 * repair loop can recognise a test failure without knowing the runner. */
export const TEST_FAILED_RULE = 'test/failed';

/**
 * The first stack frame that points inside the test file itself.
 *
 * The rest of the trace is the runner's own frames, and anchoring a finding to
 * `@vitest/runner/dist/chunk-artifact.js` is worse than anchoring it to line 1.
 */
function frameLine(message: string, file: string): number | null {
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`${escaped}:(\\d+):(\\d+)`).exec(toPosix(message));
  return match === null ? null : Number(match[1]);
}

function parseVitestJson(input: ParseInput): ParsedFinding[] {
  const document = jsonOrNull(input.stdout);
  const suites = (document as { testResults?: readonly VitestSuite[] } | null)?.testResults;
  if (suites === undefined) return [];

  const findings: ParsedFinding[] = [];
  for (const suite of suites) {
    const file = repoRelativePosix(input.repoRoot, suite.name ?? '');
    for (const assertion of suite.assertionResults ?? []) {
      if (assertion.status !== 'failed') continue;
      const detail = assertion.failureMessages?.[0] ?? '';
      const line = frameLine(detail, file);
      findings.push(
        mint(input, {
          severity: 'error',
          file,
          rule: TEST_FAILED_RULE,
          message: `${assertion.fullName ?? 'test'}: ${detail.split('\n')[0] ?? ''}`.trim(),
          startLine: line ?? 1,
        }),
      );
    }
  }
  return findings;
}

// ── JUnit XML ────────────────────────────────────────────────────────────────

const TESTCASE = /<testcase\b([^>]*)>([\s\S]*?)<\/testcase>/g;
const SELF_CLOSING_ATTR = /(\w[\w:-]*)="([^"]*)"/g;
const FAILURE = /<failure\b([^>]*)(?:\/>|>([\s\S]*?)<\/failure>)/;

const attributes = (raw: string): Record<string, string> => {
  const found: Record<string, string> = {};
  for (const match of raw.matchAll(SELF_CLOSING_ATTR)) {
    found[match[1] as string] = match[2] as string;
  }
  return found;
};

const unescapeXml = (text: string): string =>
  text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');

/**
 * A deliberately small reader: `<testcase>` elements and the `<failure>` inside
 * them, and nothing else.
 *
 * Not a general XML parser, and it must not become one — a JUnit report is a
 * flat document with two element names that matter, and pulling an XML library
 * into the daemon to read it would be a dependency for one regex.
 */
function parseJunitXml(input: ParseInput): ParsedFinding[] {
  const findings: ParsedFinding[] = [];
  for (const testcase of input.stdout.matchAll(TESTCASE)) {
    const body = testcase[2] ?? '';
    const failure = FAILURE.exec(body);
    if (failure === null) continue;

    const attrs = attributes(testcase[1] ?? '');
    const file = repoRelativePosix(input.repoRoot, attrs.classname ?? attrs.file ?? '');
    const detail = unescapeXml(failure[2] ?? '');
    const message = unescapeXml(attributes(failure[1] ?? '').message ?? '');
    findings.push(
      mint(input, {
        severity: 'error',
        file,
        rule: TEST_FAILED_RULE,
        message: `${attrs.name ?? 'test'}: ${message}`.trim(),
        startLine: frameLine(detail, file) ?? 1,
      }),
    );
  }
  return findings;
}

// ── jsonl ────────────────────────────────────────────────────────────────────

/**
 * KAR-12.6 S39, second scenario — a `jsonl` line under `$.violations` that is
 * not Finding-shaped: a custom producer's output that cannot be trusted at
 * all, rather than a finding with a blank field.
 *
 * Thrown rather than defaulted. `./run-gate.ts` turns this into `needs-human`
 * with reason `gate-output-unparseable` and records **no** findings — a
 * partially-parsed set is worse than none, because the diff view would render
 * three of five problems and a reviewer would reasonably conclude there were
 * three (10-verification-gates.md §2, notes).
 */
export class GateOutputUnparseable extends Error {
  /** The raw line that failed the shape check, for the caller's own log. */
  readonly line: string;

  constructor(line: string) {
    super(`jsonl entry is not Finding-shaped — missing "file": ${line}`);
    this.name = 'GateOutputUnparseable';
    this.line = line;
  }
}

interface JsonlFinding {
  readonly file?: string;
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
  readonly endLine?: number;
  readonly rule?: string;
  readonly severity?: string;
  readonly message?: string;
}

/**
 * `$.violations` — a single top-level key, not a query language.
 *
 * The architecture's example is `path: $.violations` and the value it names is
 * an array of Finding-shaped objects on each line. Supporting a general JSONPath
 * would be a parser, a dependency and a surface for a gate file to be subtly
 * wrong in; supporting one dotted path covers the documented case and fails
 * loudly outside it (an unknown key yields no findings, and the gate then falls
 * back to its exit code).
 */
function selectPath(line: unknown, expression: string | undefined): unknown[] {
  if (expression === undefined) return [line];
  const keys = expression
    .replace(/^\$\.?/, '')
    .split('.')
    .filter(Boolean);
  let cursor: unknown = line;
  for (const key of keys) {
    if (typeof cursor !== 'object' || cursor === null) return [];
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return Array.isArray(cursor) ? (cursor as unknown[]) : cursor === undefined ? [] : [cursor];
}

const JSONL_SEVERITY: Readonly<Record<string, GateSeverity>> = {
  error: 'error',
  warning: 'warning',
  warn: 'warning',
  info: 'info',
};

function parseJsonl(input: ParseInput): ParsedFinding[] {
  const findings: ParsedFinding[] = [];
  for (const line of input.stdout.split('\n')) {
    if (line.trim() === '') continue;
    const document = jsonOrNull(line);
    if (document === null) continue;
    for (const entry of selectPath(document, input.path)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const raw = entry as JsonlFinding;
      const file = raw.file ?? raw.path;
      // A Finding cannot exist without knowing what it is about (S39): a line
      // missing this is not "zero findings", it is output nobody can trust.
      if (typeof file !== 'string' || file.length === 0) {
        throw new GateOutputUnparseable(line);
      }
      findings.push(
        mint(input, {
          severity: JSONL_SEVERITY[raw.severity ?? ''] ?? 'error',
          file,
          rule: raw.rule ?? '',
          message: raw.message ?? '',
          startLine: raw.line ?? 1,
          ...(raw.column === undefined ? {} : { startCol: raw.column }),
          ...(raw.endLine === undefined ? {} : { endLine: raw.endLine }),
        }),
      );
    }
  }
  return findings;
}

// ── the dispatch ─────────────────────────────────────────────────────────────

const PARSERS: Readonly<Record<GateParser, (input: ParseInput) => ParsedFinding[]>> = {
  tsc: parseTsc,
  'eslint-json': parseEslintJson,
  'biome-json': parseBiomeJson,
  'vitest-json': parseVitestJson,
  'junit-xml': parseJunitXml,
  jsonl: parseJsonl,
  // §2's escape hatch: the exit code is the whole of the evidence, and the
  // output is attached as an artifact rather than mined for structure.
  none: () => [],
};

export function parseFindings(parser: GateParser, input: ParseInput): readonly ParsedFinding[] {
  return PARSERS[parser](input);
}
