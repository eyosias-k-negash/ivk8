# Build context: repository root (workspaces). See Makefile / CI.
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY services/analytics-service/package.json services/analytics-service/
COPY services/drive-sync-service/package.json services/drive-sync-service/
COPY services/web-dashboard/package.json services/web-dashboard/
RUN npm ci --workspace @ivy/analytics-service --ignore-scripts
COPY packages/contracts packages/contracts
COPY services/analytics-service services/analytics-service
RUN npm run build -w @ivy/analytics-service

# Runtime: distroless, non-root, no shell, no package manager. The bundle has no node_modules.
FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=build /repo/services/analytics-service/dist/server.mjs ./server.mjs
ENV NODE_ENV=production PORT=8081
EXPOSE 8081
USER nonroot
CMD ["server.mjs"]
