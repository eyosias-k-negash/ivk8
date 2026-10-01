#!/usr/bin/env bash
# Post-deploy checks, run locally (make smoke) and in CI against the ephemeral k3d cluster.
set -euo pipefail
BASE="${BASE_URL:-http://localhost:8080}"
fail() { echo "FAIL: $*" >&2; exit 1; }

echo "==> web serves the SPA"
curl -fsS "$BASE/" | grep -q '<div id="root">' || fail "index.html not served"

echo "==> API answers through the ingress, signed out"
curl -fsS "$BASE/api/me" | grep -q '"signedIn":false' || fail "/api/me"

echo "==> Drive routes require sign-in"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/backups")
[[ "$code" == "401" ]] || fail "/api/backups returned $code, expected 401"

echo "==> login redirects to Google with read-only scope"
loc=$(curl -s -o /dev/null -w '%{redirect_url}' "$BASE/api/auth/login")
[[ "$loc" == https://accounts.google.com/* && "$loc" == *drive.readonly* ]] || fail "login redirect: $loc"

echo "==> analytics-service is NOT reachable via the ingress"
# /datasets/* falls through to the SPA (HTML); an analytics JSON error body would mean exposure.
body=$(curl -s "$BASE/datasets/$(printf 'a%.0s' {1..64})/balances")
[[ "$body" != *'"error"'* ]] || fail "analytics exposed publicly"

echo "==> NetworkPolicy: a pod labelled as web-dashboard cannot reach analytics-service"
kubectl -n ivy delete pod np-probe --ignore-not-found >/dev/null
kubectl -n ivy apply -f - >/dev/null <<'YAML'
apiVersion: v1
kind: Pod
metadata:
  name: np-probe
  labels: { app.kubernetes.io/name: web-dashboard, role: probe }
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext: { runAsNonRoot: true, runAsUser: 65534, seccompProfile: { type: RuntimeDefault } }
  containers:
    - name: probe
      image: busybox:1.36
      command: ["sh", "-c", "wget -T 5 -qO- http://analytics-service:8081/healthz && echo REACHABLE || echo BLOCKED"]
      securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
YAML
kubectl -n ivy wait --for=jsonpath='{.status.phase}'=Succeeded pod/np-probe --timeout=90s >/dev/null || true
out=$(kubectl -n ivy logs np-probe 2>/dev/null || true)
kubectl -n ivy delete pod np-probe --ignore-not-found >/dev/null
[[ "$out" == *BLOCKED* ]] || fail "network policy did not block web -> analytics (got: $out)"

echo "All smoke checks passed."
