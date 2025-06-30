#!/bin/bash

# Get latest commit, reset local directory to it
git fetch origin
git reset --hard origin/main

# Kill any existing screen session named "waze-closure-tracking"
screen -S waze-closure-tracking -X quit 2>/dev/null || true

# Start a new screen session
screen -d -m -S waze-closure-tracking -L -Logfile log.txt sudo npm run track

echo "Started Waze Closure Tracking in screen session 'waze-closure-tracking'"
echo "To view the session: screen -r waze-closure-tracking"
echo "To view the log: tail -f log.txt"
