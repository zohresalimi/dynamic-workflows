/**
 * KAR-05.7 AC2 — Layer A, the schema-conformance oracle, as a unit.
 *
 * There is **no official ACP conformance kit** (verified negative, 2026-08-02:
 * no `conformance/`, `compliance/` or `tests/` directory in the spec repo, and
 * `@agentclientprotocol/conformance`, `acp-conformance` and
 * `@agentclientprotocol/test-kit` all 404 on npm; web search asserts otherwise
 * by conflating it with an unrelated academic protocol also abbreviated ACP).
 * What does exist is `schema.json`, and `ajv` arrives transitively anyway — so
 * this layer costs nothing and fires the instant an upstream SDK bump changes
 * the wire shape.
 *
 * The specs that matter are the negative ones. A validator that accepts
 * everything passes a whole corpus and proves nothing, so each rejection here
 * also asserts that the report names the **file, the line and the JSON
 * pointer** — the three facts that turn "the corpus is broken" into a diff.
 *
 * Verifies: EPIC-05-S25 · AC2 · test plan #1, #8
 */
import { expect, it, describe as suite } from 'vitest';
import {
  ACP_SCHEMA_DEFS,
  acpSchema,
  corpusRecordings,
  describeViolations,
  readCapturedFrames,
  validateAcpFrames,
} from './acp-conformance.ts';

const line = (value: unknown): string => JSON.stringify(value);

const GOOD_UPDATE = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: 'sess-1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
  },
};

const GOOD_INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: 1, clientCapabilities: { fs: {}, terminal: false } },
};

suite('the oracle itself', () => {
  it('is the published schema, with the 262 $defs measured on 2026-08-02', () => {
    // Without this the whole layer could pass against an empty schema, and a
    // wire change would land in silence.
    expect(Object.keys(acpSchema().$defs as object)).toHaveLength(ACP_SCHEMA_DEFS);
  });

  it('accepts a well-formed frame in each direction, so the rejections mean something', () => {
    const frames = readCapturedFrames(
      `${line({ t: 0, dir: 'in', msg: GOOD_INITIALIZE })}\n${line({ t: 1, dir: 'out', msg: GOOD_UPDATE })}\n`,
      'fixture.ndjson',
    );
    expect(frames).toHaveLength(2);
    expect(validateAcpFrames(frames)).toEqual([]);
  });
});

suite('AC2 — one bad frame fails loudly', () => {
  const corpus =
    `${line({ header: { agent: 'fixture', version: '1.0.0' } })}\n` +
    `${line({ t: 0, dir: 'in', msg: GOOD_INITIALIZE })}\n` +
    `${line({ t: 1, dir: 'out', msg: GOOD_UPDATE })}\n` +
    `${line({
      t: 2,
      dir: 'out',
      msg: {
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'sess-1',
          update: {
            sessionUpdate: 'agent_thought_stream_v3',
            content: { type: 'text', text: '?' },
          },
        },
      },
    })}\n`;

  it('names the file, the line number and the failing JSON pointer', () => {
    const violations = validateAcpFrames(
      readCapturedFrames(corpus, 'recordings/f@1.0.0/bad.ndjson'),
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      file: 'recordings/f@1.0.0/bad.ndjson',
      line: 4,
    });
    // The pointer is what a reader opens the file at. `/params/update` or
    // deeper — anything shallower would just say "the frame is wrong".
    expect(violations[0]?.pointer).toMatch(/^\/params\/update/);

    const report = describeViolations(violations);
    expect(report).toContain('recordings/f@1.0.0/bad.ndjson:4');
    expect(report).toContain('/params/update');
  });

  it('reports the offending line and leaves its neighbours alone', () => {
    const violations = validateAcpFrames(readCapturedFrames(corpus, 'bad.ndjson'));
    expect(violations.map((violation) => violation.line)).toEqual([4]);
  });

  it('treats a line that is not JSON at all as a violation rather than skipping it', () => {
    const violations = validateAcpFrames(
      readCapturedFrames(
        `${line({ t: 0, dir: 'in', msg: GOOD_INITIALIZE })}\n${line({ t: 1, dir: 'out', raw: '{"half a frame' })}\n`,
        'torn.ndjson',
      ),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.keyword).toBe('json');
    expect(describeViolations(violations)).toContain('torn.ndjson:2');
  });
});

suite('AC2 — the reader understands both shapes a capture comes in', () => {
  it('re-frames a raw base64 capture and flips it to the agent perspective', () => {
    // A client-side transport capture stores chunks, not frames: one chunk can
    // carry two notifications and one frame can span two chunks. A reader that
    // treated a line as a frame would validate garbage and pass.
    const chunk = (dir: string, text: string): string =>
      line({ t: 0, dir, b64: Buffer.from(text, 'utf8').toString('base64') });

    const frames = readCapturedFrames(
      `${chunk('out', `${line(GOOD_INITIALIZE)}\n`)}\n${chunk('in', `${line(GOOD_UPDATE)}\n`)}\n`,
      'capture.ndjson',
    );

    // "out" on the client's side is what the agent received, hence "in" here.
    expect(frames.map((frame) => frame.dir)).toEqual(['in', 'out']);
    expect(validateAcpFrames(frames)).toEqual([]);
  });

  it('joins a frame split across two chunks before validating it', () => {
    const text = `${line(GOOD_UPDATE)}\n`;
    const half = Math.floor(text.length / 2);
    const capture =
      `${line({ t: 0, dir: 'in', b64: Buffer.from(text.slice(0, half)).toString('base64') })}\n` +
      `${line({ t: 1, dir: 'in', b64: Buffer.from(text.slice(half)).toString('base64') })}\n`;

    const frames = readCapturedFrames(capture, 'split.ndjson');
    expect(frames).toHaveLength(1);
    expect(validateAcpFrames(frames)).toEqual([]);
  });

  it('ignores the header, the stderr lines and the exit line', () => {
    const frames = readCapturedFrames(
      `${line({ header: { agent: 'x', version: '1.0.0' } })}\n` +
        `${line({ t: 0, stderr: 'warning: something\n' })}\n` +
        `${line({ t: 1, dir: 'in', msg: GOOD_INITIALIZE })}\n` +
        `${line({ t: 2, exit: { code: 0, signal: null } })}\n`,
      'mixed.ndjson',
    );
    expect(frames).toHaveLength(1);
    expect(frames[0]?.line).toBe(3);
  });
});

suite('AC6 / test plan #8 — a directory with no exact version errors', () => {
  it('refuses to walk a corpus whose directory carries a moving tag', () => {
    expect(() => corpusRecordings({ 'claude-agent-acp@latest': ['a.ndjson'] })).toThrow(
      /latest|exact version/,
    );
  });

  it('refuses a directory with no @ at all rather than treating it as a provider', () => {
    // Goldens rotting into a `latest` directory is the failure this prevents,
    // and it is silent: everything still replays, right up to the release that
    // changed what the file means.
    expect(() => corpusRecordings({ 'claude-agent-acp': ['a.ndjson'] })).toThrow(
      /<provider>@<version>/,
    );
  });

  it('accepts an exact version, and reports the key it parsed', () => {
    expect(corpusRecordings({ 'claude-agent-acp@0.64.1': ['simple-edit.ndjson'] })).toEqual([
      {
        provider: 'claude-agent-acp',
        version: '0.64.1',
        case: 'simple-edit',
        file: 'claude-agent-acp@0.64.1/simple-edit.ndjson',
      },
    ]);
  });
});
