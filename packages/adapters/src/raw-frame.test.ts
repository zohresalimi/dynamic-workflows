/**
 * KAR-05.2 AC1 — `caps_json` is stored **byte-for-byte as received**, which
 * means the probe cannot re-serialise a parsed object and call it the
 * response. `sliceMember` is how the exact source text of one top-level member
 * is taken out of a frame nobody has reformatted.
 *
 * Verifies: EPIC-05-S6 (scenario 2) · AC1
 */
import { expect, it, describe as suite } from 'vitest';
import { sliceMember } from './raw-frame.ts';

suite('sliceMember takes the source text, not a re-encoding', () => {
  it('keeps the whitespace and the key order the sender chose', () => {
    const frame = '{"jsonrpc":"2.0","id":0,"result": { "b": 1,\n  "a":  [2, 3] } }';
    expect(sliceMember(frame, 'result')).toBe('{ "b": 1,\n  "a":  [2, 3] }');
  });

  it('handles a member that is not an object', () => {
    expect(sliceMember('{"error":null,"result":true}', 'result')).toBe('true');
    expect(sliceMember('{"result":  "ok"  }', 'result')).toBe('"ok"');
    expect(sliceMember('{"result":-1.5e3}', 'result')).toBe('-1.5e3');
  });

  it('is not fooled by the key appearing inside a string value', () => {
    const frame = '{"id":"result","result":{"note":"the result is here"}}';
    expect(sliceMember(frame, 'result')).toBe('{"note":"the result is here"}');
  });

  it('is not fooled by a brace or a quote inside a string', () => {
    const frame = String.raw`{"result":{"text":"a } and a \" and a { too"},"id":1}`;
    expect(sliceMember(frame, 'result')).toBe(String.raw`{"text":"a } and a \" and a { too"}`);
  });

  it('only sees top-level members: a nested "result" is not the answer', () => {
    const frame = '{"error":{"result":"nested"},"result":"real"}';
    expect(sliceMember(frame, 'result')).toBe('"real"');
  });

  it('returns null when the member is absent, so a caller must decide', () => {
    expect(sliceMember('{"error":{"code":-32601}}', 'result')).toBeNull();
  });

  it('returns null for text that is not an object at all', () => {
    expect(sliceMember('not json', 'result')).toBeNull();
    expect(sliceMember('[1,2,3]', 'result')).toBeNull();
    expect(sliceMember('', 'result')).toBeNull();
  });

  it('returns null for a truncated frame rather than a truncated slice', () => {
    expect(sliceMember('{"result":{"a":1', 'result')).toBeNull();
  });

  it('round-trips: what it returns parses to what JSON.parse saw', () => {
    const frame = '{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1,"x":[{"y":null}]}}';
    const sliced = sliceMember(frame, 'result');
    expect(sliced).not.toBeNull();
    expect(JSON.parse(sliced ?? '')).toEqual((JSON.parse(frame) as { result: unknown }).result);
  });
});
