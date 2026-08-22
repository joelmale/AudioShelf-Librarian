import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsStore } from "./settings.js";

/**
 * Covers the gap that made a correctly-configured deployment look broken: the
 * stack environment defined ABS_URL, QBIT_URL, QBIT_USER and friends, and the
 * application read none of them — connection targets came only from
 * settings.json, so edits to the environment silently did nothing.
 */

const KEYS = [
  "ABS_URL", "ABS_TOKEN", "QBIT_URL", "QBITTORRENT_URL", "QBIT_USER", "QBIT_PASS",
  "ANTHROPIC_API_KEY", "HTTP_PROXY", "HTTPS_PROXY", "OLLAMA_URL", "OLLAMA_MODEL",
] as const;

const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const dirs: string[] = [];

function store(): SettingsStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-env-"));
  dirs.push(dir);
  return new SettingsStore(dir);
}

beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("environment overrides for connection targets", () => {
  it("uses the stored value when no environment variable is set", () => {
    const s = store();
    s.updateSettings({ qbitUrl: "http://stored:8080", qbitUser: "stored-user" });

    expect(s.getSettings().qbitUrl).toBe("http://stored:8080");
    expect(s.getSettings().qbitUser).toBe("stored-user");
  });

  it("lets the environment win over a stored value", () => {
    const s = store();
    s.updateSettings({ qbitUrl: "http://stored:8080", qbitUser: "stored-user" });
    process.env.QBIT_URL = "http://from-env:9090";
    process.env.QBIT_USER = "env-user";

    expect(s.getSettings().qbitUrl).toBe("http://from-env:9090");
    expect(s.getSettings().qbitUser).toBe("env-user");
  });

  it("accepts QBITTORRENT_URL as an alias", () => {
    const s = store();
    process.env.QBITTORRENT_URL = "https://qbittorrent.example.test/";

    expect(s.getSettings().qbitUrl).toBe("https://qbittorrent.example.test/");
  });

  it("prefers QBIT_URL when both names are present", () => {
    const s = store();
    process.env.QBIT_URL = "http://preferred:1";
    process.env.QBITTORRENT_URL = "http://fallback:2";

    expect(s.getSettings().qbitUrl).toBe("http://preferred:1");
  });

  it("treats an empty environment variable as unset", () => {
    // Compose writes "" for ${VAR:-} when the variable is not supplied; that
    // must not blank out a working stored value.
    const s = store();
    s.updateSettings({ qbitUrl: "http://stored:8080" });
    process.env.QBIT_URL = "";
    process.env.QBITTORRENT_URL = "   ";

    expect(s.getSettings().qbitUrl).toBe("http://stored:8080");
  });

  it("overrides absUrl from the environment", () => {
    const s = store();
    s.updateSettings({ absUrl: "http://stored-abs" });
    process.env.ABS_URL = "https://abs.example.test";

    expect(s.getSettings().absUrl).toBe("https://abs.example.test");
  });
});

describe("getPublicSettings", () => {
  it("reports environment-managed fields so the UI can show edits are ignored", () => {
    const s = store();
    process.env.QBIT_USER = "env-user";
    process.env.ABS_URL = "https://abs.example.test";

    expect(s.getPublicSettings().managedByEnvironment).toEqual(
      expect.arrayContaining(["qbitUser", "absUrl"]),
    );
  });

  it("does not report a field whose environment variable is empty", () => {
    const s = store();
    process.env.QBIT_USER = "";

    expect(s.getPublicSettings().managedByEnvironment).not.toContain("qbitUser");
  });

  it("shows the effective value, not the shadowed stored one", () => {
    // Returning settings.json here while getSettings() resolves the environment
    // is exactly how a UI ends up displaying a target the app is not using.
    const s = store();
    s.updateSettings({ qbitUrl: "http://stored:8080" });
    process.env.QBIT_URL = "http://from-env:9090";

    expect(s.getPublicSettings().qbitUrl).toBe("http://from-env:9090");
  });

  it("still never exposes secret values", () => {
    const s = store();
    process.env.QBIT_PASS = "super-secret";
    process.env.ABS_TOKEN = "token-secret";

    const published = JSON.stringify(s.getPublicSettings());

    expect(published).not.toContain("super-secret");
    expect(published).not.toContain("token-secret");
    expect(s.getPublicSettings().secretStatus.qbitPassConfigured).toBe(true);
  });

  it("does not persist an environment-supplied secret to disk", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-env-"));
    dirs.push(dir);
    process.env.QBIT_PASS = "env-only-secret";
    const s = new SettingsStore(dir);
    s.updateSettings({ qbitUrl: "http://any:8080" });

    const secretsPath = path.join(dir, "secrets.json");
    const onDisk = fs.existsSync(secretsPath) ? fs.readFileSync(secretsPath, "utf8") : "";

    expect(onDisk).not.toContain("env-only-secret");
  });
});
