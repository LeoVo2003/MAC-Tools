FROM node:22.23.4-bookworm-slim

# Chromium + virtual display + noVNC (live tương tác)
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
    xvfb \
    x11vnc \
    novnc \
    websockify \
    fluxbox \
    procps \
    && rm -rf /var/lib/apt/lists/*

# (S2) user không đặc quyền — container không chạy root
RUN useradd -m -u 1000 app

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY public ./public
COPY src ./src
COPY scripts ./scripts
COPY .env.example ./

RUN chmod +x /app/scripts/docker-entrypoint.sh

# CHROME_NO_SANDBOX=true là bắt buộc khi chạy non-root trong Docker mà không có
# SYS_ADMIN: Chromium sandbox cần userns/CLONE_NEWUSER, bị chặn bởi Docker seccomp
# mặc định + cap_drop. Đã đánh đổi có chủ ý (xem S2): giảm rủi ro bằng user non-root,
# cap_drop ALL, no-new-privileges thay vì tắt sandbox khi chạy root.
ENV NODE_ENV=production \
    OPEN_BROWSER=false \
    HEADLESS=false \
    CHROME_LIVE=true \
    DISPLAY=:99 \
    CHROME_PATH=/usr/bin/chromium \
    CHROME_NO_SANDBOX=true \
    MAX_CONCURRENT_JOBS=2 \
    PORT=3847 \
    DOWNLOAD_DIR=/data/downloads \
    NOVNC_PATH=/usr/share/novnc

# (S2/B4) thư mục dữ liệu thuộc user app — phải làm TRƯỚC VOLUME
# (mọi thay đổi sau VOLUME sẽ bị Docker bỏ qua)
RUN mkdir -p /data/downloads /app/data /app/errors \
    && chown -R app:app /app /data
VOLUME ["/data/downloads", "/app/data", "/app/errors"]

EXPOSE 3847
# (S2) chạy app bằng user không đặc quyền
USER app
ENTRYPOINT ["/app/scripts/docker-entrypoint.sh"]
