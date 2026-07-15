import pLimit from "p-limit";
import { SettingsStore } from "../../../config/settings.js";

export interface QbitTorrent {
  hash: string;
  name: string;
  progress: number;
  state: string; // 'downloading', 'stalledDL', 'metaDL', 'error', 'pausedUP', etc.
  save_path: string;
  content_path?: string;
  eta: number;
  dlspeed: number;
  size: number;
  category?: string;
}

export class QBittorrentService {
  private url = "";
  private user = "";
  private pass = "";
  private cookie: string | null = null;
  
  // Concurrency limiter for API calls
  private limit = pLimit(1);

  constructor(private readonly settingsStore = SettingsStore.getInstance()) {
    this.refreshSettings();
  }

  private refreshSettings(): void {
    const sysSettings = this.settingsStore.getSettings();
    const qUrl = sysSettings.qbitUrl || "http://qbittorrent:8080";
    const nextUrl = qUrl.endsWith('/') ? qUrl.slice(0, -1) : qUrl;
    const nextUser = sysSettings.qbitUser || "admin";
    const nextPass = sysSettings.qbitPass || "adminadmin";
    if (nextUrl !== this.url || nextUser !== this.user || nextPass !== this.pass) {
      this.url = nextUrl;
      this.user = nextUser;
      this.pass = nextPass;
      this.cookie = null;
    }
  }

  private async login(): Promise<void> {
    this.refreshSettings();
    const params = new URLSearchParams();
    params.append("username", this.user);
    params.append("password", this.pass);

    const res = await fetch(`${this.url}/api/v2/auth/login`, {
      method: "POST",
      body: params,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      }
    });

    if (res.ok) {
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        this.cookie = setCookie.split(";")[0];
      }
    } else {
      throw new Error(`Failed to login to qBittorrent: ${res.statusText}`);
    }
  }

  private async request<T>(endpoint: string, options: RequestInit = {}, retry = true): Promise<T> {
    return this.limit(async () => {
      this.refreshSettings();
      if (!this.cookie && retry) {
        await this.login();
      }

      const headers = new Headers(options.headers || {});
      if (this.cookie) {
        headers.set("Cookie", this.cookie);
      }

      let res = await fetch(`${this.url}${endpoint}`, {
        ...options,
        headers
      });

      if (res.status === 403 && retry) {
        // Cookie might have expired
        await this.login();
        if (this.cookie) {
          headers.set("Cookie", this.cookie);
        }
        res = await fetch(`${this.url}${endpoint}`, {
          ...options,
          headers
        });
      }

      if (!res.ok) {
        throw new Error(`qBittorrent API error ${res.status}: ${res.statusText} at ${endpoint}`);
      }

      const text = await res.text();
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch (e) {
        return text as any as T;
      }
    });
  }

  public async addMagnetLink(magnetLink: string, savePath?: string): Promise<void> {
    const formData = new FormData();
    formData.append("urls", magnetLink);
    formData.append("category", "audiobooks"); // Default category
    if (savePath) {
      formData.append("savepath", savePath);
    }

    await this.request<string>("/api/v2/torrents/add", {
      method: "POST",
      body: formData,
    });
  }

  public async getTorrents(filter: "all" | "downloading" | "completed" | "paused" | "active" = "all", category?: string): Promise<QbitTorrent[]> {
    let endpoint = `/api/v2/torrents/info?filter=${filter}`;
    if (category) {
      endpoint += `&category=${category}`;
    }
    return this.request<QbitTorrent[]>(endpoint);
  }

  public async removeTorrent(hash: string, deleteFiles: boolean = false): Promise<void> {
    const params = new URLSearchParams();
    params.append("hashes", hash);
    params.append("deleteFiles", deleteFiles.toString());

    await this.request<string>("/api/v2/torrents/delete", { 
      method: "POST",
      body: params,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });
  }

  public async testConnection(): Promise<boolean> {
    try {
      await this.login();
      return true;
    } catch {
      return false;
    }
  }
}
