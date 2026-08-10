/**
 * The closed error envelope, written by hand onto a socket that asked to be
 * upgraded (KAR-15.2 AC11, KAR-15.8 AC2).
 *
 * By hand because there is no `Context` here: the request never became one. A
 * client that spoke WebSocket gets a readable HTTP refusal rather than a reset
 * connection, which is the difference between "the daemon refused me, and said
 * why" and an afternoon spent looking at the wrong layer.
 *
 * Shared by the upgrade guard in `./server.ts` and the PTY socket in
 * `./pty-socket.ts` so there is one refusal shape on this path. Two copies
 * would drift the moment one of them learned a header the other did not — and
 * `Vary: Origin` is exactly such a header (KAR-15.2 AC5).
 */
import type { Duplex } from 'node:stream';
import { API_ERROR_STATUS, type ApiErrorCode, apiError } from './errors.ts';

const STATUS_TEXT: Partial<Record<(typeof API_ERROR_STATUS)[ApiErrorCode], string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** Ends the socket with an HTTP response. Nothing was upgraded. */
export function refuseUpgrade(
  socket: Duplex,
  code: ApiErrorCode,
  message: string,
  reason: string,
): void {
  const [envelope, status] = apiError(code, message, { detail: { reason } });
  const body = JSON.stringify(envelope);
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}\r\n` +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Vary: Origin\r\n' +
      'Connection: close\r\n' +
      `\r\n${body}`,
  );
}
