# One image for api / worker / migrate (same build, different command),
# plus a tiny nginx image for the web UI.
FROM node:22-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo
# Install with only manifests first, so dependency layers cache across code changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/extraction/package.json packages/extraction/
COPY packages/queue/package.json packages/queue/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm turbo run build

FROM build AS app
ENV NODE_ENV=production
CMD ["node", "apps/api/dist/main.js"]

FROM nginx:1.27-alpine AS web
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
