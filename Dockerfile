# Build stage
FROM node:23-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci

# Production stage
FROM node:23-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package*.json ./
RUN npm ci --only=production

COPY src/ ./src/

# Create directory for persistent SQLite database
RUN mkdir -p data && chown -R node:node data

USER node
EXPOSE 8080

CMD ["node", "src/server.js"]
