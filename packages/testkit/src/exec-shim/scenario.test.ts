/**
 * KAR-04.6 — the exec-shim scenario format.
 *
 * Same discipline as the ACP mock's format (KAR-04.2): nothing is defaulted
 * silently, and every rejection names the path to the value that caused it. A
 * fake whose `exitCode` was quietly ignored because the author wrote `exit`
 * produces a green suite that proves nothing, and leaves nothing to grep for.
 *
 * The format is strict JSON rather than JSONC on purpose — the testkit is not
 * allowed a comment stripper of its own, and duplicating the mock agent's would
 * be a second implementation of a parser whose bugs are silent by construction
 * (a naive one truncates every URL in the file at its first slash pair and the
 * result is still valid JSON). The `description` field carries the prose.
 *
 * Verifies: EPIC-04-S17, EPIC-04-S18, EPIC-04-S20 (format half) · AC3, AC5,
 * AC6, AC7
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import {
  EXEC_SHIM_SCENARIO_DIR,
  loadExecShimScenario,
  parseExecShimScenario,
  SCENARIO_ENV,
} from './scenario.ts';

const parse = (value: unknown): ReturnType<typeof parseExecShimScenario> =>
  parseExecShimScenario(JSON.stringify(value));

const scenarioOf = (value: unknown): ReturnType<typeof parseExecShimScenario> => {
  const parsed = parse(value);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed;
};

suite('the shipped scenarios all parse', () => {
  const files = readdirSync(EXEC_SHIM_SCENARIO_DIR).filter((name) => name.endsWith('.json'));

  it('there are some, so this suite is not vacuously green', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)('%s', (name) => {
    const parsed = parseExecShimScenario(
      readFileSync(join(EXEC_SHIM_SCENARIO_DIR, name), 'utf8'),
      name,
    );
    expect(parsed.ok ? '' : parsed.message).toBe('');
  });

  it('ships the three the acceptance criteria name by name', () => {
    expect(files).toEqual(
      expect.arrayContaining(['no-output.json', 'ignore-sigterm.json', 'write-files.json']),
    );
  });
});

suite('defaults are stated, never inferred', () => {
  it('an empty scenario is a silent, successful, harmless one', () => {
    const parsed = scenarioOf({ name: 'empty' });
    expect(parsed.ok && parsed.scenario).toMatchObject({
      name: 'empty',
      steps: [],
      result: null,
      exitCode: 0,
      stderr: '',
      noOutput: false,
      ignoreSigterm: false,
      hangForever: false,
      spawnGrandchildren: null,
      writeFiles: [],
    });
  });

  it('spawnGrandchildren defaults to the two `sleep 300` children AC6 asks for', () => {
    const parsed = scenarioOf({ name: 'tree', spawnGrandchildren: {} });
    expect(parsed.ok && parsed.scenario.spawnGrandchildren).toEqual({
      count: 2,
      sleepSeconds: 300,
    });
  });
});

suite('a wrong key is a rejection that names it', () => {
  it('rejects an unknown top-level key', () => {
    const parsed = parse({ name: 'typo', exit: 2 });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain('"exit"');
  });

  it('rejects an unknown step type and lists the ones that exist', () => {
    const parsed = parse({ name: 'x', steps: [{ type: 'chunk' }] });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain('steps[0]');
    expect(parsed.ok === false && parsed.message).toContain('chunks');
  });

  it('rejects an unknown key inside a step, with the path to it', () => {
    const parsed = parse({ name: 'x', steps: [{ type: 'chunks', count: 2, delayMS: 5 }] });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain('steps[0]');
    expect(parsed.ok === false && parsed.message).toContain('delayMS');
  });

  it('rejects a result subtype the vendor never emits', () => {
    const parsed = parse({ name: 'x', result: { subtype: 'error_everything' } });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain('error_everything');
  });

  it('rejects a writeFiles entry with no path', () => {
    const parsed = parse({ name: 'x', writeFiles: [{ content: 'hi' }] });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain('writeFiles[0]');
  });

  it('reports a JSON syntax error as one line naming the source', () => {
    const parsed = parseExecShimScenario('{ "name": ', 'broken.json');
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain('broken.json');
    expect(parsed.ok === false && parsed.message.split('\n')).toHaveLength(1);
  });
});

suite('the steps the conformance battery needs', () => {
  it('parses chunks, message, rateLimit, malformedLine and hugeLine', () => {
    const parsed = scenarioOf({
      name: 'battery',
      steps: [
        { type: 'chunks', count: 3, delayMs: 5, text: 'tick' },
        { type: 'message', text: 'done' },
        { type: 'rateLimit', resetsInSeconds: 900, status: 'allowed_warning' },
        { type: 'malformedLine', text: '{"type":' },
        { type: 'hugeLine', totalBytes: 1024, chunkBytes: 256 },
      ],
    });

    expect(parsed.ok && parsed.scenario.steps).toEqual([
      { type: 'chunks', count: 3, delayMs: 5, text: 'tick' },
      { type: 'message', text: 'done' },
      { type: 'rateLimit', resetsInSeconds: 900, status: 'allowed_warning' },
      { type: 'malformedLine', text: '{"type":' },
      { type: 'hugeLine', totalBytes: 1024, chunkBytes: 256 },
    ]);
  });

  it('keeps a result envelope verbatim, denials and all', () => {
    const parsed = scenarioOf({
      name: 'denied',
      result: {
        subtype: 'success',
        isError: false,
        stopReason: 'end_turn',
        text: 'refused',
        totalCostUsd: 0.01,
        permissionDenials: [{ toolName: 'Bash', toolUseId: 't1', toolInput: { command: 'rm' } }],
      },
    });

    expect(parsed.ok && parsed.scenario.result).toEqual({
      subtype: 'success',
      isError: false,
      stopReason: 'end_turn',
      text: 'refused',
      totalCostUsd: 0.01,
      permissionDenials: [{ toolName: 'Bash', toolUseId: 't1', toolInput: { command: 'rm' } }],
    });
  });
});

suite('a scenario is named, pointed at, or written inline', () => {
  it('resolves a bare name against the shipped directory', () => {
    const loaded = loadExecShimScenario('no-output');
    expect(loaded.ok && loaded.scenario.noOutput).toBe(true);
  });

  it('resolves a path', () => {
    const loaded = loadExecShimScenario(join(EXEC_SHIM_SCENARIO_DIR, 'no-output.json'));
    expect(loaded.ok && loaded.scenario.noOutput).toBe(true);
  });

  it('reads a document written inline, so a spec can vary one field without a file', () => {
    const loaded = loadExecShimScenario('{"name":"inline","exitCode":2,"noOutput":true}');
    expect(loaded.ok && loaded.scenario.exitCode).toBe(2);
  });

  it('rejects a name that resolves to nothing, naming the variable and the name', () => {
    const loaded = loadExecShimScenario('not-a-scenario');
    expect(loaded.ok).toBe(false);
    expect(loaded.ok === false && loaded.message).toContain('not-a-scenario');
    expect(loaded.ok === false && loaded.message).toContain(SCENARIO_ENV);
  });
});
