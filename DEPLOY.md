# F User Guide Tool v2 — Deploy guide

## Yêu cầu server

- Node.js 20+
- Google Chrome **hoặc** Chromium
- Ổ đĩa đủ chỗ nếu team tick tải backup UpdraftPlus
- (Khuyến nghị) reverse proxy HTTPS (nginx)

## Chạy nhanh (VPS)

```bash
git clone <repo> && cd User-Guide
cp .env.example .env
# BẮT BUỘC sửa: SESSION_SECRET, APP_SECRET
# Production: HEADLESS=true, OPEN_BROWSER=false, NODE_ENV=production
npm install
npm start
# hoặc: npx pm2 start server.js --name fugt
```

UI: `http://SERVER_IP:3847`  
Health: `GET /api/health`

Login tool = **email + password WPM**. Không cần seed admin riêng.  
Admin mặc định: `leo.vo@macusaone.com` (thêm email: `ADMIN_EMAILS=a@x.com,b@y.com`).

## Biến môi trường quan trọng

| Key | Ý nghĩa |
|-----|---------|
| `HEADLESS=true` | Chrome không UI (server) |
| `OPEN_BROWSER=false` | Không tự mở browser trên server |
| `SESSION_SECRET` / `APP_SECRET` | Session + mã hóa WPM password |
| `ADMIN_EMAILS` | Thêm email admin (comma-separated), ngoài leo.vo@… |
| `CHROME_PATH` | Path Chrome/Chromium nếu không tự tìm |
| `DOWNLOAD_DIR` | Thư mục lưu file backup |
| `MAX_CONCURRENT_JOBS` | Số Chrome chạy song song (mặc định `4`) |
| `PORT` | Mặc định `3847` |

## Nginx mẫu (SSE + Live Chrome WebSocket)

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 80;
  server_name user-guide.keith;  # đổi domain

  # SSE log — không dùng Upgrade
  location /api/events {
    proxy_pass http://127.0.0.1:3847;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Connection '';
    proxy_buffering off;
    proxy_read_timeout 24h;
  }

  # noVNC Live Chrome — BẮT BUỘC WebSocket
  location /chrome-live/ {
    proxy_pass http://127.0.0.1:3847;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 24h;
  }

  location / {
    proxy_pass http://127.0.0.1:3847;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_buffering off;
  }
}
```

Nếu Live hiện logo noVNC + "无法连接 / Failed to connect": gần như chắc **proxy chưa forward WebSocket** — thêm block `/chrome-live/` như trên rồi reload nginx.

### Domain thật (FlashVPS)
`https://user-guide.kietvh.io.vn` — nginx: `/etc/nginx/sites-available/user-guide`

### Checklist chạy mượt trên VPS
```bash
cd /home/flashvps/User-Guide
# 1) .env: CHROME_LIVE=true (hoặc false nếu team không cần Live), HEADLESS=false, secrets
#    Live mặc định tắt trên UI — user bấm Mở Live mới start x11vnc; Đóng Live = tắt (tiết kiệm CPU)
# 2) nginx có /api/events + /chrome-live/ + nginx -t && systemctl reload nginx
docker compose pull
docker compose up -d --force-recreate
docker compose ps
docker compose logs --tail=40
# Health
curl -s http://127.0.0.1:3847/api/health
# IP egress (whitelist WPM)
curl -4 -s https://ifconfig.me; echo
```

## Docker

### Build local

```bash
docker compose up -d --build
```

Nhớ inject `.env` an toàn; không build secret vào image.

### Image từ GHCR + auto deploy

Push `main` / tag `v*` → Actions **build → push GHCR → SSH VPS** (`/home/flashvps/User-Guide`) chạy:

`docker compose pull && docker compose up -d`

Image: `ghcr.io/leovo2003/user-guide:latest`

#### GitHub Secrets (Settings → Secrets and variables → Actions)

| Secret | Ý nghĩa |
|--------|---------|
| `SSH_HOST` | IP hoặc domain VPS |
| `SSH_USER` | User SSH (vd. `flashvps`) |
| `SSH_PRIVATE_KEY` | Private key (nội dung file `~/.ssh/id_ed25519` hoặc deploy key) |
| `SSH_PORT` | (Tuỳ chọn) mặc định `22` |
| `GHCR_TOKEN` | PAT GitHub quyền `read:packages` (bắt buộc nếu package private) |
| `GHCR_USER` | Username GitHub (vd. `LeoVo2003`) |

#### Chuẩn bị VPS (một lần)

Deploy CI sẽ **tự tạo** `/home/flashvps/User-Guide` nếu chưa có, sync `docker-compose.yml` + `.env.example`.

Lần đầu nếu chưa có `.env`: CI copy từ `.env.example` rồi **dừng** — bạn SSH vào sửa `SESSION_SECRET` / `APP_SECRET`, chạy lại workflow.

```bash
# Chỉ cần sẵn trên VPS:
# - Public key trong ~/.ssh/authorized_keys của SSH_USER
# - User trong group docker
# (thư mục + compose do CI tạo)
nano /home/flashvps/User-Guide/.env   # sau lần deploy đầu
```

`.env` chỉ nằm trên VPS — không đưa vào image hay GitHub Secrets (trừ SSH/GHCR ở trên).

## Lưu ý vận hành

- User login WPM → Run dùng đúng tk đó; không còn form WPM trong Run.
- Tracking: `data/runs.jsonl` — tab Báo cáo (admin).
- Backup: tick option mới tải; tab **Backup files**.
- Deploy từ `main`; test trên `develop`.

## Local (Windows/Mac)

```bash
npm install
npm start
```
