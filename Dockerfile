# Headscale Console — tiny, dependency-free image

# Stage 1: build the Browser SSH client (Tailscale compiled to WebAssembly).
# Skip it with: docker build --target app .  (Browser SSH is then unavailable.)
FROM golang:1.27-alpine AS ssh
RUN apk add --no-cache bash git patch
COPY scripts/build-ssh.sh /build-ssh.sh
RUN bash /build-ssh.sh /out

FROM node:22-alpine AS app

LABEL org.opencontainers.image.title="headscale-console" \
      org.opencontainers.image.description="Tailscale-style web admin console for Headscale"

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app
COPY --chown=node:node package.json server.js host.js ./
COPY --chown=node:node public ./public

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1

CMD ["node", "server.js"]

# Default target: the app plus the Browser SSH client.
FROM app
COPY --from=ssh --chown=node:node /out ./public/ssh
