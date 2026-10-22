# Fully pinned multi-arch index digest from docker-library/repo-info (2026-09).
# Retain and rotate this digest deliberately, not automatically during deployment.
FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src/ ./src/
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ENV NODE_ENV=production UMICH_MCP_HTTP_HOST=0.0.0.0 UMICH_MCP_HTTP_PORT=8080
WORKDIR /app
# The server runs on node alone: the npm CLI is not used at runtime, and the
# copy that ships in the base image carries high severity advisories of its
# own. Removing it leaves the image with the server and its runtime
# dependencies only, and the vulnerability scan with nothing to report.
RUN rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/share/man/man1/npm.1 \
    /usr/local/share/man/man1/npx.1
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/package.json ./package.json
USER node
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e 'fetch("http://127.0.0.1:8080/healthz",{headers:{host:"umich-dining-mcp.duckdns.org"}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
CMD ["node", "dist/http-server.js"]
