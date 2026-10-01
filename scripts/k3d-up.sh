#!/usr/bin/env bash
# One command to a running stack: k3d cluster -> images -> secret -> manifests -> wait.
# Idempotent: re-run it after code changes to rebuild and roll out.
set -euo pipefail
cd "$(dirname "$0")/.."

CLUSTER="${CLUSTER:-ivy}"
OVERLAY="${OVERLAY:-local}"
PORT="${PORT:-8080}"

for bin in docker k3d kubectl; do
  command -v "$bin" >/dev/null || { echo "error: $bin is required" >&2; exit 1; }
done

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example. Fill in GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / SESSION_SECRET, then re-run." >&2
  exit 1
fi

if ! k3d cluster get "$CLUSTER" >/dev/null 2>&1; then
  echo "==> creating k3d cluster $CLUSTER (http://localhost:$PORT)"
  k3d cluster create "$CLUSTER" --agents 1 -p "${PORT}:80@loadbalancer" --wait
fi
kubectl config use-context "k3d-$CLUSTER" >/dev/null

bash scripts/build-images.sh "$OVERLAY"
echo "==> importing images"
k3d image import -c "$CLUSTER" "ivy/analytics-service:$OVERLAY" "ivy/drive-sync-service:$OVERLAY" "ivy/web-dashboard:$OVERLAY"

kubectl apply -f k8s/base/namespace.yaml >/dev/null
bash scripts/create-secrets.sh

echo "==> applying k8s/overlays/$OVERLAY"
kubectl apply -k "k8s/overlays/$OVERLAY"
# Same tag every time, so force new pods to pick up freshly imported images.
kubectl -n ivy rollout restart deploy >/dev/null
for d in analytics-service drive-sync-service web-dashboard; do
  kubectl -n ivy rollout status "deploy/$d" --timeout=180s
done

echo
echo "Ivy Wallet Plus is up: http://localhost:$PORT"
