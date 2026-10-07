# Build context: repository root (workspaces). See Makefile / CI.
FROM node:26-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY services/analytics-service/package.json services/analytics-service/
COPY services/drive-sync-service/package.json services/drive-sync-service/
COPY services/web-dashboard/package.json services/web-dashboard/
RUN npm ci --workspace @ivy/drive-sync-service --ignore-scripts
COPY packages/contracts packages/contracts
COPY services/drive-sync-service services/drive-sync-service
RUN npm run build -w @ivy/drive-sync-service

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
COPY --from=build /repo/services/drive-sync-service/dist/server.mjs ./server.mjs
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER nonroot
CMD ["server.mjs"]
