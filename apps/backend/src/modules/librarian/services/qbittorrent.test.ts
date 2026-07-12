import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "../../../config/settings.js";
import { QBittorrentService } from "./qbittorrent.js";

describe("QBittorrentService live settings", () => {
  const directories: string[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses updated connection settings on the next request and clears the old session", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-qbit-settings-"));
    directories.push(dataDir);
    const store = new SettingsStore(dataDir);
    store.updateSettings({
      qbitUrl: "http://qbit-old:8080",
      qbitUser: "old-user",
      qbitPass: "old-pass",
    });

    const requests: Array<{ url: string; body: BodyInit | null | undefined }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: init?.body });
      if (url.endsWith("/api/v2/auth/login")) {
        return new Response("Ok.", { status: 200, headers: { "set-cookie": "SID=test-session; Path=/" } });
      }
      return new Response("", { status: 200 });
    }));

    const service = new QBittorrentService(store);
    await service.addMagnetLink("magnet:?xt=urn:btih:first");

    store.updateSettings({
      qbitUrl: "http://qbit-new:9090/",
      qbitUser: "new-user",
      qbitPass: "new-pass",
    });
    await service.addMagnetLink("magnet:?xt=urn:btih:second");

    expect(requests.map(({ url }) => url)).toEqual([
      "http://qbit-old:8080/api/v2/auth/login",
      "http://qbit-old:8080/api/v2/torrents/add",
      "http://qbit-new:9090/api/v2/auth/login",
      "http://qbit-new:9090/api/v2/torrents/add",
    ]);
    expect((requests[0].body as URLSearchParams).get("username")).toBe("old-user");
    expect((requests[0].body as URLSearchParams).get("password")).toBe("old-pass");
    expect((requests[2].body as URLSearchParams).get("username")).toBe("new-user");
    expect((requests[2].body as URLSearchParams).get("password")).toBe("new-pass");
  });
});
