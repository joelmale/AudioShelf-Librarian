import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AnyWsMessage } from "@audioshelf/shared";
import { appendAccessToken, onAccessTokenChange } from "../auth/session.js";

/**
 * Application WebSocket.
 *
 * Consumers subscribe to a message type rather than reading a `lastMessage`
 * state value. The old shape had two defects: a single state slot silently
 * dropped any message that arrived in the same tick as another (progress and
 * completion events could vanish), and because the provider wraps the whole
 * route tree, every message re-rendered the entire application — once per
 * backend `console.log`, since `debugLogs` defaults to true and every log line
 * is broadcast.
 *
 * Now the socket dispatches straight to registered handlers and the context
 * value is referentially stable, so message traffic causes no re-renders at all.
 * Only `connected` is state, and that changes rarely.
 */

const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;

export function websocketUrl(location: Pick<Location, "protocol" | "host"> = window.location): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api`;
}

export type WsMessageType = AnyWsMessage["type"];
export type WsPayload<T extends WsMessageType> = Extract<AnyWsMessage, { type: T }>["payload"];
type Handler = (payload: never) => void;

interface WsContextValue {
  connected: boolean;
  subscribe<T extends WsMessageType>(type: T, handler: (payload: WsPayload<T>) => void): () => void;
}

const WsContext = createContext<WsContextValue>({
  connected: false,
  subscribe: () => () => undefined,
});

export const useWebSocket = () => useContext(WsContext);

/**
 * Subscribe to one message type for the lifetime of a component.
 *
 * The handler is held in a ref, so callers do not have to memoize it and an
 * unstable inline closure will not resubscribe on every render.
 */
export function useWsEvent<T extends WsMessageType>(type: T, handler: (payload: WsPayload<T>) => void): void {
  const { subscribe } = useWebSocket();
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(
    () => subscribe(type, ((payload: WsPayload<T>) => handlerRef.current(payload)) as never),
    [subscribe, type],
  );
}

export const WebSocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [connected, setConnected] = useState(false);
  const listenersRef = useRef(new Map<string, Set<Handler>>());

  const subscribe = useCallback<WsContextValue["subscribe"]>((type, handler) => {
    const listeners = listenersRef.current;
    const set = listeners.get(type) ?? new Set<Handler>();
    set.add(handler as Handler);
    listeners.set(type, set);
    return () => {
      set.delete(handler as Handler);
      if (set.size === 0) listeners.delete(type);
    };
  }, []);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let disposed = false;

    const scheduleReconnect = () => {
      if (disposed || retryTimer !== null) return;
      // Exponential backoff with jitter. The previous fixed 3s retry hammered
      // the server forever when the socket could not be established at all —
      // which is exactly what happened whenever authentication was enabled.
      const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attempts, MAX_RECONNECT_DELAY_MS);
      attempts += 1;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect();
      }, delay + Math.floor(Math.random() * 250));
    };

    const dispatch = (message: AnyWsMessage) => {
      const handlers = listenersRef.current.get(message.type);
      if (!handlers) return;
      for (const handler of [...handlers]) {
        try {
          (handler as (payload: unknown) => void)(message.payload);
        } catch (error) {
          // One bad subscriber must not stop the others from seeing the event.
          console.error("WebSocket handler failed", error);
        }
      }
    };

    const connect = () => {
      try {
        ws = new WebSocket(appendAccessToken(websocketUrl()));

        ws.onopen = () => {
          attempts = 0;
          setConnected(true);
        };
        ws.onerror = () => setConnected(false);
        ws.onclose = () => {
          setConnected(false);
          scheduleReconnect();
        };
        ws.onmessage = (event) => {
          try {
            dispatch(JSON.parse(event.data) as AnyWsMessage);
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

    // Signing in or out must rebuild the socket: the token travels in the
    // handshake query string and cannot be changed on a live connection.
    const unsubscribeToken = onAccessTokenChange(() => {
      attempts = 0;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      ws?.close();
    });

    return () => {
      disposed = true;
      unsubscribeToken();
      if (retryTimer !== null) clearTimeout(retryTimer);
      ws?.close();
    };
  }, []);

  // Stable identity: message traffic never invalidates this, so subscribers do
  // not re-render when events arrive.
  const value = useMemo<WsContextValue>(() => ({ connected, subscribe }), [connected, subscribe]);

  return <WsContext.Provider value={value}>{children}</WsContext.Provider>;
};
