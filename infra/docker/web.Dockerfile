FROM node:22-bookworm-slim AS build

RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web ./apps/web
COPY packages/contracts ./packages/contracts
RUN pnpm install --frozen-lockfile && pnpm --filter @audiotool/web build

FROM nginx:1.29-alpine
COPY infra/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/apps/web/dist /usr/share/nginx/html
EXPOSE 80

