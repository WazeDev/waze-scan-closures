# waze-scan-closures

Scans for Waze map closures and sends Discord notifications when new closures are reported.

## Features

- Uses [Puppeteer](https://github.com/puppeteer/puppeteer) to log into Waze Map Editor (WME) and manage session cookies  
- Scans configurable geographic regions for active closures  
- Saves raw closure data to `scan_results.json`  
- Tracks already-reported closures in `closure_tracking.json`  
- Sends rich embeds to Discord via webhook when new closures appear  
- Caches Waze entities (users, segments, streets, cities, states) in `feature_cache.json` to reduce API requests  

## Prerequisites

- Node.js v16+  
- A Discord webhook URL  

## Installation

```sh
git clone https://github.com/WazeDev/waze-scan-closures.git
cd waze-scan-closures
npm install
npm run build          # compile TypeScript to JavaScript in out/
npm run scan           # run a single closure scan
npm run track          # start tracking new closures and notify Discord
```

## Configuration
1. Copy the example and fill in your values:

```cp config.json.example config.json```

2. Edit `config.json`

## Usage

### 1. Scan for closures

This script logs into WME, generates scan URLs, and writes results to `scan_results.json`.

```sh
npm run scan
```

- Uses `out/scan_areas.js`  

### 2. Track new closures & notify Discord

This script watches `scan_results.json` for changes, identifies new closures, and posts embeds to Discord.

```sh
npm run track
```

- Uses `out/track_closures.js`  

## Project Structure

```text
├── config.json.example       # Template for your config
├── config.json               # Your configured values (copy from example)
├── feature_cache.json        # Auto-generated cache of Waze feature metadata
├── scan_results.json         # Raw scan output
├── closure_tracking.json     # Tracks already reported closures
├── package.json              # NPM metadata & scripts
├── tsconfig.json             # TypeScript configuration
├── src/                      # TypeScript sources
│   ├── scan_areas.ts
│   └── track_closures.ts
├── out/                      # Compiled JavaScript
│   ├── scan_areas.js
│   └── track_closures.js
└── README.md                 # Documentation
```

## License

This project is licensed under the MIT License – see the [LICENSE](LICENSE) file
