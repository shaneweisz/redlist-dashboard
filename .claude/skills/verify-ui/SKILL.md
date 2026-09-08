---
name: verify-ui
description: Launch and drive the redlist-dashboard Next.js app for manual/agent verification, including the Node 22 workaround needed for Playwright browser checks on this machine.
---

# Running redlist-dashboard

The app lives in `app/`. All commands below run from that directory.

## First-time setup

```bash
cd app
npm install
npm run fetch-data-from-r2   # populates app/data/ from private R2 (needs R2 creds in .env.local)
```

## Dev server

```bash
npm run dev &
until curl -sf http://localhost:3000 >/dev/null; do sleep 1; done
```
Runs on port 3000 (Next.js + Turbopack). Stop with `pkill -f 'next dev'`.

## Browser-driven verification (Playwright)

**Known issue:** if the machine's default `node -v` is a very new release (v26.x has been observed to do this), `npx playwright install chromium` downloads the browser fine but then **hangs indefinitely during zip extraction** — no error, just a stuck process. This is a Node/Playwright compatibility issue, not a network problem (confirmed: plain `curl`/`fetch` of the same file completes in seconds).

**Fix:** install Node 22 LTS side-by-side (keg-only, does not touch the default `node`) and use it just for the Playwright install + driver script:

```bash
brew install node@22   # one-time; safe, does not relink the default node
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
mkdir -p /tmp/pw-browsers-node22
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers-node22 npx playwright install --no-shell chromium
```

**`--no-shell` matters for anything with a map.** Plain `playwright install chromium`
can leave you with only `chromium_headless_shell`, which cannot create a WebGL
context on macOS — MapLibre then fails to initialise with
`Failed to initialize WebGL ... BindToCurrentSequence failed`, the canvas never
appears, and `waitForSelector("canvas.maplibregl-canvas")` times out. No GPU flag
fixes it, because the shell build is the problem. Install the full browser and
launch it explicitly:

```js
const browser = await chromium.launch({
  channel: "chromium",                        // the full build, not the shell
  args: ["--enable-unsafe-swiftshader"],      // software GL, still needed
});
```

Then drive it with a small script (adjust the flow to whatever you're verifying):

```js
// verify.mjs — run from app/ with the Node 22 PATH override above
import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const errors = [];
page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
page.on("pageerror", (err) => errors.push(String(err)));

await page.goto("http://localhost:3000", { waitUntil: "networkidle" });
await page.waitForSelector("text=Taxonomic Group", { timeout: 20000 });
await page.screenshot({ path: "/tmp/verify-01.png" });

// ...interact: page.getByRole("button", { name: "..." }).click(), etc.

console.log("Console errors:", JSON.stringify(errors, null, 2));
await browser.close();
```

```bash
PLAYWRIGHT_BROWSERS_PATH=/tmp/pw-browsers-node22 node verify.mjs
```

Write the driver script inside `app/` (not `/tmp`) so Node's module resolution finds `playwright` in `app/node_modules` — otherwise you'll hit `ERR_MODULE_NOT_FOUND`. Delete it when done; it's a scratch file, not something to commit.

## Gotchas hit in practice

- **React controlled inputs**: use Playwright's `fill`/`click`, not `eval el.value = ...` — the latter skips React's onChange.
- **Slow first paint**: Turbopack compiles routes on demand; the first `page.goto` can take several seconds. Use `waitForSelector`, not a fixed `waitForTimeout`.
- **Data-dependent UI**: most of the dashboard's summary tables (Table 1a mode, SSC groups mode, taxa subgroups) read from precomputed `app/data/*.json` files, not live queries. If a feature shows zeros/empty after a code change, check whether the underlying data file needs regenerating (`npx tsx scripts/build-taxa-summary.ts`) before assuming the UI is broken — see the main README's "Data Sync Pipeline" section.

- **PostHog events never transmit under Playwright — and fail *silently*.** `posthog.capture()`
  returns without queueing anything, sends no request, and logs nothing even with
  `posthog.debug(true)`. This is not a bug in the app: posthog-js's `isLikelyBot`
  (`src/utils/blocked-uas.ts`) blocks `headlesschrome` by user agent **and** ends with
  `return !!navigator.webdriver`, so *any* WebDriver-controlled browser is classed as a bot
  and every event is dropped by a silent `return` inside `capture()`. Do not conclude from a
  Playwright run that analytics are broken in production. To verify analytics for real, defeat
  both signals:

  ```js
  const ctx = await browser.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
               "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",   // no "HeadlessChrome"
  });
  await ctx.addInitScript(() =>
    Object.defineProperty(navigator, "webdriver", { get: () => false })
  );
  ```

  Then intercept `**/ingest/**` and fulfil the POSTs locally so test events never reach the
  real PostHog project. The bodies are **raw gzip bytes in a `text/plain` request**, so read
  them with `request.postDataBuffer()` (the string `postData()` mangles the binary) and
  `zlib.gunzipSync`:

  ```js
  const buf = route.request().postDataBuffer();
  const txt = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString("utf8")
                                                 : buf.toString("utf8");
  JSON.parse(txt).batch?.forEach((e) => console.log(e.event));
  ```
