const https = require("https");
https.get("https://www.audiobooksnow.com/bestsellers/", (res) => {
  let data = "";
  res.on("data", d => data += d);
  res.on("end", () => {
    const cheerio = require("cheerio");
    const $ = cheerio.load(data);
    console.log($(".resultCard").first().text().replace(/\s+/g, " ").trim());
  });
});
