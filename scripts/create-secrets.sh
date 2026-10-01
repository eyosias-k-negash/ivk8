#!/usr/bin/env bash
# Creates/updates the `ivy-secrets` Secret from environment variables or ./.env.
# Values are piped straight to kubectl and never echoed. Nothing is written to disk.
set -euo pipefail
cd "$(dirname "$0")/.."

NAMESPACE="${NAMESPACE:-ivy}"

if [[ -f .env ]]; then
  set -a; # shellcheck disable=SC1091
  source .env; set +a
fi

for v in GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET SESSION_SECRET; do
  if [[ -z "${!v:-}" ]]; then
    echo "error: $v is not set (put it in .env, see .env.example)" >&2
    exit 1
  fi
done
if (( ${#SESSION_SECRET} < 32 )); then
  echo "error: SESSION_SECRET must be at least 32 characters (openssl rand -hex 32)" >&2
  exit 1
fi

kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$NAMESPACE" >/dev/null

kubectl -n "$NAMESPACE" create secret generic ivy-secrets \
  --from-literal=GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
  --from-literal=GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET" \
  --from-literal=SESSION_SECRET="$SESSION_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null

echo "secret/ivy-secrets applied in namespace $NAMESPACE"
