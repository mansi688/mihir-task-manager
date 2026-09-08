#!/usr/bin/env bash
# One-command setup + start for the main app.
#
# Usage:  ./start.sh
#
# This script always operates on the folder it lives in — not the folder
# you happen to be sitting in when you run it — so "wrong directory"
# errors (cd into the wrong place, run npm from Downloads by mistake,
# etc.) become structurally impossible. You can double-click this file,
# or run it from anywhere:
#   bash /full/path/to/start.sh

set -e
cd "$(dirname "$0")"

echo "Working directory: $(pwd)"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed or not on your PATH."
  echo "Install it from https://nodejs.org, then run this script again."
  exit 1
fi
echo "Node.js found: $(node -v)"

if [ ! -d node_modules ]; then
  echo ""
  echo "Installing dependencies (first run only, this can take a minute)..."
  npm install
else
  echo "Dependencies already installed."
fi

if [ ! -f .env ]; then
  echo ""
  echo "No .env file found — creating one with a random JWT_SECRET..."
  cp .env.example .env
  RANDOM_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  # Portable in-place sed for both GNU (Linux) and BSD (macOS) sed.
  if sed --version >/dev/null 2>&1; then
    sed -i "s#JWT_SECRET=.*#JWT_SECRET=${RANDOM_SECRET}#" .env
  else
    sed -i '' "s#JWT_SECRET=.*#JWT_SECRET=${RANDOM_SECRET}#" .env
  fi
  echo ".env created with a real random secret — nothing further to edit."
else
  echo ".env already exists — leaving it as is."
fi

echo ""
echo "Starting the server..."
echo "Once it says 'server running', open http://localhost:4000 in your browser."
echo ""
npm start
