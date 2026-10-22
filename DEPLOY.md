# MAC Tools — Deploy guide

## Yêu cầu server

- Node.js 22.23.4+ / 24.22.1+ / 26.12.1+ (bản vá CVE-2026-111497 — Brotli RCE; bản cũ hơn và Node 20 EOL đều dính)
- Google Chrome **hoặc** Chromium
- Ổ đĩa đủ chỗ nếu team tick tải backup UpdraftPlus
- (Khuyến nghị) reverse proxy HTTPS (nginx)

## Chạy nhanh (VPS)

```bash
git clone <repo> && cd mac-tools
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
Admin: cấu hình qua `ADMIN_EMAILS` (thêm email: `ADMIN_EMAILS=a@x.com,b@y.com`).

## Biến môi trường quan trọng

| Key | Ý nghĩa |
|-----|---------|
| `HEADLESS=true` | Chrome không UI (server) |
| `OPEN_BROWSER=false` | Không tự mở browser trên server |
| `SESSION_SECRET` / `APP_SECRET` | Session + mã hóa WPM password |
| `ADMIN_EMAILS` | Danh sách email admin (comma-separated) |
| `CHROME_PATH` | Path Chrome/Chromium nếu không tự tìm |
| `DOWNLOAD_DIR` | Thư mục lưu file backup |
| `MAX_CONCURRENT_JOBS` | `0` (mặc định) = không giới hạn job đồng thời; số nguyên dương = giới hạn do admin chọn |
| `PORT` | Mặc định `3847` |

Từ `2.1.1`, Compose không đặt quota CPU, ứng dụng không tự hạ CPU và không cần mount `docker.sock`. Các biến `DOCKER_CPU_*` / `ADAPTIVE_*` cũ không còn sử dụng. Chrome không bị ép tắt GPU; khả năng tăng tốc phụ thuộc phần cứng, driver và quyền truy cập thiết bị trong container.

CI chuyển `MAX_CONCURRENT_JOBS` sang `0`, xóa cấu hình CPU/adaptive cũ và recreate container để gỡ quota đang áp dụng. Deploy thủ công: cập nhật Compose, đặt `MAX_CONCURRENT_JOBS=0` trong `.env`, chạy `docker compose up -d --force-recreate`. Nhiều job đồng thời có thể tăng tải CPU/RAM; có thể đặt lại số job nếu host cần chia sẻ tài nguyên.

## Nginx mẫu (Socket.IO + Live Chrome WebSocket)

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}

server {
  listen 80;
  server_name your-domain.example.com;  # đổi thành domain thật của bạn

  # Socket.IO rooms (log/queue theo user) — BẮT BUỘC WebSocket
  location /socket.io/ {
    proxy_pass http://127.0.0.1:3847;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
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
Nếu log/queue không realtime sau F5: thêm block `/socket.io/` như trên.

### Domain thật (FlashVPS)
`https://tools.example.com` — nginx: `/etc/nginx/sites-available/user-guide`

### Checklist chạy mượt trên VPS
```bash
cd /home/USER/mac-tools
# 1) .env: CHROME_LIVE=true (hoặc false nếu team không cần Live), HEADLESS=false, secrets
#    Live mặc định tắt trên UI — user bấm Mở Live mới start x11vnc; Đóng Live = tắt (tiết kiệm CPU)
#    CPU không đặt quota; MAX_CONCURRENT_JOBS=0 để không chờ slot.
# 2) nginx có /socket.io/ + /chrome-live/ (WebSocket) + nginx -t && systemctl reload nginx
# 3) recreate để nhận image + deps socket.io: docker compose up -d --force-recreate
docker compose pull
docker compose up -d --force-recreate
docker compose ps
docker compose logs --tail=40
# Health
curl -s http://127.0.0.1:3847/api/health
# Xác nhận quota CPU đã gỡ: NanoCpus = 0, CpuQuota = 0 hoặc -1
docker inspect "$(docker compose ps -q fugt)" --format '{{.HostConfig.NanoCpus}} {{.HostConfig.CpuQuota}}'
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

Push `main` / tag `v*` → Actions **build → push GHCR → SSH VPS** (`/home/USER/mac-tools`) chạy:

`docker compose pull && docker compose up -d --force-recreate`

**Không cần SSH VPS hàng ngày** — chỉ `git push origin main` (hoặc merge `develop` → `main`). Xem progress: GitHub → Actions. VPS chỉ cần setup secrets + `.env` một lần.

Image: `ghcr.io/leovo2003/user-guide:latest`

#### GitHub Secrets (Settings → Secrets and variables → Actions)

| Secret | Ý nghĩa |
|--------|---------|
| `SSH_HOST` | IP hoặc domain VPS |
| `SSH_USER` | User SSH (vd. `USER`) |
| `SSH_PRIVATE_KEY` | Private key (nội dung file `~/.ssh/id_ed25519` hoặc deploy key) |
| `SSH_PORT` | (Tuỳ chọn) mặc định `22` |
| `GHCR_TOKEN` | PAT GitHub quyền `read:packages` (bắt buộc nếu package private) |
| `GHCR_USER` | Username GitHub (vd. `LeoVo2003`) |

#### Chuẩn bị VPS (một lần)

Deploy CI sẽ **tự tạo** `/home/USER/mac-tools` nếu chưa có, sync `docker-compose.yml` + `.env.example`.

Lần đầu nếu chưa có `.env`: CI copy từ `.env.example` rồi **dừng** — bạn SSH vào sửa `SESSION_SECRET` / `APP_SECRET`, chạy lại workflow.

```bash
# Chỉ cần sẵn trên VPS:
# - Public key trong ~/.ssh/authorized_keys của SSH_USER
# - User trong group docker
# (thư mục + compose do CI tạo)
nano /home/USER/mac-tools/.env   # sau lần deploy đầu
```

`.env` chỉ nằm trên VPS — không đưa vào image hay GitHub Secrets (trừ SSH/GHCR ở trên).

## Lưu ý vận hành

- User login WPM → Run dùng đúng tk đó; không còn form WPM trong Run.
- Tracking: `data/runs.jsonl` — tab Báo cáo (admin).
- Backup: bước Backup Now trên site (không tải file / không tab Backup files).
- Realtime: Socket.IO room `user:<id>` — F5 vẫn join lại channel của mình.
- Deploy từ `main`; test trên `develop`.

## Local (Windows/Mac)

```bash
npm install
npm start
```
