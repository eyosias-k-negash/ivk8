#!/usr/bin/env bash
# Build, import and deploy Ivy Wallet Plus to the existing kubeadm cluster (k8s/overlays/kubeadm).
# Run on the control-plane node: images are imported into THAT node's containerd and the
# pods are pinned there. Needs .env (see .env.example) and sudo for `ctr`.
set -euo pipefail
cd "$(dirname "$0")/.."

EXPECTED_CONTEXT="${KUBE_CONTEXT:-kubernetes-admin@kubernetes}"
PIN_NODE="${PIN_NODE:-hostname}"
TAG=kubeadm
NAMESPACE=ivy
SERVICES=(analytics-service drive-sync-service web-dashboard)
# CHANGE-CAUSE shown by `kubectl rollout history` (make up-kubeadm CAUSE="..."); defaults to the git commit.
if [[ -z "${CAUSE:-}" ]]; then
  CAUSE="deploy $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
  git diff --quiet HEAD 2>/dev/null || CAUSE+=" (dirty)"
fi

die() { echo "error: $*" >&2; exit 1; }

# 1. Guard rails: right cluster, right machine, cluster pieces present.
ctx="$(kubectl config current-context)"
[[ "$ctx" == "$EXPECTED_CONTEXT" ]] \
  || die "kubectl context is '$ctx', expected '$EXPECTED_CONTEXT' (set KUBE_CONTEXT to override)"
[[ "$(uname -n)" == "$PIN_NODE" ]] \
  || die "run this on node '$PIN_NODE' (this is '$(uname -n)'); images are imported locally"
[[ "$(uname -m)" == "x86_64" ]] || die "expected an amd64 build host"
kubectl get node "$PIN_NODE" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' \
  | grep -qx True || die "node '$PIN_NODE' is not Ready"
kubectl get ingressclass traefik >/dev/null 2>&1 || die "IngressClass 'traefik' not found (install Traefik first)"
[[ -f .env ]] || die ".env missing (cp .env.example .env and fill it in)"

# 2. Build and import into the node's containerd (namespace k8s.io is what the kubelet uses).
bash scripts/build-images.sh "$TAG"
for s in "${SERVICES[@]}"; do
  echo "importing ivy/$s:$TAG"
  docker save --platform linux/amd64 "ivy/$s:$TAG" | sudo ctr -n k8s.io images import -
done

# 3. Secret, manifests, then wait.
NAMESPACE="$NAMESPACE" bash scripts/create-secrets.sh
kubectl apply -k k8s/overlays/kubeadm

# Image tag is constant, so force new pods to pick up the freshly imported images.
# The change-cause annotation is copied onto the ReplicaSet the restart creates.
kubectl -n "$NAMESPACE" annotate deployment --all --overwrite "kubernetes.io/change-cause=$CAUSE" >/dev/null
kubectl -n "$NAMESPACE" rollout restart deployment >/dev/null
for s in "${SERVICES[@]}"; do
  kubectl -n "$NAMESPACE" rollout status "deploy/$s" --timeout=180s
done

echo
echo "Ivy Wallet Plus is up: http://localhost:30080"
echo "(If localhost:30080 does not answer: kubectl -n traefik port-forward svc/traefik 30080:80)"
echo "Rollout recorded as: $CAUSE  (kubectl -n $NAMESPACE rollout history deploy/<name>)"
