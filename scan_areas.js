import puppeteer from 'puppeteer';
import fs from 'fs';
import fetch from 'node-fetch';

const editorUrl = 'https://waze.com/editor';
const COOKIE_PATH = 'cookies.json';

function delay(time) {
    return new Promise(function (resolve) {
        setTimeout(resolve, time)
    });
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
const freshCookies = await browser.cookies();
fs.writeFileSync(COOKIE_PATH, JSON.stringify(freshCookies, null, 2));

// ← if cookies loaded/saved OK, close Puppeteer and exit
if (freshCookies.length > 0) {
  console.log('✅ Cookies are OK, closing browser.');
  await browser.close();
}

const countryBoundaries = {
    "US": { xMin: -125, xMax: -66.5, yMin: 24.396308, yMax: 49.384358, env: "" },
    //"CA": { xMin: -141, xMax: -52, yMin: 41.676555, yMax: 83.223572, env: ""},
    //"GB": { xMin: -8.6, xMax: 1.8, yMin: 49.9, yMax: 60.8, env: "row"},
    // Add more countries as needed
};
function generateCoords(mininiumXBoundary = -180, maximumXBoundary = 180, minimumYBoundary = -90, maximumYBoundary = 90) {
    // Generate coordinates from start, incrementing by 1.5 degrees
    const coords = [];
    for (let x = mininiumXBoundary; x <= maximumXBoundary; x += 1.5) {
        for (let y = minimumYBoundary; y <= maximumYBoundary; y += 1.5) {
            coords.push({ xMin: x, yMin: y, xMax: x + 1.5, yMax: y + 1.5 });
        }
    }
    // Round the coordinates to 6 decimal places
    coords.forEach(coord => {
        coord.xMin = parseFloat(coord.xMin.toFixed(6));
        coord.yMin = parseFloat(coord.yMin.toFixed(6));
        coord.xMax = parseFloat(coord.xMax.toFixed(6));
        coord.yMax = parseFloat(coord.yMax.toFixed(6));
    });
    return coords;
}
function generateScanQueue() {
    const countryScanUrls = {};
    for (const country in countryBoundaries) {
        const boundary = countryBoundaries[country];
        // Append the environment and hyphen if it exists, e.g "row-"
        const envPrefix = boundary.env ? `${boundary.env}-` : '';
        const coords = generateCoords(boundary.xMin, boundary.xMax, boundary.yMin, boundary.yMax);
        const scanUrls = coords.map(coord => {
            return `https://www.waze.com/${envPrefix}Descartes/app/v1/Features/Closures?bbox=${coord.xMin},${coord.yMin},${coord.xMax},${coord.yMax}`;
        });
        countryScanUrls[country] = scanUrls;
    }
    return countryScanUrls;
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
    await delay(2000); // delay 2 seconds between requests to keep Waze happy
  }

  const regionDuration = Date.now() - regionStart;
  const regionAvg = regionReqSum / total;

  console.log(
    `✅ Completed ${country} in ${regionDuration}ms ` +
    `(${(regionDuration/1000).toFixed(1)}s\\${((regionDuration/1000).toFixed(1))/60}mins), ` +
    `avg request time ${regionAvg.toFixed(1)}ms`
  );
}

const overallDuration = Date.now() - overallStart;
console.log(
  `🎉 All scans completed in ${overallDuration}ms ` +
  `(${(overallDuration/1000).toFixed(1)}s\\${((overallDuration/1000).toFixed(1))/60}mins)`
);