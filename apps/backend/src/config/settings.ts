import fs from "node:fs";
import path from "node:path";
import { SystemSettings, SystemSettingsSchema } from "@audioshelf/shared";

const SECRET_KEYS = ["absToken", "qbitPass", "anthropicApiKey", "proxyUrl"] as const;
type SecretKey = (typeof SECRET_KEYS)[number];
type SecretSettings = Partial<Record<SecretKey, string>>;

export class SettingsStore {
  private static instance: SettingsStore;
  private readonly settingsPath: string;
  private readonly secretsPath: string;
  private settings: SystemSettings;
  private secrets: SecretSettings;

  private constructor() {
    const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
    this.settingsPath = path.join(dataDir, "settings.json");
    this.secretsPath = path.join(dataDir, "secrets.json");
    this.settings = this.loadSettings();
    this.secrets = this.loadSecrets();
    // One-time migration: remove legacy plaintext secrets from settings.json.
    let migrated = false;
    for (const key of SECRET_KEYS) {
      const value = this.settings[key];
      if (value) { this.secrets[key] = value; delete this.settings[key]; migrated = true; }
    }
    if (migrated) { this.saveSecrets(); this.saveSettings(); }
  }

  static getInstance(): SettingsStore {
    return (SettingsStore.instance ??= new SettingsStore());
  }

  private readJson(file: string): unknown {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); }
    catch (error: any) { if (error?.code === "ENOENT") return {}; throw error; }
  }

  private loadSettings(): SystemSettings {
    try { return SystemSettingsSchema.parse(this.readJson(this.settingsPath)); }
    catch (error) { console.error("Unable to load settings; using defaults", error); return SystemSettingsSchema.parse({}); }
  }

  private loadSecrets(): SecretSettings {
    try { return this.readJson(this.secretsPath) as SecretSettings; }
    catch (error) { console.error("Unable to load secret store", error); return {}; }
  }

  getSettings(): SystemSettings {
    return {
      ...this.settings,
      absToken: process.env.ABS_TOKEN || this.secrets.absToken,
      qbitPass: process.env.QBIT_PASS || this.secrets.qbitPass,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || this.secrets.anthropicApiKey,
      proxyUrl: process.env.HTTP_PROXY || process.env.HTTPS_PROXY || this.secrets.proxyUrl,
      ollamaUrl: process.env.OLLAMA_URL || this.settings.ollamaUrl,
      ollamaModel: process.env.OLLAMA_MODEL || this.settings.ollamaModel,
    };
  }

  getPublicSettings() {
    const current = this.getSettings();
    const publicSettings: Record<string, unknown> = { ...this.settings };
    for (const key of SECRET_KEYS) delete publicSettings[key];
    return {
      ...publicSettings,
      secretStatus: {
        absTokenConfigured: Boolean(current.absToken), qbitPassConfigured: Boolean(current.qbitPass),
        anthropicApiKeyConfigured: Boolean(current.anthropicApiKey), proxyUrlConfigured: Boolean(current.proxyUrl),
      },
    };
  }

  updateSettings(updates: Partial<SystemSettings>): ReturnType<SettingsStore["getPublicSettings"]> {
    const ordinary: Record<string, unknown> = { ...updates };
    for (const key of SECRET_KEYS) {
      const value = updates[key]; delete ordinary[key];
      if (typeof value === "string" && value.trim()) this.secrets[key] = value;
    }
    this.settings = SystemSettingsSchema.parse({ ...this.settings, ...ordinary });
    for (const key of SECRET_KEYS) delete this.settings[key];
    this.saveSettings(); this.saveSecrets();
    return this.getPublicSettings();
  }

  clearSecret(key: SecretKey): void {
    if (!SECRET_KEYS.includes(key)) throw new Error("Unknown secret key");
    delete this.secrets[key]; this.saveSecrets();
  }

  private saveSettings(): void { this.writeJson(this.settingsPath, this.settings, 0o600); }
  private saveSecrets(): void { this.writeJson(this.secretsPath, this.secrets, 0o600); }
  private writeJson(file: string, value: unknown, mode: number): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2), { encoding: "utf8", mode });
    try { fs.chmodSync(file, mode); } catch { /* Windows ACLs are deployment-managed. */ }
  }
}
