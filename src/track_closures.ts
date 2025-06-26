import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import http from "http";

const URL_HASH_FACTOR = (Math.sqrt(5) - 1) / 2;

const previewZoomLevel = 17;

// emulate __dirname in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// load config.json
const configPath = path.resolve(__dirname, "..", "config.json");
let cfg: { regionBoundaries: { [x: string]: any; }, loop?: boolean; whitelist?: string[] | Record<string, boolean>; }
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

// ← reload config.json every 15 seconds
fs.watchFile(configPath, { interval: 15000 }, () => {
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    console.log("🔄 config.json reloaded");
  } catch (err) {
    console.error("❌ Failed to reload config.json:", err);
  }
});

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


const TRACK_FILE = path.resolve(__dirname, "..", "closure_tracking.json");
// Load or initialize tracking store (id -> { firstSeen, country })
let tracked: { [id: string]: { firstSeen: string; country: string } } = {};
if (fs.existsSync(TRACK_FILE)) {
  tracked = JSON.parse(fs.readFileSync(TRACK_FILE, "utf8"));
}

// Modify signature to accept parsed JSON
async function updateTracking(data: any) {
  const newClosures: any[] = [];
  const arr = data.closures || [];
  const userName = data.userName || "Unknown User";
  for (const c of arr) {
    const country = c.location.split(",").pop()!.trim();
    if (!tracked[c.id]) {
      tracked[c.id] = { firstSeen: new Date().toISOString(), country };
      newClosures.push({
        id: c.id,
        segID: String(c.segmentId),
        userName: c.createdBy,
        timestamp: c.createdOn,
        direction: c.direction,
        lat: c.lat,
        lon: c.lon,
        location: c.location,
        roadType: c.roadType,
        roadTypeEnum: c.roadTypeEnum,
      });
    }
  }
  if (newClosures.length) {
    fs.writeFileSync(TRACK_FILE, JSON.stringify(tracked, null, 2));
    console.log(`👀 ${userName} found ${newClosures.length} new closures!`);
    for (const closure of newClosures) {
      await delay(1000); // delay to avoid rate limiting
      await notifyDiscord(closure);
    }
  }
}

// helper to notify Discord with an embed
async function notifyDiscord({
  id,
  segID,
  userName,
  timestamp,
  direction,
  lat,
  lon,
  location,
  roadType,
  roadTypeEnum,
}: {
  id: string;
  segID: string;
  userName: string;
  timestamp: number;
  direction: boolean;
  lat: number;
  lon: number;
  location: string;
  roadType: string;
  roadTypeEnum: keyof typeof roadTypes;
}) {
  let slackLocation;
  let regionCfg;
  // check location if any keywords from region.locationKeywordsFilter are present
  const searchParams = `(road | improvements | closure | construction | project | work | detour | maintenance | closed ) AND (city | town | county | state)`;
  const searchQuery = encodeURIComponent(`${location} ${searchParams}`);
  const region = Object.keys(cfg.regionBoundaries).find(r => {
    const f = cfg.regionBoundaries[r].locationKeywordsFilter;
    return f?.some((k: string) => location.toLowerCase().includes(k.toLowerCase()));
  });
  if (region) {
    console.log(`Assigning closure ${id} to region ${region}`);
    tracked[id].country = region;
    fs.writeFileSync(TRACK_FILE, JSON.stringify(tracked, null, 2));
    regionCfg = cfg.regionBoundaries[region];
  } else {
    console.warn(`Closure does not match any region, ignoring...`);
    return;
  }

  slackLocation = `<https://www.google.com/search?q=${searchQuery}&udm=50|${location}>`;
  location = `[${location}](https://www.google.com/search?q=${searchQuery}&udm=50)`;
  // Average coordinates to get a center point
  const adjLon1 = +lon.toFixed(3) + 0.005;
  const adjLat1 = +lat.toFixed(3) + 0.005;
  const adjLon2 = +lon.toFixed(3) - 0.005;
  const adjLat2 = +lat.toFixed(3) - 0.005;

  let envPrefix: string;
  if (regionCfg.env === 'row') {
    envPrefix = "row-";
  } else if (regionCfg.env === 'il') {
    envPrefix = "il-";
  } else {
    envPrefix = "";
  }

  // Get preview tile URL
  const tileX = lon2tile(lon, previewZoomLevel);
  const tileY = lat2tile(lat, previewZoomLevel);
  const tileUrl = pickTileServer(tileX, tileY, tileServers, regionCfg) // pick a tile server based on country

  userName = `[${userName}](https://www.waze.com/user/editor/${userName})`;
  let slackUsername = `<https://www.waze.com/user/editor/${userName}|${userName}>`;
  const editorUrl =
    `https://www.waze.com/en-US/editor?env=${regionCfg.env}` +
    `&lat=${lat.toFixed(6)}` +
    `&lon=${lon.toFixed(6)}` +
    `&zoomLevel=17&segments=${segID}`;
  const liveMapUrl =
    `https://www.waze.com/live-map/directions?to=ll.` +
    `${lat.toFixed(6)}%2C${lon.toFixed(6)}`;
  const appUrl = `https://www.waze.com/ul?ll=${lat.toFixed(
    6
  )},${lon.toFixed(6)}`;
  let dotMap;
  if (regionCfg.departmentOfTransporationUrl) {
    // if region has a DoT URL, append it to the appUrl
    // Check if the URL contains {lat} and {lon} twice, if so, use bounding box, if not, use start point
    if (
      (regionCfg.departmentOfTransporationUrl.match(/{lat}/g) || []).length === 2 &&
      (regionCfg.departmentOfTransporationUrl.match(/{lon}/g) || []).length === 2
    ) {
      dotMap = regionCfg.departmentOfTransporationUrl.replace("{lat}", adjLat1.toFixed(6)).replace("{lat}", adjLat2.toFixed(6)).replace("{lon}", adjLon1.toFixed(6)).replace("{lon}", adjLon2.toFixed(6));
    } else {
      dotMap = regionCfg.departmentOfTransporationUrl.replace(
        "{lat}",
        lat.toFixed(6)
      ).replace("{lon}", lon.toFixed(6));
    }
  }
  const embed = {
    author: { name: `New App Closure (${direction})` },
    // use the cached segment (sc) instead of undefined `segment`
    color: roadTypeColors[roadTypeEnum] || 0x3498db, // default to blue if no color found
    fields: [
      {
        name: "User",
        value: userName,
      },
      {
        name: "Reported at",
        value: `<t:${(timestamp / 1000).toFixed(0)}:F>`,
      },
      { name: "Segment Type", value: roadType, inline: true },
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

  if (regionCfg.departmentOfTransporationUrl) {
    embed.fields[4].value += ` | [Department of Transportation Map Link](${dotMap})`;
  }

  // 4) send to webhooks
  const webhooks = regionCfg.webhooks || [];
  for (const hook of webhooks) {
    if (hook.type === "discord") {
      console.log(`Sending a closure notification to Discord (${region})…`);
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
      console.log(`Sending a closure notification to Slack (${region})…`);
      const slackBlocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*New App Closure (${direction})*\n*User*\n${slackUsername}`
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
              text: `*Reported At*\n<!date^${(timestamp / 1000).toFixed(0)}^{date_long} {time}|${new Date(timestamp).toLocaleString()}>`
            }
          ]
        },
        {
          type: "section",
          block_id: "segmentLocation",
          fields: [
            {
              type: "mrkdwn",
              text: `*Segment Type*\n${roadType}`
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
              text: `*Links*\n• <${editorUrl}|WME Link> | <${liveMapUrl}|Livemap Link> | <${appUrl}|App Link>${regionCfg.departmentOfTransporationUrl ? ` | <${dotMap}|Department of Transportation Map Link>` : ""}`
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

// ── Replace initial run & file-watch with HTTP server ───────────────────
const PORT = 80;
const server = http.createServer((req, res) => {
  const url = new URL(req.url || "", `http://localhost`);
  if (url.pathname === "/uploadClosures") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      if (res.headersSent) return; // Prevent duplicate responses
      
      try {
        if (!body.trim()) {
          console.warn("Received empty request body for uploadClosures");
          res.statusCode = 400;
          res.end("Empty request body");
          return;
        }
        const data = JSON.parse(body);
        const user = data.userName;
        if (user === "undefined" || user === "null") {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }
        // normalize old-array or object whitelist
        let mapping: Record<string, boolean> = {};
        if (Array.isArray(cfg.whitelist)) {
          cfg.whitelist.forEach(u => mapping[u] = true);
        } else {
          mapping = { ...(cfg.whitelist || {}) };
        }
        // add unknown user as false
        if (!(user in mapping)) {
          mapping[user] = false;
          console.log(`➕ Added new user to whitelist: '${user}'`);
          cfg.whitelist = mapping;
          fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }
        // block if explicitly false
        if (!mapping[user]) {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }
        // allowed → process
        await updateTracking(data);
        res.statusCode = 200;
        res.end("Upload complete");
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 400;
          res.end("Error");
        }
        console.error("❌ Failed to process upload:", err);
      }
    });
  } else if (url.pathname === "/trackedClosures") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      if (res.headersSent) return; // Prevent duplicate responses
      
      try {
        if (!body.trim()) {
          console.warn("Received empty request body for trackedClosures");
          res.statusCode = 400;
          res.end("Empty request body");
          return;
        }
        const data = JSON.parse(body);
        const user = data.userName;
        if (user === "undefined" || user === "null") {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }
        // normalize old-array or object whitelist
        let mapping: Record<string, boolean> = {};
        if (Array.isArray(cfg.whitelist)) {
          cfg.whitelist.forEach(u => mapping[u] = true);
        } else {
          mapping = { ...(cfg.whitelist || {}) };
        }
        // add unknown user as false
        if (!(user in mapping)) {
          mapping[user] = false;
          console.log(`➕ Added new user to whitelist: '${user}' = false`);
          cfg.whitelist = mapping;
          fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }
        // block if explicitly false
        if (!mapping[user]) {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }
        // allowed → return tracked list
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(Object.keys(tracked), null, 2));
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 400;
          res.end("Error");
        }
        console.error("❌ Failed to process trackedClosures request:", err);
      }
    });
  } else {
    // Handle unknown endpoints
    if (!res.headersSent) {
      res.statusCode = 404;
      res.end("Not Found");
    }
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Server listening on ${PORT}…`);
});
