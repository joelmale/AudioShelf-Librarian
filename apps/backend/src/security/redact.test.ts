import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../config/settings.js";
import { REDACTED, currentSecrets, redactSecrets, resetSecretCache } from "./redact.js";

const ENVIRONMENT_KEYS = ["ABS_TOKEN", "QBIT_PASS", "ANTHROPIC_API_KEY", "HTTP_PROXY", "HTTPS_PROXY"] as const;
const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENVIRONMENT_KEYS)[number], string | undefined>;

const temporaryDirectories: string[] = [];

function createStore(): SettingsStore {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-redact-"));
  temporaryDirectories.push(dataDir);
  return new SettingsStore(dataDir);
}

beforeEach(() => {
  resetSecretCache();
  for (const key of ENVIRONMENT_KEYS) delete process.env[key];
});

afterEach(() => {
  resetSecretCache();
  for (const key of ENVIRONMENT_KEYS) {
    const original = originalEnvironment[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
  while (temporaryDirectories.length) {
    fs.rmSync(temporaryDirectories.pop() as string, { recursive: true, force: true });
  }
});

describe("redactSecrets", () => {
  it("removes a known secret from a log line", () => {
    const message = redactSecrets("connecting with token abs_9f3ka02mzq", ["abs_9f3ka02mzq"]);
    expect(message).not.toContain("abs_9f3ka02mzq");
    expect(message).toBe(`connecting with token ${REDACTED}`);
  });

  it("removes every occurrence, not just the first", () => {
    const message = redactSecrets("key=sk-ant-secretvalue retry key=sk-ant-secretvalue", ["sk-ant-secretvalue"]);
    expect(message).not.toContain("sk-ant-secretvalue");
  });

  it("treats secrets as literals, not regular expressions", () => {
    // A password of `a.c` must not redact `abc`; escaping is what prevents it.
    const message = redactSecrets("password a.c+d[e] and abcxdxe", ["a.c+d[e]"]);
    expect(message).toBe(`password ${REDACTED} and abcxdxe`);
  });

  it("strips credentials embedded in a proxy URL even when the value is unknown", () => {
    const message = redactSecrets("[ABB Service] proxy http://joel:hunter2@proxy.internal:8080/", []);
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("joel:");
    expect(message).toContain("proxy.internal:8080");
  });

  it("strips bearer tokens from error dumps", () => {
    const message = redactSecrets('failed: {"Authorization":"Bearer eyJhbGciOiJIUzI1NiJ9.abc"}', []);
    expect(message).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("leaves ordinary log lines untouched", () => {
    const message = "Scanned 412 files in /inbox/Brandon Sanderson";
    expect(redactSecrets(message, ["a-real-secret-value"])).toBe(message);
  });

  it("redacts the longest secret first when one contains another", () => {
    const message = redactSecrets("value=supersecrettail", ["supersecret", "supersecrettail"]);
    expect(message).toBe(`value=${REDACTED}`);
  });
});

describe("currentSecrets", () => {
  it("collects configured secrets from the settings store", () => {
    const store = createStore();
    store.updateSettings({ absToken: "abs-token-longenough", proxyUrl: "http://user:pw@proxy:8080" });

    const secrets = currentSecrets(store);

    expect(secrets).toContain("abs-token-longenough");
    expect(secrets).toContain("http://user:pw@proxy:8080");
  });

  it("ignores values too short to redact safely", () => {
    const store = createStore();
    store.updateSettings({ absToken: "abc" });

    expect(currentSecrets(store)).not.toContain("abc");
  });

  it("scrubs a stored proxy URL out of a log line end to end", () => {
    const store = createStore();
    store.updateSettings({ proxyUrl: "http://joel:hunter2@proxy.internal:8080" });

    const message = redactSecrets(
      "[ABB Service] Using proxy: http://joel:hunter2@proxy.internal:8080 for https://audiobookbay.is",
      currentSecrets(store),
    );

    expect(message).not.toContain("hunter2");
    expect(message).toContain("https://audiobookbay.is");
  });

  it("drops the cache when settings change so a rotated secret is still redacted", () => {
    const store = createStore();
    store.updateSettings({ absToken: "first-token-value" });
    expect(currentSecrets(store)).toContain("first-token-value");

    store.updateSettings({ absToken: "second-token-value" });

    expect(currentSecrets(store)).toContain("second-token-value");
  });
});
