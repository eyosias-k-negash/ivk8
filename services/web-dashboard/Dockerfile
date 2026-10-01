# Build context: repository root (workspaces). See Makefile / CI.
FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY services/analytics-service/package.json services/analytics-service/
COPY services/drive-sync-service/package.json services/drive-sync-service/
COPY services/web-dashboard/package.json services/web-dashboard/
RUN npm ci --workspace @ivy/web-dashboard --ignore-scripts
COPY packages/contracts packages/contracts
COPY services/web-dashboard services/web-dashboard
RUN npm run build -w @ivy/web-dashboard

FROM nginxinc/nginx-unprivileged:stable-alpine
COPY services/web-dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/services/web-dashboard/dist /usr/share/nginx/html
EXPOSE 8080
USER 101
