# F User Guide Tool

Công cụ web tự động hóa gói F trên WordPress qua WPM (login project → backup → tạo user → sync → Mac Role → Web Info).

**Branch:** deploy từ `main` · phát triển trên `develop`.

## Chạy local

```bash
cp .env.example .env
# Điền SECRET + mật khẩu admin (xem bên dưới) — không commit file .env
npm install
npm start
```

UI: http://localhost:3847 · Health: `GET /api/health`

## Cách dùng

| Ai | Cách vào |
|----|----------|
| Team | Mở URL tool → dùng thẳng (Run + Backup files). Không cần đăng nhập. |
| Admin | Phím tắt **Ctrl+Shift+A** → đăng nhập admin. Có thêm tab Báo cáo. |

- **WPM:** mỗi người lưu trên máy/trình duyệt của mình (không ghi đè nhau trên server).
- **Backup:** tick option trên form nếu muốn tải file về server (không zip).
- Tối đa vài job Chrome chạy song song trên server (cấu hình `MAX_CONCURRENT_JOBS`).

## Bảo mật (bắt buộc khi deploy / public repo)

- **Không** ghi mật khẩu admin / secret vào README, issue, chat công khai.
- Copy `.env.example` → `.env`, đặt:
  - `SESSION_SECRET`, `APP_SECRET` — chuỗi dài, ngẫu nhiên
  - `ADMIN_USER` / `ADMIN_PASS` — mật khẩu mạnh, **đổi ngay lần đầu**
- File `.env` và thư mục `data/` **không commit** (đã có trong `.gitignore`).
- Production: `NODE_ENV=production`, `HEADLESS=true`, `OPEN_BROWSER=false`, nên chạy sau HTTPS (nginx).
- Chỉ admin biết phím tắt + mật khẩu admin; không gửi cho cả team.

Chi tiết deploy VPS / Docker / nginx: **[DEPLOY.md](DEPLOY.md)**.

## Stack

- Node.js (Express) + Puppeteer (Chrome)
- Session auth · queue job · SSE log
- Docker / docker-compose sẵn trong repo

## API nhanh

| Endpoint | Mô tả |
|----------|--------|
| `GET /api/health` | Health check |
| `POST /api/guest` | Session team (mặc định) |
| `POST /api/login` | Đăng nhập admin |
| `POST /api/run` | Chạy job |
| `GET /api/runs` | Báo cáo (admin) |
| `GET /api/backups` | Danh sách backup trên server |
