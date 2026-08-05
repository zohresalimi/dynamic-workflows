/**
 * KAR-04.3 — the bytes the pathological behaviours put on the wire, checked
 * against the only conformance oracle that exists.
 *
 * `adapter.malformed-output` and `adapter.protocol-error` are separate reasons
 * in docs/04-domain-model.md §8 with different `class` values and therefore
 * different scheduler decisions, so the two stimuli have to be distinguishable
 * at the source: `malformedLine` must fail `JSON.parse`, and `invalidFrame`
 * must **pass** `JSON.parse` and fail validation against
 * `@agentclientprotocol/sdk/schema/schema.json` (262 `$defs`, verified
 * 2026-08-02). A generator that produced merely "some bad JSON" for both would
 * let a parser that conflates them stay green.
 *
 * The oracle is compiled here rather than shipped in the binary on purpose:
 * `packages/mock-agent` carries exactly one dependency
 * (docs/07-provider-adapter-layer.md §13) and ajv is not it.
 *
 * Verifies: EPIC-04-S10, EPIC-04-S11 · KAR-04.3 AC4, AC5, AC6 · test plan row 6
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020.js';
import { expect, it, describe as suite } from 'vitest';
import {
  HUGE_LINE_TOTAL_BYTES,
  INVALID_FRAME_VARIANTS,
  invalidFrame,
  MALFORMED_LINE,
  malformedLine,
  patternSlice,
  RAW_CHUNK_BYTES,
  TRUNCATED_FRAME_PREFIX,
  truncatedFrame,
} from '../src/pathological.ts';

const schemaPath = fileURLToPath(
  import.meta.resolve('@agentclientprotocol/sdk/schema/schema.json'),
);
const acpSchema = JSON.parse(readFileSync(schemaPath, 'utf8')) as Record<string, unknown>;

// strict: false because the schema is generated from Rust types and carries
// formats ajv has no opinion about (`uint32`, `int64`); logger: false because
// ajv narrates every one of them and drowns the run.
const ajv = new Ajv2020.default({ allErrors: true, strict: false, logger: false });
ajv.addSchema(acpSchema, 'acp');

/** Validates a value against one `$def` of the real ACP schema. */
function validateAgainst(definition: string, value: unknown): readonly ErrorObject[] | null {
  const validate = ajv.compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $ref: `acp#/$defs/${definition}`,
  });
  return validate(value) ? null : (validate.errors ?? []);
}

/** Every ajv error, flattened, so a spec can assert the report *names* a path. */
function report(errors: readonly ErrorObject[]): string {
  return errors
    .map((error) => `${error.instancePath} ${error.keyword} ${JSON.stringify(error.params)}`)
    .join('\n');
}

suite('the oracle itself', () => {
  it('accepts a well-formed session/update, so the rejections below mean something', () => {
    // Without this, a broken $ref would fail every frame and the whole file
    // would pass for the wrong reason.
    expect(
      validateAgainst('SessionNotification', {
        sessionId: 'mock-session-1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
      }),
    ).toBeNull();
  });

  it('is the schema with 262 $defs', () => {
    expect(Object.keys(acpSchema.$defs as object)).toHaveLength(262);
  });
});

suite('AC4 — malformedLine is not JSON at all', () => {
  it('throws a SyntaxError on JSON.parse', () => {
    expect(() => JSON.parse(MALFORMED_LINE)).toThrow(SyntaxError);
  });

  it('is an unbalanced brace rather than an empty or truncated-looking blank', () => {
    expect(MALFORMED_LINE).toContain('{');
    expect(MALFORMED_LINE).not.toContain('}');
  });

  it('is written as one complete line — the newline is the point', () => {
    // A malformed *line* only exists once a 0x0a has closed it; without one,
    // the client is looking at the no-newline hazard instead, which is a
    // different failure with a different reason code.
    const written = malformedLine(MALFORMED_LINE);
    expect(written.endsWith('\n')).toBe(true);
    expect(written.slice(0, -1)).not.toContain('\n');
  });
});

suite('AC3 — the truncated frame a mid-turn exit leaves behind', () => {
  it('does not parse and does not end with a newline', () => {
    const partial = truncatedFrame('mock-session-1');
    expect(partial.endsWith('\n')).toBe(false);
    expect(() => JSON.parse(partial)).toThrow(SyntaxError);
  });

  it('is a real frame cut short, not a random string', () => {
    // The point of the stimulus is that a naive reader believes it has a frame
    // until it runs out of bytes; a line that looked nothing like a frame
    // would be caught a step earlier and prove less.
    expect(TRUNCATED_FRAME_PREFIX).toContain('"jsonrpc":"2.0"');
    expect(TRUNCATED_FRAME_PREFIX).toContain('session/update');
    expect(truncatedFrame('mock-session-1')).toContain('mock-session-1');
  });
});

suite('AC5 — invalidFrame is valid JSON that the ACP schema rejects', () => {
  it('offers the four variants EPIC-04-S11 tabulates, plus the discriminator', () => {
    expect([...INVALID_FRAME_VARIANTS]).toEqual([
      'unknownSessionUpdate',
      'toolCallMissingId',
      'unknownPermissionOptionKind',
      'unknownStopReason',
      'locationPathNotAString',
    ]);
  });

  it.each([...INVALID_FRAME_VARIANTS])('%s parses as JSON', (variant) => {
    const built = invalidFrame(variant, { sessionId: 'mock-session-1', requestId: 7 });
    // The line, not the object: the claim is about what a client reads off the
    // wire, and a value that only round-trips in memory would not make it.
    expect(() => JSON.parse(built.line)).not.toThrow();
    expect(built.line.endsWith('\n')).toBe(true);
  });

  it.each([...INVALID_FRAME_VARIANTS])('%s fails schema validation, and says where', (variant) => {
    const built = invalidFrame(variant, { sessionId: 'mock-session-1', requestId: 7 });
    const frame = JSON.parse(built.line) as Record<string, unknown>;
    const errors = validateAgainst(built.definition, frame[built.subject]);

    expect(errors, `${variant} validated against ${built.definition}`).not.toBeNull();
    expect(report(errors ?? [])).toContain(built.pointer);
  });

  it('names params.update.sessionUpdate for the unknown discriminator', () => {
    const built = invalidFrame('unknownSessionUpdate', { sessionId: 'mock-session-1' });
    expect(built.subject).toBe('params');
    expect(built.pointer).toBe('/update/sessionUpdate');
    expect(
      (JSON.parse(built.line) as { params: { update: { sessionUpdate: string } } }).params.update
        .sessionUpdate,
    ).toBe('agent_thought_stream_v3');
  });

  it('is distinguishable from a malformed line — that is the whole point', () => {
    for (const variant of INVALID_FRAME_VARIANTS) {
      const built = invalidFrame(variant, { sessionId: 'mock-session-1', requestId: 7 });
      expect(() => JSON.parse(built.line)).not.toThrow();
    }
    expect(() => JSON.parse(MALFORMED_LINE)).toThrow();
  });
});

suite('AC6 — the 10 MB payload is generated, never random and never checked in', () => {
  it('defaults to 10 MiB written in 64 KiB chunks', () => {
    expect(HUGE_LINE_TOTAL_BYTES).toBe(10 * 1024 * 1024);
    expect(RAW_CHUNK_BYTES).toBe(64 * 1024);
  });

  it('is byte-identical at the same offset every time, so --seed still holds', () => {
    expect(patternSlice(0, 4096)).toBe(patternSlice(0, 4096));
    expect(patternSlice(1_000_003, 4096)).toBe(patternSlice(1_000_003, 4096));
  });

  it('is a repeating pattern: a slice equals the same window of a longer run', () => {
    const whole = patternSlice(0, 8192);
    expect(patternSlice(4096, 4096)).toBe(whole.slice(4096));
  });

  it('contains no newline and no character JSON would have to escape', () => {
    const slice = patternSlice(0, 1024 * 1024);
    expect(slice).toHaveLength(1024 * 1024);
    expect(slice).not.toContain('\n');
    expect(JSON.stringify(slice)).toHaveLength(slice.length + 2);
  });

  it('is not a single repeated character — a byte counter has to see real bytes', () => {
    expect(new Set(patternSlice(0, 1024)).size).toBeGreaterThan(8);
  });
});
