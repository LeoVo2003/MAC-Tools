# F User Guide Tool v2 — Deploy guide

## Yêu cầu server
- Node.js 20+
- Google Chrome **hoặc** Chromium
- Ổ đĩa đủ chỗ tải backup UpdraftPlus
- (Khuyến nghị) reverse proxy HTTPS (nginx)

## Chạy nhanh (VPS)
```bash
git clone <repo> && cd User-Guide
cp .env.example .env
# sửa SESSION_SECRET, APP_SECRET, ADMIN_PASS, HEADLESS=true, OPEN_BROWSER=false
npm install
npm start
# hoặc: npx pm2 start server.js --name fugt
```

UI: `http://SERVER_IP:3847`  
Health: `GET /api/health`

Login mặc định lần đầu: `admin` / `admin123` (đổi ngay).

## Biến môi trường quan trọng
| Key | Ý nghĩa |
|-----|---------|
| `HEADLESS=true` | Chạy Chrome không UI (server) |
| `OPEN_BROWSER=false` | Không tự mở browser trên server |
| `SESSION_SECRET` / `APP_SECRET` | Session + mã hóa WPM password |
| `ADMIN_USER` / `ADMIN_PASS` | Seed admin nếu chưa có user |
| `WEB_USER` / `WEB_PASS` | Seed acc team (`web` / `web@123`) — chỉ Run + Backup |
| `CHROME_PATH` | Path Chrome/Chromium nếu không tự tìm |
| `DOWNLOAD_DIR` | Thư mục lưu file backup |
| `MAX_CONCURRENT_JOBS` | Số Chrome chạy song song (mặc định `4`) |
| `PORT` | Mặc định 3847 |

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

## Lưu ý vận hành
- Team vào thẳng (không login). Admin: **Ctrl+Shift+A**.
- WPM lưu **trên từng máy** (localStorage) — nhiều người dùng chung tool, mỗi người 1 tk WPM.
- Tracking: `data/runs.jsonl` — UI tab **Báo cáo** (admin) hoặc `GET /api/runs`.
- Backup files: tick option trên form mới tải; tab **Backup files** hoặc `GET /api/backups`.
- Branch recommend: deploy từ `main` (ổn định); dev test trên `develop`.

## Local (máy Windows/Mac)
```bash
npm install
npm start
# hoặc double-click "F User Guide Tool.bat"
```
