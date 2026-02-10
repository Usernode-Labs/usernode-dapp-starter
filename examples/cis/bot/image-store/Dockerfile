FROM node:20-alpine

WORKDIR /app

# No npm dependencies — just stdlib.
COPY --chown=node:node server.js ./

RUN mkdir -p /app/data && chown node:node /app/data
USER node

ENV PORT=8001
EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=3s --start-period=2s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
