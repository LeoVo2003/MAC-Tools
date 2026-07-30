# F User Guide Tool

Công cụ web tự động hóa gói F trên WordPress qua WPM (login project → backup → tạo user → sync → Mac Role → Web Info).

**Version:** `2.1.0` — HTTP/DOM (createUser, Mac Core/Role, Web Info) + fallback Chrome. Mốc ổn định trước đó: tag `v2.0.0`.

**Branch:** deploy từ `main` · phát triển trên `develop`.

## Chạy local

```bash
cp .env.example .env
# Điền SESSION_SECRET + APP_SECRET (chuỗi mạnh) — không commit file .env
npm install
npm start
```

UI: http://localhost:3847 · Health: `GET /api/health`

## Cách dùng

1. **Đăng nhập** bằng **email + password WPM** (cùng tk đăng nhập WPM).
2. Lần đầu login → tool tự tạo user, lưu WPM (mã hóa) trên server (`data/users.json`).
3. Vào **Run** — không cần nhập lại WPM; job dùng tk đang login.
4. Tab **Backup files** cho mọi user đã login.
5. Tab **Báo cáo** chỉ hiện với admin.

**Admin:** email `leo.vo@macusaone.com` luôn là admin (có thể thêm email qua `ADMIN_EMAILS` trong `.env`).

## Bảo mật (deploy)

- Không ghi mật khẩu / secret vào README hay chat công khai.
- `.env` và `data/` **không commit**.
- Production: `NODE_ENV=production`, `HEADLESS=true`, `OPEN_BROWSER=false`, nên HTTPS.
- `SESSION_SECRET` / `APP_SECRET` phải đặt chuỗi dài, ngẫu nhiên.

Chi tiết VPS / Docker / nginx: **[DEPLOY.md](DEPLOY.md)**.

## Stack

- Node.js (Express) + Puppeteer (Chrome)
- Session auth · queue job · Socket.IO log
- User store: `data/users.json` (WPM password mã hóa AES)

## API nhanh

| Endpoint | Mô tả |
|----------|--------|
| `GET /api/health` | Health check |
| `POST /api/login` | Login bằng email/password WPM |
| `POST /api/run` | Chạy job (WPM lấy từ session) |
| `GET /api/runs` | Báo cáo (admin) |
| `GET /api/backups` | Danh sách backup trên server |
