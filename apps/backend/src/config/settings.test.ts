import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SettingsHistoryNotFoundError,
  SettingsStore,
} from "./settings.js";

const MANAGED_ENVIRONMENT_KEYS = [
  "ABS_TOKEN",
  "QBIT_PASS",
  "ANTHROPIC_API_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "OLLAMA_URL",
  "OLLAMA_MODEL",
] as const;

const originalEnvironment = Object.fromEntries(
  MANAGED_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof MANAGED_ENVIRONMENT_KEYS)[number], string | undefined>;

const temporaryDirectories: string[] = [];

function createStore(): { dataDir: string; store: SettingsStore } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-settings-"));
  temporaryDirectories.push(dataDir);
  return { dataDir, store: new SettingsStore(dataDir) };
}

describe("SettingsStore history", () => {
  beforeEach(() => {
    for (const key of MANAGED_ENVIRONMENT_KEYS) delete process.env[key];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of MANAGED_ENVIRONMENT_KEYS) {
      const original = originalEnvironment[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it("records the complete pre-change state for ordinary updates", () => {
    const { store } = createStore();
    const before = store.getPublicSettings();

    store.updateSettings(
      { libraryDir: "/library/curated", debugLogs: false },
      "settings-panel",
    );

    const [entry] = store.getHistory();
    expect(entry).toMatchObject({
      actor: "settings-panel",
      source: "update",
      changedKeys: ["debugLogs", "libraryDir"],
      snapshot: {
        libraryDir: before.libraryDir,
        debugLogs: before.debugLogs,
      },
    });
    expect(entry.snapshot).toEqual(
      expect.objectContaining({
        inboxDir: before.inboxDir,
        ollamaUrl: before.ollamaUrl,
        torrentTrackers: before.torrentTrackers,
      }),
    );
    expect(store.getPublicSettings()).toMatchObject({
      libraryDir: "/library/curated",
      debugLogs: false,
    });
  });

  it("does not add history for no-op updates and rejects invalid updates atomically", () => {
    const { store } = createStore();
    const original = store.getPublicSettings();

    store.updateSettings({ libraryDir: original.libraryDir }, "settings-panel");
    expect(store.getHistory()).toEqual([]);

    expect(() =>
      store.updateSettings({ debugLogs: "definitely" }, "settings-panel"),
    ).toThrow();
    expect(store.getHistory()).toEqual([]);
    expect(store.getPublicSettings()).toEqual(original);

    expect(() => store.restoreSettings("missing-history-entry")).toThrow(
      SettingsHistoryNotFoundError,
    );
  });

  it("keeps only the 100 most recent history states", () => {
    const { store } = createStore();

    for (let index = 0; index < 105; index += 1) {
      store.updateSettings({ libraryDir: `/library/${index}` }, "retention-test");
    }

    const history = store.getHistory();
    expect(history).toHaveLength(100);
    expect(history[0]).toMatchObject({
      actor: "retention-test",
      changedKeys: ["libraryDir"],
      snapshot: { libraryDir: "/library/103" },
    });
    expect(history.at(-1)?.snapshot.libraryDir).toBe("/library/4");
    expect(store.getHistory(12)).toHaveLength(12);
    expect(store.getHistory(1)).toHaveLength(1);
    expect(store.getHistory(10_000)).toHaveLength(100);
  });

  it("never writes secrets to history and ignores secret-only changes for history", () => {
    const { dataDir, store } = createStore();
    const secretValues = {
      absToken: "abs-super-secret",
      qbitPass: "qbit-super-secret",
      anthropicApiKey: "anthropic-super-secret",
      proxyUrl: "http://proxy-secret.example:8080",
    };

    store.updateSettings(secretValues, "settings-panel");

    expect(store.getHistory()).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, "settings-history.json"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "secrets.json"), "utf8"))).toEqual(
      secretValues,
    );

    store.updateSettings({ inboxDir: "/incoming" }, "settings-panel");
    const serializedHistory = fs.readFileSync(
      path.join(dataDir, "settings-history.json"),
      "utf8",
    );
    for (const [key, value] of Object.entries(secretValues)) {
      expect(serializedHistory).not.toContain(key);
      expect(serializedHistory).not.toContain(value);
    }
    expect(store.getHistory()[0].snapshot).not.toHaveProperty("absToken");
    expect(store.getHistory()[0].snapshot).not.toHaveProperty("proxyUrl");
  });

  it("restores ordinary settings, preserves secrets, and records a reversible rollback", () => {
    const { store } = createStore();
    store.updateSettings(
      { absToken: "token-to-preserve", qbitPass: "password-to-preserve" },
      "settings-panel",
    );
    store.updateSettings({ libraryDir: "/library/a" }, "settings-panel");
    store.updateSettings({ libraryDir: "/library/b" }, "settings-panel");
    const target = store.getHistory()[0];
    expect(target.snapshot.libraryDir).toBe("/library/a");

    const result = store.restoreSettings(target.id, "settings-panel");

    expect(result).toMatchObject({
      restoredFrom: target.id,
      changedKeys: ["libraryDir"],
      settings: { libraryDir: "/library/a" },
    });
    expect(store.getSettings()).toMatchObject({
      absToken: "token-to-preserve",
      qbitPass: "password-to-preserve",
    });
    const undo = store.getHistory()[0];
    expect(undo).toMatchObject({
      actor: "settings-panel",
      source: "rollback",
      changedKeys: ["libraryDir"],
      restoredFrom: target.id,
      snapshot: { libraryDir: "/library/b" },
    });

    store.restoreSettings(undo.id, "settings-panel");
    expect(store.getPublicSettings().libraryDir).toBe("/library/b");
    expect(store.getSettings()).toMatchObject({
      absToken: "token-to-preserve",
      qbitPass: "password-to-preserve",
    });
  });

  it("reloads ordinary settings, secrets, and bounded history from disk", () => {
    const { dataDir, store } = createStore();
    store.updateSettings(
      {
        libraryDir: "/library/persisted",
        ollamaModel: "persisted-model",
        anthropicApiKey: "persisted-key",
      },
      "settings-panel",
    );
    const expectedHistory = store.getHistory();

    const reloaded = new SettingsStore(dataDir);

    expect(reloaded.getPublicSettings()).toMatchObject({
      libraryDir: "/library/persisted",
      ollamaModel: "persisted-model",
      secretStatus: { anthropicApiKeyConfigured: true },
    });
    expect(reloaded.getSettings().anthropicApiKey).toBe("persisted-key");
    expect(reloaded.getHistory()).toEqual(expectedHistory);
  });

  it("notifies runtime subscribers after persisted updates and restores", () => {
    const { store } = createStore();
    const notifications: Array<{ level: string; changedKeys: string[]; serialized: string }> = [];
    const unsubscribe = store.subscribe((settings, changedKeys) => {
      notifications.push({
        level: settings.actionLogLevel,
        changedKeys,
        serialized: JSON.stringify(settings),
      });
    });

    store.updateSettings({ actionLogLevel: "warn", absToken: "listener-secret" });
    const restoreTarget = store.getHistory()[0];
    store.restoreSettings(restoreTarget.id);
    unsubscribe();
    store.updateSettings({ actionLogLevel: "error" });

    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toMatchObject({
      level: "warn",
      changedKeys: ["actionLogLevel", "absToken"],
    });
    expect(notifications[1]).toMatchObject({
      level: "debug",
      changedKeys: ["actionLogLevel"],
    });
    expect(notifications.every(({ serialized }) => !serialized.includes("listener-secret"))).toBe(true);
  });

  it("ignores corrupt history safely and replaces it on the next ordinary update", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "audioshelf-settings-"));
    temporaryDirectories.push(dataDir);
    fs.writeFileSync(path.join(dataDir, "settings-history.json"), "{not-json", "utf8");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const store = new SettingsStore(dataDir);

    expect(store.getHistory()).toEqual([]);
    expect(error).toHaveBeenCalledWith(
      "Unable to load settings history; ignoring it",
      expect.anything(),
    );
    store.updateSettings({ libraryDir: "/library/recovered" }, "recovery-test");
    const persisted = JSON.parse(
      fs.readFileSync(path.join(dataDir, "settings-history.json"), "utf8"),
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      actor: "recovery-test",
      snapshot: { libraryDir: "/audiobooks" },
    });
  });
});
