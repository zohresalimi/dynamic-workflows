/**
 * KAR-18.4, category 8 — PTY and memory layer.
 *
 * Four facts, each of which is invisible until it costs someone an afternoon:
 *
 * **The pty.** `@lydell/node-pty` is the package's only native dependency and
 * it is `optional`, so an uncovered platform degrades rather than failing
 * installation. No agent process needs a TTY — ACP is a pure pipe protocol
 * across all five measured agents — so this is a `warn`: what degrades is
 * DeFlow's own `terminal/*` implementation, and the honest consequence is that
 * the capability is not advertised to agents at all (EPIC-18-S35).
 *
 * **FTS5 and its tokenizer.** The tokenizer string is read back from
 * `artifact_fts`'s own DDL rather than re-derived from the constant, because
 * re-deriving it would make the check a tautology. Without `tokenchars '_-.'`,
 * `snake_case`, `kebab-case` and `file.ext` fragment and recall on code and
 * stack traces collapses — silently, since a wrong tokenizer does not error.
 *
 * **The calibration factor, with its sample count.** A report that printed
 * only the factor would let an operator read a learned 1.31 and conclude the
 * estimator is running when three samples exist and the 1.2 seed is what every
 * budget is still multiplying by. Both numbers, always (KAR-09.7 AC10).
 *
 * **The secretlint rule count.** Zero today, and it says so: F5.9's redaction
 * engine is deferred to M2 (docs/02-tech-stack.md §5). A section that omitted
 * the line would read as "redaction is fine".
 *
 * Verifies: EPIC-18-S26, EPIC-18-S34, EPIC-18-S35 · AC9
 */
import { CALIBRATION_MIN_SAMPLES, CALIBRATION_SEEDS, type Db } from '@DeFlow/core';
import {
  ARTIFACT_FTS_TOKENIZE,
  artifactFtsAvailability,
  readTokenCalibrations,
} from '@DeFlow/ledger';
import type { DoctorCheck } from './report.ts';

/** Four significant-ish digits; a ratio printed to fifteen places hides the
 * digits that moved. A whole number keeps one decimal place, because `openai 1`
 * reads as "no correction is configured" where `openai 1.0` reads as
 * "the correction is one" — which is the true statement. */
const formatFactor = (factor: number): string =>
  Number.isInteger(factor) ? factor.toFixed(1) : String(Number(factor.toFixed(4)));

/** The seed line AC9 requires: `anthropic 1.2`, `openai 1.0`, `default 1.05`. */
function seedSummary(): string {
  return Object.entries(CALIBRATION_SEEDS)
    .map(([family, factor]) => `${family} ${formatFactor(factor)}`)
    .join(', ');
}

function ptyCheck(loaded: unknown): DoctorCheck {
  if (loaded === null || loaded === undefined) {
    return {
      id: 'memory.pty',
      status: 'warn',
      detail:
        '@lydell/node-pty did not load on this platform. DeFlow still runs: terminal/* degrades ' +
        'to a no-TTY spawn over plain pipes, and the terminal capability is not advertised to ' +
        'agents, so a run completes with terminal-dependent behaviour absent rather than ' +
        'failing. No agent needs a TTY — ACP is a pipe protocol for all five measured vendors.',
      data: { loaded: false },
    };
  }
  return {
    id: 'memory.pty',
    status: 'ok',
    detail:
      '@lydell/node-pty loaded, so ACP terminal/* runs on a real pty and the terminal ' +
      'capability is advertised to agents.',
    data: { loaded: true },
  };
}

function ftsCheck(db: Db): DoctorCheck {
  const availability = artifactFtsAvailability(db);

  if (!availability.fts5Compiled) {
    return {
      id: 'memory.fts5',
      status: 'warn',
      detail:
        'FTS5 is not available: this SQLite build was not compiled with ENABLE_FTS5, so F6.7 ' +
        'artifact retrieval cannot run. better-sqlite3 bundles FTS5; a system SQLite may not.',
      data: { fts5: false },
    };
  }
  if (!availability.tableExists) {
    return {
      id: 'memory.fts5',
      status: 'warn',
      detail:
        'FTS5 is available, but artifact_fts does not exist yet — run the ledger migrations ' +
        '(KAR-09.10, migration 0012) before relying on retrieval.',
      data: { fts5: true, table: false },
    };
  }

  const tokenize = availability.tokenize ?? '(unreadable)';
  if (tokenize !== ARTIFACT_FTS_TOKENIZE) {
    return {
      id: 'memory.fts5',
      status: 'warn',
      detail:
        `FTS5 is available. artifact_fts tokenize = ${tokenize}, which does not match the ` +
        `documented setting ${ARTIFACT_FTS_TOKENIZE} — recall on snake_case, kebab-case and ` +
        'dotted identifiers is degraded until the table is dropped and rebuilt. The tokenizer ' +
        'cannot be changed in place.',
      data: { fts5: true, table: true, tokenize },
    };
  }

  return {
    id: 'memory.fts5',
    status: 'ok',
    detail: `FTS5 is available. artifact_fts tokenize = ${tokenize}`,
    data: { fts5: true, table: true, tokenize },
  };
}

function calibrationCheck(db: Db): DoctorCheck {
  const rows = readTokenCalibrations(db);
  const lines = rows.map((row) => {
    const seeded = row.samples < CALIBRATION_MIN_SAMPLES;
    return (
      `  ${row.provider}/${row.model}: ${formatFactor(row.appliedFactor)} ` +
      `(${seeded ? 'seed' : 'learned'}, n=${row.samples})` +
      (seeded
        ? ` — the ${row.family} family seed applies until ${CALIBRATION_MIN_SAMPLES} samples exist`
        : '')
    );
  });

  return {
    id: 'memory.calibration',
    status: 'ok',
    detail: [
      `tokenEstimateFactor seeds, applied below n=${CALIBRATION_MIN_SAMPLES}: ${seedSummary()}.`,
      ...(lines.length === 0
        ? ['  no (provider, model) has been sampled yet, so every pre-flight budget uses a seed.']
        : lines),
    ].join('\n'),
    data: {
      seeds: CALIBRATION_SEEDS,
      rows: rows.map((row) => ({
        provider: row.provider,
        model: row.model,
        samples: row.samples,
        appliedFactor: row.appliedFactor,
      })),
    },
  };
}

/**
 * The redaction engine's rule count.
 *
 * Zero, stated out loud. F5.9's `@secretlint/node` integration is deferred to
 * M2 (docs/02-tech-stack.md §5, docs/17-roadmap.md), and a doctor that omitted
 * the line would leave an operator assuming exported artifacts are scanned.
 */
function secretlintCheck(): DoctorCheck {
  return {
    id: 'memory.secretlint',
    status: 'warn',
    detail:
      'secretlint rules loaded: 0. Export-time secret redaction (F5.9) is deferred to M2, so ' +
      'exported artifacts and transcripts are not scanned for provider credentials yet. The ' +
      'controls that do apply today are the child-environment allowlist and the credential-path ' +
      'denies in the sandbox policy.',
    data: { rules: 0 },
  };
}

export interface MemoryInput {
  /** The ledger, file-backed. `null` when the state dir could not be opened. */
  readonly db: Db | null;
  /** The optional native pty module, already loaded (or not) by the caller. */
  readonly pty: unknown;
}

export function memoryChecks(input: MemoryInput): readonly DoctorCheck[] {
  const checks: DoctorCheck[] = [ptyCheck(input.pty)];

  if (input.db === null) {
    checks.push({
      id: 'memory.ledger',
      status: 'warn',
      detail:
        'the ledger could not be opened, so FTS5, the artifact_fts tokenizer and the token ' +
        'calibration could not be read — see the Runtime section for why the global state ' +
        'directory is unusable.',
    });
  } else {
    checks.push(ftsCheck(input.db), calibrationCheck(input.db));
  }

  checks.push(secretlintCheck());
  return checks;
}
