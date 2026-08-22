import pLimit from "p-limit";
import { SettingsStore } from "../../../config/settings.js";

/**
 * qBittorrent lives on the same LAN, so a request that has not answered in this
 * long is not going to. Without a bound, an unreachable-but-not-refusing host
 * (a paused VM, a dropped route) leaves the request hanging indefinitely and
 * takes the calling route with it.
 */
const QBIT_TIMEOUT_MS = 15_000;

/** Longest response excerpt included in an error message. */
const BODY_EXCERPT_LIMIT = 300;

/**
 * Condense a response body into something safe to put in an error message.
 *
 * A failure here can come from qBittorrent (a short text reason) or from a
 * reverse proxy in front of it (a full HTML error page). Both are worth
 * distinguishing, so HTML is collapsed to its visible text rather than dropped
 * — seeing "nginx" is what tells you the request never reached qBittorrent.
 */
export function describeResponseBody(body: string): string {
  const text = body
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > BODY_EXCERPT_LIMIT ? `${text.slice(0, BODY_EXCERPT_LIMIT)}…` : text;
}

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
      },
      signal: AbortSignal.timeout(QBIT_TIMEOUT_MS)
    });

    // Read the body before branching: qBittorrent puts the actual reason there
    // ("invalid credentials", "IP has been banned"), and a reverse proxy in
    // front of it returns its own HTML error page. Reporting only res.statusText
    // collapses every one of those into an unactionable "Forbidden".
    const detail = describeResponseBody(await res.text().catch(() => ""));

    if (!res.ok) {
      throw new Error(
        `Failed to login to qBittorrent at ${this.url} as "${this.user}" ` +
          `(HTTP ${res.status} ${res.statusText})${detail ? `: ${detail}` : ""}`,
      );
    }

    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) {
      // qBittorrent below 5.x answers a bad username/password with HTTP 200 and
      // the body "Fails." — previously treated as success, leaving this.cookie
      // null so every later call failed somewhere else entirely.
      throw new Error(
        `qBittorrent accepted the login request but issued no session cookie ` +
          `(response: ${detail || "<empty>"}). The username or password is usually wrong.`,
      );
    }

    this.cookie = setCookie.split(";")[0];
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
        headers,
        signal: AbortSignal.timeout(QBIT_TIMEOUT_MS)
      });

      if (res.status === 403 && retry) {
        // Cookie might have expired
        await this.login();
        if (this.cookie) {
          headers.set("Cookie", this.cookie);
        }
        res = await fetch(`${this.url}${endpoint}`, {
          ...options,
          headers,
          signal: AbortSignal.timeout(QBIT_TIMEOUT_MS)
        });
      }

      if (!res.ok) {
        const detail = describeResponseBody(await res.text().catch(() => ""));
        throw new Error(
          `qBittorrent API error ${res.status}: ${res.statusText} at ${endpoint}${detail ? ` — ${detail}` : ""}`,
        );
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
