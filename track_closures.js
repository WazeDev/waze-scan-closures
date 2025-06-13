import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// emulate __dirname in ES module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const roadTypes = { 1: 'Street', 2: 'Primary Street', 3: 'Freeway (Interstate / Other)', 4: 'Ramp', 5: 'Routable Pedestrian Path', 6: 'Major Highway', 7: 'Minor Highway', 8: 'Off-road / Not maintained', 9: 'Walkway', 10: 'Non-Routable Pedestrian Path', 15: 'Ferry', 16: 'Stairway', 17: 'Private Road', 18: 'Railroad', 19: 'Runway', 20: 'Parking Lot Road', 22: 'Passageway' }

dotenv.config();

function delay(time) {
    return new Promise(function (resolve) {
        setTimeout(resolve, time)
    });
}

// --- add this to load cookies and build your header ---
const COOKIE_PATH = path.resolve(__dirname, 'cookies.json');
const rawCookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf8'));
const validCookies = rawCookies.filter(c => c.name && c.value);
const cookieHeader = validCookies.map(c => `${c.name}=${c.value}`).join('; ');

// now WEBHOOK_URL will be picked up from your .env
const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK_URL) {
    console.error('❌ Missing DISCORD_WEBHOOK_URL in .env');
    process.exit(1);
}

const SCAN_FILE = path.resolve(__dirname, 'scan_results.json');
const TRACK_FILE = path.resolve(__dirname, 'closure_tracking.json');
// Load or initialize tracking store (id -> { firstSeen, country })
let tracked = {};
if (fs.existsSync(TRACK_FILE)) {
    tracked = JSON.parse(fs.readFileSync(TRACK_FILE, 'utf8'));
}

// Function to scan for new IDs
async function updateTracking() {
    const data = JSON.parse(fs.readFileSync(SCAN_FILE, 'utf8'));
    const newClosures = [];

    for (const country in data) {
        for (const c of data[country].closures) {
            if (!tracked[c.id]) {
                tracked[c.id] = { firstSeen: new Date().toISOString(), country };
                newClosures.push({
                    id: c.id,
                    country,
                    geometry: c.geometry,       // pass full geometry
                    segID: c.segID,
                    userId: c.createdBy,
                    timestamp: c.createdOn    // use createdOn from scan results
                });
            }
        }
    }

    if (newClosures.length) {
        fs.writeFileSync(TRACK_FILE, JSON.stringify(tracked, null, 2))
        for (const closure of newClosures) {
            await notifyDiscord(closure);
        }
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
    location = '',
    reason = 'No Reason Selected',
    segmentType = 'Unknown'
}) {
    const coords = geometry.coordinates;
    const [lonStart, latStart] = coords[0];
    const [lonEnd, latEnd] = coords[coords.length - 1];

    const adjLon1 = +lonStart.toFixed(3) + 0.005;
    const adjLat1 = +latStart.toFixed(3) + 0.005;
    const adjLon2 = +lonEnd.toFixed(3) - 0.005;
    const adjLat2 = +latEnd.toFixed(3) - 0.005;

    const featuresUrl = `https://www.waze.com/Descartes/app/Features?` +
        `bbox=${adjLon1},${adjLat1},${adjLon2},${adjLat2}` +
        `&roadClosures=true&roadTypes=1,2,3,4,6,7`;

    // ← include cookies when fetching user info
    let userName = userId;
    try {
        await delay(2000); // delay 2 seconds between requests to keep Waze happy
        const res = await fetch(featuresUrl, {
            headers: { Cookie: cookieHeader },
            timeout: 30000
        });
        const js = await res.json();
        const usr = js.users.objects.find(u => u.id === userId);
        const segment = js.segments.objects.find(s => s.id === segID);
        if (usr?.userName) userName = usr.userName;
        if (segment?.roadType) segmentType = roadTypes[segment.roadType]
    } catch (e) {
        console.warn(`User lookup failed: ${e.message}, features URL: ${featuresUrl}`);
    }

    const envParam = country.toLowerCase() === 'us' ? 'usa' : country.toLowerCase();
    const editorUrl = `https://www.waze.com/en-US/editor?env=${envParam}` +
        `&lat=${latStart.toFixed(6)}` +
        `&lon=${lonStart.toFixed(6)}` +
        `&zoomLevel=17&segments=${segID}`;
    const liveMapUrl = `https://www.waze.com/live-map/directions?to=ll.` +
        `${latStart.toFixed(6)}%2C${lonStart.toFixed(6)}`;
    const appUrl = `https://www.waze.com/ul?ll=${latStart.toFixed(6)},${lonStart.toFixed(6)}`;
    const embed = {
        author: {
            name: 'New App Closure (A➜B)'
        },
        color: 0xE74C3C,
        fields: [
            { name: 'User', value: `${userName} • <t:${(timestamp / 1000).toFixed(0)}:F>`, inline: false },
            { name: 'Segment Type', value: segmentType, inline: true },
            {
                name: 'Links',
                value:
                    `[WME Link](${editorUrl}) | ` +
                    `[Livemap Link](${liveMapUrl}) | ` +
                    `[App Link](${appUrl})`,
                inline: false
            }
        ]
    };

    // 4) send to Discord
    try {
        await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ embeds: [embed] })
        });
    } catch (e) {
        console.error('Discord webhook error:', e.message);
    }
}

// Initial run & watch
await updateTracking()
fs.watchFile(SCAN_FILE, { interval: 1000 }, (curr, prev) => {
    if (curr.mtime > prev.mtime) updateTracking()
})