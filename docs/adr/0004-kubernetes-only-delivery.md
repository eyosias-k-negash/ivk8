# 0004. Kubernetes-only delivery: k3d locally and in CI

- Status: accepted (2026-10-01)

## Context
The definition of done asks for a one-command start and an automated pipeline that tests the app and blocks security issues. The project is a DevOps portfolio piece.

## Decision
- One manifest set (kustomize `base` plus `local` and `ci` overlays). No docker-compose.
- `make up` creates a k3d cluster, builds and imports images, creates the Secret and applies the manifests.
- CI deploys the same overlay to an ephemeral k3d cluster and runs `scripts/smoke-test.sh`, which also proves the NetworkPolicy.
- The release workflow publishes signed images (GHCR, SBOM, provenance, cosign).

## Consequences
- Local and CI environments are the same shape as production.
- The local loop is slower than compose. `npm run dev:*` plus the Vite proxy covers fast iteration.
- Open: choose a long-lived target (e.g. a single-node k3s VM with Argo CD pulling the signed images) and add TLS (cert-manager).
