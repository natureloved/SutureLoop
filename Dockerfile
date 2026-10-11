# SutureLoop Autonomous Self-Healing Agent
# Production Dockerfile
FROM node:22-alpine

WORKDIR /app

# Install git (required for Entire code graph & Git safety-net checkpoints)
RUN apk add --no-cache git

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy application source code and web assets
COPY . .

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

# Launch SutureLoop Mission Control & Telemetry Server
CMD ["npm", "run", "serve"]
