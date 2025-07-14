import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import http from "http";
import { log } from "console";

const URL_HASH_FACTOR = (Math.sqrt(5) - 1) / 2;

const previewZoomLevel = 17;

// emulate __dirname in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── add timestamped log helpers ─────────────────────────────────────────
function logInfo(msg: string) {
  console.log(`[${new Date().toISOString()}] INFO: ${msg}`);
}
function logError(msg: string) {
  console.error(`[${new Date().toISOString()}] ERROR: ${msg}`);
}
function logWarning(msg: string) {
  console.warn(`[${new Date().toISOString()}] WARNING: ${msg}`);
}

// load config.json
const configPath = path.resolve(__dirname, "..", "config.json");
let cfg: { regionBoundaries: { [x: string]: any; }, loop?: boolean; whitelist?: string[] | Record<string, boolean>; }
try {
  cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
} catch (err) {
  if (err instanceof Error) {
    logError(`❌ Failed to load config.json: ${err.message}`);
  } else {
    logError(`❌ Failed to load config.json: ${err}`);
  }
  process.exit(1);
}
logInfo("🔧 Loaded config.json");

// ← reload config.json every 15 seconds
fs.watchFile(configPath, { interval: 15000 }, () => {
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    logInfo("🔄 config.json reloaded");
  } catch (err) {
    logError(`❌ Failed to reload config.json:) ${err instanceof Error ? err.message : err}`);
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
  17: 0xA8A45F, // Private Road
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
  const now = Date.now();
  
  for (const c of arr) {
    const country = c.location.split(",").pop()!.trim();
    
    // Find the region first to get its maxClosureAgeDays setting
    const region = Object.keys(cfg.regionBoundaries).find(r => {
      const f = cfg.regionBoundaries[r].locationKeywordsFilter;
      return f?.some((k: string) => c.location.toLowerCase().includes(k.toLowerCase()));
    });
    
    if (!region) {
      // Skip closures that don't match any configured region
      continue;
    }
    
    const regionCfg = cfg.regionBoundaries[region];
    // Get max age configuration per region (default to 3 days if not specified)
    const maxClosureAgeDays = regionCfg.maxClosureAgeDays ?? 3;
    
    // Check closure age based on region configuration
    if (maxClosureAgeDays === 0) {
      // Only report active closures (startDate <= now <= endDate)
      const startTime = new Date(c.createdOn || c.timestamp).getTime();
      const endTime = c.endDate ? new Date(c.endDate).getTime() : now + (24 * 60 * 60 * 1000); // Default to 24h if no end date
      
      if (now < startTime || now > endTime) {
        continue; // Skip inactive closures
      }
    } else if (maxClosureAgeDays > 0) {
      // Check if closure is within the specified age limit
      const closureTime = new Date(c.createdOn || c.timestamp).getTime();
      const maxAge = maxClosureAgeDays * 24 * 60 * 60 * 1000; // Convert days to milliseconds
      
      if (now - closureTime > maxAge) {
        continue; // Skip closures older than the limit
      }
    }
    // If maxClosureAgeDays is negative, report all closures (no age limit)
    
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
        duration: c.duration || "Unknown", // use provided duration or default to "Unknown"
        closureStatus: c.status || "New" // use provided status or default to "Unknown"
      });
    }
  }
  if (newClosures.length) {
    logInfo(`👀 ${userName} found ${newClosures.length} new closures!`);
    
    // Group closures by segment ID and region to avoid spamming webhooks (if enabled per region)
    const groupedClosures = new Map<string, any[]>();
    const ungroupedClosures: any[] = [];
    
    for (const closure of newClosures) {
      const segID = closure.segID;
      
      // Find the region for this closure to check grouping setting
      const region = Object.keys(cfg.regionBoundaries).find(r => {
        const f = cfg.regionBoundaries[r].locationKeywordsFilter;
        return f?.some((k: string) => closure.location.toLowerCase().includes(k.toLowerCase()));
      });
      
      const regionCfg = region ? cfg.regionBoundaries[region] : null;
      const shouldGroup = regionCfg?.groupClosuresBySegment ?? true; // Default to true if not specified
      
      if (shouldGroup) {
        const groupKey = `${segID}-${region}`;
        if (!groupedClosures.has(groupKey)) {
          groupedClosures.set(groupKey, []);
        }
        groupedClosures.get(groupKey)!.push(closure);
      } else {
        ungroupedClosures.push(closure);
      }
    }
    
    // Send notifications for ungrouped closures (regions that have grouping disabled)
    for (const closure of ungroupedClosures) {
      await delay(1000); // delay to avoid rate limiting
      await notifyDiscord(closure);
    }
    
    // Send notifications for each group
    for (const [groupKey, closures] of groupedClosures) {
      await delay(1000); // delay to avoid rate limiting
      if (closures.length === 1) {
        // Single closure - use existing notification
        await notifyDiscord(closures[0]);
      } else {
        // Multiple closures on same segment - use grouped notification
        await notifyDiscordGrouped(closures);
      }
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
  duration = "Unknown",
  closureStatus = "New" // default to "New" if not provided
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
  duration?: string; // optional duration parameter
  closureStatus?: string; // optional status parameter
}) {
  let slackLocation;
  let regionCfg;
  // check location if any keywords from region.locationKeywordsFilter are present
  const searchParams = `(road | improvements | closure | construction | project | work | detour | maintenance | closed ) AND (city | town | county | state) -realtor -zillow`;
  const searchQuery = encodeURIComponent(`(${location} | ${lat},${lon}) ${searchParams}`);
  const region = Object.keys(cfg.regionBoundaries).find(r => {
    const f = cfg.regionBoundaries[r].locationKeywordsFilter;
    return f?.some((k: string) => location.toLowerCase().includes(k.toLowerCase()));
  });
  if (region) {
    logInfo(`Assigning closure ${id} to region ${region}`);
    tracked[id].country = region;
    fs.writeFileSync(TRACK_FILE, JSON.stringify(tracked, null, 2));
    regionCfg = cfg.regionBoundaries[region];
  } else {
    delete tracked[id];
    logError(`Closure is in a region that is not configured: ${location}`);
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

  if (closureStatus.startsWith("Finished")) {
    closureStatus = "Past";
  }

  // Get preview tile URL
  const tileX = lon2tile(lon, previewZoomLevel);
  const tileY = lat2tile(lat, previewZoomLevel);
  const tileUrl = pickTileServer(tileX, tileY, tileServers, regionCfg) // pick a tile server based on country
  
  let slackUsername = `<https://www.waze.com/user/editor/${userName}|${userName}>`;
  userName = `[${userName}](https://www.waze.com/user/editor/${userName})`;
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
    author: { name: `${closureStatus} App Closure (${direction})` },
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
      { name: "Duration", value: duration },
      { name: "Segment Type", value: roadType, inline: true },
      {
        name: "Location",
        value: location,
        inline: true,
      },
      {
        name: "Links",
        value:
          `[WME](${editorUrl}) | ` +
          `[LiveMap](${liveMapUrl}) | ` +
          `[App](${appUrl})`,
      },
    ],
    thumbnail: {
      url: tileUrl,
    },
  };

  if (regionCfg.departmentOfTransporationUrl) {
    // use custom name if provided, else default
    const linkName =
      regionCfg.departmentOfTransporationName ??
      "DOT";
    const lastField = embed.fields[embed.fields.length - 1];
    (lastField as { value: string }).value +=
      ` | [${linkName}](${dotMap})`;
  }

  // 4) send to webhooks
  const webhooks = regionCfg.webhooks || [];
  for (const hook of webhooks) {
    if (hook.type === "discord") {
      logInfo(`Sending a closure notification to Discord (${region})…`);
      const maxRetries = 3;
      let attempt = 0;
      let success = false;
      while (attempt < maxRetries && !success) {
        attempt++;
        const res = await fetch(hook.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds: [embed] }),
        });
        if (res.status === 204) {
          logInfo("Discord notification sent successfully.");
          success = true;
        } else if (res.status === 429) {
          const retryData: any = await res.json().catch(() => null);
          const retryAfter = (retryData && typeof retryData.retry_after === 'number') ? retryData.retry_after : 1;
          logWarning(`Discord rate limited; retrying after ${retryAfter}s (attempt ${attempt}/${maxRetries})`);
          await delay(retryAfter * 1000);
        } else {
          const text = await res.text();
          logError(`Discord webhook request failed (${res.status}): ${text}`);
          break;
        }
      }
      if (!success) {
        logError(`Failed to send Discord notification after ${maxRetries} attempts.`);
      }
    } else if (hook.type === "slack") {
      logInfo(`Sending a closure notification to Slack (${region})…`);
      // use custom DOT name or default
      const dotLabel = regionCfg.departmentOfTransporationName
        ?? "DOT";
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
              text: `*Reported At*\n<!date^${(timestamp / 1000).toFixed(0)}^{date_long} {time}|${new Date(timestamp).toLocaleString()}>\n*Duration*\n${duration}`
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
              text: `*Links*\n• <${editorUrl}|WME> | <${liveMapUrl}|LiveMap> | <${appUrl}|App>` +
                `${regionCfg.departmentOfTransporationUrl ? ` | <${dotMap}|${dotLabel}>` : ""}`
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
        logInfo("Slack notification sent successfully.");
      } else {
        const text = await slackRes.text();
        logError(`Slack webhook request failed (${slackRes.status}): ${text}`);
      }
    } else {
      logWarning(`Unknown webhook type: ${hook.type}`);
    }
  }
  return;
}

// helper to notify Discord with grouped closures on the same segment
async function notifyDiscordGrouped(closures: any[]) {
  if (closures.length === 0) return;
  
  // Use the first closure as the base for common information
  const firstClosure = closures[0];
  const {
    segID,
    lat,
    lon,
    location,
    roadType,
    roadTypeEnum
  } = firstClosure;
  
  let regionCfg;
  const searchParams = `(road | improvements | closure | construction | project | work | detour | maintenance | closed ) AND (city | town | county | state) -realtor -zillow`;
  const searchQuery = encodeURIComponent(`(${location} | ${lat},${lon}) ${searchParams}`);
  const region = Object.keys(cfg.regionBoundaries).find(r => {
    const f = cfg.regionBoundaries[r].locationKeywordsFilter;
    return f?.some((k: string) => location.toLowerCase().includes(k.toLowerCase()));
  });
  
  if (region) {
    logInfo(`Assigning ${closures.length} grouped closures to region ${region}`);
    regionCfg = cfg.regionBoundaries[region];
  } else {
    // Remove all closures from tracking if region not found
    closures.forEach(c => delete tracked[c.id]);
    logError(`Grouped closures are in a region that is not configured: ${location}`);
    return;
  }

  // Update tracking for all closures
  closures.forEach(c => {
    if (tracked[c.id]) {
      tracked[c.id].country = region;
    }
  });
  fs.writeFileSync(TRACK_FILE, JSON.stringify(tracked, null, 2));

  const formattedLocation = `[${location}](https://www.google.com/search?q=${searchQuery}&udm=50)`;
  const slackLocation = `<https://www.google.com/search?q=${searchQuery}&udm=50|${location}>`;
  
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
  const tileUrl = pickTileServer(tileX, tileY, tileServers, regionCfg);
  
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

  // Create a summary of all closures
  const closureDetails = closures.map((c, index) => {
    const status = c.closureStatus.startsWith("Finished") ? "Past" : c.closureStatus;
    const userName = `[${c.userName}](https://www.waze.com/user/editor/${c.userName})`;
    const duration = c.duration || "Unknown";
    const direction = c.direction;
    return `${status} • (${direction}) • ${userName} • ${duration} • <t:${(c.timestamp / 1000).toFixed(0)}:F>`;
  }).join('\n');

  const slackClosureDetails = closures.map((c, index) => {
    const status = c.closureStatus.startsWith("Finished") ? "Past" : c.closureStatus;
    const slackUsername = `<https://www.waze.com/user/editor/${c.userName}|${c.userName}>`;
    const duration = c.duration || "Unknown";
    const direction = c.direction;
    return `${status} • (${direction}) • ${slackUsername} • ${duration} • <!date^${(c.timestamp / 1000).toFixed(0)}^{date_long} {time}|${new Date(c.timestamp).toLocaleString()}>`;
  }).join('\n');

  const embed = {
    author: { name: `${closures.length} App Closures on Same Segment` },
    color: roadTypeColors[roadTypeEnum as keyof typeof roadTypeColors] || 0x3498db, // default to blue if no color found
    fields: [
      {
        name: "Closures",
        value: closureDetails,
      },
      { name: "Segment Type", value: roadType, inline: true },
      {
        name: "Location",
        value: formattedLocation,
        inline: true,
      },
      {
        name: "Links",
        value:
          `[WME](${editorUrl}) | ` +
          `[LiveMap](${liveMapUrl}) | ` +
          `[App](${appUrl})`,
      },
    ],
    thumbnail: {
      url: tileUrl,
    },
  };

  if (regionCfg.departmentOfTransporationUrl) {
    const linkName =
      regionCfg.departmentOfTransporationName ??
      "DOT";
    const lastField = embed.fields[embed.fields.length - 1];
    (lastField as { value: string }).value +=
      ` | [${linkName}](${dotMap})`;
  }

  // Send to webhooks
  const webhooks = regionCfg.webhooks || [];
  for (const hook of webhooks) {
    if (hook.type === "discord") {
      logInfo(`Sending grouped closure notification to Discord (${region}) for ${closures.length} closures…`);
      const maxRetries = 3;
      let attempt = 0;
      let success = false;
      while (attempt < maxRetries && !success) {
        attempt++;
        const res = await fetch(hook.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds: [embed] }),
        });
        if (res.status === 204) {
          logInfo("Discord grouped notification sent successfully.");
          success = true;
        } else if (res.status === 429) {
          const retryData: any = await res.json().catch(() => null);
          const retryAfter = (retryData && typeof retryData.retry_after === 'number') ? retryData.retry_after : 1;
          logWarning(`Discord rate limited; retrying after ${retryAfter}s (attempt ${attempt}/${maxRetries})`);
          await delay(retryAfter * 1000);
        } else {
          const text = await res.text();
          logError(`Discord webhook request failed (${res.status}): ${text}`);
          break;
        }
      }
      if (!success) {
        logError(`Failed to send Discord grouped notification after ${maxRetries} attempts.`);
      }
    } else if (hook.type === "slack") {
      logInfo(`Sending grouped closure notification to Slack (${region}) for ${closures.length} closures…`);
      const dotLabel = regionCfg.departmentOfTransporationName ?? "DOT";
      const slackBlocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${closures.length} App Closures on Same Segment*`
          },
          accessory: {
            type: "image",
            image_url: tileUrl,
            alt_text: "Tile preview"
          }
        },
        {
          type: "section",
          block_id: "closureDetails",
          text: {
            type: "mrkdwn",
            text: `*Closures*\n${slackClosureDetails}`
          }
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
              text: `*Links*\n• <${editorUrl}|WME> | <${liveMapUrl}|LiveMap> | <${appUrl}|App>` +
                `${regionCfg.departmentOfTransporationUrl ? ` | <${dotMap}|${dotLabel}>` : ""}`
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
        logInfo("Slack grouped notification sent successfully.");
      } else {
        const text = await slackRes.text();
        logError(`Slack webhook request failed (${slackRes.status}): ${text}`);
      }
    } else {
      logWarning(`Unknown webhook type: ${hook.type}`);
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
          logWarning("Received empty request body for uploadClosures");
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
        // add editor as true
        if (!(user in mapping)) {
          mapping[user] = true;
          logInfo(`➕ Added new user to whitelist: ${user}`);
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
        logError(`❌ Failed to process upload: ${err instanceof Error ? err.message : err}`);
      }
    });
    return;   // ← ensure we don't fall through
  } else if (url.pathname === "/trackedClosures") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", async () => {
      if (res.headersSent) return; // Prevent duplicate responses
      
      try {
        if (!body.trim()) {
          logWarning("Received empty request body for trackedClosures");
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
        // add editor as true
        if (!(user in mapping)) {
          mapping[user] = true;
          logInfo(`➕ Added new user to whitelist: ${user}`);
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
        // allowed → return tracked list, optionally filtered by env
        const envFilter = data.env as string | undefined;
        const ids = Object.entries(tracked)
          .filter(([id, info]) => {
            if (!envFilter) return true;
            const region = cfg.regionBoundaries[info.country];
            return region?.env === envFilter;
          })
          .map(([id]) => id);
        
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(ids, null, 2));
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = 400;
          res.end("Error");
        }
        logError(`❌ Failed to process trackedClosures request: ${err instanceof Error ? err.message : err}`);
      }
    });
    return;
  } else {
    // Handle unknown endpoints
    if (!res.headersSent) {
      res.statusCode = 404;
      res.end("Not Found");
    }
  }
});

// Start the server
server.listen(PORT, () => {
  logInfo(`🚀 Server started on port ${PORT}`);
  logInfo("🔍 Listening for closure uploads...");
});

// Handle server errors
server.on('error', (err) => {
  logError(`❌ Server error: ${err.message}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logInfo('📴 Received SIGTERM, shutting down gracefully');
  server.close(() => {
    logInfo('💤 Process terminated');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logInfo('📴 Received SIGINT, shutting down gracefully');
  server.close(() => {
    logInfo('💤 Process terminated');
    process.exit(0);
  });
});

