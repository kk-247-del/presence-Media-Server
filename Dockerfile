FROM node:18-alpine

WORKDIR /app

# Copy package files FIRST (critical for caching)
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --omit=dev

# Copy application code
COPY server.js ./

# Create temp directory
RUN mkdir -p tmp

EXPOSE 8080

CMD ["node", "server.js"]
