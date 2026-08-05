/**
 * KAR-05.1 AC4 — one `session/update` notification becomes exactly one DeFlow
 * event, and this is the pure half of that translation.
 *
 * Pure on purpose. The loop that appends is integration-tested against a real
 * child process and a real SQLite file; *what* an update says is a function of
 * the frame alone, and a function of the frame alone is a unit test.
 *
 * The `message` is a `singleLine()` domain value (`NodeProgressSchema`), which
 * is why every arm goes through `toSingleLine`: an agent that streams a chunk
 * containing a newline is ordinary, and a payload the append boundary refuses
 * would lose the frame rather than record it.
 *
 * Verifies: EPIC-05-S1, EPIC-05-S3 · AC4
 */
import { SINGLE_LINE_MAX } from '@DeFlow/core';
import type * as acp from '@agentclientprotocol/sdk';
import { expect, it, describe as suite } from 'vitest';
import { describeUpdate } from './updates.ts';

suite('the phase is the update kind, unabridged', () => {
  it('carries the ACP discriminator through as the phase', () => {
    const kinds: acp.SessionUpdate[] = [
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'go' } },
    ];
    expect(kinds.map((update) => describeUpdate(update).phase)).toEqual([
      'agent_message_chunk',
      'agent_thought_chunk',
      'user_message_chunk',
    ]);
  });

  it('does not invent a phase for an update kind this build has never seen', () => {
    // Forward compatibility, the same rule the event envelope follows: an
    // unknown kind is data to be recorded, not a parse error.
    const future = { sessionUpdate: 'quantum_update', payload: 7 } as unknown as acp.SessionUpdate;
    expect(describeUpdate(future).phase).toBe('quantum_update');
  });
});

suite('the message is a single line the board can render', () => {
  it('reads a text chunk back', () => {
    expect(
      describeUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'ok' },
      }).message,
    ).toBe('ok');
  });

  it('collapses a multi-line chunk rather than letting it reach the append boundary', () => {
    const described = describeUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'first\nsecond\r\nthird' },
    });
    expect(described.message).toBe('first second third');
  });

  it('clamps a chunk longer than the domain allows', () => {
    const described = describeUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'x'.repeat(SINGLE_LINE_MAX * 3) },
    });
    expect(described.message?.length).toBeLessThanOrEqual(SINGLE_LINE_MAX);
  });

  it('omits the message entirely for a chunk with no text, rather than sending an empty one', () => {
    // `singleLine()` refuses the empty string, so "" would be a payload the
    // ledger rejects — the frame would be lost to keep a field present.
    const described = describeUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    });
    expect(described.message).toBeUndefined();
  });

  it('says what a tool call is and what state it is in', () => {
    const described = describeUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'Run the tests',
      kind: 'execute',
      status: 'pending',
      locations: [{ path: '/wt/n1/package.json' }],
    });
    expect(described.phase).toBe('tool_call');
    expect(described.message).toContain('Run the tests');
    expect(described.message).toContain('execute');
    expect(described.message).toContain('pending');
  });

  it('tracks a tool call through its status walk by id', () => {
    const described = describeUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
    });
    expect(described.message).toContain('tc-1');
    expect(described.message).toContain('completed');
  });

  it('counts the entries of a plan instead of inlining it', () => {
    const described = describeUpdate({
      sessionUpdate: 'plan',
      entries: [
        { content: 'read', priority: 'high', status: 'pending' },
        { content: 'write', priority: 'medium', status: 'pending' },
      ],
    });
    expect(described.message).toBe('2 entries');
  });
});
