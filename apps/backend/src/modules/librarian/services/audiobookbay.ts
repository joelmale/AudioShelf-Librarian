import * as cheerio from "cheerio";
import https from "https";
import cron from "node-cron";
import type { ABBSearchResult, ABBPaginatedResponse } from "@audioshelf/shared";
import { SettingsStore } from "../../../config/settings.js";

export class AntiBotChallengeError extends Error {
  public url: string;
  constructor(message: string, url: string) {
    super(message);
    this.name = "AntiBotChallengeError";
    this.url = url;
  }
}

export class AudiobookBayService {
  private activeDomain: string | null = null;
  private domainsToTest = [
    "https://audiobookbay.lu",
    "https://audiobookbay.nl",
    "https://audiobookbay.is",
    "https://audiobookbayabb.com",
  ];

  private lastScrapeTime: Date | null = null;
  private knownMirrorsCount: number = 0;
  private sessionCookie: string = "";

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
    const { Agent, ProxyAgent } = await import("undici");
    const settings = SettingsStore.getInstance().getSettings();
    const proxyUrl = settings.proxyUrl;
    const useProxy = settings.useProxy ?? true;

    let dispatcher;
    if (useProxy && proxyUrl) {
      console.log(`[ABB Service] Using proxy: ${proxyUrl} for ${url}`);
      dispatcher = new ProxyAgent({
        uri: proxyUrl,
        requestTls: { rejectUnauthorized: false }
      });
    } else {
      dispatcher = new Agent({
        connect: { rejectUnauthorized: false }
      });
    }
    if (this.sessionCookie) {
      options.headers = { ...options.headers, "Cookie": this.sessionCookie };
    }
    return fetch(url, { ...options, dispatcher: dispatcher as any });
  }

  private updateCookies(res: Response) {
    let cookies: string[] = [];
    if (typeof res.headers.getSetCookie === 'function') {
      cookies = res.headers.getSetCookie();
    } else {
      const sc = res.headers.get('set-cookie');
      if (sc) cookies = [sc];
    }
    if (cookies.length > 0) {
      const newCookies = cookies.map(c => c.split(';')[0]).join('; ');
      // Simple merge: just overwrite for now as it's usually just one clearance cookie
      this.sessionCookie = newCookies;
    }
  }

  public setClearanceCookie(cookieString: string) {
    this.sessionCookie = cookieString;
  }

  private async fetchWithChallenge(url: string, options: any = {}): Promise<string> {
    const defaultHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Connection": "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1"
    };
    
    options.headers = { ...defaultHeaders, ...options.headers };
    let res = await this.fetchInsecure(url, { ...options, redirect: "manual" });

    // Follow manual redirects
    let redirectCount = 0;
    while (res.status >= 300 && res.status < 400 && redirectCount < 5) {
      this.updateCookies(res);
      const location = res.headers.get('location');
      if (!location) break;
      const nextUrl = location.startsWith('http') ? location : new URL(location, url).toString();
      res = await this.fetchInsecure(nextUrl, { ...options, redirect: "manual" });
      redirectCount++;
    }

    if (!res.ok && res.status !== 200) {
      const errText = await res.text().catch(() => "");
      console.error(`ABB request failed for ${url} with status ${res.status} ${res.statusText}. Snippet:`, errText.substring(0, 500));
      if (res.status === 403 || errText.toLowerCase().includes("cloudflare") || errText.includes("Just a moment...")) {
        throw new AntiBotChallengeError(`Anti-bot challenge detected (HTTP ${res.status})`, url);
      }
      throw new Error(`Request failed with status ${res.status}`);
    }

    this.updateCookies(res);
    let html = await res.text();
    
    if (html.includes("Just a moment...") && html.toLowerCase().includes("cloudflare")) {
      throw new AntiBotChallengeError(`Anti-bot challenge detected in response body`, url);
    }

    const jsRedirectMatch = html.match(/window\.location\.replace\(['"]([^'"]+)['"]\)/);
    if (jsRedirectMatch && jsRedirectMatch[1]) {
      console.log(`[ABB Service] Following anti-bot redirect to: ${jsRedirectMatch[1]}`);
      const redirectUrl = jsRedirectMatch[1];

      res = await this.fetchInsecure(redirectUrl, { ...options, redirect: "manual" });

      redirectCount = 0;
      while (res.status >= 300 && res.status < 400 && redirectCount < 5) {
        this.updateCookies(res);
        const location = res.headers.get('location');
        if (!location) break;
        const nextUrl = location.startsWith('http') ? location : new URL(location, redirectUrl).toString();
        res = await this.fetchInsecure(nextUrl, { ...options, redirect: "manual" });
        redirectCount++;
      }

      if (!res.ok && res.status !== 200) {
        const errText = await res.text().catch(() => "");
        console.error(`ABB redirect failed with status ${res.status}. Snippet:`, errText.substring(0, 500));
        throw new Error(`Redirect failed with status ${res.status}`);
      }
      this.updateCookies(res);

      // The anti-bot redirect resolves to the homepage, not our original URL.
      // Now that we have the clearance cookies, re-fetch the original search URL.
      console.log(`[ABB Service] Anti-bot challenge passed, re-fetching original URL: ${url}`);
      res = await this.fetchInsecure(url, { ...options, redirect: "manual" });

      redirectCount = 0;
      while (res.status >= 300 && res.status < 400 && redirectCount < 5) {
        this.updateCookies(res);
        const location = res.headers.get('location');
        if (!location) break;
        const nextUrl = location.startsWith('http') ? location : new URL(location, url).toString();
        res = await this.fetchInsecure(nextUrl, { ...options, redirect: "manual" });
        redirectCount++;
      }

      if (!res.ok && res.status !== 200) {
        const errText = await res.text().catch(() => "");
        if (res.status === 403 || errText.toLowerCase().includes("cloudflare") || errText.includes("Just a moment...")) {
          throw new AntiBotChallengeError(`Anti-bot challenge detected after retry (HTTP ${res.status})`, url);
        }
        throw new Error(`Retry after challenge failed with status ${res.status}`);
      }
      this.updateCookies(res);
      html = await res.text();
    }

    return html;
  }

  private async refreshProxies(): Promise<void> {
    try {
      console.log("Fetching Torrends proxy list...");
      const res = await this.fetchInsecure("https://torrends.to/proxy/audiobook-bay", {
        headers: { "User-Agent": "Mozilla/5.0" }
      });
      const html = await res.text();
      const domainRegex = /audiobookbay[a-z0-9-.]*\.[a-z]{2,}/gi;
      const matches = html.match(domainRegex) || [];
      const scrapedDomains: string[] = [...new Set(matches)]
        .filter(d => !d.toLowerCase().includes('audiobookbay.me') && !d.toLowerCase().includes('.biz'))
        .map(d => `https://${d}`);

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
        const html = await this.fetchWithChallenge(domain, { signal: AbortSignal.timeout(10000) });
        if (html && html.includes("postTitle") && html.toLowerCase().includes("audiobook")) {
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
        const html = await this.fetchWithChallenge(this.activeDomain, { signal: AbortSignal.timeout(10000) });
        if (html && html.includes("postTitle") && html.toLowerCase().includes("audiobook")) return this.activeDomain;
        else this.activeDomain = null;
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

  async search(query: string, category: string = "", page: number = 1): Promise<ABBPaginatedResponse> {
    // Instead of aggressively fetching multiple pages concurrently which triggers anti-bot protection,
    // we just fetch the single requested page and rely on the frontend's pagination controls.
    return this.fetchPage(query, category, page);
  }

  private async fetchPage(query: string, category: string = "", page: number = 1): Promise<ABBPaginatedResponse> {
    const domain = await this.resolveActiveDomain();

    // Construct search URL
    let searchUrl = page === 1 
      ? `${domain}/?s=${encodeURIComponent(query)}`
      : `${domain}/page/${page}/?s=${encodeURIComponent(query)}`;
      
    if (category) {
      searchUrl += `&cat=${category}`;
    }

    console.log(`ABB Search: ${searchUrl}`);
    const html = await this.fetchWithChallenge(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
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

    if (results.length === 0) {
      console.warn(`ABB Search returned 0 results for: ${query}. This might indicate a block or proxy issue. Response snippet:`, html.substring(0, 500));
    }

    return { results, totalPages, currentPage: page };
  }

  async getMagnetLink(bookUrl: string): Promise<string> {
    // Fetches the specific book page to extract the info hash and build the magnet link
    const html = await this.fetchWithChallenge(bookUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

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

    const settingsTrackers = SettingsStore.getInstance().getSettings().torrentTrackers || "";
    const trackers: string[] = settingsTrackers
      .split("\n")
      .map(tr => tr.trim())
      .filter(tr => tr.length > 0);

    const trStrings: string = trackers
      .map((tr: string) => `tr=${encodeURIComponent(tr)}`)
      .join("&");

    return `magnet:?xt=urn:btih:${infoHash}&dn=${title}${trStrings ? '&' + trStrings : ''}`;
  }

  async getPopularAudiobooks(): Promise<{ title: string; url: string; rawText: string }[]> {
    const domain = await this.resolveActiveDomain();
    const html = await this.fetchWithChallenge(domain, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const $ = cheerio.load(html);
    const results: { title: string; url: string; rawText: string }[] = [];

    const popularSection = $("h2:contains('Most Popular')").parent();
    if (!popularSection.length) {
      console.warn("Could not find 'Most Popular Audio Books' section on ABB homepage.");
      return [];
    }

    popularSection.find("li a").each((_, el) => {
      const url = $(el).attr("href") || "";
      const rawText = $(el).text().trim();
      if (!rawText) return;

      // Titles are often formatted like: "Book Title - Author Name"
      let parsedTitle = rawText;
      const dashIndex = rawText.lastIndexOf(" - ");
      if (dashIndex !== -1) {
        parsedTitle = rawText.substring(0, dashIndex).trim();
      }

      results.push({
        title: parsedTitle,
        rawText,
        url: url.startsWith("http") ? url : `${domain}${url}`
      });
    });

    return results;
  }

  async getBookDetails(bookUrl: string): Promise<{ coverUrl: string; description: string }> {
    try {
      const html = await this.fetchWithChallenge(bookUrl, {
        headers: { "User-Agent": "Mozilla/5.0" }
      });

      const $ = cheerio.load(html);
      const domain = await this.resolveActiveDomain();

      let coverUrl = $(".postContent img").first().attr("src") || "";
      if (coverUrl && !coverUrl.startsWith("http")) {
        coverUrl = `${domain}${coverUrl}`;
      }

      // Extract description
      // usually in paragraph tags in .postContent
      let description = "";
      $(".postContent p").each((_, el) => {
        const text = $(el).text().trim();
        // Ignore lines that look like metadata (Category, File Size, Format, etc)
        if (text && !text.includes("Category:") && !text.includes("File Size:") && !text.includes("Format:")) {
          description += text + "\n";
        }
      });

      return { coverUrl, description: description.trim() };
    } catch (e) {
      console.error(`Failed to get details for ${bookUrl}`, e);
      return { coverUrl: "", description: "" };
    }
  }
}
