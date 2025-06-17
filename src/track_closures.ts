import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { fileURLToPath } from "url";

// Extend the Window interface to include getWmeSdk
declare global {
  interface Window {
    getWmeSdk?: (...args: any[]) => any;
  }
}

const URL_HASH_FACTOR = (Math.sqrt(5) - 1) / 2;

const previewZoomLevel = 17;

const COOKIE_PATH = "cookies.json";

// ← ensure cookies.json exists
if (!fs.existsSync(COOKIE_PATH)) {
  fs.writeFileSync(COOKIE_PATH, JSON.stringify([], null, 2), "utf8");
}

// emulate __dirname in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// load config.json
const configPath = path.resolve(__dirname, "..", "config.json");
let cfg: { regionBoundaries: { [x: string]: any; }; };
try {
  cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (err) {
  if (err instanceof Error) {
    console.error("❌ Failed to load config.json:", err.message);
  } else {
    console.error("❌ Failed to load config.json:", err);
  }
  process.exit(1);
}

const tileServers = [
  "https://editor-tiles-${env}-1.waze.com/tiles/roads/${z}/${x}/${y}/tile.png",
  "https://editor-tiles-${env}-2.waze.com/tiles/roads/${z}/${x}/${y}/tile.png",
  "https://editor-tiles-${env}-3.waze.com/tiles/roads/${z}/${x}/${y}/tile.png",
  "https://editor-tiles-${env}-4.waze.com/tiles/roads/${z}/${x}/${y}/tile.png"
]

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

const roadTypeColors = {
  1: 0xD5D4C4, // Street
  2: 0xD5CF4D, // Primary Street
  3: 0xAF6ABA, // Freeway (Interstate / Other)
  4: 0x9EA99F, // Ramp
  5: 0x8e44ad, // Routable Pedestrian Path
  6: 0x3CA3B9, // Major Highway
  7: 0x5EA978, // Minor Highway
  8: 0x95a5a6, // Off-road / Not maintained
  9: 0x7f8c8d, // Walkway
  10: 0x34495e, // Non-Routable Pedestrian Path
  15: 0x16a085, // Ferry
  16: 0x27ae60, // Stairway
  17: 0xc0392b, // Private Road
  18: 0x8e44ad, // Railroad
  19: 0x2980b9, // Runway
  20: 0x979797, // Parking Lot Road
  22: 0x2ecc71, // Passageway
};
const editorUrl = "https://waze.com/editor";

function delay(time: number = 1000) {
  if (time <= 0) {
    return Promise.resolve(); // No delay needed
  }
  return new Promise(function (resolve) {
    setTimeout(resolve, time);
  });
}

function lon2tile(lon: number, zoom: number = previewZoomLevel) {
  return String(Math.floor(((lon + 180) / 360) * 2 ** zoom));
}

function lat2tile(lat: number, zoom: number = previewZoomLevel) {
  const rad = (lat * Math.PI) / 180;
  return String(Math.floor(
    ((1 -
      Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) /
      2) *
    2 ** zoom
  ));
}

function pickTileServer(x: string, y: string, t: typeof tileServers = tileServers, r: { env: string; }) {
  let n = 1;
  let e = `${x}${y}`;
  for (let i = 0; i < e.length; i++) {
    n *= e.charCodeAt(i) * URL_HASH_FACTOR;
    n -= Math.floor(n);
  }
  const idx = Math.floor(n * t.length);
  let tileServer = t[idx];
  let env;
  if (r.env === "row") {
    env = "row";
  } else if (r.env === "il") {
    env = "il";
  } else {
    env = "na";
  }
  let url = tileServer.replace("${x}", x).replace("${y}", y).replace("${z}", previewZoomLevel.toString()).replace("${env}", env);
  return url;
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
const validCookies = rawCookies.filter((c: { name: any; value: any; }) => c.name && c.value);
if (validCookies.length) {
  await page.setCookie(...validCookies);
}

// Build a Cookie header string for node‐fetch
const cookieHeader = validCookies.map((c: { name: any; value: any; }) => `${c.name}=${c.value}`).join("; ");

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
const SCAN_FILE = path.resolve(__dirname, "..", "scan_results.json");
const TRACK_FILE = path.resolve(__dirname, "..", "closure_tracking.json");
// Load or initialize tracking store (id -> { firstSeen, country })
let tracked: { [id: string]: { firstSeen: string; country: string } } = {};
if (fs.existsSync(TRACK_FILE)) {
  tracked = JSON.parse(fs.readFileSync(TRACK_FILE, "utf8"));
}

// ← Add this right after config.json load
const CACHE_PATH = path.resolve(__dirname, "..", "feature_cache.json");
// include countries cache
let featureCache: { users: any; segments: any; streets: any; cities: any; states: any; countries: any; };
if (fs.existsSync(CACHE_PATH)) {
  featureCache = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
} else {
  featureCache = { users: {}, segments: {}, streets: {}, cities: {}, states: {}, countries: {} };
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
          timestamp: c.createdOn,
          forward: c.forward // use createdOn from scan results
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
  forward,
  location = "Unknown",
  reason = "No Reason Selected",
  segmentType = "Unknown",
}: {
  id: string;
  country: string;
  geometry: { coordinates: [number, number][] };
  segID: string;
  userId: string;
  trust?: number;
  timestamp: number;
  forward: boolean;
  location?: string;
  reason?: string;
  segmentType?: string;
}) {
  const coords = geometry.coordinates;
  // Average coordinates to get a center point
  const avgLon = coords.reduce((sum, coord) => sum + coord[0], 0) / coords.length;
  const avgLat = coords.reduce((sum, coord) => sum + coord[1], 0) / coords.length;
  const [lonStart, latStart] = coords[0];
  const [lonEnd, latEnd] = coords[coords.length - 1];
  const region = cfg.regionBoundaries[country];

  const adjLon1 = +avgLon.toFixed(3) + 0.005;
  const adjLat1 = +avgLat.toFixed(3) + 0.005;
  const adjLon2 = +avgLon.toFixed(3) - 0.005;
  const adjLat2 = +avgLat.toFixed(3) - 0.005;

  let envPrefix: string;
  if (region.env === 'row') {
    envPrefix = "row-";
  } else if (region.env === 'il') {
    envPrefix = "il-";
  } else {
    envPrefix = "";
  }

  // Get preview tile URL
  const tileX = lon2tile(avgLon, previewZoomLevel);
  const tileY = lat2tile(avgLat, previewZoomLevel);
  const tileUrl = pickTileServer(tileX, tileY, tileServers, region) // pick a tile server based on country

  const featuresUrl =
    `https://www.waze.com/${envPrefix}Descartes/app/Features?` +
    `bbox=${adjLon1.toFixed(3)},${adjLat1.toFixed(3)},${adjLon2.toFixed(
      3
    )},${adjLat2.toFixed(3)}` +
    `&roadClosures=true&roadTypes=1,2,3,4,6,7,20`;
  // first check cache
  const uc = featureCache.users[userId];
  let sc = featureCache.segments[segID];
  let streetID = sc?.primaryStreetID;
  const stc = streetID && featureCache.streets[streetID];
  const cc = stc && featureCache.cities[stc.cityID];
  const stt = cc && featureCache.states[cc.stateID];
  // only lookup country if city has a valid countryID
  const ctry = cc?.countryID != null
    ? featureCache.countries[cc.countryID]
    : undefined;

  let userName = uc ? `[${uc.userName} (${uc.rank})](https://www.waze.com/user/editor/${uc.userName})` : userId;
  segmentType = sc ? roadTypes[sc.roadType as keyof typeof roadTypes] : "Unknown";

  if (stc) {
    const names = [stc.name || stc.englishName];
    if (cc)   names.push(cc.name  || cc.englishName);
    if (stt)  names.push(stt.name);
    if (ctry?.name)  names.push(ctry.name);    // ← here is where country should be added
    location = names.filter(Boolean).join(", ");
  }

  // if anything missing in cache, do one fetch and populate cache
  if (!uc || !sc || !stc || !cc || !stt) {
    console.log(`Fetching closure details ${id} (${country}) ${featuresUrl}`);
    const reqStart = Date.now();
    const res = await fetch(featuresUrl, {
      headers: { Cookie: cookieHeader }
    });
    if (res.status === 403) {
      console.error(`❌ Received 403 Forbidden from Waze features API for ${featuresUrl}, exiting.`);
      process.exit(1);
    }
    const js: any = await res.json();
    const reqDuration = Date.now() - reqStart;
    await delay(1000 - reqDuration);


    // ── BULK POPULATE CACHE ───────────────────────────────────────────────
    js.users.objects.forEach((u: { id: string | number; userName: any; rank: any; }) => {
      featureCache.users[u.id] = { userName: u.userName, rank: u.rank };
    });
    js.segments.objects.forEach((s: { id: string | number; roadType: any; primaryStreetID: any; }) => {
      featureCache.segments[s.id] = {
        roadType: s.roadType,
        primaryStreetID: s.primaryStreetID,
      };
    });
    js.streets.objects.forEach((st: { id: string | number; name: any; englishName: any; cityID: any; }) => {
      featureCache.streets[st.id] = {
        name: st.name || st.englishName,
        cityID: st.cityID,
      };
    });
    js.cities.objects.forEach((c: { id: string | number; name: any; englishName: any; stateID: any; countryID?: number; }) => {
      featureCache.cities[c.id] = {
        name: c.name || c.englishName,
        stateID: c.stateID,
        countryID: c.countryID,
      };
    });
    js.states.objects.forEach((s: { id: string | number; name: any; }) => {
      featureCache.states[s.id] = { name: s.name };
    });
    // cache countries
    if (js.countries?.objects) {
      js.countries.objects.forEach((c: { id: number; name: string; abbr?: string; env?: string }) => {
        featureCache.countries[c.id] = { name: c.name, abbr: c.abbr, env: c.env };
      });
    }

    // persist entire cache
    fs.writeFileSync(CACHE_PATH, JSON.stringify(featureCache, null, 2));

    // ── REBUILD LOCAL SHORTCUTS ──────────────────────────────────────────
    // re-derive uc, sc, stc, cc, stt, userName, segmentType, location using updated featureCache...
    const uc2 = featureCache.users[userId];
    const sc2 = featureCache.segments[segID];
    const stc2 = sc2 && featureCache.streets[sc2.primaryStreetID];
    const cc2 = stc2 && featureCache.cities[stc2.cityID];
    const stt2 = cc2 && featureCache.states[cc2.stateID];
    const ctry2 = cc2 && featureCache.countries[cc2.countryID];

    // overwrite your variables for userName, segmentType, location…
    userName = uc2 ? `[${uc2.userName} (${uc2.rank})](https://www.waze.com/user/editor/${uc2.userName})` : userName;
    segmentType = sc2 ? roadTypes[sc2.roadType as keyof typeof roadTypes] : segmentType;
    if (stc2) {
      const parts: string[] = [];
      if (stc2.name) parts.push(stc2.name);
      if (cc2?.name) parts.push(cc2.name);
      if (stt2?.name) parts.push(stt2.name);
      if (ctry2?.name) parts.push(ctry2.name);
      location = parts.join(", ");
    }

    // ← now that we have a fresh segment, overwrite sc so embed.color works
    sc = sc2;
  }

  // check location if any keywords from region.locationKeywordsFilter are present
  if (location !== "Unknown") {
    const searchParams = `(road | improvements | closure | construction | project | work | detour | maintenance | closed ) AND (city | town | county | state)`;
    const searchQuery = encodeURIComponent(`${location} ${searchParams}`);
    if (region.locationKeywordsFilter && region.locationKeywordsFilter.length > 0) {
      const keywords = region.locationKeywordsFilter.map((k: string) => k.toLowerCase());
      if (!keywords.some((k: string) => location.toLowerCase().includes(k))) {
        console.warn(`Closure not in current region, trying other regions for "${location}"…`);
        // try other regions
        const other = Object.keys(cfg.regionBoundaries).find(r => {
          if (r === country) return false;
          const f = cfg.regionBoundaries[r].locationKeywordsFilter;
          return f?.some((k: string) => location.toLowerCase().includes(k.toLowerCase()));
        });
        if (other) {
          console.log(`Reassigning closure ${id} to region ${other}`);
          tracked[id].country = other;
          fs.writeFileSync(TRACK_FILE, JSON.stringify(tracked, null, 2));
          // notify for new region context
          await notifyDiscord({ id, country: other, geometry, segID, userId, trust, timestamp, forward });
          return;
        } else {
          console.warn(`Closure does not match any region, ignoring...`);
          fs.writeFileSync(TRACK_FILE, JSON.stringify(tracked, null, 2));
          return;
        }
      }
    }
    location = `[${location}](https://www.google.com/search?q=${searchQuery}&udm=50)`;
  }

  const editorUrl =
    `https://www.waze.com/en-US/editor?env=${region.env}` +
    `&lat=${avgLat.toFixed(6)}` +
    `&lon=${avgLon.toFixed(6)}` +
    `&zoomLevel=17&segments=${segID}`;
  const liveMapUrl =
    `https://www.waze.com/live-map/directions?to=ll.` +
    `${avgLat.toFixed(6)}%2C${avgLon.toFixed(6)}`;
  const appUrl = `https://www.waze.com/ul?ll=${avgLat.toFixed(
    6
  )},${avgLon.toFixed(6)}`;
  let dotMap;
  if (region.departmentOfTransporationUrl) {
    // if region has a DoT URL, append it to the appUrl
    // Check if the URL contains {lat} and {lon} twice, if so, use bounding box, if not, use start point
    if (
      (region.departmentOfTransporationUrl.match(/{lat}/g) || []).length === 2 &&
      (region.departmentOfTransporationUrl.match(/{lon}/g) || []).length === 2
    ) {
      dotMap = region.departmentOfTransporationUrl.replace("{lat}", adjLat1.toFixed(6)).replace("{lat}", adjLat2.toFixed(6)).replace("{lon}", adjLon1.toFixed(6)).replace("{lon}", adjLon2.toFixed(6));
    } else {
      dotMap = region.departmentOfTransporationUrl.replace(
        "{lat}",
        avgLat.toFixed(6)
      ).replace("{lon}", avgLon.toFixed(6));
    }
  }
  let direction;
  if (forward === true) {
    direction = "A➜B";
  } else {
    direction = "B➜A";
  }
  const embed = {
    author: { name: `New App Closure (${direction})` },
    // use the cached segment (sc) instead of undefined `segment`
    color: sc
      ? (roadTypeColors[sc.roadType as keyof typeof roadTypeColors] || 0xe74c3c)
      : 0xe74c3c,
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
    thumbnail: {
		url: tileUrl,
	},
  };

  if (region.departmentOfTransporationUrl) {
    embed.fields[4].value += ` | [Department of Transportation Map Link](${dotMap})`;
  }

  // 4) send to webhooks
  const webhooks = region.webhooks || [];
  for (const hook of webhooks) {
    if (hook.type === "discord") {
      console.log(`Sending a closure notification to Discord (${country})…`);
      const res = await fetch(hook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      });
      if (res.status === 204) {
        console.log("Discord notification sent successfully.");
      } else {
        const text = await res.text();
        console.error(`Discord webhook request failed (${res.status}): ${text}`);
      }
    } else if (hook.type === "slack") {
      console.log(`Sending a closure notification to Slack (${country})…`);
      // build Slack-compatible username link
      const slackUserName = uc
        ? `<https://www.waze.com/user/editor/${uc.userName}|${uc.userName} (${uc.rank})>`
        : userId;
      // convert location Markdown link [text](url) to Slack format <url|text>
      const slackLocation = location.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');
       const slackBlocks = [
         {
           type: "section",
           text: {
             type: "mrkdwn",
             text: `*New App Closure (${direction})*\n*User*\n${slackUserName}`
           },
           accessory: {
             type: "image",
             image_url: tileUrl,
             alt_text: "Tile preview"
           }
         },
         {
           type: "section",
           block_id: "reportedAt",
           fields: [
             {
               type: "mrkdwn",
               text: `*Reported At*\n<t:${(timestamp/1000).toFixed(0)}:F>`
             }
           ]
         },
         {
           type: "section",
           block_id: "segmentLocation",
           fields: [
             {
               type: "mrkdwn",
               text: `*Segment Type*\n${segmentType}`
             },
             {
               type: "mrkdwn",
               text: `*Location*\n${slackLocation}`
             }
           ]
         },
         {
           type: "section",
           block_id: "links",
           fields: [
             {
               type: "mrkdwn",
               text: `*Links*\n• <${editorUrl}|WME Link> | <${liveMapUrl}|Livemap Link> | <${appUrl}|App Link>${region.departmentOfTransporationUrl ? ` | <${dotMap}|DOT Map>` : ""}`
             }
           ]
         }
       ];
      const slackRes = await fetch(hook.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blocks: slackBlocks }),
      });
      if (slackRes.ok) {
        console.log("Slack notification sent successfully.");
      } else {
        const text = await slackRes.text();
        console.error(`Slack webhook request failed (${slackRes.status}): ${text}`);
      }
    } else {
      console.warn(`Unknown webhook type: ${hook.type}`);
    }
  }
  return;
}

// Initial run & watch
console.log("👀 Watching for new closures…");
await updateTracking();
fs.watchFile(SCAN_FILE, { interval: 1000 }, (curr, prev) => {
  //console.log(`👀 Scan results has been updated, checking for new closures...`);
  if (curr.mtime > prev.mtime) updateTracking();
});
