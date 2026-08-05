/**
 * KAR-04.6 — the two vendor behaviours a uniform shim gets wrong.
 *
 * Both are decisions the fake binary has to make before it writes a byte, so
 * they are pure functions over argv and can be unit tested. The integration
 * specs then prove the real process really does exit that way; this file is
 * where the *rules* live, because a rule stated once in a table is a rule you
 * can read.
 *
 * Verifies: EPIC-04-S17 (rule half), EPIC-04-S20 (rule half) · AC1, AC2, AC4
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import { repoRoot } from '../snapshot.ts';
import {
  CLAUDE_VERBOSE_REQUIRED,
  DIALECT_ENV,
  DIALECTS,
  decideCli,
  readDialect,
} from './dialects.ts';

const recorded = JSON.parse(
  readFileSync(join(repoRoot, 'fixtures/cli-shapes/claude-code@2.1.220.json'), 'utf8'),
) as { streamJson: { verboseRequiredError: string; outputFormats?: string[] } };

suite('the dialect comes from the environment (AC1)', () => {
  it('names all three dialects', () => {
    expect([...DIALECTS]).toEqual(['claude-stream-json', 'codex-jsonl', 'copilot-json']);
  });

  it.each([...DIALECTS])('accepts %s', (dialect) => {
    expect(readDialect({ [DIALECT_ENV]: dialect })).toEqual({ ok: true, dialect });
  });

  it('rejects an unset dialect by name rather than defaulting to one', () => {
    const read = readDialect({});
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.stderr).toContain(DIALECT_ENV);
    expect(read.ok === false && read.exitCode).not.toBe(0);
  });

  it('rejects an unknown dialect and lists the ones it knows', () => {
    const read = readDialect({ [DIALECT_ENV]: 'claude-stream-jsonl' });
    expect(read.ok).toBe(false);
    expect(read.ok === false && read.stderr).toContain('claude-stream-json');
    expect(read.ok === false && read.stderr).toContain('copilot-json');
  });
});

suite('claude-stream-json requires --verbose alongside -p (AC2)', () => {
  it('refuses with the exact string the real binary prints', () => {
    const decision = decideCli('claude-stream-json', [
      '-p',
      'say ok',
      '--output-format',
      'stream-json',
    ]);
    expect(decision).toEqual({
      ok: false,
      exitCode: 1,
      stderr: 'Error: When using --print, --output-format=stream-json requires --verbose',
    });
  });

  it('and that string is the recorded one, character for character', () => {
    expect(CLAUDE_VERBOSE_REQUIRED).toBe(recorded.streamJson.verboseRequiredError);
  });

  it('accepts the same argv with --verbose', () => {
    expect(
      decideCli('claude-stream-json', [
        '--print',
        'say ok',
        '--output-format',
        'stream-json',
        '--verbose',
      ]),
    ).toEqual({ ok: true, format: 'stream-json' });
  });

  it('accepts --output-format json without --verbose, which is why the gotcha is missable', () => {
    expect(decideCli('claude-stream-json', ['-p', 'say ok', '--output-format', 'json'])).toEqual({
      ok: true,
      format: 'json',
    });
  });

  it('defaults to text when no format is asked for', () => {
    expect(decideCli('claude-stream-json', ['-p', 'say ok'])).toEqual({ ok: true, format: 'text' });
  });

  it('rejects a format no version of the binary has', () => {
    const decision = decideCli('claude-stream-json', ['-p', 'x', '--output-format', 'ndjson']);
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.stderr).toContain('ndjson');
  });
});

suite('copilot-json has no stream-json at all (AC4)', () => {
  it('exits non-zero when stream-json is requested', () => {
    const decision = decideCli('copilot-json', ['-p', 'say ok', '--output-format', 'stream-json']);
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.exitCode).toBeGreaterThan(0);
    // The refusal has to name the formats that do exist, or a shim author
    // reading the failure learns only that something went wrong.
    expect(decision.ok === false && decision.stderr).toMatch(/text/);
    expect(decision.ok === false && decision.stderr).toMatch(/json/);
  });

  it('accepts json', () => {
    expect(decideCli('copilot-json', ['-p', 'say ok', '--output-format', 'json'])).toEqual({
      ok: true,
      format: 'json',
    });
  });

  it('accepts text, and never emits the verbose gotcha — that is Claude Code’s alone', () => {
    const decision = decideCli('copilot-json', ['-p', 'x', '--output-format', 'text', '--verbose']);
    expect(decision).toEqual({ ok: true, format: 'text' });
  });
});

suite('codex-jsonl is a different CLI shape again', () => {
  it('emits JSONL under --json', () => {
    expect(decideCli('codex-jsonl', ['exec', 'say ok', '--json'])).toEqual({
      ok: true,
      format: 'jsonl',
    });
  });

  it('is text without --json', () => {
    expect(decideCli('codex-jsonl', ['exec', 'say ok'])).toEqual({ ok: true, format: 'text' });
  });

  it('has no --output-format, so a shim that reaches for one is told so', () => {
    const decision = decideCli('codex-jsonl', ['exec', 'x', '--output-format', 'stream-json']);
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.stderr).toContain('--output-format');
  });
});
