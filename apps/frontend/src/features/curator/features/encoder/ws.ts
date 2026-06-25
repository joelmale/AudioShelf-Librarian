/**
 * useEncodeSocket — typed WebSocket hook for the live encode console.
 *
 * Connects to the api/ WebSocket (`/ws/encode`), subscribes to one operation,
 * and exposes the streamed log lines + latest progress/status. It also returns
 * `control(action)` so the console can pause/resume/cancel over the SAME socket
 * (the bidirectional capability the encoder was specified to use), rather than
 * a separate REST round-trip.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface EncodeProgress {
  phase: string;
  current: number;
  total: number;
  message?: string;
}

export interface EncodeLogLine {
  line: string;
  ts: number;
}

type ServerEvent =
  | { type: 'log'; line: string; ts: number }
  | { type: 'progress'; progress: EncodeProgress; ts: number }
  | { type: 'status'; status: string; summary?: unknown; ts: number }
  | { type: 'control'; action: string; changed: boolean; status: string; ts: number }
  | { type: 'error'; error: string; code: string };

export type EncodeControl = 'pause' | 'resume' | 'cancel';

export interface UseEncodeSocket {
  connected: boolean;
  lines: EncodeLogLine[];
  progress: EncodeProgress | null;
  status: string | null;
  control: (action: EncodeControl) => void;
}

function socketUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws/encode`;
}

export function useEncodeSocket(operationId: string | null): UseEncodeSocket {
  const [connected, setConnected] = useState(false);
  const [lines, setLines] = useState<EncodeLogLine[]>([]);
  const [progress, setProgress] = useState<EncodeProgress | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!operationId) return;
    setLines([]);
    setProgress(null);
    setStatus(null);

    const ws = new WebSocket(socketUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ action: 'subscribe', operationId }));
    };
    ws.onclose = () => setConnected(false);
    ws.onmessage = (ev) => {
      let msg: ServerEvent;
      try {
        msg = JSON.parse(ev.data as string) as ServerEvent;
      } catch {
        return;
      }
      if (msg.type === 'log') setLines((prev) => [...prev, { line: msg.line, ts: msg.ts }]);
      else if (msg.type === 'progress') setProgress(msg.progress);
      else if (msg.type === 'status') setStatus(msg.status);
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [operationId]);

  const control = useCallback(
    (action: EncodeControl) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === ws.OPEN && operationId) {
        ws.send(JSON.stringify({ action, operationId }));
      }
    },
    [operationId]
  );

  return { connected, lines, progress, status, control };
}
