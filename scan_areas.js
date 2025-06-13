import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'
import fetch from 'node-fetch'

// emulate __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// load config.json
const cfgPath = path.resolve(__dirname, 'config.json')
let regionBoundaries
try {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  regionBoundaries = cfg.regionBoundaries
} catch (err) {
  console.error('❌ Failed to load regionBoundaries from config.json:', err.message)
  process.exit(1)
}
if (!regionBoundaries || Object.keys(regionBoundaries).length === 0) {
  console.error('❌ regionBoundaries missing in config.json')
  process.exit(1)
}

const COOKIE_PATH = 'cookies.json'
const editorUrl = 'https://waze.com/editor'

function delay(time) {
  if (time <= 0) {
    return Promise.resolve(); // No delay needed
  }
  return new Promise(function (resolve) {
    setTimeout(resolve, time)
  });
}

if (!fs.existsSync(COOKIE_PATH)) {
  fs.writeFileSync(COOKIE_PATH, JSON.stringify([], null, 2), 'utf8');
}

// Launch the browser and open a new blank page and make it visible
const browser = await puppeteer.launch({
  headless: false, // Set to false to see the browser
  defaultViewport: null, // Use the default viewport size
  args: ['--start-maximized'] // Start the browser maximized
});
const page = await browser.newPage();

// Load and apply saved cookies to the page
const rawCookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
const validCookies = rawCookies.filter(c => c.name && c.value);
if (validCookies.length) {
  await page.setCookie(...validCookies);
}

// Build a Cookie header string for node‐fetch
const cookieHeader = validCookies
  .map(c => `${c.name}=${c.value}`)
  .join('; ');

// 1) Navigate and wait for SDK + login in one go
await page.goto(editorUrl);

await page.waitForFunction(
  () => {
    // guard against SDK not injected yet
    if (typeof window.getWmeSdk !== 'function') {
      console.log('waiting for getWmeSdk…');
      return false;
    }
    const sdk = window.getWmeSdk({
      scriptId: 'wme-scan-closures',
      scriptName: 'Waze Scan Closures'
    });
    console.log('got sdk, loggedIn=', !!sdk?.WmeState?.isLoggedIn());
    return sdk?.State?.isLoggedIn() === true;
  },
  {
    polling: 1000,  // check every second
    timeout: 0      // wait indefinitely
  }
);

console.log('✅ Logged in; continuing…');

// 2) Save fresh cookies
const freshCookies = await page.cookies();
fs.writeFileSync(COOKIE_PATH, JSON.stringify(freshCookies, null, 2));

// ← if cookies loaded/saved OK, close Puppeteer and exit
if (freshCookies.length > 0) {
  console.log('✅ Cookies are OK, closing browser.');
  await browser.close();
}

function generateCoords(xMin, xMax, yMin, yMax) {
  const coords = []
  for (let x = xMin; x <= xMax; x += 1.5)
    for (let y = yMin; y <= yMax; y += 1.5)
      coords.push({
        xMin: +x.toFixed(6),
        yMin: +y.toFixed(6),
        xMax: + (x + 1.5).toFixed(6),
        yMax: + (y + 1.5).toFixed(6)
      })
  return coords
}

function generateScanQueue() {
  const scanUrls = {}
  for (const region in regionBoundaries) {
    const b = regionBoundaries[region]
    scanUrls[region] = generateCoords(b.xMin, b.xMax, b.yMin, b.yMax)
      .map(c => (
        `https://www.waze.com/Descartes/app/v1/Features/Closures` +
        `?bbox=${c.xMin},${c.yMin},${c.xMax},${c.yMax}`
      ))
  }
  return scanUrls
}

// Track total scan time
const overallStart = Date.now();

// 3) Generate scan queue and start visiting URLs
const scanQueue = generateScanQueue();
const scanResults = {};

// initialize a closures array for each country
for (const country in scanQueue) {
  scanResults[country] = { closures: [] };
}

for (const country in scanQueue) {
  console.log(`Scanning ${country}…`);
  const regionStart = Date.now();
  let regionReqSum = 0;

  const urls = scanQueue[country];
  const total = urls.length;

  for (let idx = 0; idx < total; idx++) {
    const url = urls[idx];
    console.log(`Visiting [${country}] ${idx + 1}/${total}: ${url}`);

    const reqStart = Date.now();
    let closuresData;
    try {
      const res = await fetch(url, {
        headers: { Cookie: cookieHeader },
        timeout: 30000
      });
      closuresData = await res.json();
    } catch (err) {
      console.error(`✖ fetch error (${idx + 1}/${total}):`, err.message);
      continue;
    }

    const reqDuration = Date.now() - reqStart;
    regionReqSum += reqDuration;
    console.log(` → request took ${reqDuration}ms`);

    console.log(
      `→ got ${closuresData.roadClosures.objects.length} roadClosures ` +
      `for ${country} (${idx + 1}/${total})`
    );

    // your existing filter + push logic…
    const userClosures = closuresData.roadClosures.objects
      .filter(c => !c.reason && c.startDate && c.endDate &&
        (new Date(c.endDate) - new Date(c.startDate)) === 3600000 &&
        c.createdBy !== 304740435 && c.closureStatus === 'ACTIVE');

    if (userClosures.length) {
      console.log(`✔ ${userClosures.length} user closures`);
      scanResults[country].closures.push(...userClosures);
      fs.writeFileSync('scan_results.json', JSON.stringify(scanResults, null, 2));
    }
    await delay(1000 - reqDuration); // Make sure there is one second between requests to keep Waze happy
  }

  const regionDuration = Date.now() - regionStart;
  const regionAvg = regionReqSum / total;

  console.log(
    `✅ Completed ${country} in ${regionDuration}ms ` +
    `(${(regionDuration / 1000).toFixed(1)}s/${((regionDuration / 1000).toFixed(1)) / 60}mins), ` +
    `avg request time ${regionAvg.toFixed(1)}ms`
  );
}

const overallDuration = Date.now() - overallStart;
console.log(
  `🎉 All scans completed in ${overallDuration}ms ` +
  `(${(overallDuration / 1000).toFixed(1)}s/${((overallDuration / 1000).toFixed(1)) / 60}mins)`
);