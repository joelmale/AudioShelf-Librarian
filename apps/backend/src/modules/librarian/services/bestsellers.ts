import * as cheerio from "cheerio";
import { request } from "undici";
import { generateCandidateId } from "../../curator/core/candidateId.js";

export type BestsellerSource =
  | "audible"
  | "audiobooksnow"
  | "apple"
  | "nyt-fiction"
  | "nyt-nonfiction";

export interface BestsellerBook {
  id: string;
  title: string;
  author: string;
  coverUrl: string;
  description: string;
  source: BestsellerSource;
  sourceItemId?: string;
  sourceUrl?: string;
  ownership?: 'owned' | 'unowned' | 'possible';
  isFinished?: boolean;
}

export type SourceFreshness = 'ready' | 'stale' | 'failed' | 'not-configured' | 'empty';

export interface SourceFetchResult {
  source: BestsellerSource;
  books: BestsellerBook[];
  status: SourceFreshness;
  errorMessage?: string | null;
  attributionUrl: string;
  publicationDate?: string | null;
}

export type NytAudioList = "audio-fiction" | "audio-nonfiction";

/** NYT list entries arrive in ALL CAPS; humanize them for display. */
export function nytTitleCase(title: string): string {
  return title
    .toLowerCase()
    .replace(/(^|[\s\-—(:"'])([a-z])/g, (_match, boundary, letter) => boundary + letter.toUpperCase());
}

export class BestsellersService {
  async fetchAudibleBestsellersDetailed(): Promise<SourceFetchResult> {
    const attributionUrl = "https://www.audible.com/charts/best";
    try {
      const { statusCode, body } = await request(attributionUrl, {
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
        const link = $(el).find("h3 a");
        const title = link.text().trim();
        const author = $(el).find(".authorLabel a").text().trim();
        const coverUrl = $(el).find("img.bc-image-inset-border").attr("src") || "";
        let description = $(el).find(".bc-text.bc-size-small.bc-color-secondary").first().text().trim();
        
        if (description.startsWith("By:")) {
          description = ""; // the byline was caught in the description, just clear it
        }

        const href = link.attr("href") || "";
        const asinMatch = href.match(/\/pd\/(?:[^/]+\/)?([A-Z0-9]{10})/i) || $(el).attr("data-asin")?.match(/([A-Z0-9]{10})/i);
        const sourceItemId = asinMatch ? asinMatch[1] : undefined;
        const sourceUrl = href ? (href.startsWith("http") ? href : `https://www.audible.com${href}`) : undefined;
        const id = generateCandidateId("audible", sourceItemId, title, author);

        if (title && author) {
          books.push({ id, title, author, coverUrl, description, source: "audible", sourceItemId, sourceUrl });
        }
      });

      return {
        source: "audible",
        books,
        status: books.length > 0 ? "ready" : "empty",
        errorMessage: null,
        attributionUrl,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Failed to fetch Audible bestsellers:", e);
      return {
        source: "audible",
        books: [],
        status: "failed",
        errorMessage: msg,
        attributionUrl,
      };
    }
  }

  async fetchAudibleBestsellers(): Promise<BestsellerBook[]> {
    return (await this.fetchAudibleBestsellersDetailed()).books;
  }

  async fetchAudiobooksNowBestsellersDetailed(): Promise<SourceFetchResult> {
    const attributionUrl = "https://www.audiobooksnow.com/bestsellers/";
    try {
      const { statusCode, body } = await request(attributionUrl, {
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
        const link = $(el).find("h2 a").first().length ? $(el).find("h2 a").first() : $(el).find("a").first();
        const title = $(el).find("h2").text().trim();
        const author = $(el).find(".d-small a").first().text().trim();
        const href = link.attr("href") || "";
        const sourceItemIdMatch = href.match(/\/audiobook\/[^/]+\/(\d+)\/?/i) || href.match(/\/(\d+)\/?$/);
        const sourceItemId = sourceItemIdMatch ? sourceItemIdMatch[1] : undefined;
        const sourceUrl = href ? (href.startsWith("http") ? href : `https://www.audiobooksnow.com${href}`) : undefined;
        
        let coverUrl = coverUrls[i] || $(el).find("img.jacketSmall").attr("src") || "";
        if (coverUrl.includes("data:image/svg")) {
          coverUrl = ""; // clear SVG placeholder if we didn't find the real URL
        }
        
        const id = generateCandidateId("audiobooksnow", sourceItemId, title, author);

        if (title && author) {
          books.push({ id, title, author, coverUrl, description: "", source: "audiobooksnow", sourceItemId, sourceUrl });
        }
      });

      return {
        source: "audiobooksnow",
        books,
        status: books.length > 0 ? "ready" : "empty",
        errorMessage: null,
        attributionUrl,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Failed to fetch AudiobooksNow bestsellers:", e);
      return {
        source: "audiobooksnow",
        books: [],
        status: "failed",
        errorMessage: msg,
        attributionUrl,
      };
    }
  }

  async fetchAudiobooksNowBestsellers(): Promise<BestsellerBook[]> {
    return (await this.fetchAudiobooksNowBestsellersDetailed()).books;
  }

  async fetchAppleBestsellersDetailed(): Promise<SourceFetchResult> {
    const attributionUrl = "https://books.apple.com/us/charts/audiobooks";
    try {
      const { statusCode, body } = await request(
        "https://rss.marketingtools.apple.com/api/v2/us/audio-books/top/25/audio-books.json"
      );

      if (statusCode !== 200) {
        throw new Error(`Apple Books feed returned status ${statusCode}`);
      }

      const feed = (await body.json()) as {
        feed?: {
          results?: Array<{
            id?: string;
            name?: string;
            artistName?: string;
            artworkUrl100?: string;
            url?: string;
          }>;
        };
      };

      const books: BestsellerBook[] = (feed.feed?.results ?? [])
        .filter((entry) => entry.name && entry.artistName)
        .map((entry) => {
          const sourceItemId = entry.id;
          const sourceUrl = entry.url;
          const title = entry.name!;
          const author = entry.artistName!;
          const coverUrl = (entry.artworkUrl100 || "").replace("100x100", "400x400");
          const id = generateCandidateId("apple", sourceItemId, title, author);
          return {
            id,
            title,
            author,
            coverUrl,
            description: "",
            source: "apple" as const,
            sourceItemId,
            sourceUrl,
          };
        });

      return {
        source: "apple",
        books,
        status: books.length > 0 ? "ready" : "empty",
        errorMessage: null,
        attributionUrl,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("Failed to fetch Apple Books bestsellers:", e);
      return {
        source: "apple",
        books: [],
        status: "failed",
        errorMessage: msg,
        attributionUrl,
      };
    }
  }

  async fetchAppleBestsellers(): Promise<BestsellerBook[]> {
    return (await this.fetchAppleBestsellersDetailed()).books;
  }

  async fetchNytBestsellersDetailed(apiKey: string | undefined, list: NytAudioList): Promise<SourceFetchResult> {
    const source: BestsellerSource = list === "audio-fiction" ? "nyt-fiction" : "nyt-nonfiction";
    const attributionUrl = `https://www.nytimes.com/books/best-sellers/${list}/`;

    if (!apiKey) {
      return {
        source,
        books: [],
        status: "not-configured",
        errorMessage: "NYT Books API key is not configured in Settings",
        attributionUrl,
      };
    }

    try {
      const { statusCode, body } = await request(
        `https://api.nytimes.com/svc/books/v3/lists/current/${list}.json?api-key=${encodeURIComponent(apiKey)}`
      );

      if (statusCode !== 200) {
        throw new Error(`NYT Books API returned status ${statusCode} for ${list}`);
      }

      const data = (await body.json()) as {
        results?: {
          published_date?: string;
          books?: Array<{
            primary_isbn13?: string;
            primary_isbn10?: string;
            title?: string;
            author?: string;
            book_image?: string;
            description?: string;
            amazon_product_url?: string;
          }>;
        };
      };

      const books: BestsellerBook[] = (data.results?.books ?? [])
        .filter((entry) => entry.title && entry.author)
        .map((entry) => {
          const title = nytTitleCase(entry.title!);
          const author = entry.author!;
          const sourceItemId = entry.primary_isbn13 || entry.primary_isbn10 || undefined;
          const sourceUrl = entry.amazon_product_url || undefined;
          const id = generateCandidateId(source, sourceItemId, title, author);
          return {
            id,
            title,
            author,
            coverUrl: entry.book_image || "",
            description: entry.description || "",
            source,
            sourceItemId,
            sourceUrl,
          };
        });

      return {
        source,
        books,
        status: books.length > 0 ? "ready" : "empty",
        errorMessage: null,
        attributionUrl,
        publicationDate: data.results?.published_date ?? null,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Failed to fetch NYT ${list} bestsellers:`, e);
      return {
        source,
        books: [],
        status: "failed",
        errorMessage: msg,
        attributionUrl,
      };
    }
  }

  async fetchNytBestsellers(apiKey: string | undefined, list: NytAudioList): Promise<BestsellerBook[]> {
    return (await this.fetchNytBestsellersDetailed(apiKey, list)).books;
  }
}
