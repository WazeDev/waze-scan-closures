import fs from "fs";
import path from "path";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import http from "http";
const URL_HASH_FACTOR = (Math.sqrt(5) - 1) / 2;
const previewZoomLevel = 17;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
function logInfo(msg) {
    console.log(`[${new Date().toISOString()}] INFO: ${msg}`);
}
function logError(msg) {
    console.error(`[${new Date().toISOString()}] ERROR: ${msg}`);
}
function logWarning(msg) {
    console.warn(`[${new Date().toISOString()}] WARNING: ${msg}`);
}
const configPath = path.resolve(__dirname, "..", "config.json");
let cfg;
try {
    cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
}
catch (err) {
    if (err instanceof Error) {
        logError(`❌ Failed to load config.json: ${err.message}`);
    }
    else {
        logError(`❌ Failed to load config.json: ${err}`);
    }
    process.exit(1);
}
logInfo("🔧 Loaded config.json");
fs.watchFile(configPath, { interval: 15000 }, () => {
    try {
        cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
        logInfo("🔄 config.json reloaded");
    }
    catch (err) {
        logError(`❌ Failed to reload config.json:) ${err instanceof Error ? err.message : err}`);
    }
});
const tileServers = [
    "https://editor-tiles-${env}-1.waze.com/tiles/roads/${z}/${x}/${y}/tile.png",
    "https://editor-tiles-${env}-2.waze.com/tiles/roads/${z}/${x}/${y}/tile.png",
    "https://editor-tiles-${env}-3.waze.com/tiles/roads/${z}/${x}/${y}/tile.png",
    "https://editor-tiles-${env}-4.waze.com/tiles/roads/${z}/${x}/${y}/tile.png"
];
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
    1: 0xD5D4C4,
    2: 0xD5CF4D,
    3: 0xAF6ABA,
    4: 0x9EA99F,
    5: 0x8e44ad,
    6: 0x3CA3B9,
    7: 0x5EA978,
    8: 0x95a5a6,
    9: 0x7f8c8d,
    10: 0x34495e,
    15: 0x16a085,
    16: 0x27ae60,
    17: 0xA8A45F,
    18: 0x8e44ad,
    19: 0x2980b9,
    20: 0x979797,
    22: 0x2ecc71,
};
const editorUrl = "https://waze.com/editor";
function delay(time = 1000) {
    if (time <= 0) {
        return Promise.resolve();
    }
    return new Promise(function (resolve) {
        setTimeout(resolve, time);
    });
}
function lon2tile(lon, zoom = previewZoomLevel) {
    return String(Math.floor(((lon + 180) / 360) * 2 ** zoom));
}
function lat2tile(lat, zoom = previewZoomLevel) {
    const rad = (lat * Math.PI) / 180;
    return String(Math.floor(((1 -
        Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) /
        2) *
        2 ** zoom));
}
function pickTileServer(x, y, t = tileServers, r) {
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
    }
    else if (r.env === "il") {
        env = "il";
    }
    else {
        env = "na";
    }
    let url = tileServer.replace("${x}", x).replace("${y}", y).replace("${z}", previewZoomLevel.toString()).replace("${env}", env);
    return url;
}
const TRACK_FILE = path.resolve(__dirname, "..", "closure_tracking.json");
let tracked = {};
if (fs.existsSync(TRACK_FILE)) {
    tracked = JSON.parse(fs.readFileSync(TRACK_FILE, "utf8"));
}
async function updateTracking(data) {
    const newClosures = [];
    const arr = data.closures || [];
    const userName = data.userName || "Unknown User";
    for (const c of arr) {
        const country = c.location.split(",").pop().trim();
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
                duration: c.duration || "Unknown"
            });
        }
    }
    if (newClosures.length) {
        logInfo(`👀 ${userName} found ${newClosures.length} new closures!`);
        for (const closure of newClosures) {
            await delay(1000);
            await notifyDiscord(closure);
        }
    }
}
async function notifyDiscord({ id, segID, userName, timestamp, direction, lat, lon, location, roadType, roadTypeEnum, duration = "Unknown" }) {
    let slackLocation;
    let regionCfg;
    const searchParams = `(road | improvements | closure | construction | project | work | detour | maintenance | closed ) AND (city | town | county | state)`;
    const searchQuery = encodeURIComponent(`${location} ${searchParams}`);
    const region = Object.keys(cfg.regionBoundaries).find(r => {
        const f = cfg.regionBoundaries[r].locationKeywordsFilter;
        return f?.some((k) => location.toLowerCase().includes(k.toLowerCase()));
    });
    if (region) {
        logInfo(`Assigning closure ${id} to region ${region}`);
        tracked[id].country = region;
        fs.writeFileSync(TRACK_FILE, JSON.stringify(tracked, null, 2));
        regionCfg = cfg.regionBoundaries[region];
    }
    else {
        delete tracked[id];
        logError(`Closure is in a region that is not configured: ${location}`);
        return;
    }
    slackLocation = `<https://www.google.com/search?q=${searchQuery}&udm=50|${location}>`;
    location = `[${location}](https://www.google.com/search?q=${searchQuery}&udm=50)`;
    const adjLon1 = +lon.toFixed(3) + 0.005;
    const adjLat1 = +lat.toFixed(3) + 0.005;
    const adjLon2 = +lon.toFixed(3) - 0.005;
    const adjLat2 = +lat.toFixed(3) - 0.005;
    let envPrefix;
    if (regionCfg.env === 'row') {
        envPrefix = "row-";
    }
    else if (regionCfg.env === 'il') {
        envPrefix = "il-";
    }
    else {
        envPrefix = "";
    }
    const tileX = lon2tile(lon, previewZoomLevel);
    const tileY = lat2tile(lat, previewZoomLevel);
    const tileUrl = pickTileServer(tileX, tileY, tileServers, regionCfg);
    let slackUsername = `<https://www.waze.com/user/editor/${userName}|${userName}>`;
    userName = `[${userName}](https://www.waze.com/user/editor/${userName})`;
    const editorUrl = `https://www.waze.com/en-US/editor?env=${regionCfg.env}` +
        `&lat=${lat.toFixed(6)}` +
        `&lon=${lon.toFixed(6)}` +
        `&zoomLevel=17&segments=${segID}`;
    const liveMapUrl = `https://www.waze.com/live-map/directions?to=ll.` +
        `${lat.toFixed(6)}%2C${lon.toFixed(6)}`;
    const appUrl = `https://www.waze.com/ul?ll=${lat.toFixed(6)},${lon.toFixed(6)}`;
    let dotMap;
    if (regionCfg.departmentOfTransporationUrl) {
        if ((regionCfg.departmentOfTransporationUrl.match(/{lat}/g) || []).length === 2 &&
            (regionCfg.departmentOfTransporationUrl.match(/{lon}/g) || []).length === 2) {
            dotMap = regionCfg.departmentOfTransporationUrl.replace("{lat}", adjLat1.toFixed(6)).replace("{lat}", adjLat2.toFixed(6)).replace("{lon}", adjLon1.toFixed(6)).replace("{lon}", adjLon2.toFixed(6));
        }
        else {
            dotMap = regionCfg.departmentOfTransporationUrl.replace("{lat}", lat.toFixed(6)).replace("{lon}", lon.toFixed(6));
        }
    }
    const embed = {
        author: { name: `New App Closure (${direction})` },
        color: roadTypeColors[roadTypeEnum] || 0x3498db,
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
                value: `[WME](${editorUrl}) | ` +
                    `[Livemap](${liveMapUrl}) | ` +
                    `[App](${appUrl})`,
            },
        ],
        thumbnail: {
            url: tileUrl,
        },
    };
    if (regionCfg.departmentOfTransporationUrl) {
        const linkName = regionCfg.departmentOfTransporationName ??
            "DOT";
        const lastField = embed.fields[embed.fields.length - 1];
        lastField.value +=
            ` | [${linkName}](${dotMap})`;
    }
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
                }
                else if (res.status === 429) {
                    const retryData = await res.json().catch(() => null);
                    const retryAfter = (retryData && typeof retryData.retry_after === 'number') ? retryData.retry_after : 1;
                    logWarning(`Discord rate limited; retrying after ${retryAfter}s (attempt ${attempt}/${maxRetries})`);
                    await delay(retryAfter * 1000);
                }
                else {
                    const text = await res.text();
                    logError(`Discord webhook request failed (${res.status}): ${text}`);
                    break;
                }
            }
            if (!success) {
                logError(`Failed to send Discord notification after ${maxRetries} attempts.`);
            }
        }
        else if (hook.type === "slack") {
            logInfo(`Sending a closure notification to Slack (${region})…`);
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
                            text: `*Links*\n• <${editorUrl}|WME> | <${liveMapUrl}|Livemap> | <${appUrl}|App>` +
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
            }
            else {
                const text = await slackRes.text();
                logError(`Slack webhook request failed (${slackRes.status}): ${text}`);
            }
        }
        else {
            logWarning(`Unknown webhook type: ${hook.type}`);
        }
    }
    return;
}
const PORT = 80;
const server = http.createServer((req, res) => {
    const url = new URL(req.url || "", `http://localhost`);
    if (url.pathname === "/uploadClosures") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
            if (res.headersSent)
                return;
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
                let mapping = {};
                if (Array.isArray(cfg.whitelist)) {
                    cfg.whitelist.forEach(u => mapping[u] = true);
                }
                else {
                    mapping = { ...(cfg.whitelist || {}) };
                }
                if (!(user in mapping)) {
                    mapping[user] = true;
                    logInfo(`➕ Added new user to whitelist: ${user}`);
                    cfg.whitelist = mapping;
                    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");
                    res.statusCode = 404;
                    res.end("Not Found");
                    return;
                }
                if (!mapping[user]) {
                    res.statusCode = 404;
                    res.end("Not Found");
                    return;
                }
                await updateTracking(data);
                res.statusCode = 200;
                res.end("Upload complete");
            }
            catch (err) {
                if (!res.headersSent) {
                    res.statusCode = 400;
                    res.end("Error");
                }
                logError(`❌ Failed to process upload: ${err instanceof Error ? err.message : err}`);
            }
        });
        return;
    }
    else if (url.pathname === "/trackedClosures") {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", async () => {
            if (res.headersSent)
                return;
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
                let mapping = {};
                if (Array.isArray(cfg.whitelist)) {
                    cfg.whitelist.forEach(u => mapping[u] = true);
                }
                else {
                    mapping = { ...(cfg.whitelist || {}) };
                }
                if (!(user in mapping)) {
                    mapping[user] = true;
                    logInfo(`➕ Added new user to whitelist: ${user}`);
                    cfg.whitelist = mapping;
                    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), "utf8");
                    res.statusCode = 404;
                    res.end("Not Found");
                    return;
                }
                if (!mapping[user]) {
                    res.statusCode = 404;
                    res.end("Not Found");
                    return;
                }
                const envFilter = data.env;
                const ids = Object.entries(tracked)
                    .filter(([id, info]) => {
                    if (!envFilter)
                        return true;
                    const region = cfg.regionBoundaries[info.country];
                    return region?.env === envFilter;
                })
                    .map(([id]) => id);
                res.statusCode = 200;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(ids, null, 2));
            }
            catch (err) {
                if (!res.headersSent) {
                    res.statusCode = 400;
                    res.end("Error");
                }
                logError(`❌ Failed to process trackedClosures request: ${err instanceof Error ? err.message : err}`);
            }
        });
        return;
    }
    else {
        if (!res.headersSent) {
            res.statusCode = 404;
            res.end("Not Found");
        }
    }
});
server.listen(PORT, () => {
    logInfo(`🚀 Server started on port ${PORT}`);
    logInfo("🔍 Listening for closure uploads...");
});
server.on('error', (err) => {
    logError(`❌ Server error: ${err.message}`);
});
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
