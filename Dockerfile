FROM node:20-bookworm-slim

# Chromium + deps (Docker headless cần lib đầy đủ, không chỉ binary)
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    ca-certificates \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
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

RUN mkdir -p /data/downloads /data/appdata /app/errors
VOLUME ["/data/downloads", "/data/appdata"]

EXPOSE 3847
CMD ["node", "server.js"]
