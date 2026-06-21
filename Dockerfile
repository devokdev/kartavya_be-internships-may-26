# Build stage
FROM node:23-alpine AS builder
RUN apk add --no-cache build-base python3
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# Production stage
FROM node:23-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/

# Create directory for persistent SQLite database
RUN mkdir -p data && chown -R node:node data

USER node
EXPOSE 8080

CMD ["node", "src/server.js"]
