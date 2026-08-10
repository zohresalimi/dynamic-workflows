/**
 * `GET /api/pty/:runId/:nodeId` — the one WebSocket in the product
 * (KAR-15.8, docs/11-api-and-realtime.md §1, §7.7).
 *
 * Three properties are the whole story, and each is load-bearing:
 *
 * 1. **The upgrade is authorised before a socket exists** (AC2). This module
 *    is only ever reached through the guard `startHttp` installs on
 *    `server.on('upgrade', …)` (KAR-15.2 AC11), which has already checked the
 *    bearer token, the `Origin` and the `Host`. Everything below therefore
 *    runs *after* the request was allowed, and the refusals here are about
 *    what was asked for, not about who asked.
 * 2. **It is the same `node:http` server Hono serves from** (AC1). Not a
 *    second listener and not a Hono WebSocket helper: one process, one port,
 *    one origin (D10), and no dependency whose next major version decides when
 *    a socket may be accepted.
 * 3. **It is a live interactive channel only** (AC4). The durable record is
 *    `io_chunk`, written by the session regardless of who is attached, so
 *    closing the panel neither kills the node nor loses a byte — and a panel
 *    that reopens backfills from `GET /api/runs/:id/nodes/:nodeId/io`
 *    (KAR-15.6) rather than from anything held here.
 *
 * Because of (3) this socket holds no buffer and no history: it forwards what
 * the pty produced while it was attached, and it is allowed to be closed at
 * any moment by either end without anybody losing anything. That is what makes
 * a protocol violation a *close* rather than something to recover from.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { log } from '../logging.ts';
import type { PtyExit } from '../pty/pty-session.ts';
import { ptySessionFor } from '../pty/pty-sessions.ts';
import { exitFrameText, parseClientText, parsePtyPath } from './pty-protocol.ts';
import { setUpgradeHandler } from './server.ts';
import { refuseUpgrade } from './socket-refusal.ts';
import {
  acceptKey,
  CLOSE_NORMAL,
  closePayload,
  createFrameDecoder,
  encodeFrame,
  OPCODE,
  WsProtocolError,
} from './ws-frame.ts';

const pty = log.child({ mod: 'pty-socket' });

/** Registers this module as the daemon's upgrade handler. Called by `boot`. */
export function installPtyUpgrade(): void {
  setUpgradeHandler(ptyUpgradeHandler);
}

export function ptyUpgradeHandler(request: IncomingMessage, socket: Duplex, head: Buffer): void {
  const path = (request.url ?? '/').split('?')[0] ?? '/';
  const target = parsePtyPath(path);
  if (target === null) {
    refuseUpgrade(socket, 'not_found', `no terminal is served at ${path}`, 'not_a_pty_path');
    return;
  }

  // RFC 6455 §4.2.1. A missing key is a client that is not speaking WebSocket,
  // and answering it with a 101 would leave both ends waiting for frames the
  // other will never send.
  const key = headerOf(request, 'sec-websocket-key');
  const version = headerOf(request, 'sec-websocket-version');
  if (key === undefined || version !== '13') {
    refuseUpgrade(
      socket,
      'invalid_request',
      'a pty upgrade needs Sec-WebSocket-Key and Sec-WebSocket-Version: 13',
      'bad_handshake',
    );
    return;
  }

  const session = ptySessionFor(target.runId, target.nodeId);
  if (session === null) {
    // 404 and not 409: from the client's side "this node has no live terminal"
    // and "this node does not exist" are the same fact, and the node may
    // simply have finished. The panel falls back to the io endpoint.
    refuseUpgrade(
      socket,
      'node_not_found',
      `no live terminal for ${target.nodeId} on ${target.runId}`,
      'no_live_pty',
    );
    return;
  }

  // Keystrokes. Nagle would coalesce them into 40 ms batches, which is the
  // entire latency budget of "type into it at keystroke latency".
  if ('setNoDelay' in socket) (socket as { setNoDelay(on: boolean): void }).setNoDelay(true);

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
      // KAR-15.2 AC5 — on this response too: it is the one the browser caches
      // a decision about.
      'Vary: Origin\r\n\r\n',
  );

  const decoder = createFrameDecoder({ requireMask: true });
  let closed = false;

  const send = (bytes: Buffer): void => {
    if (closed || socket.destroyed) return;
    socket.write(bytes);
  };

  const shut = (code: number, reason = ''): void => {
    if (closed) return;
    closed = true;
    send(encodeFrame(OPCODE.close, closePayload(code, reason)));
    detach();
    socket.end();
  };

  const detach = session.attach({
    onData: (bytes) => send(encodeFrame(OPCODE.binary, bytes)),
    onExit: (exit: PtyExit) => {
      // AC5: the exit frame, then the close — in that order, because a client
      // that saw the close first would report a dropped connection for a node
      // that finished cleanly.
      send(encodeFrame(OPCODE.text, Buffer.from(exitFrameText(exit), 'utf8')));
      shut(CLOSE_NORMAL, 'node exited');
    },
  });

  const consume = (bytes: Buffer): void => {
    try {
      for (const message of decoder.push(bytes)) {
        switch (message.opcode) {
          case OPCODE.binary:
            // The whole point of the socket: raw bytes, straight to the pty.
            session.write(message.payload);
            break;
          case OPCODE.text: {
            const command = parseClientText(message.payload.toString('utf8'));
            session.resize(command.cols, command.rows);
            break;
          }
          case OPCODE.ping:
            send(encodeFrame(OPCODE.pong, message.payload));
            break;
          case OPCODE.pong:
            break;
          case OPCODE.close:
            shut(CLOSE_NORMAL, 'panel closed');
            break;
          default:
            break;
        }
      }
    } catch (error) {
      // A live-only channel has nothing to salvage: the durable record is
      // already in `io_chunk`, so the honest response to a frame the client
      // had no right to send is to say why and close.
      const violation = error instanceof WsProtocolError;
      pty.warn(
        { runId: session.runId, nodeId: session.nodeId, err: String(error) },
        'closing a pty socket on a bad frame',
      );
      shut(violation ? (error as WsProtocolError).closeCode : 1011, 'protocol error');
    }
  };

  if (head.byteLength > 0) consume(head);
  socket.on('data', consume);
  // Detach on **both**, and never kill: a tab that crashed and a tab that was
  // closed politely are the same event as far as the node is concerned.
  socket.on('close', () => {
    closed = true;
    detach();
  });
  socket.on('error', () => {
    closed = true;
    detach();
  });

  pty.debug({ runId: session.runId, nodeId: session.nodeId }, 'pty socket attached');
}

function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
