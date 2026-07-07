import { Agent } from "undici";
async function test() {
  const dispatcher = new Agent({ connect: { rejectUnauthorized: false } });
  const domains = ['https://audiobookbay.fi', 'https://audiobookbay.nl', 'https://audiobookbay.ch', 'https://audiobookbay.net', 'https://audiobookbay.org'];
  for (const d of domains) {
    try {
      const res = await fetch(d, { headers: { "User-Agent": "Mozilla/5.0" }, dispatcher: dispatcher as any, signal: AbortSignal.timeout(5000) });
      if (res.ok) { console.log(d, "WORKS"); break; }
    } catch(e) {}
  }
}
test();
