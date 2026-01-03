# Multi-stage Dockerfile optimized for production and ffmpeg support

# Builder stage: install build tools, dependencies and compile TypeScript
FROM node:20-bullseye-slim AS builder
WORKDIR /app

# Install minimal runtime tools (no native build toolchain since current deps are pure JS)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
# If native addons are added later (node-gyp), re-add python3, make, g++ in the builder stage

# Copy package manifests and minimal build config, then install deps and run lifecycle scripts
COPY package*.json tsconfig.json ./
# We ignore lifecycle scripts during install here because prepare/build runs during `npm ci`
# and the source files are not available yet. Install dependencies without running scripts,
# then copy source and run the build step so tsc has access to the `src/` files.
RUN node --version && npm --version && npm ci --ignore-scripts --loglevel=verbose || (echo "npm ci failed, trying npm install --legacy-peer-deps --ignore-scripts" && npm install --legacy-peer-deps --no-audit --ignore-scripts --loglevel=info)

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
# We must ignore lifecycle scripts here because `prepare` triggers `tsc` which is a devDependency
# and won't be installed in production. Use `--ignore-scripts` to prevent build-time scripts.
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts || npm install --production --no-audit --no-fund --ignore-scripts

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
