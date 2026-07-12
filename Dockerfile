FROM node:24.4.1-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/* \
 && npm ci && find . -name "*.tsbuildinfo" -delete && npm run build && npm prune --omit=dev

FROM node:24.4.1-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3050 DATA_DIR=/app/data
WORKDIR /app
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/backend/package.json ./apps/backend/package.json
COPY --from=build --chown=node:node /app/apps/backend/dist ./apps/backend/dist
COPY --from=build --chown=node:node /app/apps/frontend/dist ./apps/frontend/dist
COPY --from=build --chown=node:node /app/packages/shared ./packages/shared
RUN mkdir -p /app/data /app/logs /app/staging && chown -R node:node /app/data /app/logs /app/staging
USER node
EXPOSE 3050
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:3050/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["npm", "start", "--workspace", "apps/backend"]
