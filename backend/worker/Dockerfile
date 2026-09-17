FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/worker/package.json backend/worker/
COPY backend/shared/package.json backend/shared/
RUN pnpm install --frozen-lockfile --prod --filter emul-worker...

FROM node:22-alpine
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/backend/worker/node_modules backend/worker/node_modules
COPY --from=deps /app/backend/shared/node_modules backend/shared/node_modules
COPY backend/worker/ backend/worker/
COPY backend/shared/ backend/shared/
USER node
CMD ["node", "--experimental-strip-types", "backend/worker/src/index.ts"]
