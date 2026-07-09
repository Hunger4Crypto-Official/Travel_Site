# THE Travel Club - production image
# Zero runtime dependencies, so this is a single-stage, minimal build.
FROM node:22-alpine

# Fail fast and predictably in production.
ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

# Install dependencies first for better layer caching. There are no runtime
# dependencies today, so this is guarded to succeed with or without a lockfile
# and with or without a package.json requiring installs.
COPY package.json ./
COPY package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev || true

# Copy the rest of the application source.
COPY . .

# Drop privileges: the base image ships a non-root "node" user.
# Ensure the app directory is owned by that user so runtime file writes
# (optional JSONL stores under ./data) do not fail on permissions.
RUN chown -R node:node /app
USER node

EXPOSE 3000

# Liveness: hit the app's own /health endpoint using the built-in fetch.
# No curl/wget needed; exits non-zero when the server is unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
