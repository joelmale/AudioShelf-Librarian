import React, { createContext, useContext, useEffect, useState } from "react";
import type { AnyWsMessage } from "@audioshelf/shared";

const RECONNECT_DELAY_MS = 3_000;

export function websocketUrl(location: Pick<Location, "protocol" | "host"> = window.location): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api`;
}

interface WsContextValue {
  connected: boolean;
  lastMessage: AnyWsMessage | null;
}

const WsContext = createContext<WsContextValue>({ connected: false, lastMessage: null });

export const useWebSocket = () => useContext(WsContext);

export const WebSocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<AnyWsMessage | null>(null);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const scheduleReconnect = () => {
      if (!disposed && retryTimer === null) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          connect();
        }, RECONNECT_DELAY_MS);
      }
    };

    const connect = () => {
      try {
        ws = new WebSocket(websocketUrl());

        ws.onopen = () => setConnected(true);
        ws.onerror = () => setConnected(false);
        ws.onclose = () => {
          setConnected(false);
          scheduleReconnect();
        };

        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data) as AnyWsMessage;
            setLastMessage(msg);
          } catch (e) {
            console.error("Failed to parse WS message", e);
          }
        };
      } catch (error) {
        // A proxy or browser policy failure must not prevent the application UI
        // from rendering. The provider remains disconnected and retries later.
        console.warn("Unable to open application WebSocket", error);
        setConnected(false);
        scheduleReconnect();
      }
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      ws?.close();
    };
  }, []);

  return (
    <WsContext.Provider value={{ connected, lastMessage }}>
      {children}
    </WsContext.Provider>
  );
};
