FROM node:20-alpine AS builder
WORKDIR /app
ENV NODE_ENV=production

# Copy manifests & tsconfig first (better layer cache)
COPY package.json package-lock.json* tsconfig.json ./
COPY offchain ./offchain
COPY types ./types
COPY scripts ./scripts

RUN npm ci --omit=dev
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Copy only what runtime needs
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/dist /app/dist
COPY config.yaml /app/config.yaml
COPY offchain/tools/inspect_liquidator.js /app/tools/inspect_liquidator.js
COPY scripts/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Metrics
EXPOSE 9464
CMD ["/app/entrypoint.sh"]
