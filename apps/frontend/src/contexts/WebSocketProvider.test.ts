import { describe, expect, it } from "vitest";
import { websocketUrl } from "./WebSocketProvider.js";

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
