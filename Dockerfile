# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# Build the Vite frontend → dist/
RUN npm run build

# Bundle the Express server to a single CJS file → dist/server.cjs
# --platform=node marks all Node built-ins (zlib, fs, path, …) as external.
# Everything else (express, cors, @aws-sdk) is inlined so no node_modules
# are needed at runtime.
RUN npx esbuild server/index.ts \
      --bundle \
      --platform=node \
      --format=cjs \
      --outfile=dist/server.cjs

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# Copy the self-contained build output
COPY --from=builder /app/dist ./dist

# Pre-create the cache directory with open permissions so the named volume
# initialises correctly on first run (Docker copies image dir contents into
# an empty volume on first mount).
RUN mkdir -p /cache && chmod 777 /cache

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    AWS_REGION=ap-southeast-1 \
    CACHE_DIR=/cache

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3000/ || exit 1

CMD ["sh", "-c", "mkdir -p $CACHE_DIR && chmod 777 $CACHE_DIR && node dist/server.cjs"]
