const https = require("https");
const cheerio = require("cheerio");

https.get("https://audiobookbay.lu", { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
  let data = "";
  res.on("data", chunk => data += chunk);
  res.on("end", () => {
    const $ = cheerio.load(data);
    const popularSection = $("h2:contains('Most Popular')").parent();
    console.log(popularSection.html());
  });
}).on("error", (err) => console.log(err));
