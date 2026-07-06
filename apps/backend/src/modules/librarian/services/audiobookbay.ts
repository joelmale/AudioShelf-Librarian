import * as cheerio from "cheerio";
import https from "https";
import cron from "node-cron";
import type { ABBSearchResult } from "@audioshelf/shared";

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
    const { Agent } = await import("undici");
    const dispatcher = new Agent({
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
      $("a").each((_, el) => {
        const text = $(el).text().trim();
        if (text && text.includes("audiobookbay")) {
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

  async search(query: string, category: string = "", page: number = 1): Promise<{ results: ABBSearchResult[], totalPages: number, currentPage: number }> {
    const domain = await this.resolveActiveDomain();
    
    // Construct search URL
    let searchUrl = `${domain}/page/${page}/?s=${encodeURIComponent(query)}`;
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
      let parsedCategory = "Audiobook";
      const catMatch = metaText.match(/Category:\s*(.+?)\s*Language:/);
      if (catMatch) {
        parsedCategory = catMatch[1].replace(/&nbsp;/g, ' ').trim();
      }

      const contentText = $(el).find(".postContent p[style*='text-align:center']").text() || 
                          $(el).find(".postContent p.center").last().text() || "";
      
      let parsedSize = "Unknown";
      let parsedFormat = "";
      let parsedAdded = "Unknown";

      const sizeMatch = contentText.match(/File Size:\s*(.+?)\s*(GBs|MBs)/i);
      if (sizeMatch) {
        parsedSize = `${sizeMatch[1].trim()} ${sizeMatch[2]}`;
      }
      
      const formatMatch = contentText.match(/Format:\s*(.+?)\s*\//i) || contentText.match(/Format:\s*(.+?)\s*$/i);
      if (formatMatch) {
        parsedFormat = formatMatch[1].trim();
      }

      const addedMatch = contentText.match(/Posted:\s*(.+?)\s*Format/i);
      if (addedMatch) {
        parsedAdded = addedMatch[1].trim();
      }

      // Combine format and category into category string if format is found
      if (parsedFormat && parsedFormat !== "?") {
        parsedCategory = `${parsedFormat} • ${parsedCategory}`;
      }
      
      results.push({
        id,
        title,
        url: url.startsWith("http") ? url : `${domain}${url}`,
        coverUrl: coverUrl.startsWith("http") ? coverUrl : `${domain}${coverUrl}`,
        category: parsedCategory,
        size: parsedSize, 
        seeders: 0,
        leechers: 0,
        added: parsedAdded
      });
    });

    // Extract total pages
    let totalPages = 1;
    const paginationLinks = $(".wp-pagenavi a");
    paginationLinks.each((_, el) => {
      const pageText = $(el).attr("title");
      if (pageText) {
        // Find the highest number in title attributes of pagination (e.g. title="27", title="&raquo;&raquo;" sometimes holds last page, 
        // but typically the actual page links have title="number")
        const pageNum = parseInt(pageText, 10);
        if (!isNaN(pageNum) && pageNum > totalPages) {
          totalPages = pageNum;
        }
      }
    });

    return { results, totalPages, currentPage: page };
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
