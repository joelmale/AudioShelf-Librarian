/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketProvider, useWsEvent, websocketUrl } from "./WebSocketProvider.js";
import { resetAccessTokenCache, setAccessToken } from "../auth/session.js";

/** Minimal WebSocket double whose instances the tests can drive directly. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }

  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
  vi.useFakeTimers();
  sessionStorage.clear();
  resetAccessTokenCache();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  resetAccessTokenCache();
});

const socket = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

function render(ui: React.ReactNode) {
  act(() => {
    root.render(<WebSocketProvider>{ui}</WebSocketProvider>);
  });
}

describe("websocketUrl", () => {
  it("uses WSS when the application is served over HTTPS", () => {
    expect(websocketUrl({ protocol: "https:", host: "audioshelf.example.test" } as Location))
      .toBe("wss://audioshelf.example.test/api");
  });

  it("uses WS for local HTTP development", () => {
    expect(websocketUrl({ protocol: "http:", host: "localhost:5173" } as Location))
      .toBe("ws://localhost:5173/api");
  });
});

describe("WebSocketProvider dispatch", () => {
  function Subscriber({ onLog }: { onLog: (message: string) => void }) {
    useWsEvent("system:log", (payload) => onLog(payload.message));
    return null;
  }

  const logMessage = (message: string) => ({
    type: "system:log",
    payload: { level: "info", message, timestamp: "2026-01-01T00:00:00.000Z" },
  });

  it("delivers every message, including several in the same tick", () => {
    // The old provider stored a single `lastMessage` state value, so two
    // messages arriving before React re-rendered meant the first was lost.
    const received: string[] = [];
    render(<Subscriber onLog={(m) => received.push(m)} />);

    act(() => {
      socket().emit(logMessage("first"));
      socket().emit(logMessage("second"));
      socket().emit(logMessage("third"));
    });

    expect(received).toEqual(["first", "second", "third"]);
  });

  it("fans one message out to every subscriber", () => {
    const a: string[] = [];
    const b: string[] = [];
    render(
      <>
        <Subscriber onLog={(m) => a.push(m)} />
        <Subscriber onLog={(m) => b.push(m)} />
      </>,
    );

    act(() => socket().emit(logMessage("shared")));

    expect(a).toEqual(["shared"]);
    expect(b).toEqual(["shared"]);
  });

  it("does not deliver messages of other types", () => {
    const received: string[] = [];
    render(<Subscriber onLog={(m) => received.push(m)} />);

    act(() => socket().emit({ type: "librarian:scan_warning", payload: { message: "x", files: [] } }));

    expect(received).toEqual([]);
  });

  it("keeps delivering to other subscribers when one throws", () => {
    const survived: string[] = [];
    function Thrower() {
      useWsEvent("system:log", () => {
        throw new Error("subscriber blew up");
      });
      return null;
    }
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <>
        <Thrower />
        <Subscriber onLog={(m) => survived.push(m)} />
      </>,
    );

    act(() => socket().emit(logMessage("still delivered")));

    expect(survived).toEqual(["still delivered"]);
  });

  it("stops delivering after a subscriber unmounts", () => {
    const received: string[] = [];
    render(<Subscriber onLog={(m) => received.push(m)} />);
    act(() => root.render(<WebSocketProvider>{null}</WebSocketProvider>));

    act(() => socket().emit(logMessage("after unmount")));

    expect(received).toEqual([]);
  });

  it("does not re-render subscribers when messages arrive", () => {
    // The provider wraps the whole route tree, and every backend console.log is
    // broadcast, so re-rendering per message was a real cost.
    let renders = 0;
    function Counting() {
      renders += 1;
      useWsEvent("system:log", () => undefined);
      return null;
    }
    render(<Counting />);
    const baseline = renders;

    act(() => {
      socket().emit(logMessage("a"));
      socket().emit(logMessage("b"));
    });

    expect(renders).toBe(baseline);
  });
});

describe("WebSocketProvider connection", () => {
  it("sends the access token in the handshake query string", () => {
    setAccessToken("jwt-abc");
    render(null);

    expect(socket().url).toContain("access_token=jwt-abc");
  });

  it("connects without a token when signed out", () => {
    render(null);
    expect(socket().url).not.toContain("access_token");
  });

  it("backs off exponentially instead of retrying on a fixed interval", () => {
    render(null);
    const first = FakeWebSocket.instances.length;

    act(() => socket().close());
    act(() => vi.advanceTimersByTime(400));
    expect(FakeWebSocket.instances.length).toBe(first); // ~1s + jitter, not yet

    act(() => vi.advanceTimersByTime(1_500));
    expect(FakeWebSocket.instances.length).toBe(first + 1);

    // Second failure waits longer than the first.
    act(() => socket().close());
    act(() => vi.advanceTimersByTime(1_500));
    expect(FakeWebSocket.instances.length).toBe(first + 1);

    act(() => vi.advanceTimersByTime(1_500));
    expect(FakeWebSocket.instances.length).toBe(first + 2);
  });

  it("reconnects immediately when the token changes", () => {
    render(null);
    const before = FakeWebSocket.instances.length;

    act(() => setAccessToken("new-token"));
    act(() => vi.advanceTimersByTime(2_000));

    expect(FakeWebSocket.instances.length).toBe(before + 1);
    expect(socket().url).toContain("access_token=new-token");
  });
});
