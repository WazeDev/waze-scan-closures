import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import puppeteer from 'puppeteer'
import fetch from 'node-fetch'

// emulate __dirname
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// load config.json
const cfgPath = path.resolve(__dirname, "..", "config.json");
interface RegionBoundary {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  env: string;
}

let regionBoundaries: Record<string, RegionBoundary>
interface Config {
  regionBoundaries: Record<string, RegionBoundary>;
  loop?: boolean;
  [key: string]: unknown;
}
let cfg: Config;
try {
  cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as Config;
  regionBoundaries = cfg.regionBoundaries
} catch (err) {
  if (err instanceof Error) {
    console.error('❌ Failed to load regionBoundaries from config.json:', err.message)
  } else {
    console.error('❌ Failed to load regionBoundaries from config.json:', err)
  }
  process.exit(1)
}
if (Object.keys(regionBoundaries).length === 0) {
  console.error('❌ regionBoundaries missing in config.json')
  process.exit(1)
}

const COOKIE_PATH = path.resolve(__dirname, "..", "cookies.json");
const SCAN_RESULTS_PATH = path.resolve(__dirname, "..", "scan_results.json");
const editorUrl = 'https://waze.com/editor'

function delay(time = 1000) {
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
interface Cookie {
  name: string;
  value: string;
  domain?: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  [key: string]: unknown;
}
const rawCookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8')) as unknown as Cookie[];
const validCookies = rawCookies.filter((c: Cookie) => c.name && c.value);
if (validCookies.length) {
  await page.setCookie(...validCookies);
}

// Build a Cookie header string for node‐fetch
const cookieHeader = validCookies
  .map((c: Cookie) => `${c.name}=${c.value}`)
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
    interface WmeSdk {
      State?: {
        isLoggedIn: () => boolean;
      };
      WmeState?: {
        isLoggedIn: () => boolean;
      };
    }
    const sdk = (window as unknown as { getWmeSdk: (opts: { scriptId: string; scriptName: string }) => WmeSdk }).getWmeSdk({
      scriptId: 'wme-scan-closures',
      scriptName: 'Waze Scan Closures'
    });
    console.log('got sdk, loggedIn=', !!sdk.WmeState?.isLoggedIn());
    return sdk.State?.isLoggedIn() === true;
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

function generateCoords(xMin: number, xMax: number, yMin: number, yMax: number) {
  const coords = []
  for (let x = xMin; x <= xMax; x += 1.5)
    for (let y = yMin; y <= yMax; y += 1.5)
      coords.push({
        xMin: +x.toFixed(6),
        yMin: +y.toFixed(6),
        xMax: +(x + 1.5).toFixed(6),
        yMax: +(y + 1.5).toFixed(6)
      })
  return coords
}

function generateScanQueue() {
  const scanUrls: Record<string, string[]> = {};
  for (const region in regionBoundaries) {
    const b = regionBoundaries[region]
    let envPrefix: string;
    if (b.env === 'row') {
      envPrefix = "row-";
    } else if (b.env === 'il') {
      envPrefix = "il-";
    } else { 
      envPrefix = "";
    }
    scanUrls[region] = generateCoords(b.xMin, b.xMax, b.yMin, b.yMax)
      .map(c => (
        `https://www.waze.com/${envPrefix}Descartes/app/v1/Features/Closures` +
        `?bbox=${String(c.xMin)},${String(c.yMin)},${String(c.xMax)},${String(c.yMax)}`
      ))
  }
  return scanUrls
}

// Track total scan time
let overallStart: number;
// 3) Generate scan queue and start visiting URLs
const scanQueue = generateScanQueue();
interface RoadClosure {
  reason: string | null;
  startDate: string | number | Date;
  endDate: string | number | Date;
  createdBy: number;
  closureStatus: string;
  [key: string]: unknown;
}
const scanResults: Record<string, { closures: RoadClosure[] }> = {};

// initialize a closures array for each country
cfg.loop ??= false; // default to not looping
if (cfg.loop) {
  console.log('🔄 Looping enabled, will repeat scans until stopped.')
  for (;;) {
    for (const country in scanQueue) {
      scanResults[country] = { closures: [] };
    }
    overallStart = Date.now();
    await performScan();
  }
} else {
  console.log('🔄 Looping disabled, will perform a single scan.')
  await performScan();
  console.log('🔄 Scan completed, exiting.');
}

async function performScan() {
for (const country in scanQueue) {
  console.log(`Scanning ${country}…`);
  const regionStart = Date.now();
  let regionReqSum = 0;

  const urls = scanQueue[country];
  const total = urls.length;

  for (let idx = 0; idx < total; idx++) {
    const url = urls[idx];
    console.log(`Visiting [${country}] ${String(idx + 1)}/${String(total)}: ${url}`);

    const reqStart = Date.now();
    let closuresData: unknown;
    try {
      const res = await fetch(url, {
        headers: { Cookie: cookieHeader }
      });
      if (res.status === 403) {
        console.error('❌ Received 403 Forbidden from Waze API, exiting.');
        process.exit(1);
      }
      closuresData = await res.json();
    } catch (err) {
      if (err instanceof Error) {
        console.error(`✖ fetch error (${String(idx + 1)}/${String(total)}):`, err.message);
      } else {
        console.error(`✖ fetch error (${String(idx + 1)}/${String(total)}):`, err);
      }
      continue;
    }

    const reqDuration = Date.now() - reqStart;
    regionReqSum += reqDuration;
    console.log(` → request took ${String(reqDuration)}ms/${(reqDuration / 1000).toFixed(1)}s`);

    // Type guard to avoid 'unknown' error
    if (
      typeof closuresData === 'object' &&
      closuresData !== null &&
      'roadClosures' in closuresData &&
      typeof (closuresData as { roadClosures?: unknown }).roadClosures === 'object' &&
      closuresData.roadClosures !== null &&
      typeof closuresData.roadClosures === 'object' &&
      'objects' in closuresData.roadClosures &&
      Array.isArray((closuresData.roadClosures as { objects?: unknown[] }).objects)
    ) {
      const roadClosures = (closuresData as { roadClosures: { objects: RoadClosure[] } }).roadClosures;
      console.log(
        `→ got ${String(roadClosures.objects.length)} roadClosures ` +
        `for ${country} (${String(idx + 1)}/${String(total)})`
      );

      // your existing filter + push logic…
      const userClosures = roadClosures.objects.filter(c =>
        !c.reason &&
        c.startDate &&
        c.endDate &&
        (new Date(c.endDate).getTime() - new Date(c.startDate).getTime()) === 3600000 &&
        c.createdBy !== 304740435 &&
        c.closureStatus === 'ACTIVE'
      );

      if (userClosures.length) {
        scanResults[country].closures.push(...userClosures);
        fs.writeFileSync(SCAN_RESULTS_PATH, JSON.stringify(scanResults, null, 2));
      }
    } else {
      console.warn('⚠ Unexpected closuresData format:', closuresData);
    }
    await delay(Math.max(0, 1000 - reqDuration)); // Make sure there is one second between requests to keep Waze happy
  }

  const regionDuration = Date.now() - regionStart;
  const regionAvg = regionReqSum / total;

  console.log(
    `✅ Completed ${country} in ${String(regionDuration)}ms ` +
    `(${(regionDuration / 1000).toFixed(1)}s/${(regionDuration / 1000 / 60).toFixed(1)}mins), ` +
    `avg request time ${regionAvg.toFixed(1)}ms`
  );
}

const overallDuration = Date.now() - overallStart;
console.log(
  `🎉 All scans completed in ${overallDuration.toString()}ms ` +
  `(${(overallDuration / 1000).toFixed(1)}s/${(overallDuration / 1000 / 60).toFixed(1)}mins)`
);
}
