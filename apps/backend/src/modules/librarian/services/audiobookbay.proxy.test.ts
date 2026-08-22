import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsStore } from "../../../config/settings.js";

/**
 * The scraper's dispatcher handling. Two properties matter beyond "it works":
 *
 *  - A dispatcher owns a connection pool, and fetchInsecure runs several times
 *    per search (redirects and the anti-bot challenge are followed manually).
 *    Building one per call leaked a pool per call.
 *  - When a proxy is configured it must be used or the request must fail. There
 *    is deliberately no fall back to a direct connection: the proxy exists to
 *    keep this traffic off the user's own address, so going direct on failure
 *    would defeat it at exactly the moment it matters.
 */

const ENV_KEYS = ["ABB_PROXY_URL", "HTTP_PROXY", "HTTPS_PROXY"] as const;
const original = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];

/** Records every dispatcher undici is asked to build. */
function trackUndici() {
  const built: string[] = [];
  const closed: string[] = [];
  vi.doMock("undici", () => ({
    ProxyAgent: class {
      constructor(opts: { uri: string }) {
        built.push(`proxy:${opts.uri}`);
      }
      async close() {
        closed.push("proxy");
      }
    },
    Agent: class {
      constructor() {
        built.push("direct");
      }
      async close() {
        closed.push("direct");
      }
    },
  }));
  return { built, closed };
}

function storeWith(settings: Record<string, unknown>): SettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-abbproxy-"));
  dirs.push(dir);
  const store = new SettingsStore(dir);
  store.updateSettings(settings);
  return store;
}

/**
 * Build the service against a specific settings store.
 *
 * `vi.resetModules()` gives each test a fresh module graph, so the service
 * imports its own copy of the settings module. The spy therefore has to be
 * installed on THAT copy — spying on the statically-imported one silently does
 * nothing and the service quietly falls through to the real singleton.
 */
async function serviceWith(settings: Record<string, unknown>) {
  const settingsModule = await import("../../../config/settings.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-abbproxy-"));
  dirs.push(dir);
  const store = new settingsModule.SettingsStore(dir);
  store.updateSettings(settings);
  vi.spyOn(settingsModule.SettingsStore, "getInstance").mockReturnValue(store);

  const { AudiobookBayService } = await import("./audiobookbay.js");
  const service = new AudiobookBayService();
  return {
    service,
    call: (url: string) =>
      (service as unknown as { fetchInsecure(u: string): Promise<Response> }).fetchInsecure.call(service, url),
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("undici");
  for (const key of ENV_KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("proxy configuration source", () => {
  it("reads ABB_PROXY_URL from the environment", () => {
    const store = storeWith({});
    process.env.ABB_PROXY_URL = "http://gluetun:8888";

    expect(store.getSettings().proxyUrl).toBe("http://gluetun:8888");
  });

  it("prefers ABB_PROXY_URL over the conventional names", () => {
    const store = storeWith({});
    process.env.ABB_PROXY_URL = "http://gluetun:8888";
    process.env.HTTP_PROXY = "http://someone-elses-proxy:3128";

    expect(store.getSettings().proxyUrl).toBe("http://gluetun:8888");
  });

  it("still honours HTTP_PROXY when ABB_PROXY_URL is absent", () => {
    const store = storeWith({});
    process.env.HTTP_PROXY = "http://legacy:3128";

    expect(store.getSettings().proxyUrl).toBe("http://legacy:3128");
  });

  it("keeps the proxy url out of the public settings response", () => {
    const store = storeWith({});
    process.env.ABB_PROXY_URL = "http://user:pass@gluetun:8888";

    const published = JSON.stringify(store.getPublicSettings());

    expect(published).not.toContain("gluetun:8888");
    expect(published).not.toContain("pass");
    expect(store.getPublicSettings().secretStatus.proxyUrlConfigured).toBe(true);
  });
});

describe("dispatcher reuse", () => {
  it("builds one dispatcher and reuses it across requests", async () => {
    const { built } = trackUndici();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("postTitle audiobook", { status: 200 })));
    process.env.ABB_PROXY_URL = "http://gluetun:8888";
    const { call } = await serviceWith({ useProxy: true });

    await call("https://audiobookbay.lu/a");
    await call("https://audiobookbay.lu/b");
    await call("https://audiobookbay.lu/c");

    expect(built.filter((b) => b.startsWith("proxy:"))).toEqual(["proxy:http://gluetun:8888"]);
  });

  it("rebuilds and closes the old dispatcher when the proxy changes", async () => {
    const { built, closed } = trackUndici();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    process.env.ABB_PROXY_URL = "http://gluetun:8888";
    const { call } = await serviceWith({ useProxy: true });

    await call("https://audiobookbay.lu/a");
    process.env.ABB_PROXY_URL = "http://other:8888";
    await call("https://audiobookbay.lu/b");

    expect(built).toContain("proxy:http://gluetun:8888");
    expect(built).toContain("proxy:http://other:8888");
    expect(closed.length).toBeGreaterThan(0);
  });

  it("uses a direct dispatcher when the proxy is disabled", async () => {
    const { built } = trackUndici();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200 })));
    process.env.ABB_PROXY_URL = "http://gluetun:8888";
    const { call } = await serviceWith({ useProxy: false });

    await call("https://audiobookbay.lu/a");

    expect(built).not.toContain("proxy:http://gluetun:8888");
    expect(built).toContain("direct");
  });

  it("does not fall back to a direct connection when the proxy fails", async () => {
    // Failing closed is the point: a silent direct retry would put the user's
    // real address on the wire precisely when the proxy is not protecting it.
    const { built } = trackUndici();
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("proxy unreachable");
    }));
    process.env.ABB_PROXY_URL = "http://gluetun:8888";
    const { call } = await serviceWith({ useProxy: true });

    await expect(call("https://audiobookbay.lu/a")).rejects.toThrow(/proxy unreachable/);
    expect(built).not.toContain("direct");
  });
});
