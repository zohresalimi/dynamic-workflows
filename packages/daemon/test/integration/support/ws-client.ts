/**
 * A WebSocket client made of `node:http` and the daemon's own frame codec.
 *
 * Node ships a global `WebSocket`, and it is the wrong tool for this spec for
 * one reason: the browser-shaped constructor takes no headers, so it cannot
 * send `Authorization: Bearer …` — and a test that worked around that by
 * moving the token into the query string would be testing the exact design
 * KAR-15.2 refused (docs/15-security-model.md §3.2). Driving the upgrade by
 * hand also gives this spec the thing it is really about: it can observe the
 * **refusal**, which arrives as an ordinary HTTP response on a socket that was
 * never upgraded, and it can prove that no upgrade happened at all.
 *
 * Encoding runs through `src/http/ws-frame.ts` in its client configuration —
 * masked out, unmasked in — so the two sides of the codec are exercised
 * against each other rather than against a second implementation of the same
 * misunderstanding.
 */
import { Buffer } from 'node:buffer';
import { request as httpRequest } from 'node:http';
import type { Socket } from 'node:net';
import {
  acceptKey,
  CLOSE_NORMAL,
  closePayload,
  createFrameDecoder,
  encodeFrame,
  newWebSocketKey,
  OPCODE,
  type WsMessage,
} from '../../../src/http/ws-frame.ts';

/** An upgrade the daemon answered with an HTTP response instead of a socket. */
export class UpgradeRefused extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`the upgrade was refused with ${status}: ${body}`);
    this.name = 'UpgradeRefused';
    this.status = status;
    this.body = body;
  }

  /** The daemon's closed error envelope, as `apiError` writes it. */
  get code(): string {
    try {
      return (JSON.parse(this.body) as { error: { code: string } }).error.code;
    } catch {
      return '';
    }
  }
}

export interface WsClient {
  /** Every message received, in order, control frames included. */
  readonly received: readonly WsMessage[];
  /** Binary payloads only, concatenated and decoded — a terminal's screen. */
  output(): string;
  /** Text payloads only, in order. */
  texts(): string[];
  sendBinary(bytes: Buffer): void;
  sendText(text: string): void;
  /** Sends a close frame and waits for the socket to end. */
  close(): Promise<void>;
  /** Ends the socket without a close frame — a tab that was killed. */
  destroy(): void;
  /** Resolves when the socket ends, whoever closed it. */
  readonly ended: Promise<void>;
  readonly headers: Readonly<Record<string, string>>;
}

export interface OpenWsOptions {
  readonly headers?: Readonly<Record<string, string>>;
  /** Omit `Sec-WebSocket-Key`/`Version` to prove the handshake is checked. */
  readonly handshake?: boolean;
}

export function openWs(url: string, options: OpenWsOptions = {}): Promise<WsClient> {
  const key = newWebSocketKey();
  const handshake = options.handshake ?? true;

  return new Promise<WsClient>((resolve, reject) => {
    const request = httpRequest(url, {
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        ...(handshake ? { 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': key } : {}),
        ...options.headers,
      },
    });

    request.on('error', reject);

    // The refusal path: the daemon wrote a status line and a JSON envelope
    // onto the socket and closed it, so `upgrade` never fires.
    request.on('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => reject(new UpgradeRefused(response.statusCode ?? 0, body)));
    });

    request.on('upgrade', (response, socket: Socket, head: Buffer) => {
      const accept = response.headers['sec-websocket-accept'];
      if (accept !== acceptKey(key)) {
        socket.destroy();
        reject(new Error(`Sec-WebSocket-Accept was ${String(accept)}, not the digest of the key`));
        return;
      }

      const received: WsMessage[] = [];
      // A server never masks, so the client decoder must not require one.
      const decoder = createFrameDecoder({ requireMask: false });
      let endResolve: () => void = () => undefined;
      const ended = new Promise<void>((settle) => {
        endResolve = settle;
      });

      const consume = (bytes: Buffer): void => {
        for (const message of decoder.push(bytes)) {
          received.push(message);
          // Answering a ping keeps a socket the daemon is heartbeating alive.
          if (message.opcode === OPCODE.ping) {
            socket.write(encodeFrame(OPCODE.pong, message.payload, { mask: true }));
          }
        }
      };

      if (head.byteLength > 0) consume(head);
      socket.on('data', consume);
      socket.on('close', () => endResolve());
      socket.on('error', () => endResolve());

      resolve({
        received,
        headers: Object.fromEntries(
          Object.entries(response.headers).map(([name, value]) => [
            name,
            Array.isArray(value) ? (value[0] ?? '') : (value ?? ''),
          ]),
        ),
        output: () =>
          Buffer.concat(
            received.filter((m) => m.opcode === OPCODE.binary).map((m) => m.payload),
          ).toString('utf8'),
        texts: () =>
          received.filter((m) => m.opcode === OPCODE.text).map((m) => m.payload.toString('utf8')),
        sendBinary: (bytes) => void socket.write(encodeFrame(OPCODE.binary, bytes, { mask: true })),
        sendText: (text) =>
          void socket.write(encodeFrame(OPCODE.text, Buffer.from(text, 'utf8'), { mask: true })),
        close: async () => {
          socket.write(
            encodeFrame(OPCODE.close, closePayload(CLOSE_NORMAL, 'panel closed'), { mask: true }),
          );
          await ended;
        },
        destroy: () => socket.destroy(),
        ended,
      });
    });

    request.end();
  });
}
