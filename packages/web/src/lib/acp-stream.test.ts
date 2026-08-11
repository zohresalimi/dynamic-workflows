/**
 * KAR-17.5 — ACP frames in, typed messages out.
 *
 * Verifies: EPIC-17-S21 (scenarios 1 and 2), EPIC-17-S20 (scenario 4) · AC1,
 * AC10
 *
 * The frames are the **real recording** — `recordings/claude-agent-acp@0.64.1/
 * full-cycle.ndjson`, captured on 2026-08-04 by running a real handshake
 * against a real binary — rather than four objects written from the spec. The
 * shapes this parser has to survive are the ones a vendor actually emits:
 * `agent_message_chunk` arriving as four separate frames that are one sentence,
 * a `tool_call` whose `title` is the only human-readable thing on it, an
 * `_meta` block nobody documented, and `usage_update` and
 * `available_commands_update` frames that are protocol housekeeping and not
 * transcript.
 *
 * `plan` is the one member of AC1's list the recording does not contain — the
 * two agents captured never emitted one — so it is asserted from a frame built
 * to the SDK's shape, and labelled as such rather than smuggled in beside the
 * real ones.
 */
import { expect, it, describe as suite } from 'vitest';
import recording from '../../../../recordings/claude-agent-acp@0.64.1/full-cycle.ndjson?raw';
import { acpTranscript } from './acp-stream.ts';
import type { IoChunkLine } from './node-output.ts';

/**
 * The agent→client frames of a recording, as the `io_chunk` rows the daemon
 * would have written for them.
 *
 * `dir: 'in'` is the recording's perspective on the *client* side — frames
 * arriving from the agent — which is exactly the set that reaches `agent_json`.
 * One recorded line can carry several frames, because a pipe splits wherever
 * the kernel felt like it, and that is the shape `io_chunk` preserves.
 */
function agentJsonChunks(text: string): IoChunkLine[] {
  const chunks: IoChunkLine[] = [];
  let seq = 100;
  for (const line of text.split('\n').filter((one) => one !== '')) {
    const entry = JSON.parse(line) as {
      header?: unknown;
      dir?: string;
      t?: number;
      msg?: unknown;
      b64?: string;
    };
    if (entry.header !== undefined || entry.dir !== 'in') continue;

    const body =
      entry.msg === undefined
        ? new TextDecoder().decode(Uint8Array.from(atob(entry.b64 ?? ''), (c) => c.charCodeAt(0)))
        : `${JSON.stringify(entry.msg)}\n`;

    chunks.push({
      seq: (seq += 1),
      stream: 'agent_json',
      ts: 1_754_812_800_000 + Math.round(entry.t ?? 0),
      data: body,
    });
  }
  return chunks;
}

const chunks = agentJsonChunks(recording);

/** The transcript of the first prompt turn — everything the recording holds. */
const transcript = acpTranscript(chunks);

suite('EPIC-17-S21 — every message is typed, and housekeeping is not a message', () => {
  it('read real frames at all, so nothing below is vacuous', () => {
    expect(chunks.length).toBeGreaterThan(20);
    expect(chunks.every((one) => one.stream === 'agent_json')).toBe(true);
  });

  it('types each message as the ACP discriminator AC1 names', () => {
    const kinds = new Set(transcript.messages.map((one) => one.kind));

    expect(kinds.has('agent_message_chunk')).toBe(true);
    expect(kinds.has('tool_call')).toBe(true);
    expect(kinds.has('tool_call_update')).toBe(true);
  });

  it('keeps protocol housekeeping out of the transcript', () => {
    // `usage_update`, `available_commands_update` and `session_info_update` are
    // accounting and capability news. Rendering them as agent output is how a
    // panel opened to answer "what is it doing" fills with noise.
    const rendered = transcript.messages.map((one) => one.kind);

    expect(rendered).not.toContain('usage_update');
    expect(rendered).not.toContain('available_commands_update');
    expect(rendered).not.toContain('session_info_update');
  });

  it('joins the chunks of one message and anchors it to the seq it began at', () => {
    // Four `agent_message_chunk` frames sharing `messageId: msg-2` are one
    // paragraph, not four list rows — but the anchor a link points at has to be
    // a real `io_chunk.seq`, so it is the *first* frame's.
    const messages = transcript.messages.filter((one) => one.kind === 'agent_message_chunk');
    expect(messages.length).toBe(2);

    const [first, second] = messages;
    expect(first?.text.length).toBeGreaterThan(0);
    expect(second?.text.length).toBeGreaterThan(first?.text.length ?? 0);

    const seqs = chunks.map((one) => one.seq);
    expect(seqs).toContain(first?.seq);
    expect(seqs).toContain(second?.seq);
    expect(second?.seq).toBeGreaterThan(first?.seq ?? 0);
  });

  it('gives every message a distinct seq, because a link that is not unique is not a link', () => {
    const seqs = transcript.messages.map((one) => one.seq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('carries the tool call’s identity and status, not just its prose', () => {
    const call = transcript.messages.find((one) => one.kind === 'tool_call');
    expect(call?.toolCallId).toMatch(/^toolu_/);
    expect(call?.status).toBe('pending');
    expect(call?.title).toBe('Write');

    // The updates that followed carry the same id — which is what lets the list
    // show a call and its outcome as one thing rather than three unrelated rows.
    const updates = transcript.messages.filter((one) => one.kind === 'tool_call_update');
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((one) => one.toolCallId === call?.toolCallId)).toBe(true);
  });

  it('reads a plan update, which the recorded agents never sent', () => {
    // Built to `@agentclientprotocol/sdk`'s `SessionUpdate` shape rather than
    // captured, and kept separate from the recording above so the difference
    // between "verified against a vendor" and "verified against a spec" is
    // visible in the file.
    const planFrame: IoChunkLine = {
      seq: 9_001,
      stream: 'agent_json',
      ts: 1_754_812_900_000,
      data: `${JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: '00000000-0000-4000-8000-000000000001',
          update: {
            sessionUpdate: 'plan',
            entries: [
              { content: 'read the failing test', priority: 'high', status: 'completed' },
              { content: 'fix the reducer', priority: 'high', status: 'in_progress' },
            ],
          },
        },
      })}\n`,
    };

    const plan = acpTranscript([planFrame]).messages;
    expect(plan).toHaveLength(1);
    expect(plan[0]?.kind).toBe('plan');
    expect(plan[0]?.seq).toBe(9_001);
    expect(plan[0]?.text).toContain('fix the reducer');
  });
});

suite('EPIC-17-S20 scenario 4 — honest endings (AC10)', () => {
  it('sees the result envelope, and reports the latest turn’s reason', () => {
    // `{"id":3,"result":{"stopReason":"end_turn"}}` is the response to
    // `session/prompt`. Its presence is the difference between "the agent
    // finished" and "the pipe went quiet".
    //
    // This recording is a *full cycle* and holds two prompt turns: the first
    // ends `end_turn`, the second is cancelled by the client
    // (`session/cancel`, then `{"id":4,"result":{"stopReason":"cancelled"}}`).
    // One attempt's `io_chunk` stream can hold several turns, so the reason
    // reported is the latest one — which is what the panel has to say about a
    // node the operator is looking at now.
    expect(transcript.endedWithoutResult).toBe(false);
    expect(transcript.stopReason).toBe('cancelled');

    // And the earlier one is genuinely in the same stream, so "latest" is a
    // choice this parser makes rather than the only value available.
    const upToFirstEnd = chunks.slice(
      0,
      chunks.findIndex((one) => one.data.includes('"end_turn"')) + 1,
    );
    expect(acpTranscript(upToFirstEnd).stopReason).toBe('end_turn');
  });

  it('says so when the output ended with no result envelope at all', () => {
    // Everything up to and including the last `session/update`, with the
    // response cut off — an adapter killed mid-turn, which is precisely the
    // eleven-minutes-and-nothing case the panel exists for.
    const truncated = chunks.filter((one) => !one.data.includes('"stopReason"'));
    const cut = acpTranscript(truncated);

    expect(cut.messages.length).toBeGreaterThan(0);
    expect(cut.endedWithoutResult).toBe(true);
    expect(cut.stopReason).toBeNull();
  });

  it('does not call an empty stream an unfinished turn', () => {
    // A node that produced nothing at all is AC10's *other* honest state, and
    // conflating it with "ended without a result" would report a truncation
    // that never happened.
    const empty = acpTranscript([]);

    expect(empty.messages).toEqual([]);
    expect(empty.endedWithoutResult).toBe(false);
  });
});
