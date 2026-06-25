import React, { createContext, useContext, useEffect, useState } from "react";
import type { AnyWsMessage } from "@audioshelf/shared";

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
    const ws = new WebSocket(`ws://${window.location.host}/api`);
    
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as AnyWsMessage;
        setLastMessage(msg);
      } catch (e) {
        console.error("Failed to parse WS message", e);
      }
    };

    return () => {
      ws.close();
    };
  }, []);

  return (
    <WsContext.Provider value={{ connected, lastMessage }}>
      {children}
    </WsContext.Provider>
  );
};
