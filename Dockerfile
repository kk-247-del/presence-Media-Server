FROM node:18-alpine

WORKDIR /app

# Copy package.json ONLY
COPY package.json ./

# Install dependencies
RUN npm install --omit=dev

# Copy server
COPY server.js ./

EXPOSE 8080

CMD ["npm", "start"]
