import { Agent } from "undici";
async function test() {
  const domains = [
    'https://audiobookbay.nl',
    'https://audiobookbay.me',
    'https://audiobookbayabb.com',
    'https://audiobookbay.unblockit.lat',
    'https://audiobookbay.biz',
    'https://audiobookbay.lu',
    'https://audiobookbay.is'
  ];
  
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  
  for (const d of domains) {
    try {
      console.log("Testing:", d);
      const res = await fetch(d, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
        dispatcher: dispatcher as any,
        signal: AbortSignal.timeout(5000)
      });
      console.log(d, "->", res.status);
    } catch(e: any) {
      console.log(d, "-> ERROR", e.message);
    }
  }
}
test();
