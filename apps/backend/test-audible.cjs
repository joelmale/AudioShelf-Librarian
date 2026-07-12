const https = require("https");
https.get("https://www.audible.com/charts/best", { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
  let data = "";
  res.on("data", d => data += d);
  res.on("end", () => {
    const cheerio = require("cheerio");
    const $ = cheerio.load(data);
    console.log($(".productListItem").first().find(".bc-popover-inner p").first().text().trim());
  });
});
