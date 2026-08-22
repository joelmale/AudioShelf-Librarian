import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "../../../config/settings.js";
import { QBittorrentService, describeResponseBody } from "./qbittorrent.js";

/**
 * A real incident drove these: the login failure surfaced as
 * "Failed to login to qBittorrent: Forbidden" and nothing else. That single
 * word cannot distinguish wrong credentials from a banned IP from a reverse
 * proxy rejecting the request before qBittorrent ever sees it — each of which
 * needs a different fix. The reason is in the response body, which was thrown
 * away.
 */

const dirs: string[] = [];

function storeWith(settings: Record<string, unknown>): SettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-qbit-diag-"));
  dirs.push(dir);
  const store = new SettingsStore(dir);
  store.updateSettings(settings);
  return store;
}

function respondWith(response: Response) {
  vi.stubGlobal("fetch", vi.fn(async () => response.clone()));
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("describeResponseBody", () => {
  it("passes through a short plain-text reason", () => {
    expect(describeResponseBody("Your IP address has been banned.")).toBe(
      "Your IP address has been banned.",
    );
  });

  it("reduces an HTML error page to its visible text", () => {
    // Seeing "nginx" is the signal that the request never reached qBittorrent.
    const html = "<html><head><title>403 Forbidden</title></head><body><center><h1>403 Forbidden</h1></center><hr><center>nginx</center></body></html>";

    const described = describeResponseBody(html);

    expect(described).toContain("403 Forbidden");
    expect(described).toContain("nginx");
    expect(described).not.toContain("<");
  });

  it("drops script and style content", () => {
    expect(describeResponseBody("<style>a{b:c}</style><script>x()</script><p>real</p>")).toBe("real");
  });

  it("truncates a long body", () => {
    const described = describeResponseBody("x".repeat(1000));

    expect(described.length).toBeLessThan(320);
    expect(described.endsWith("…")).toBe(true);
  });

  it("returns empty for an empty body", () => {
    expect(describeResponseBody("   ")).toBe("");
  });
});

describe("qBittorrent login diagnostics", () => {
  const settings = { qbitUrl: "http://qbit:8080", qbitUser: "admin", qbitPass: "secret" };

  it("includes the status, target, user and body reason on failure", async () => {
    respondWith(new Response("Your IP address has been banned after too many failed authentication attempts.", { status: 403 }));
    const service = new QBittorrentService(storeWith(settings));

    await expect(service.addMagnetLink("magnet:?xt=urn:btih:x")).rejects.toThrow(
      /HTTP 403.*banned after too many failed authentication attempts/s,
    );
  });

  it("names the qBittorrent instance and username being used", async () => {
    respondWith(new Response("invalid credentials", { status: 403 }));
    const service = new QBittorrentService(storeWith(settings));

    await expect(service.addMagnetLink("magnet:?xt=urn:btih:x")).rejects.toThrow(
      /http:\/\/qbit:8080 as "admin"/,
    );
  });

  it("never puts the password in the error", async () => {
    respondWith(new Response("invalid credentials", { status: 403 }));
    const service = new QBittorrentService(storeWith(settings));

    const error = await service.addMagnetLink("magnet:?xt=urn:btih:x").catch((e: Error) => e);

    expect(String(error)).not.toContain("secret");
  });

  it("surfaces a proxy HTML page distinctly from a qBittorrent reason", async () => {
    respondWith(new Response("<html><body><h1>403 Forbidden</h1><hr><center>nginx</center></body></html>", { status: 403 }));
    const service = new QBittorrentService(storeWith(settings));

    await expect(service.addMagnetLink("magnet:?xt=urn:btih:x")).rejects.toThrow(/nginx/);
  });

  it("fails loudly when a 200 response carries no session cookie", async () => {
    // Pre-5.x qBittorrent answers bad credentials with 200 "Fails.". That used
    // to be treated as success, leaving no cookie and failing later somewhere
    // unrelated.
    respondWith(new Response("Fails.", { status: 200 }));
    const service = new QBittorrentService(storeWith(settings));

    await expect(service.addMagnetLink("magnet:?xt=urn:btih:x")).rejects.toThrow(
      /no session cookie.*Fails\./s,
    );
  });

  it("still succeeds when a session cookie is issued", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/api/v2/auth/login")) {
        return new Response("Ok.", { status: 200, headers: { "set-cookie": "SID=abc; Path=/" } });
      }
      return new Response("", { status: 200 });
    }));
    const service = new QBittorrentService(storeWith(settings));

    await expect(service.addMagnetLink("magnet:?xt=urn:btih:x")).resolves.not.toThrow();
  });
});
