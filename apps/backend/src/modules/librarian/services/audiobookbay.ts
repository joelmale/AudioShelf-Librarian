import * as cheerio from "cheerio";
import https from "https";
import cron from "node-cron";

export interface ABBSearchResult {
  id: string;
  title: string;
  coverUrl: string;
  category: string;
  size: string;
  seeders: number;
  leechers: number;
  added: string;
  url: string;
}

export class AudiobookBayService {
  private activeDomain: string | null = null;
  private domainsToTest = [
    "https://audiobookbay.lu",
    "https://audiobookbay.is",
    "https://audiobookbayabb.com",
  ];

  private lastScrapeTime: Date | null = null;
  private knownMirrorsCount: number = 0;

  constructor() {
    // Run proxy resolution immediately on startup
    this.refreshProxies().catch(err => console.error("Initial proxy resolution failed:", err));
    
    // Schedule a cron job to run every 24 hours at midnight
    cron.schedule("0 0 * * *", () => {
      console.log("Running scheduled ABB proxy resolution...");
      this.refreshProxies().catch(console.error);
    });
  }

  getStats() {
    return {
      activeDomain: this.activeDomain,
      lastScrapeTime: this.lastScrapeTime,
      knownMirrorsCount: this.knownMirrorsCount
    };
  }

  // Native fetch with TLS verification bypassed for sketchy proxy certs
  private async fetchInsecure(url: string, options: any = {}): Promise<Response> {
    const { Dispatcher, request } = await import("undici");
    const dispatcher = new Dispatcher.Agent({
      connect: { rejectUnauthorized: false }
    });
    return fetch(url, { ...options, dispatcher: dispatcher as any });
  }

  private async refreshProxies(): Promise<void> {
    try {
      console.log("Fetching Torrends proxy list...");
      const res = await this.fetchInsecure("https://torrends.to/proxy/audiobook-bay", {
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      const html = await res.text();
      const $ = cheerio.load(html);
      
      const scrapedDomains: string[] = [];
      $("table.proxy-list td.url").each((_, el) => {
        const text = $(el).text().trim();
        if (text) {
          scrapedDomains.push(`https://${text}`);
        }
      });
      
      if (scrapedDomains.length > 0) {
        this.domainsToTest = [...scrapedDomains, ...this.domainsToTest];
      }
      this.lastScrapeTime = new Date();
    } catch (e) {
      console.error("Failed to fetch proxy list, falling back to hardcoded domains", e);
    }

    // Deduplicate
    this.domainsToTest = [...new Set(this.domainsToTest)];
    this.knownMirrorsCount = this.domainsToTest.length;

    for (const domain of this.domainsToTest) {
      try {
        console.log(`Testing ABB mirror: ${domain}`);
        const res = await this.fetchInsecure(domain, { signal: AbortSignal.timeout(5000) });
        if (res.ok) {
          this.activeDomain = domain;
          console.log(`Active ABB domain updated to: ${domain}`);
          return;
        }
      } catch (e) {
        // Continue to next domain
      }
    }
  }

  async resolveActiveDomain(): Promise<string> {
    if (this.activeDomain) {
      // Fast path: Just test the cached domain to make sure it's still alive
      try {
        const res = await this.fetchInsecure(this.activeDomain, { signal: AbortSignal.timeout(5000) });
        if (res.ok) return this.activeDomain;
      } catch (e) {
        this.activeDomain = null;
      }
    }

    // If cached domain failed, refresh proxies synchronously
    await this.refreshProxies();

    if (!this.activeDomain) {
      throw new Error("No active AudiobookBay domain found.");
    }
    return this.activeDomain;
  }

  async search(query: string, category: string = ""): Promise<ABBSearchResult[]> {
    const domain = await this.resolveActiveDomain();
    
    // Construct search URL
    let searchUrl = `${domain}/page/1/?s=${encodeURIComponent(query)}`;
    if (category) {
      searchUrl += `&cat=${category}`;
    }

    console.log(`ABB Search: ${searchUrl}`);
    const res = await this.fetchInsecure(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!res.ok) throw new Error("Search request failed");
    
    const html = await res.text();
    const $ = cheerio.load(html);
    const results: ABBSearchResult[] = [];

    // Parse ABB search results (typically divs with class "post")
    $("#content .post").each((_, el) => {
      const titleEl = $(el).find(".postTitle h2 a");
      const title = titleEl.text().trim();
      if (!title || title.toLowerCase() === "forum") return;

      const url = titleEl.attr("href") || "";
      const idMatch = url.match(/\/audio-books\/([^/]+)/);
      const id = idMatch ? idMatch[1] : "";

      const coverUrl = $(el).find(".postContent img").attr("src") || "";
      
      const metaText = $(el).find(".postInfo").text() || "";
      // Extract size and seeders using regex if possible, or leave blank if ABB hides them on search page
      // Format is usually in the post content or info
      
      results.push({
        id,
        title,
        url: url.startsWith("http") ? url : `${domain}${url}`,
        coverUrl: coverUrl.startsWith("http") ? coverUrl : `${domain}${coverUrl}`,
        category: "Audiobook", // Extract if possible
        size: "Unknown", 
        seeders: 0,
        leechers: 0,
        added: "Unknown"
      });
    });

    return results;
  }

  async getMagnetLink(bookUrl: string): Promise<string> {
    // Fetches the specific book page to extract the info hash and build the magnet link
    const res = await this.fetchInsecure(bookUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    if (!res.ok) throw new Error("Failed to fetch book page");

    const html = await res.text();
    const $ = cheerio.load(html);

    // Info hash is typically in a table row with "Info Hash:"
    let infoHash = "";
    $("table tr").each((_, el) => {
      const text = $(el).text();
      if (text.includes("Info Hash:")) {
        infoHash = $(el).find("td").last().text().trim();
      }
    });

    if (!infoHash) {
      throw new Error("Could not extract Info Hash from the page");
    }

    const title = encodeURIComponent($(".postTitle h1").text().trim() || "Audiobook");
    
    // Build magnet link using public trackers
    const trackers = [
      "udp://tracker.openbittorrent.com:80",
      "udp://tracker.opentrackr.org:1337/announce",
      "udp://tracker.coppersurfer.tk:6969/announce"
    ];

    const trStrings = trackers.map(tr => `tr=${encodeURIComponent(tr)}`).join("&");
    return `magnet:?xt=urn:btih:${infoHash}&dn=${title}&${trStrings}`;
  }
}
