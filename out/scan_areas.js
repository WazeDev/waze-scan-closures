import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import fetch from 'node-fetch';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const cfgPath = path.resolve(__dirname, "..", "config.json");
let regionBoundaries;
let cfg;
try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    regionBoundaries = cfg.regionBoundaries;
}
catch (err) {
    if (err instanceof Error) {
        console.error('❌ Failed to load regionBoundaries from config.json:', err.message);
    }
    else {
        console.error('❌ Failed to load regionBoundaries from config.json:', err);
    }
    process.exit(1);
}
if (Object.keys(regionBoundaries).length === 0) {
    console.error('❌ regionBoundaries missing in config.json');
    process.exit(1);
}
const COOKIE_PATH = path.resolve(__dirname, "..", "cookies.json");
const SCAN_RESULTS_PATH = path.resolve(__dirname, "..", "scan_results.json");
const editorUrl = 'https://waze.com/editor';
function delay(time = 1000) {
    if (time <= 0) {
        return Promise.resolve();
    }
    return new Promise(function (resolve) {
        setTimeout(resolve, time);
    });
}
if (!fs.existsSync(COOKIE_PATH)) {
    fs.writeFileSync(COOKIE_PATH, JSON.stringify([], null, 2), 'utf8');
}
const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    args: ['--start-maximized']
});
const page = await browser.newPage();
const rawCookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
const validCookies = rawCookies.filter((c) => c.name && c.value);
if (validCookies.length) {
    await page.setCookie(...validCookies);
}
const cookieHeader = validCookies
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
await page.goto(editorUrl);
await page.waitForFunction(() => {
    if (typeof window.getWmeSdk !== 'function') {
        console.log('waiting for getWmeSdk…');
        return false;
    }
    const sdk = window.getWmeSdk({
        scriptId: 'wme-scan-closures',
        scriptName: 'Waze Scan Closures'
    });
    console.log('got sdk, loggedIn=', !!sdk.WmeState?.isLoggedIn());
    return sdk.State?.isLoggedIn() === true;
}, {
    polling: 1000,
    timeout: 0
});
console.log('✅ Logged in; continuing…');
const freshCookies = await page.cookies();
fs.writeFileSync(COOKIE_PATH, JSON.stringify(freshCookies, null, 2));
if (freshCookies.length > 0) {
    console.log('✅ Cookies are OK, closing browser.');
    await browser.close();
}
function generateCoords(xMin, xMax, yMin, yMax) {
    const coords = [];
    for (let x = xMin; x <= xMax; x += 1.5)
        for (let y = yMin; y <= yMax; y += 1.5)
            coords.push({
                xMin: +x.toFixed(6),
                yMin: +y.toFixed(6),
                xMax: +(x + 1.5).toFixed(6),
                yMax: +(y + 1.5).toFixed(6)
            });
    return coords;
}
function generateScanQueue() {
    const scanUrls = {};
    for (const region in regionBoundaries) {
        const b = regionBoundaries[region];
        scanUrls[region] = generateCoords(b.xMin, b.xMax, b.yMin, b.yMax)
            .map(c => (`https://www.waze.com/Descartes/app/v1/Features/Closures` +
            `?bbox=${String(c.xMin)},${String(c.yMin)},${String(c.xMax)},${String(c.yMax)}`));
    }
    return scanUrls;
}
let overallStart;
const scanQueue = generateScanQueue();
const scanResults = {};
cfg.loop ??= false;
if (cfg.loop) {
    console.log('🔄 Looping enabled, will repeat scans until stopped.');
    for (;;) {
        for (const country in scanQueue) {
            scanResults[country] = { closures: [] };
        }
        overallStart = Date.now();
        await performScan();
    }
}
else {
    console.log('🔄 Looping disabled, will perform a single scan.');
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
            let closuresData;
            try {
                const res = await fetch(url, {
                    headers: { Cookie: cookieHeader }
                });
                closuresData = await res.json();
            }
            catch (err) {
                if (err instanceof Error) {
                    console.error(`✖ fetch error (${String(idx + 1)}/${String(total)}):`, err.message);
                }
                else {
                    console.error(`✖ fetch error (${String(idx + 1)}/${String(total)}):`, err);
                }
                continue;
            }
            const reqDuration = Date.now() - reqStart;
            regionReqSum += reqDuration;
            console.log(` → request took ${String(reqDuration)}ms/${(reqDuration / 1000).toFixed(1)}s`);
            if (typeof closuresData === 'object' &&
                closuresData !== null &&
                'roadClosures' in closuresData &&
                typeof closuresData.roadClosures === 'object' &&
                closuresData.roadClosures !== null &&
                typeof closuresData.roadClosures === 'object' &&
                'objects' in closuresData.roadClosures &&
                Array.isArray(closuresData.roadClosures.objects)) {
                const roadClosures = closuresData.roadClosures;
                console.log(`→ got ${String(roadClosures.objects.length)} roadClosures ` +
                    `for ${country} (${String(idx + 1)}/${String(total)})`);
                const userClosures = roadClosures.objects.filter(c => !c.reason &&
                    c.startDate &&
                    c.endDate &&
                    (new Date(c.endDate).getTime() - new Date(c.startDate).getTime()) === 3600000 &&
                    c.createdBy !== 304740435 &&
                    c.closureStatus === 'ACTIVE');
                if (userClosures.length) {
                    scanResults[country].closures.push(...userClosures);
                    fs.writeFileSync(SCAN_RESULTS_PATH, JSON.stringify(scanResults, null, 2));
                }
            }
            else {
                console.warn('⚠ Unexpected closuresData format:', closuresData);
            }
            await delay(Math.max(0, 1000 - reqDuration));
        }
        const regionDuration = Date.now() - regionStart;
        const regionAvg = regionReqSum / total;
        console.log(`✅ Completed ${country} in ${String(regionDuration)}ms ` +
            `(${(regionDuration / 1000).toFixed(1)}s/${(regionDuration / 1000 / 60).toFixed(1)}mins), ` +
            `avg request time ${regionAvg.toFixed(1)}ms`);
    }
    const overallDuration = Date.now() - overallStart;
    console.log(`🎉 All scans completed in ${overallDuration.toString()}ms ` +
        `(${(overallDuration / 1000).toFixed(1)}s/${(overallDuration / 1000 / 60).toFixed(1)}mins)`);
}
