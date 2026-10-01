#!/usr/bin/env bash
# Build all three images from the repo root (npm workspaces need the root as context).
# Usage: scripts/build-images.sh [tag]   (default tag: local)
set -euo pipefail
cd "$(dirname "$0")/.."
TAG="${1:-local}"
for svc in analytics-service drive-sync-service web-dashboard; do
  echo "==> building ivy/$svc:$TAG"
  docker build -f "services/$svc/Dockerfile" -t "ivy/$svc:$TAG" .
done
