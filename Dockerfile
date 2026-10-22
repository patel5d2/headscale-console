# Headscale Console — tiny, dependency-free image
FROM node:22-alpine

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
