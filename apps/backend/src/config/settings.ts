import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  PublicSettingsResponse,
  PublicSystemSettings,
  PublicSystemSettingsSchema,
  SettingsHistoryEntry,
  SettingsHistoryEntrySchema,
  SystemSettings,
  SystemSettingsSchema,
} from "@audioshelf/shared";

const HISTORY_LIMIT = 100;
export const SECRET_KEYS = ["absToken", "qbitPass", "anthropicApiKey", "nytApiKey", "proxyUrl"] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];
type SecretSettings = Partial<Record<SecretKey, string>>;

/**
 * Settings whose value can be supplied by the environment instead of the UI.
 *
 * An environment value always WINS over the stored one, and is never persisted
 * — which is the point: a deployment can inject credentials without them ever
 * landing in secrets.json. `getPublicSettings()` reports which fields are
 * currently environment-managed so the UI can show that editing them has no
 * effect.
 *
 * Connection targets (absUrl, qbitUrl, qbitUser) were previously readable only
 * from settings.json. That meant a compose file could set QBIT_USER and the
 * application would silently ignore it while appearing to be configured.
 */
const ENVIRONMENT_MANAGED_FIELDS = {
  absUrl: ["ABS_URL"],
  absToken: ["ABS_TOKEN"],
  // QBITTORRENT_URL is accepted as an alias so existing deployments that use
  // the longer name keep working without an edit.
  qbitUrl: ["QBIT_URL", "QBITTORRENT_URL"],
  qbitUser: ["QBIT_USER"],
  qbitPass: ["QBIT_PASS"],
  anthropicApiKey: ["ANTHROPIC_API_KEY"],
  nytApiKey: ["NYT_API_KEY"],
  // ABB_PROXY_URL is preferred over the conventional HTTP_PROXY/HTTPS_PROXY
  // names. Only the AudiobookBay scraper consults this setting, so naming it
  // explicitly keeps the container free of a variable that other libraries may
  // start honouring globally — which would silently route ABS, Anthropic and
  // every other outbound call through the same proxy.
  proxyUrl: ["ABB_PROXY_URL", "HTTP_PROXY", "HTTPS_PROXY"],
  ollamaUrl: ["OLLAMA_URL"],
  ollamaModel: ["OLLAMA_MODEL"],
} as const;

/** First non-empty value among the given environment variables. */
function fromEnvironment(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value && value.trim()) return value.trim();
  }
  return undefined;
}

export class SettingsHistoryNotFoundError extends Error {
  constructor(id: string) {
    super(`Settings history entry ${id} was not found`);
    this.name = "SettingsHistoryNotFoundError";
  }
}

export interface SettingsRestoreResult {
  settings: PublicSettingsResponse;
  restoredFrom: string;
  changedKeys: string[];
}

export type SettingsChangeListener = (
  settings: PublicSettingsResponse,
  changedKeys: string[],
) => void;

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changedSettingKeys(
  previous: PublicSystemSettings,
  next: PublicSystemSettings,
): string[] {
  return Object.keys({ ...previous, ...next })
    .filter((key) => !sameValue(previous[key as keyof PublicSystemSettings], next[key as keyof PublicSystemSettings]))
    .sort();
}

export class SettingsStore {
  private static instance: SettingsStore;
  private readonly settingsPath: string;
  private readonly secretsPath: string;
  private readonly historyPath: string;
  private settings: PublicSystemSettings;
  private secrets: SecretSettings;
  private history: SettingsHistoryEntry[];
  private readonly listeners = new Set<SettingsChangeListener>();

  constructor(dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data")) {
    this.settingsPath = path.join(dataDir, "settings.json");
    this.secretsPath = path.join(dataDir, "secrets.json");
    this.historyPath = path.join(dataDir, "settings-history.json");
    this.secrets = this.loadSecrets();

    const loadedSettings = this.loadSettings();
    let migrated = false;
    for (const key of SECRET_KEYS) {
      const value = loadedSettings[key];
      if (value) {
        this.secrets[key] = value;
        migrated = true;
      }
    }
    this.settings = PublicSystemSettingsSchema.parse(loadedSettings);
    this.history = this.loadHistory();

    // One-time migration: remove legacy plaintext secrets from settings.json.
    if (migrated) {
      this.saveSecrets(this.secrets);
      this.saveSettings(this.settings);
    }
  }

  static getInstance(): SettingsStore {
    return (SettingsStore.instance ??= new SettingsStore());
  }

  private readJson(file: string): unknown {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error: any) {
      if (error?.code === "ENOENT") return {};
      throw error;
    }
  }

  private loadSettings(): SystemSettings {
    try {
      return SystemSettingsSchema.parse(this.readJson(this.settingsPath));
    } catch (error) {
      console.error("Unable to load settings; using defaults", error);
      return SystemSettingsSchema.parse({});
    }
  }

  private loadSecrets(): SecretSettings {
    try {
      const raw = this.readJson(this.secretsPath);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      return Object.fromEntries(
        SECRET_KEYS.flatMap((key) => {
          const value = (raw as Record<string, unknown>)[key];
          return typeof value === "string" && value ? [[key, value]] : [];
        }),
      ) as SecretSettings;
    } catch (error) {
      console.error("Unable to load secret store", error);
      return {};
    }
  }

  private loadHistory(): SettingsHistoryEntry[] {
    try {
      const raw = this.readJson(this.historyPath);
      if (!Array.isArray(raw)) return [];
      return SettingsHistoryEntrySchema.array().parse(raw).slice(0, HISTORY_LIMIT);
    } catch (error) {
      console.error("Unable to load settings history; ignoring it", error);
      return [];
    }
  }

  getSettings(): SystemSettings {
    return {
      ...this.settings,
      // Secrets: environment first, then the separate secret store.
      absToken: fromEnvironment("ABS_TOKEN") ?? this.secrets.absToken,
      qbitPass: fromEnvironment("QBIT_PASS") ?? this.secrets.qbitPass,
      anthropicApiKey: fromEnvironment("ANTHROPIC_API_KEY") ?? this.secrets.anthropicApiKey,
      nytApiKey: fromEnvironment("NYT_API_KEY") ?? this.secrets.nytApiKey,
      proxyUrl: fromEnvironment("ABB_PROXY_URL", "HTTP_PROXY", "HTTPS_PROXY") ?? this.secrets.proxyUrl,
      // Connection targets: environment first, then the stored setting.
      absUrl: fromEnvironment("ABS_URL") ?? this.settings.absUrl,
      qbitUrl: fromEnvironment("QBIT_URL", "QBITTORRENT_URL") ?? this.settings.qbitUrl,
      qbitUser: fromEnvironment("QBIT_USER") ?? this.settings.qbitUser,
      ollamaUrl: fromEnvironment("OLLAMA_URL") ?? this.settings.ollamaUrl,
      ollamaModel: fromEnvironment("OLLAMA_MODEL") ?? this.settings.ollamaModel,
    };
  }

  getPublicSettings(): PublicSettingsResponse {
    const current = this.getSettings();
    const managedByEnvironment = Object.entries(ENVIRONMENT_MANAGED_FIELDS)
      .filter(([, environmentKeys]) => fromEnvironment(...environmentKeys) !== undefined)
      .map(([field]) => field);

    // Report the EFFECTIVE non-secret values, not the stored ones. Returning
    // settings.json here while getSettings() resolved something else from the
    // environment is how a UI ends up showing a connection target the
    // application is not actually using.
    const { absToken, qbitPass, anthropicApiKey, nytApiKey, proxyUrl, ...effective } = current;

    return {
      ...effective,
      secretStatus: {
        absTokenConfigured: Boolean(current.absToken),
        qbitPassConfigured: Boolean(current.qbitPass),
        anthropicApiKeyConfigured: Boolean(current.anthropicApiKey),
        nytApiKeyConfigured: Boolean(current.nytApiKey),
        proxyUrlConfigured: Boolean(current.proxyUrl),
      },
      managedByEnvironment,
    };
  }

  getHistory(limit = HISTORY_LIMIT): SettingsHistoryEntry[] {
    const safeLimit = Math.max(1, Math.min(HISTORY_LIMIT, Math.floor(limit) || HISTORY_LIMIT));
    return this.history.slice(0, safeLimit).map((entry) => SettingsHistoryEntrySchema.parse(entry));
  }

  subscribe(listener: SettingsChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  updateSettings(updates: unknown, actor = "internal"): PublicSettingsResponse {
    const parsed = SystemSettingsSchema.partial().parse(updates);
    const ordinaryUpdates: Record<string, unknown> = { ...parsed };
    const nextSecrets: SecretSettings = { ...this.secrets };

    for (const key of SECRET_KEYS) {
      const value = parsed[key];
      delete ordinaryUpdates[key];
      if (typeof value === "string" && value.trim()) nextSecrets[key] = value;
    }

    const nextSettings = PublicSystemSettingsSchema.parse({
      ...this.settings,
      ...ordinaryUpdates,
    });
    const changedKeys = changedSettingKeys(this.settings, nextSettings);
    const changedSecretKeys = SECRET_KEYS.filter((key) => nextSecrets[key] !== this.secrets[key]);
    const secretsChanged = changedSecretKeys.length > 0;
    if (changedKeys.length === 0 && !secretsChanged) return this.getPublicSettings();

    const nextHistory = changedKeys.length > 0
      ? [this.createHistoryEntry("update", changedKeys, actor), ...this.history].slice(0, HISTORY_LIMIT)
      : this.history;

    this.persistTransition(nextSettings, nextSecrets, nextHistory, {
      settings: changedKeys.length > 0,
      secrets: secretsChanged,
      history: changedKeys.length > 0,
    });
    this.settings = nextSettings;
    this.secrets = nextSecrets;
    this.history = nextHistory;
    this.notifyListeners([...changedKeys, ...changedSecretKeys]);
    return this.getPublicSettings();
  }

  restoreSettings(id: string, actor = "internal"): SettingsRestoreResult {
    const target = this.history.find((entry) => entry.id === id);
    if (!target) throw new SettingsHistoryNotFoundError(id);

    const nextSettings = PublicSystemSettingsSchema.parse(target.snapshot);
    const changedKeys = changedSettingKeys(this.settings, nextSettings);
    if (changedKeys.length > 0) {
      const nextHistory = [
        this.createHistoryEntry("rollback", changedKeys, actor, id),
        ...this.history,
      ].slice(0, HISTORY_LIMIT);
      this.persistTransition(nextSettings, this.secrets, nextHistory, {
        settings: true,
        secrets: false,
        history: true,
      });
      this.settings = nextSettings;
      this.history = nextHistory;
      this.notifyListeners(changedKeys);
    }

    return {
      settings: this.getPublicSettings(),
      restoredFrom: id,
      changedKeys,
    };
  }

  clearSecret(key: SecretKey): void {
    if (!SECRET_KEYS.includes(key)) throw new Error("Unknown secret key");
    if (!(key in this.secrets)) return;
    const nextSecrets = { ...this.secrets };
    delete nextSecrets[key];
    this.saveSecrets(nextSecrets);
    this.secrets = nextSecrets;
    this.notifyListeners([key]);
  }

  private createHistoryEntry(
    source: SettingsHistoryEntry["source"],
    changedKeys: string[],
    actor: string,
    restoredFrom?: string,
  ): SettingsHistoryEntry {
    return SettingsHistoryEntrySchema.parse({
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      actor: actor.trim() || "internal",
      source,
      changedKeys,
      restoredFrom,
      snapshot: this.settings,
    });
  }

  private persistTransition(
    nextSettings: PublicSystemSettings,
    nextSecrets: SecretSettings,
    nextHistory: SettingsHistoryEntry[],
    changed: { settings: boolean; secrets: boolean; history: boolean },
  ): void {
    try {
      if (changed.settings) this.saveSettings(nextSettings);
      if (changed.secrets) this.saveSecrets(nextSecrets);
      if (changed.history) this.saveHistory(nextHistory);
    } catch (error) {
      // Best-effort restoration keeps a failed multi-file transition from becoming active.
      try { if (changed.settings) this.saveSettings(this.settings); } catch { /* preserve original error */ }
      try { if (changed.secrets) this.saveSecrets(this.secrets); } catch { /* preserve original error */ }
      try { if (changed.history) this.saveHistory(this.history); } catch { /* preserve original error */ }
      throw error;
    }
  }

  private notifyListeners(changedKeys: string[]): void {
    if (changedKeys.length === 0) return;
    const publicSettings = this.getPublicSettings();
    for (const listener of this.listeners) {
      try {
        listener(publicSettings, [...changedKeys]);
      } catch (error) {
        console.error("Settings change listener failed", error);
      }
    }
  }

  private saveSettings(value: PublicSystemSettings): void {
    this.writeJson(this.settingsPath, value, 0o600);
  }

  private saveSecrets(value: SecretSettings): void {
    this.writeJson(this.secretsPath, value, 0o600);
  }

  private saveHistory(value: SettingsHistoryEntry[]): void {
    this.writeJson(this.historyPath, value, 0o600);
  }

  private writeJson(file: string, value: unknown, mode: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode });
      try { fs.chmodSync(temporary, mode); } catch { /* Windows ACLs are deployment-managed. */ }
      try {
        fs.renameSync(temporary, file);
      } catch (error: any) {
        if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
        fs.rmSync(file, { force: true });
        fs.renameSync(temporary, file);
      }
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch { /* best-effort temp cleanup */ }
    }
    try { fs.chmodSync(file, mode); } catch { /* Windows ACLs are deployment-managed. */ }
  }
}
