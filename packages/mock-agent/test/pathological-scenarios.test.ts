/**
 * KAR-04.3 AC8 — every pathological behaviour is reachable two ways: from a
 * scenario file, and from one dedicated CLI flag.
 *
 * The second half is not a convenience. When someone reports "the daemon wedged
 * on a huge frame", the first thing anyone needs is a command that reproduces
 * it — `deflow-mock-agent --huge-line` — without first learning the scenario
 * format. The flag resolves to the *same shipped scenario file* the suite uses
 * rather than to a second, in-memory definition, because two definitions of one
 * behaviour drift and the drift is invisible until the reproduction stops
 * reproducing.
 *
 * Verifies: KAR-04.3 · AC1–AC8 (the parser half)
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import { PATHOLOGICAL_FLAGS, parseArgv, USAGE } from '../src/cli.ts';
import { parseScenario, type Step } from '../src/scenario.ts';

/** The narrowing every spec below wants: a parsed scenario, or a thrown message. */
function stepsOf(value: unknown): readonly Step[] {
  const parsed = parseScenario(JSON.stringify(value));
  if (!parsed.ok) throw new Error(`expected a scenario, got: ${parsed.message}`);
  return parsed.scenario.steps;
}

function failure(value: unknown): string {
  const parsed = parseScenario(JSON.stringify(value));
  if (parsed.ok) throw new Error(`expected a rejection, got a scenario`);
  return parsed.message;
}

suite('the seven pathological steps are part of the scenario format', () => {
  it('parses hangForever with its declared trailing flush', () => {
    const [step] = stepsOf({
      steps: [
        {
          type: 'hangForever',
          onCancel: { steps: [{ type: 'message', text: 'tail' }], stopReason: 'cancelled' },
        },
      ],
    });
    expect(step).toEqual({
      type: 'hangForever',
      onCancel: { steps: [{ type: 'message', text: 'tail' }], stopReason: 'cancelled' },
    });
  });

  it('defaults hangForever to answering cancel with stopReason cancelled', () => {
    // Per adapter layer §2.5 stage 1: cancel ends the turn with a *response*,
    // not with a teardown. A default of "carry on" would make the common case
    // the one that deadlocks.
    const [step] = stepsOf({ steps: [{ type: 'hangForever' }] });
    expect(step).toEqual({ type: 'hangForever', onCancel: { steps: [], stopReason: 'cancelled' } });
  });

  it('parses hangForeverIgnoringCancel, the SIGTERM path’s target', () => {
    expect(stepsOf({ steps: [{ type: 'hangForeverIgnoringCancel' }] })).toEqual([
      { type: 'hangForeverIgnoringCancel' },
    ]);
  });

  it('parses exit with its code, frame budget and truncation flag', () => {
    expect(
      stepsOf({
        steps: [{ type: 'exit', code: 1, afterFrames: 2, truncateMidFrame: true }],
      }),
    ).toEqual([{ type: 'exit', code: 1, afterFrames: 2, truncateMidFrame: true }]);
  });

  it('defaults exit to a clean-ish nonzero exit with no truncation', () => {
    expect(stepsOf({ steps: [{ type: 'exit' }] })).toEqual([
      { type: 'exit', code: 1, afterFrames: 0, truncateMidFrame: false },
    ]);
  });

  it('parses malformedLine, invalidFrame, hugeLine, noNewline and spawnGrandchildren', () => {
    expect(
      stepsOf({
        steps: [
          { type: 'malformedLine' },
          { type: 'invalidFrame', variant: 'unknownStopReason' },
          { type: 'hugeLine', totalBytes: 1024, chunkBytes: 256 },
          { type: 'noNewline', chunkBytes: 256, intervalMs: 5, totalBytes: 4096 },
          { type: 'spawnGrandchildren', count: 3, lifetimeMs: 5_000 },
        ],
      }),
    ).toEqual([
      { type: 'malformedLine', text: '{"jsonrpc":"2.0","method":' },
      { type: 'invalidFrame', variant: 'unknownStopReason' },
      { type: 'hugeLine', totalBytes: 1024, chunkBytes: 256, lineBytes: null },
      { type: 'noNewline', chunkBytes: 256, intervalMs: 5, totalBytes: 4096 },
      { type: 'spawnGrandchildren', count: 3, lifetimeMs: 5_000 },
    ]);
  });

  it('gives a tool call a result of a stated size, for the 256 KiB spill threshold', () => {
    const [step] = stepsOf({
      steps: [
        {
          type: 'toolCall',
          title: 'run the tests',
          toolKind: 'execute',
          path: '/tmp/x',
          statuses: ['pending', 'completed'],
          contentBytes: 307200,
        },
      ],
    });
    expect((step as { contentBytes: number }).contentBytes).toBe(307200);
  });

  it('defaults contentBytes to null: an ordinary tool call carries no result blob', () => {
    const [step] = stepsOf({
      steps: [
        {
          type: 'toolCall',
          title: 't',
          toolKind: 'execute',
          path: '/tmp/x',
          statuses: ['completed'],
        },
      ],
    });
    expect((step as { contentBytes: number | null }).contentBytes).toBeNull();
  });

  it('takes an exact line size, which is how the 8 MiB boundary is stimulated', () => {
    const [step] = stepsOf({ steps: [{ type: 'hugeLine', lineBytes: 8388609 }] });
    expect(step).toEqual({
      type: 'hugeLine',
      totalBytes: 10 * 1024 * 1024,
      chunkBytes: 64 * 1024,
      lineBytes: 8388609,
    });
  });

  it('defaults lineBytes to null, meaning "as long as totalBytes makes it"', () => {
    const [step] = stepsOf({ steps: [{ type: 'hugeLine', totalBytes: 1024, chunkBytes: 256 }] });
    expect(step).toEqual({
      type: 'hugeLine',
      totalBytes: 1024,
      chunkBytes: 256,
      lineBytes: null,
    });
  });

  it('lets noNewline run without end, which is the wedge it models', () => {
    const [step] = stepsOf({ steps: [{ type: 'noNewline' }] });
    expect(step).toEqual({
      type: 'noNewline',
      chunkBytes: 64 * 1024,
      intervalMs: 10,
      totalBytes: null,
    });
  });

  it('rejects an invalidFrame variant nobody implemented', () => {
    const message = failure({ steps: [{ type: 'invalidFrame', variant: 'agent_on_fire' }] });
    expect(message).toContain('steps[0]');
    expect(message).toContain('agent_on_fire');
  });

  it('rejects a misspelled truncation flag rather than silently not truncating', () => {
    const message = failure({ steps: [{ type: 'exit', truncateMidframe: true }] });
    expect(message).toContain('steps[0]');
    expect(message).toContain('truncateMidframe');
  });

  it('rejects a non-boolean truncateMidFrame', () => {
    expect(failure({ steps: [{ type: 'exit', truncateMidFrame: 'yes' }] })).toContain('boolean');
  });
});

suite('AC8 — one dedicated CLI flag per behaviour', () => {
  it('covers all seven behaviours', () => {
    expect(Object.keys(PATHOLOGICAL_FLAGS).sort()).toEqual([
      '--exit-mid-turn',
      '--hang-forever',
      '--hang-forever-ignoring-cancel',
      '--huge-line',
      '--invalid-frame',
      '--malformed-line',
      '--no-newline',
    ]);
  });

  it.each(Object.keys(PATHOLOGICAL_FLAGS))('%s selects a shipped scenario file', (flag) => {
    const parsed = parseArgv([flag]);
    if (parsed.kind !== 'run') throw new Error(`${flag} did not parse: ${JSON.stringify(parsed)}`);

    const path = parsed.options.scenarioPath ?? '';
    expect(basename(path)).toBe(PATHOLOGICAL_FLAGS[flag]);
    expect(existsSync(path), `${path} exists`).toBe(true);

    // The reproduction command is only useful if the file behind it is one the
    // binary will actually accept.
    const loaded = parseScenario(readFileSync(path, 'utf8'), path);
    expect(loaded.ok ? '' : loaded.message).toBe('');
  });

  it('still honours --seed alongside a behaviour flag', () => {
    const parsed = parseArgv(['--seed', '9', '--huge-line']);
    expect(parsed.kind === 'run' ? parsed.options.seed : -1).toBe(9);
  });

  it('refuses a behaviour flag together with --scenario', () => {
    // Two scripts, one turn: whichever won would be a silent choice, and the
    // reader of the failing test would have no way to tell which ran.
    const parsed = parseArgv(['--huge-line', '--scenario', '/tmp/x.jsonc']);
    expect(parsed.kind).toBe('error');
    expect(parsed.kind === 'error' ? parsed.message : '').toContain('--huge-line');
  });

  it('refuses two behaviour flags at once, for the same reason', () => {
    const parsed = parseArgv(['--huge-line', '--no-newline']);
    expect(parsed.kind).toBe('error');
  });

  it('documents every flag in --help, so the reproduction is discoverable', () => {
    for (const flag of Object.keys(PATHOLOGICAL_FLAGS)) expect(USAGE).toContain(flag);
  });
});
