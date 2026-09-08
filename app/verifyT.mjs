import { chromium } from "playwright";
const FULL = "http://localhost:3000/mapping/4CGXS";
const browser = await chromium.launch({ channel: "chromium", args: ["--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
const errors = [];
const byId = [];
page.on("console", (m) => { if (m.type() === "error" && !/sentry|ingest/i.test(m.text())) errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));
page.on("request", (r) => { if (r.url().includes("gbifIds=")) byId.push(decodeURIComponent(r.url().split("gbifIds=")[1])); });

await page.goto(FULL, { waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 60000 });
await page.waitForTimeout(10000);
const sampleIds = () => page.evaluate(() => [...document.querySelectorAll("table tbody tr")].length);
console.log("rows in the default sample:", await sampleIds());

// page out twice to reach records the default sample doesn't hold
const btn = page.getByRole("button", { name: /Click to load \d+ more/ }).first();
await btn.click(); await page.waitForTimeout(9000);
await btn.click(); await page.waitForTimeout(9000);

// take a record from the far end and plant a georeference against it
const far = await page.evaluate(() => {
  const cells = [...document.querySelectorAll("table tbody tr")].slice(-1)[0];
  // the GBIF id is on the row's own dataset or in the last cell's link
  const link = cells.querySelector('a[href*="gbif.org/occurrence/"]');
  return link ? Number(link.getAttribute("href").split("/occurrence/")[1]) : null;
});
console.log("record from the far end:", far);
await page.evaluate((gbifID) => {
  const key = "redlist-georefs:v1:4CGXS";
  localStorage.setItem(key, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    records: { [gbifID]: {
      gbifID,
      decimalLatitude: 21.5,
      decimalLongitude: 86.5,
      coordinateUncertaintyInMeters: 5000,
      georeferencedDate: new Date().toISOString(),
      georeferenceRemarks: "planted for the reload test",
    } },
  }));
}, far);

// reload: the default sample won't contain it
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector("canvas.maplibregl-canvas", { timeout: 60000 });
await page.waitForTimeout(14000);
console.log("rows after reload:", await sampleIds());
console.log("by-id requests:", JSON.stringify(byId));
const found = await page.evaluate((gbifID) => {
  const rows = [...document.querySelectorAll("table tbody tr")];
  const inTable = rows.some(r => (r.querySelector('a[href*="gbif.org/occurrence/"]')?.getAttribute("href") || "").endsWith(String(gbifID)));
  const t = document.body.textContent || "";
  return { inTable, edited: /1 record edited/.test(t) };
}, far);
console.log("recovered record in the table:", JSON.stringify(found));
await page.screenshot({ path: "/tmp/vT-recovered.png" });
// clean up so the next run starts fresh
await page.evaluate(() => localStorage.removeItem("redlist-georefs:v1:4CGXS"));
console.log("ERRORS:", JSON.stringify(errors.slice(0,5)));
await browser.close();
