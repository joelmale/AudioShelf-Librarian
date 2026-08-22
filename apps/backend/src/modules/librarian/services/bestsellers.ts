import * as cheerio from "cheerio";
import { request } from "undici";

export type BestsellerSource =
  | "audible"
  | "audiobooksnow"
  | "apple"
  | "nyt-fiction"
  | "nyt-nonfiction";

export interface BestsellerBook {
  title: string;
  author: string;
  coverUrl: string;
  description: string;
  source: BestsellerSource;
}

export type NytAudioList = "audio-fiction" | "audio-nonfiction";

/** NYT list entries arrive in ALL CAPS; humanize them for display. */
export function nytTitleCase(title: string): string {
  return title
    .toLowerCase()
    .replace(/(^|[\s\-—(:"'])([a-z])/g, (_match, boundary, letter) => boundary + letter.toUpperCase());
}

export class BestsellersService {
  async fetchAudibleBestsellers(): Promise<BestsellerBook[]> {
    try {
      const { statusCode, body } = await request("https://www.audible.com/charts/best", {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      });
      
      if (statusCode !== 200) {
        throw new Error(`Audible returned status ${statusCode}`);
      }

      const html = await body.text();
      const $ = cheerio.load(html);
      const books: BestsellerBook[] = [];

      $(".productListItem").each((i, el) => {
        if (i >= 20) return; // limit to top 20
        const title = $(el).find("h3 a").text().trim();
        const author = $(el).find(".authorLabel a").text().trim();
        const coverUrl = $(el).find("img.bc-image-inset-border").attr("src") || "";
        let description = $(el).find(".bc-text.bc-size-small.bc-color-secondary").first().text().trim();
        
        if (description.startsWith("By:")) {
            description = ""; // the byline was caught in the description, just clear it
        }

        if (title && author) {
          books.push({ title, author, coverUrl, description, source: "audible" });
        }
      });

      return books;
    } catch (e) {
      console.error("Failed to fetch Audible bestsellers:", e);
      return [];
    }
  }

  async fetchAudiobooksNowBestsellers(): Promise<BestsellerBook[]> {
    try {
      const { statusCode, body } = await request("https://www.audiobooksnow.com/bestsellers/", {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      });
      
      if (statusCode !== 200) {
        throw new Error(`AudiobooksNow returned status ${statusCode}`);
      }

      const html = await body.text();
      const $ = cheerio.load(html);
      const books: BestsellerBook[] = [];

      // AudiobooksNow uses Nuxt/Vue and lazy loads covers. The real cover URLs are embedded 
      // in the __NUXT__ state JSON at the bottom of the HTML. We can extract the large jackets in order.
      const jacketMatches = html.match(/https:\\u002F\\u002Fstatic\.audiobooksnow\.com\\u002Fjackets\\u002Flarge\\[^"]+\.jpg/g) || [];
      const coverUrls = jacketMatches.map(url => url.replace(/\\u002F/g, '/'));

      $(".resultCard").each((i, el) => {
        if (i >= 20) return;
        const title = $(el).find("h2").text().trim();
        const author = $(el).find(".d-small a").first().text().trim();
        
        let coverUrl = coverUrls[i] || $(el).find("img.jacketSmall").attr("src") || "";
        if (coverUrl.includes("data:image/svg")) {
            coverUrl = ""; // clear SVG placeholder if we didn't find the real URL
        }
        
        if (title && author) {
          books.push({ title, author, coverUrl, description: "", source: "audiobooksnow" });
        }
      });

      return books;
    } catch (e) {
      console.error("Failed to fetch AudiobooksNow bestsellers:", e);
      return [];
    }
  }

  async fetchAppleBestsellers(): Promise<BestsellerBook[]> {
    try {
      // Official Apple marketing feed: structured JSON, no scraping. The limit
      // segment only accepts 10/25/50.
      const { statusCode, body } = await request(
        "https://rss.marketingtools.apple.com/api/v2/us/audio-books/top/25/audio-books.json"
      );

      if (statusCode !== 200) {
        throw new Error(`Apple Books feed returned status ${statusCode}`);
      }

      const feed = (await body.json()) as {
        feed?: { results?: Array<{ name?: string; artistName?: string; artworkUrl100?: string }> };
      };

      return (feed.feed?.results ?? [])
        .filter((entry) => entry.name && entry.artistName)
        .map((entry) => ({
          title: entry.name!,
          author: entry.artistName!,
          // The feed serves 100x100 thumbnails, but the CDN renders any
          // requested size from the same URL.
          coverUrl: (entry.artworkUrl100 || "").replace("100x100", "400x400"),
          description: "",
          source: "apple" as const,
        }));
    } catch (e) {
      console.error("Failed to fetch Apple Books bestsellers:", e);
      return [];
    }
  }

  async fetchNytBestsellers(apiKey: string | undefined, list: NytAudioList): Promise<BestsellerBook[]> {
    if (!apiKey) return [];
    const source: BestsellerSource = list === "audio-fiction" ? "nyt-fiction" : "nyt-nonfiction";

    try {
      const { statusCode, body } = await request(
        `https://api.nytimes.com/svc/books/v3/lists/current/${list}.json?api-key=${encodeURIComponent(apiKey)}`
      );

      if (statusCode !== 200) {
        throw new Error(`NYT Books API returned status ${statusCode} for ${list}`);
      }

      const data = (await body.json()) as {
        results?: { books?: Array<{ title?: string; author?: string; book_image?: string; description?: string }> };
      };

      return (data.results?.books ?? [])
        .filter((entry) => entry.title && entry.author)
        .map((entry) => ({
          title: nytTitleCase(entry.title!),
          author: entry.author!,
          coverUrl: entry.book_image || "",
          description: entry.description || "",
          source,
        }));
    } catch (e) {
      console.error(`Failed to fetch NYT ${list} bestsellers:`, e);
      return [];
    }
  }
}
