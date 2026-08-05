/**
 * KAR-04.2 — the scenario parser, which is the only thing standing between a
 * typo in a data file and a turn that mysteriously emits nothing.
 *
 * The parser is deliberately hand-written rather than generated from the JSON
 * Schema: `packages/mock-agent` ships with exactly one dependency
 * (docs/07-provider-adapter-layer.md §13), so it cannot carry ajv into the
 * binary. ./scenario-schema.test.ts is the half that keeps the two honest
 * about each other.
 *
 * Every rejection here has to name *where*. "invalid scenario" sends the
 * reader back to a hundred-line JSONC file with no starting point, and the
 * whole point of AC7 is failing fast rather than debugging an empty turn.
 *
 * Verifies: KAR-04.2 · AC1, AC7 · test plan row 1
 */
import { expect, it, describe as suite } from 'vitest';
import { parseScenario } from '../src/scenario.ts';

/** The narrowing the specs below all want: a failure, with its message. */
function failure(text: string): string {
  const parsed = parseScenario(text);
  if (parsed.ok) throw new Error(`expected a rejection, got a scenario: ${text}`);
  return parsed.message;
}

function success(text: string) {
  const parsed = parseScenario(text);
  if (!parsed.ok) throw new Error(`expected a scenario, got: ${parsed.message}`);
  return parsed.scenario;
}

suite('AC1 — a scenario that cannot be understood is rejected, not defaulted', () => {
  it('names the step index and the offending type for an unknown step type', () => {
    const message = failure(
      JSON.stringify({
        steps: [{ type: 'chunks', count: 1 }, { type: 'chunkz' }],
      }),
    );
    expect(message).toContain('steps[1]');
    expect(message).toContain('chunkz');
  });

  it('rejects a file that is not JSON at all', () => {
    expect(failure('{ not json')).toMatch(/json/i);
  });

  it('rejects a top-level value that is not an object', () => {
    expect(failure('[]')).toMatch(/object/i);
  });

  it('rejects a scenario with no steps array', () => {
    expect(failure(JSON.stringify({ name: 'empty' }))).toContain('steps');
  });

  it('rejects an unknown top-level key rather than ignoring it', () => {
    // A silently ignored key is the failure mode this whole story exists to
    // remove: "delayMS" instead of "delayMs" would produce a turn that bursts,
    // and a green cadence assertion nobody could explain.
    const message = failure(JSON.stringify({ steps: [], stopReasson: 'end_turn' }));
    expect(message).toContain('stopReasson');
  });

  it('rejects an unknown key inside a step, naming the step', () => {
    const message = failure(JSON.stringify({ steps: [{ type: 'chunks', count: 2, delayMS: 50 }] }));
    expect(message).toContain('steps[0]');
    expect(message).toContain('delayMS');
  });

  it('rejects a chunks step whose count is not a positive integer', () => {
    expect(failure(JSON.stringify({ steps: [{ type: 'chunks', count: 0 }] }))).toContain(
      'steps[0]',
    );
    expect(failure(JSON.stringify({ steps: [{ type: 'chunks', count: 1.5 }] }))).toContain('count');
  });

  it('rejects a toolCall status the ACP schema does not define', () => {
    const message = failure(
      JSON.stringify({
        steps: [
          {
            type: 'toolCall',
            title: 'read a file',
            toolKind: 'read',
            path: '/tmp/x',
            statuses: ['pending', 'running'],
          },
        ],
      }),
    );
    expect(message).toContain('steps[0]');
    expect(message).toContain('running');
  });

  it('rejects a toolCall with no ToolCallLocation path', () => {
    // AC3: the location is what makes path-scope enforcement testable at
    // request time (F5.3), so a scenario that omits it is not a valid stimulus.
    const message = failure(
      JSON.stringify({
        steps: [{ type: 'toolCall', title: 't', toolKind: 'read', statuses: ['pending'] }],
      }),
    );
    expect(message).toContain('path');
  });

  it('rejects a toolKind outside the ACP ToolKind union', () => {
    const message = failure(
      JSON.stringify({
        steps: [
          { type: 'toolCall', title: 't', toolKind: 'grep', path: '/tmp/x', statuses: ['pending'] },
        ],
      }),
    );
    expect(message).toContain('grep');
  });

  it('rejects a permission step with no options to choose between', () => {
    const message = failure(
      JSON.stringify({
        steps: [{ type: 'permission', title: 't', toolKind: 'edit', path: '/tmp/x', options: [] }],
      }),
    );
    expect(message).toContain('options');
  });

  it('rejects a permission option whose kind is not a PermissionOptionKind', () => {
    const message = failure(
      JSON.stringify({
        steps: [
          {
            type: 'permission',
            title: 't',
            toolKind: 'edit',
            path: '/tmp/x',
            options: [{ optionId: 'yes', name: 'Yes', kind: 'maybe' }],
          },
        ],
      }),
    );
    expect(message).toContain('maybe');
  });

  it('rejects a clientCall naming a method the client does not serve', () => {
    const message = failure(
      JSON.stringify({ steps: [{ type: 'clientCall', method: 'fs/delete_file' }] }),
    );
    expect(message).toContain('fs/delete_file');
  });

  it('rejects a stopReason outside the ACP StopReason union', () => {
    expect(failure(JSON.stringify({ steps: [], stopReason: 'done' }))).toContain('done');
  });

  it('rejects a branch stopReason too, not only the top-level one', () => {
    const message = failure(
      JSON.stringify({
        steps: [
          {
            type: 'permission',
            title: 't',
            toolKind: 'edit',
            path: '/tmp/x',
            options: [{ optionId: 'a', name: 'a', kind: 'allow_once' }],
            onCancelled: { stopReason: 'gave_up' },
          },
        ],
      }),
    );
    expect(message).toContain('gave_up');
  });

  it('rejects a bad step nested inside a branch, naming the path to it', () => {
    const message = failure(
      JSON.stringify({
        steps: [
          {
            type: 'permission',
            title: 't',
            toolKind: 'edit',
            path: '/tmp/x',
            options: [{ optionId: 'a', name: 'a', kind: 'allow_once' }],
            onAllowed: { steps: [{ type: 'nope' }] },
          },
        ],
      }),
    );
    expect(message).toContain('steps[0].onAllowed.steps[0]');
  });
});

suite('AC1 — JSON or JSONC', () => {
  it('accepts line and block comments, and a trailing comma', () => {
    const scenario = success(`{
      // the plan comes first
      "name": "commented",
      /* five chunks, 50 ms apart */
      "steps": [
        { "type": "chunks", "count": 5, "delayMs": 50 },
      ],
    }`);
    expect(scenario.steps).toHaveLength(1);
  });

  it('does not strip a // that lives inside a string', () => {
    // The naive stripper truncates every path in the file at the first slash
    // pair, and the resulting scenario is valid JSON with the wrong data —
    // which is worse than a parse error, because it runs.
    const scenario = success(
      JSON.stringify({
        steps: [
          {
            type: 'toolCall',
            title: 'fetch',
            toolKind: 'fetch',
            path: 'https://example.test/a',
            statuses: ['pending'],
          },
        ],
      }),
    );
    expect(scenario.steps[0]).toMatchObject({ path: 'https://example.test/a' });
  });
});

suite('AC1 — defaults are stated, not inferred at the call site', () => {
  it('defaults the turn stopReason to end_turn', () => {
    expect(success(JSON.stringify({ steps: [] })).stopReason).toBe('end_turn');
  });

  it('defaults a chunk delay to zero', () => {
    const scenario = success(JSON.stringify({ steps: [{ type: 'chunks', count: 3 }] }));
    expect(scenario.steps[0]).toMatchObject({ type: 'chunks', count: 3, delayMs: 0 });
  });

  it('reports the source in the message when one is given', () => {
    const parsed = parseScenario('{ nope', '/tmp/broken.jsonc');
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.message).toContain('/tmp/broken.jsonc');
  });

  it('keeps the diagnostic to a single line', () => {
    // AC1 asks for a one-line diagnostic on stderr. A message with an embedded
    // newline turns into two, and the caller cannot fix that after the fact.
    expect(failure('{ nope')).not.toContain('\n');
  });
});
