FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

ARG APP_VERSION=dev
RUN printf '{\n  "version": "%s"\n}\n' "$APP_VERSION" > dist/config.json


FROM alpine:3.21
RUN apk add --no-cache nginx nginx-mod-http-brotli \
 && ln -sf /dev/stdout /var/log/nginx/access.log \
 && ln -sf /dev/stderr /var/log/nginx/error.log
COPY nginx.conf /etc/nginx/http.d/default.conf
COPY --from=build /app/dist /var/www/emul
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
