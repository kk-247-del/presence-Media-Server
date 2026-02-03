FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --production

# Copy the server code (Ensure this matches your filename!)
COPY index.js ./ 

ENV NODE_ENV=production
# The port is provided by Railway at runtime
EXPOSE 8080

CMD ["node", "index.js"]
