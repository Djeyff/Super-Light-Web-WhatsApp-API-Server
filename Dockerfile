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
# In Zeabur: mount a volume at /app/data to survive restarts
RUN mkdir -p /app/data/auth_info_baileys /app/data/sessions /app/data/uploads /app/logs

# Environment defaults for persistent storage
# Override these with Zeabur env vars pointing to the mounted volume
ENV DATABASE_PATH=/app/data/whatsapp.db
ENV AUTH_DIR=/app/data/auth_info_baileys
ENV SESSION_STORE_PATH=/app/data/sessions

EXPOSE 3000

CMD ["node", "index.js"]
