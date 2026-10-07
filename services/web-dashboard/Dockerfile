# Build context: repository root (workspaces). See Makefile / CI.
FROM node:26-alpine AS build
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
USER root
COPY services/web-dashboard/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/services/web-dashboard/dist /usr/share/nginx/html
RUN chmod 644 /etc/nginx/conf.d/default.conf && \
    find /usr/share/nginx/html -type f -exec chmod 644 {} + && \
    find /usr/share/nginx/html -type d -exec chmod 755 {} +
EXPOSE 8080
USER 101
