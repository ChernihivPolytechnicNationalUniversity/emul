FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && apk add --no-cache git
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/shared/package.json backend/shared/
COPY backend/api/package.json backend/api/
COPY backend/worker/package.json backend/worker/
RUN pnpm install --frozen-lockfile
COPY . .
# The editor's symbol index per chip, from the same pinned ST sources the worker compiles against.
RUN sh backend/worker/toolchain/stage-st.sh /tmp/st && pnpm symbols /tmp/st public/symbols && rm -rf /tmp/st
RUN pnpm build

FROM alpine:3.21
RUN apk add --no-cache nginx nginx-mod-http-brotli
COPY nginx.conf /etc/nginx/nginx.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
USER nginx
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
