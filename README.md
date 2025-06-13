# waze-scan-closures

Scans for Waze map closures and sends Discord notifications when new closures are reported.

## Features

- Uses [Puppeteer](https://github.com/puppeteer/puppeteer) to log into Waze Map Editor (WME) and manage session cookies  
- Scans configurable geographic regions for active closures  
- Saves raw closure data to `scan_results.json`  
- Tracks already-reported closures in `closure_tracking.json`  
- Sends rich embeds to Discord via webhook when new closures appear  

## Prerequisites

- Node.js v16+  
- A Discord webhook URL  

## Installation

```sh
git clone https://github.com/WazeDev/wme-scan-closures.git
cd wme-scan-closures
npm install
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

- [scan_areas.js](scan_areas.js)  
- Generates scan queue based on `countryBoundaries` in the script.  
- Outputs `scan_results.json`.  

### 2. Track new closures & notify Discord

This script watches `scan_results.json` for changes, identifies new closures, and posts embeds to Discord.

```sh
npm run track
```

- [track_closures.js](track_closures.js)  
- Reads `scan_results.json` and updates `closure_tracking.json`.  
- Sends Discord webhook notifications.  

## Project Structure

```text
├── .env.example           # Environment variable template
├── .gitignore             # Files to ignore in Git
├── LICENSE                # MIT License
├── package.json           # NPM metadata & scripts
├── scan_areas.js          # Scan script for closures
├── track_closures.js      # Tracking & Discord notification script
└── README.md              # This file
```

## License

This project is licensed under the MIT License – see the [LICENSE](LICENSE) file
