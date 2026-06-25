/**
 * WebSocket layer for the interactive encode console (UI-facing — api/ only).
 *
 * Bidirectional, unlike the AI pipeline's one-way SSE: a client subscribes to an
 * encode operation and receives the buffered backlog plus live log/progress/status
 * events; it can also send pause/resume/cancel control messages that resolve the
 * OperationController in the shared registry. This is the "fully interactive"
 * transport the encoder was specified to use.
 *
 * Imports only core + sibling api. Attaches to the existing http.Server so it
 * shares the API port (no extra listener).
 */
import type { Server } from 'node:http';

import { WebSocketServer, type WebSocket } from 'ws';

import type { EncodeHub, EncodeEvent } from './encodeHub.js';
import type { ApiServices } from './services.js';

const WS_PATH = '/ws/encode';

type ClientMessage =
  | { action: 'subscribe'; operationId: string }
  | { action: 'pause' | 'resume' | 'cancel'; operationId: string };

function send(ws: WebSocket, payload: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function parse(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as ClientMessage;
    if (typeof msg?.action !== 'string' || typeof msg?.operationId !== 'string') return null;
    return msg;
  } catch {
    return null;
  }
}

/**
 * Attach the encode WebSocket server to an existing HTTP server. Returns a close
 * handle for graceful shutdown.
 */
export function attachEncodeWebSocket(
  server: Server,
  services: Pick<ApiServices, 'operations' | 'encodeHub' | 'logger'>
): { close: () => void } {
  const { operations, encodeHub, logger } = services;
  const wss = new WebSocketServer({ server, path: WS_PATH });

  wss.on('connection', (ws: WebSocket) => {
    let unsubscribe: (() => void) | null = null;

    const handleSubscribe = (operationId: string): void => {
      unsubscribe?.();
      const forward = (event: EncodeEvent): void => send(ws, event);
      const { backlog, unsubscribe: stop } = (encodeHub as EncodeHub).subscribe(operationId, forward);
      unsubscribe = stop;
      for (const event of backlog) send(ws, event);
      // If the op is already terminal, tell the client so it can close the console.
      const op = operations.get(operationId);
      if (op?.isTerminal()) send(ws, { type: 'status', status: op.status, ts: Date.now() });
    };

    ws.on('message', (data: Buffer) => {
      const msg = parse(data.toString());
      if (!msg) {
        send(ws, { type: 'error', error: 'Malformed message', code: 'VALIDATION' });
        return;
      }
      if (msg.action === 'subscribe') {
        handleSubscribe(msg.operationId);
        return;
      }
      const op = operations.get(msg.operationId);
      if (!op) {
        send(ws, { type: 'error', error: `No operation ${msg.operationId}`, code: 'NOT_FOUND' });
        return;
      }
      const changed =
        msg.action === 'pause' ? op.pause() : msg.action === 'resume' ? op.resume() : op.cancel();
      send(ws, { type: 'control', action: msg.action, changed, status: op.status, ts: Date.now() });
    });

    ws.on('close', () => unsubscribe?.());
    ws.on('error', (err) => logger.debug('encode ws error', { error: String(err) }));
  });

  logger.info('Encode WebSocket listening', { path: WS_PATH });
  return {
    close: () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
    },
  };
}
