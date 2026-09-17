FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/api/package.json backend/api/
COPY backend/shared/package.json backend/shared/
RUN pnpm install --frozen-lockfile --prod --filter emul-api...

FROM node:22-alpine
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/backend/api/node_modules backend/api/node_modules
COPY --from=deps /app/backend/shared/node_modules backend/shared/node_modules
COPY backend/api/ backend/api/
COPY backend/shared/ backend/shared/
USER node
EXPOSE 8787
CMD ["node", "--experimental-strip-types", "backend/api/src/index.ts"]
