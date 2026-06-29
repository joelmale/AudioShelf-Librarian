import fs from "fs";
import path from "path";
import { SystemSettings, SystemSettingsSchema } from "@audioshelf/shared";

export class SettingsStore {
  private static instance: SettingsStore;
  private readonly settingsPath: string;
  private settings: SystemSettings;

  private constructor() {
    const dataDir = process.env.DATA_DIR || path.join(process.cwd(), "data");
    this.settingsPath = path.join(dataDir, "settings.json");
    this.settings = this.loadSettings();
    
    // Inject and save optional environment overrides
    let dirty = false;
    
    if (process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== this.settings.anthropicApiKey) {
      this.settings.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
      dirty = true;
    }
    
    if (process.env.OLLAMA_URL && process.env.OLLAMA_URL !== this.settings.ollamaUrl) {
      this.settings.ollamaUrl = process.env.OLLAMA_URL;
      dirty = true;
    }
    
    if (process.env.OLLAMA_MODEL && process.env.OLLAMA_MODEL !== this.settings.ollamaModel) {
      this.settings.ollamaModel = process.env.OLLAMA_MODEL;
      dirty = true;
    }

    if (dirty) {
      this.saveSettings();
    }
  }

  public static getInstance(): SettingsStore {
    if (!SettingsStore.instance) {
      SettingsStore.instance = new SettingsStore();
    }
    return SettingsStore.instance;
  }

  private loadSettings(): SystemSettings {
    try {
      if (fs.existsSync(this.settingsPath)) {
        const raw = fs.readFileSync(this.settingsPath, "utf-8");
        const parsed = JSON.parse(raw);
        const result = SystemSettingsSchema.safeParse(parsed);
        if (result.success) {
          return result.data;
        } else {
          console.error("Failed to parse settings.json, using defaults.");
        }
      }
    } catch (e) {
      console.error("Error loading settings:", e);
    }
    // Return defaults if file doesn't exist or is invalid
    return SystemSettingsSchema.parse({});
  }

  public getSettings(): SystemSettings {
    return this.settings;
  }

  public updateSettings(updates: Partial<SystemSettings>): SystemSettings {
    const newSettings = { ...this.settings, ...updates };
    const result = SystemSettingsSchema.safeParse(newSettings);
    
    if (result.success) {
      this.settings = result.data;
      this.saveSettings();
      return this.settings;
    } else {
      throw new Error(`Invalid settings: ${result.error.message}`);
    }
  }

  private saveSettings() {
    try {
      const dataDir = path.dirname(this.settingsPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2), "utf-8");
    } catch (e) {
      console.error("Error saving settings:", e);
    }
  }
}
