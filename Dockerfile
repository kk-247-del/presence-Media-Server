 FROM node:18-alpine

WORKDIR /app

# Copy package.json ONLY
COPY package.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy server code
COPY server.js ./

# Create tmp dir (optional safety)
RUN mkdir -p tmp

EXPOSE 8080

CMD ["node", "server.js"]
