FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public
COPY src ./src
COPY scripts ./scripts
COPY .env.example ./

ENV NODE_ENV=production \
    OPEN_BROWSER=false \
    HEADLESS=true \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=true \
    PORT=3847 \
    DOWNLOAD_DIR=/data/downloads

RUN mkdir -p /data/downloads /data/appdata
VOLUME ["/data/downloads", "/data/appdata"]

# App root dùng DOWNLOAD_DIR; data/users nằm cạnh app — mount nếu cần persist
EXPOSE 3847
CMD ["node", "server.js"]
