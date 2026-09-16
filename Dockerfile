# Build the static site, then serve it with nginx. Everything the browser needs — the app,
# the example firmware — lives in dist/, so the runtime image has no Node in it.
#
#   docker build --build-arg APP_VERSION=1.2.3 -t emul .
#   docker run -p 8080:8080 emul
#
# /config.json is deploy-time settings (Help → Version), served from /etc/config/config.json.
# The image bakes a default with APP_VERSION (the docker-build-push action sets it from the
# release version); a ConfigMap mounted at /etc/config replaces it without a rebuild.

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# Also writes .br/.gz twins of every text asset and ELF (vite.config.ts); nginx serves those.
RUN pnpm build

# Alpine's own nginx rather than the nginx.org image: the brotli module is a package here
# (nginx-mod-http-brotli), built against the same binary, so nothing is compiled from source.
FROM alpine:3.21@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d
ARG APP_VERSION=unknown

RUN apk add --no-cache nginx nginx-mod-http-brotli

COPY nginx.conf /etc/nginx/nginx.conf
COPY security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
RUN mkdir -p /etc/config \
 && printf '{\n  "version": "%s"\n}\n' "$APP_VERSION" > /etc/config/config.json

RUN nginx -t && rm -f /tmp/nginx.pid

USER nginx
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
