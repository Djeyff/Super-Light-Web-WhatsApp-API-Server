FROM node:20-alpine

WORKDIR /app

# Build tools for native modules (better-sqlite3, bcrypt)
RUN apk add --no-cache python3 make g++

# Install dependencies
COPY package*.json ./
RUN npm install

# Copy app source
COPY . .

# Create persistent data directories
RUN mkdir -p data sessions logs uploads auth_info_baileys

EXPOSE 3000

CMD ["node", "index.js"]
