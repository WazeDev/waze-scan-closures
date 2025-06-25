# waze-scan-closures

Scans for Waze map closures and sends Discord notifications when new closures are reported.

## Features
- Tracks already-reported closures in `closure_tracking.json`  
- Sends rich embeds to Discord via webhook when new closures appear

## Prerequisites

- Node.js v16+  
- A Discord webhook URL  

## Installation

```sh
git clone https://github.com/WazeDev/waze-scan-closures.git
cd waze-scan-closures
npm install
npm run build          # compile TypeScript to JavaScript in out/
npm run track          # start tracking new closures and notify Discord
```

## Configuration
1. Copy the example and fill in your values:

```cp config.json.example config.json```

2. Edit `config.json`

## Usage

- Uses `out/scan_areas.js`  

### 1. Track new closures & notify Discord

This script runs a webserver, identifies new closures, and posts embeds to Discord.

```sh
npm run track
```

## Project Structure

```text
├── config.json.example       # Template for your config
├── config.json               # Your configured values (copy from example)
├── closure_tracking.json     # Tracks already reported closures
├── package.json              # NPM metadata & scripts
├── tsconfig.json             # TypeScript configuration
├── src/                      # TypeScript sources
│   └── track_closures.ts
├── out/                      # Compiled JavaScript
│   └── track_closures.js
└── README.md                 # Documentation
```

## License

This project is licensed under the MIT License – see the [LICENSE](LICENSE) file
