/**
 * How a refusal from the safety layer crosses the ACP wire.
 *
 * KAR-08.2 AC7/AC8 — a refusal becomes a JSON-RPC **error response**, so the
 * agent's *request* fails and its session does not. A denial is a rejection,
 * not a teardown: the agent gets its error, takes whatever branch it has for
 * one, and carries on with its turn.
 *
 * The structured denial rides on `data` rather than in the message, because
 * the node inspector renders it and the approval queue groups by it; a UI that
 * had to parse an English sentence to find out which route an escape took
 * would be parsing an English sentence. `-32602` is what a refused parameter
 * gets, ACP having no permission-denied code of its own.
 *
 * Shared by ./acp-fs.ts and ./acp-terminal.ts because a second copy is how the
 * two boundaries end up reporting the same denial two different ways.
 */
import { RequestError } from '@agentclientprotocol/sdk';
import { PermissionDeniedError } from '../path-mediation.ts';

export const rejecting = async <T>(op: () => Promise<T>): Promise<T> => {
  try {
    return await op();
  } catch (error) {
    throw error instanceof PermissionDeniedError
      ? new RequestError(-32602, error.message, { ...error.denial })
      : error;
  }
};
