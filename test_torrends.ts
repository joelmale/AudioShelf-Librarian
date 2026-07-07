import { Agent } from "undici";
import * as cheerio from "cheerio";
async function test() {
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  const res = await fetch("https://torrends.to/proxy/audiobook-bay", {
    headers: { "User-Agent": "Mozilla/5.0" },
    dispatcher: dispatcher as any
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
  console.log(scrapedDomains);
}
test();
