# Multi-stage Dockerfile optimized for production and ffmpeg support

# Builder stage: install build tools, dependencies and compile TypeScript
FROM node:20-bullseye-slim AS builder
WORKDIR /app

# Install minimal build dependencies for native modules if needed
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 g++ make \
  && rm -rf /var/lib/apt/lists/*

# Copy package manifests and minimal build config, then install deps and run lifecycle scripts
COPY package*.json tsconfig.json ./
# Prefer npm ci when package-lock.json is present
RUN npm ci

# Copy remaining source and build application
COPY . .
RUN npm run build

# Runtime stage: smaller image, ffmpeg installed for stream snapshots
FROM node:20-bullseye-slim
WORKDIR /app

# Install ffmpeg and minimal runtime deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Create a non-root user to run the app
RUN groupadd -r app && useradd -r -g app app && mkdir -p /app && chown app:app /app

# Copy package files and install only production dependencies
COPY package*.json ./
# Use npm ci for reproducible installs when possible, otherwise fall back
RUN npm ci --omit=dev --no-audit --no-fund || npm install --production --no-audit --no-fund

# Copy built artifacts from the builder
COPY --from=builder /app/dist ./dist

# Set ownership and switch to non-root user
RUN chown -R app:app /app
USER app

ENV NODE_ENV=production
# Default path to look for config inside container (can be overridden with CONFIG_PATH env var)
ENV CONFIG_PATH=/app/config.yaml

# Start the application
CMD ["node", "dist/index.js"]
