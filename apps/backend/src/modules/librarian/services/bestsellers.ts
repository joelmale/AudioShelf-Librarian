import * as cheerio from "cheerio";
import { request } from "undici";

export interface BestsellerBook {
  title: string;
  author: string;
  coverUrl: string;
  description: string;
  source: "audible" | "audiobooksnow";
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
}
