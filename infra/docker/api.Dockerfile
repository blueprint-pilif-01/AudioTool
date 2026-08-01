FROM node:22-bookworm-slim

RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api ./apps/api
COPY packages ./packages
RUN pnpm install --frozen-lockfile && pnpm --filter @audiotool/api... build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["pnpm", "--filter", "@audiotool/api", "start"]

