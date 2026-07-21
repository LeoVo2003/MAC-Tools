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

## Nginx mẫu

```nginx
server {
  listen 80;
  server_name tool.example.com;
  location / {
    proxy_pass http://127.0.0.1:3847;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Connection '';
    proxy_buffering off; /* SSE */
  }
}
```

## Docker

```bash
docker compose up -d --build
```

Nhớ inject `.env` an toàn; không build secret vào image.

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
