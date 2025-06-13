import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { fileURLToPath } from "url";

const COOKIE_PATH = "cookies.json";

// ← ensure cookies.json exists
if (!fs.existsSync(COOKIE_PATH)) {
  fs.writeFileSync(COOKIE_PATH, JSON.stringify([], null, 2), "utf8");
}

// emulate __dirname in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// load config.json
const configPath = path.resolve(__dirname, "config.json");
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (err) {
  console.error("❌ Failed to load config.json:", err.message);
  process.exit(1);
}

const roadTypes = {
  1: "Street",
  2: "Primary Street",
  3: "Freeway (Interstate / Other)",
  4: "Ramp",
  5: "Routable Pedestrian Path",
  6: "Major Highway",
  7: "Minor Highway",
  8: "Off-road / Not maintained",
  9: "Walkway",
  10: "Non-Routable Pedestrian Path",
  15: "Ferry",
  16: "Stairway",
  17: "Private Road",
  18: "Railroad",
  19: "Runway",
  20: "Parking Lot Road",
  22: "Passageway",
};
const editorUrl = "https://waze.com/editor";

function delay(time) {
  if (time <= 0) {
    return Promise.resolve(); // No delay needed
  }
  return new Promise(function (resolve) {
    setTimeout(resolve, time);
  });
}

// Launch the browser and open a new blank page and make it visible
const browser = await puppeteer.launch({
  headless: false, // Set to false to see the browser
  defaultViewport: null, // Use the default viewport size
  args: ["--start-maximized"], // Start the browser maximized
});
const page = await browser.newPage();

// Load and apply saved cookies to the page
const rawCookies = JSON.parse(fs.readFileSync(COOKIE_PATH, "utf8"));
const validCookies = rawCookies.filter((c) => c.name && c.value);
if (validCookies.length) {
  await page.setCookie(...validCookies);
}

// Build a Cookie header string for node‐fetch
const cookieHeader = validCookies.map((c) => `${c.name}=${c.value}`).join("; ");

// 1) Navigate and wait for SDK + login in one go
await page.goto(editorUrl);

await page.waitForFunction(
  () => {
    // guard against SDK not injected yet
    if (typeof window.getWmeSdk !== "function") {
      console.log("waiting for getWmeSdk…");
      return false;
    }
    const sdk = window.getWmeSdk({
      scriptId: "wme-scan-closures",
      scriptName: "Waze Scan Closures",
    });
    console.log("got sdk, loggedIn=", !!sdk?.WmeState?.isLoggedIn());
    return sdk?.State?.isLoggedIn() === true;
  },
  {
    polling: 1000, // check every second
    timeout: 0, // wait indefinitely
  }
);

console.log("✅ Logged in; continuing…");

// 2) Save fresh cookies
const freshCookies = await page.cookies();
fs.writeFileSync(COOKIE_PATH, JSON.stringify(freshCookies, null, 2));

// ← if cookies loaded/saved OK, close Puppeteer and exit
if (freshCookies.length > 0) {
  console.log("✅ Cookies are OK, closing browser.");
  await browser.close();
}

// now WEBHOOK_URL will be picked up from your .env
const SCAN_FILE = path.resolve(__dirname, "scan_results.json");
const TRACK_FILE = path.resolve(__dirname, "closure_tracking.json");
// Load or initialize tracking store (id -> { firstSeen, country })
let tracked = {};
if (fs.existsSync(TRACK_FILE)) {
  tracked = JSON.parse(fs.readFileSync(TRACK_FILE, "utf8"));
}

// Function to scan for new IDs
async function updateTracking() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(SCAN_FILE, "utf8"));
  } catch {
    console.error(`❌ Scan results file not found: ${SCAN_FILE}`);
    return;
  }
  const newClosures = [];

  for (const country in data) {
    for (const c of data[country].closures) {
      if (!tracked[c.id]) {
        tracked[c.id] = { firstSeen: new Date().toISOString(), country };
        newClosures.push({
          id: c.id,
          country,
          geometry: c.geometry, // pass full geometry
          segID: c.segID,
          userId: c.createdBy,
          timestamp: c.createdOn, // use createdOn from scan results
        });
      }
    }
  }

  if (newClosures.length) {
    fs.writeFileSync(TRACK_FILE, JSON.stringify(tracked, null, 2));
    console.log(`👀 Found ${newClosures.length} new closures!`);
    for (const closure of newClosures) {
      await notifyDiscord(closure);
    }
  } else {
    //console.log("👀 No new closures found.");
  }
}

// helper to notify Discord with an embed
async function notifyDiscord({
  id,
  country,
  geometry,
  segID,
  userId,
  trust = 0,
  timestamp,
  location = "Unknown",
  reason = "No Reason Selected",
  segmentType = "Unknown",
}) {
  const coords = geometry.coordinates;
  const [lonStart, latStart] = coords[0];
  const [lonEnd, latEnd] = coords[coords.length - 1];
  const region = cfg.regionBoundaries[country];

  const adjLon1 = +lonStart.toFixed(2) + 0.01;
  const adjLat1 = +latStart.toFixed(2) + 0.01;
  const adjLon2 = +lonEnd.toFixed(2) - 0.01;
  const adjLat2 = +latEnd.toFixed(2) - 0.01;

  const featuresUrl =
    `https://www.waze.com/Descartes/app/Features?` +
    `bbox=${adjLon1.toFixed(2)},${adjLat1.toFixed(2)},${adjLon2.toFixed(
      2
    )},${adjLat2.toFixed(2)}` +
    `&roadClosures=true&roadTypes=1,2,3,4,6,7`;
  let userName = userId;
  let streetName = "Unknown";
  // default city/state
  let cityName = "Unknown",
    stateName = "Unknown";
  let reqStart, reqDuration;
  try {
    console.log(`Fetching closure details ${id} (${country})…`);
    reqStart = Date.now();
    const res = await fetch(featuresUrl, {
      headers: { Cookie: cookieHeader },
      timeout: 30000,
    });
    const js = await res.json();
    reqDuration = Date.now() - reqStart;

    // get user & segment
    const usr = js.users.objects.find((u) => u.id === userId);
    const segment = js.segments.objects.find((s) => s.id === segID);
    if (usr?.userName)
      userName = `[${usr.userName} (${usr.rank})](https://www.waze.com/user/editor/${usr.userName})`;
    if (segment?.roadType) segmentType = roadTypes[segment.roadType];

    // ← LOOKUP STREET, CITY & STATE
    if (segment?.primaryStreetID) {
      const street = js.streets.objects.find(
        (st) => st.id === segment.primaryStreetID
      );
      if (street) {
        streetName = street.name || street.englishName || streetName;
        if (streetName !== null && streetName !== "") location = streetName;
        const city = js.cities.objects.find((c) => c.id === street.cityID);
        if (city) {
          cityName = city.name || city.englishName;
          if (cityName !== null && cityName !== "") location += `, ${cityName}`;
          const state = js.states.objects.find((st) => st.id === city.stateID);
          if (state) {
            stateName = state.name;
            if (stateName !== null && stateName !== "")
              location += `, ${stateName}`;
          }
        }
      }
    }
  } catch (e) {
    console.warn(`Lookup failed: ${e.message} ${featuresUrl}`);
  }
  // check location if any keywords from region.keywordsFilter are present
  if (location !== "Unknown") {
    let searchParams = `(road | improvements | closure | construction | project | work | detour | maintenance | closed ) AND (city | town | county | state)`;
    let searchQuery = encodeURIComponent(`${location} ${searchParams}`);
    if (region.keywordsFilter && region.keywordsFilter.length > 0) {
      const keywords = region.keywordsFilter.map((k) => k.toLowerCase());
      if (!keywords.some((k) => location.toLowerCase().includes(k))) {
        console.warn(`Closure is not in region "${location}", skipping…`);
        return; // exit early if no keywords match
      }
    }
    location = `[${location}](https://www.google.com/search?q=${searchQuery})`;
  }

  const envParam =
    country.toLowerCase() === "us" ? "usa" : country.toLowerCase();
  const editorUrl =
    `https://www.waze.com/en-US/editor?env=${envParam}` +
    `&lat=${latStart.toFixed(6)}` +
    `&lon=${lonStart.toFixed(6)}` +
    `&zoomLevel=17&segments=${segID}`;
  const liveMapUrl =
    `https://www.waze.com/live-map/directions?to=ll.` +
    `${latStart.toFixed(6)}%2C${lonStart.toFixed(6)}`;
  const appUrl = `https://www.waze.com/ul?ll=${latStart.toFixed(
    6
  )},${lonStart.toFixed(6)}`;
  const embed = {
    author: { name: "New App Closure (A➜B)" },
    color: 0xe74c3c,
    fields: [
      {
        name: "User",
        value: userName,
      },
      {
        name: "Reported at",
        value: `<t:${(timestamp / 1000).toFixed(0)}:F>`,
      },
      { name: "Segment Type", value: segmentType, inline: true },
      {
        name: "Location",
        value: location,
        inline: true,
      },
      {
        name: "Links",
        value:
          `[WME Link](${editorUrl}) | ` +
          `[Livemap Link](${liveMapUrl}) | ` +
          `[App Link](${appUrl})`,
      },
    ],
  };

  // 4) send to Discord
  try {
    console.log(`Sending a closure notification to Discord (${country})…`);
    let discordReq = await fetch(region.discordWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
    switch (discordReq.status) {
      case 204:
        console.log("Discord notification sent successfully.");
        break;
      case 429:
        console.error("Discord rate limit exceeded, retry later.");
      case 400:
        const errorText = await discordReq.text();
        console.error(`Embed data is invalid: ${errorText}`);
        return; // exit early on bad request
      default:
        const text = await discordReq.text();
        console.error(
          `Discord webhook request failed (${discordReq.status}): ${text}`
        );
    }
  } catch (e) {
    console.error("Discord webhook error:", e.message);
  }
  await delay(1000 - reqDuration); // avoid rate limiting
}

// Initial run & watch
console.log("👀 Watching for new closures…");
await updateTracking();
fs.watchFile(SCAN_FILE, { interval: 1000 }, (curr, prev) => {
  //console.log(`👀 Scan results has been updated, checking for new closures...`);
  if (curr.mtime > prev.mtime) updateTracking();
});
