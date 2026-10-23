# syntax=docker/dockerfile:1
# Compile on the builder's native architecture: the output is portable JS/WASM.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig*.json ./
COPY src ./src
COPY public ./public
RUN npm run build

# Reuse a locally built Browser SSH client when present. CI builds the pinned
# Headplane source using scripts/build-ssh.sh. --target app omits Browser SSH.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS ssh
RUN apk add --no-cache bash git patch
COPY scripts/build-ssh.sh public/ss[h] /stage/
RUN if [ -s /stage/hp_ssh.wasm ] && [ -s /stage/wasm_exec.js ]; then \
      mkdir -p /out && cp /stage/hp_ssh.wasm* /stage/wasm_exec.js /stage/LICENSE.headplane /out/; \
    else bash /stage/build-ssh.sh /out; fi

FROM node:22-alpine AS app
LABEL org.opencontainers.image.title="headscale-console" \
      org.opencontainers.image.description="Web admin console for Headscale. Run: docker run -d --name headscale-console --restart unless-stopped -p 8090:8080 -v headscale-console-data:/data ghcr.io/patel5d2/headscale-console:latest then open http://localhost:8090" \
      org.opencontainers.image.source="https://github.com/patel5d2/headscale-console" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/data
WORKDIR /app
COPY --from=build /build/package.json ./
COPY --from=build /build/dist ./dist
COPY --from=build /build/public ./public
# The runtime has no npm dependencies. Keep code read-only to the service user.
RUN rm -rf public/ssh && \
    chmod 0755 dist/cli/hsconsole.js && \
    ln -s /app/dist/cli/hsconsole.js /usr/local/bin/hsconsole && \
    mkdir -p /data && chown node:node /data && chmod 0700 /data
VOLUME ["/data"]
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "dist/server/server.js"]

FROM app AS full
COPY --from=ssh /out ./public/ssh
