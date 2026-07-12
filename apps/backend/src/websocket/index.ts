import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { AnyWsMessageSchema, type AnyWsMessage } from "@audioshelf/shared";
import { authEnabled, verifyAccessToken } from '../security/auth.js';

export class WsRouter {
  private wss: WebSocketServer;

  constructor(server: Server) {
    this.wss = new WebSocketServer({ server });
    
    this.wss.on("connection", async (ws, request) => {
      if(authEnabled()) {
        const url=new URL(request.url??'/', 'http://localhost');
        const token=url.searchParams.get('access_token') ?? request.headers.authorization?.replace(/^Bearer\s+/i,'');
        try { if(!token)throw new Error('missing token'); await verifyAccessToken(token); }
        catch { ws.close(1008,'Authentication required'); return; }
      }
      console.log("New WebSocket connection established");
      
      ws.on("message", (data) => {
        try {
          const raw = JSON.parse(data.toString());
          // Optional: handle incoming messages if needed
        } catch (e) {
          console.error("Failed to parse incoming WS message", e);
        }
      });

      ws.on("close", () => {
        console.log("WebSocket connection closed");
      });
    });
  }

  /** Broadcast a strictly-typed message to all connected clients */
  public broadcast(message: AnyWsMessage): void {
    const data = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }
}

export function attachWebSocket(server: Server): WsRouter {
  return new WsRouter(server);
}
