# Ivy Wallet Plus. `make up` is the one command to a running stack (k3d + kustomize).
.DEFAULT_GOAL := help
SHELL := /bin/bash

.PHONY: help install typecheck test build check up down smoke images k8s-render k8s-validate scan logs up-kubeadm down-kubeadm

help: ## Show targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install workspace dependencies
	npm ci

typecheck: ## Typecheck all workspaces
	npm run typecheck

test: ## Unit + API tests for all services
	npm test

build: ## Build all services (bundles + SPA)
	npm run build

check: typecheck test k8s-validate ## Everything CI runs before images

up: ## Create/update local k3d cluster and deploy everything (needs .env)
	bash scripts/k3d-up.sh

down: ## Delete the local k3d cluster
	bash scripts/k3d-down.sh

up-kubeadm: ## Build, import and deploy to the existing kubeadm cluster (run on the control-plane node; needs .env + sudo)
	bash scripts/kubeadm-up.sh

down-kubeadm: ## Remove Ivy from the kubeadm cluster (deletes the ivy namespace, incl. the secret)
	kubectl --context $${KUBE_CONTEXT:-kubernetes-admin@kubernetes} delete namespace ivy --ignore-not-found

smoke: ## Smoke-test the running cluster
	bash scripts/smoke-test.sh

images: ## Build the three images (tag: local)
	bash scripts/build-images.sh local

k8s-render: ## Print rendered manifests for the local overlay
	kubectl kustomize k8s/overlays/local

k8s-validate: ## Schema-validate rendered manifests (needs kubeconform)
	@for o in local ci kubeadm; do kubectl kustomize k8s/overlays/$$o | kubeconform -strict -summary -; done

scan: ## Local security scans (needs gitleaks + trivy)
	gitleaks detect --no-banner --redact
	trivy fs --config trivy.yaml .
	trivy config --config trivy.yaml k8s

logs: ## Tail logs of all services
	kubectl -n ivy logs -f -l app.kubernetes.io/part-of=ivy-wallet-plus --max-log-requests 10 --prefix
