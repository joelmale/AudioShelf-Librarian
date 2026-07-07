import { Agent } from "undici";
import * as cheerio from "cheerio";

async function fetchInsecure(url: string, options: any = {}): Promise<Response> {
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  let res = await fetch(url, { ...options, dispatcher: dispatcher as any });
  let html = await res.text();

  // Handle JS redirect
  if (html.includes("window.location.replace")) {
    const match = html.match(/window\.location\.replace\('([^']+)'\)/);
    if (match && match[1]) {
      const redirectUrl = match[1];
      console.log("Following JS redirect:", redirectUrl);
      res = await fetch(redirectUrl, { ...options, dispatcher: dispatcher as any });
      html = await res.text();
    }
  }

  // Override res.text() to return the final HTML
  res.text = async () => html;
  return res;
}

async function test() {
  const res = await fetchInsecure("https://audiobookbay.biz", { headers: { "User-Agent": "Mozilla/5.0" } });
  const html = await res.text();
  const $ = cheerio.load(html);
  const popularSection = $("h2:contains('Most Popular')").parent();
  console.log("Popular items:", popularSection.find("li a").length);
}
test();
