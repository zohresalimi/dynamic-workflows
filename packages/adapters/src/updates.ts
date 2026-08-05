/**
 * One `session/update` notification, described as the pair the ledger keeps:
 * a `phase` and a one-line `message` (`NodeProgressSchema`).
 *
 * The *bytes* of the frame are not in here. They go to `io_chunk` verbatim,
 * because a framing bug is only ever diagnosable from what actually arrived,
 * and because the control plane is replayed on every daemon start while the
 * data plane never is (docs/05-durable-execution.md §5.1). This module decides
 * only what the control-plane row says.
 *
 * Every arm goes through `toSingleLine`, and an arm with nothing to say omits
 * `message` rather than sending `''`: `singleLine()` refuses the empty string,
 * and a payload the append boundary refuses would lose the frame in order to
 * keep a field present.
 */
import { toSingleLine } from '@DeFlow/core';
import type * as acp from '@agentclientprotocol/sdk';

/**
 * The text a tool call is reporting as its result, concatenated, or `''`.
 *
 * This is the payload docs/07-provider-adapter-layer.md §10.2 names first when
 * it says what has to be spilled: a `tool_call_update` carrying a build log or
 * a captured test failure. Only `content` blocks are read — a `diff` block is a
 * structured value the plan layer owns, and a `terminal` block is a reference
 * to output the terminal service has already bounded (AC7), so neither is
 * bytes this layer should be copying anywhere.
 */
export function toolCallContentText(update: acp.SessionUpdate): string {
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
    return '';
  }
  let text = '';
  for (const block of update.content ?? []) {
    if (block.type === 'content') text += textOf(block.content);
  }
  return text;
}

/** What one update contributes to the node's progress record. */
export interface UpdateDescription {
  /** The ACP discriminator, carried through unabridged — including one this
   * build has never seen, which is data to record rather than a parse error. */
  readonly phase: string;
  /** Absent when the update has nothing renderable to say. */
  readonly message?: string;
}

/** The text of a content block, or `''` for a block that carries none. */
function textOf(content: acp.ContentBlock | undefined): string {
  if (content === undefined) return '';
  return content.type === 'text' ? content.text : '';
}

function described(phase: string, message: string): UpdateDescription {
  const line = toSingleLine(message);
  return line === '' ? { phase } : { phase, message: line };
}

/**
 * Reads one update. Total: every input produces a description, including a
 * `sessionUpdate` from a newer protocol build.
 */
export function describeUpdate(update: acp.SessionUpdate): UpdateDescription {
  const phase = (update as { sessionUpdate: string }).sessionUpdate;

  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk':
    case 'user_message_chunk':
      return described(phase, textOf(update.content));

    case 'tool_call':
      return described(
        phase,
        `${update.kind ?? 'other'} ${update.status ?? 'pending'}: ${update.title}`,
      );

    case 'tool_call_update':
      return described(phase, `${update.toolCallId} ${update.status ?? 'updated'}`);

    case 'plan':
      return described(phase, `${update.entries.length} entries`);

    case 'usage_update':
      return described(phase, `${update.used}/${update.size} tokens in context`);

    case 'current_mode_update':
      return described(phase, `mode ${update.currentModeId}`);

    default:
      // Everything else — plan_update, plan_removed, available_commands_update,
      // config_option_update, session_info_update, and whatever v1.4 adds — is
      // recorded as having happened. The frame itself is in `io_chunk`.
      return { phase };
  }
}
