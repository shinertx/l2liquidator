FROM node:20-alpine as builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY offchain ./offchain
COPY config.example.yaml ./config.example.yaml
RUN npm run build || true

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app /app
CMD ["node","/app/dist/offchain/orchestrator.js"]
