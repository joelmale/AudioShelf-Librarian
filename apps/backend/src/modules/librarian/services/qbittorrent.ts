export class QBittorrentService {
  private baseUrl: string;

  constructor() {
    this.baseUrl = process.env.QBITTORRENT_URL || "http://qbittorrent:8080";
  }

  async addMagnetLink(magnetLink: string): Promise<void> {
    console.log(`Sending magnet link to qBittorrent at ${this.baseUrl}`);
    
    // We assume the qBittorrent instance is on the local network/docker network
    // and we might need to authenticate if it's configured to require it.
    // For now, we will try to post directly, or you can add auth logic if needed.
    
    // The API requires form-data for /api/v2/torrents/add
    const formData = new FormData();
    formData.append("urls", magnetLink);
    
    // Add default category if wanted
    formData.append("category", "audiobooks");

    const res = await fetch(`${this.baseUrl}/api/v2/torrents/add`, {
      method: "POST",
      body: formData
    });

    if (!res.ok) {
      if (res.status === 403) {
        throw new Error("qBittorrent authentication failed or is required.");
      }
      const text = await res.text();
      throw new Error(`qBittorrent API error: ${res.status} - ${text}`);
    }

    console.log("Successfully added torrent to qBittorrent");
  }

  async getTorrents(filter: string = "completed", category: string = "audiobooks"): Promise<any[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v2/torrents/info?filter=${filter}&category=${category}`);
      if (!res.ok) throw new Error("Failed to fetch torrents");
      return await res.json();
    } catch (e) {
      console.error("Failed to fetch torrents from qBittorrent:", e);
      return [];
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/v2/app/version`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
