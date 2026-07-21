# F User Guide Tool

**v2.0-dev** (đang chuyển hướng web). Mốc v1: folder `Auto F Package-v1.0-milestone-2026-07-21` cạnh project.

Tool local/tự host — tự động hoá quy trình tạo tài khoản khách **gói F**:

WPM login → Quick Login → UpdraftPlus backup (tải file, không zip) → tạo user → sync WPM → Mac Core → Mac Role → (tuỳ) điền Task Output → xuất kết quả.

Dùng **Google Chrome hệ thống + Puppeteer Extra Stealth**.

## Cài đặt (dev)

```bash
npm install
npm start
```

UI: http://localhost:3847 — cần Google Chrome.

Tracking lượt chạy: `GET /api/runs` (file `data/runs.jsonl`).

### Tài khoản WPM

UI → **Tài khoản WPM** → Lưu (ghi `.env` trên máy đó).

## Gửi team offline (v1 zip — tạm giữ)

```bash
npm run build:release
```

Zip folder: `release/F User Guide Tool/` — v2 sẽ ưu tiên deploy web, không gửi zip mỗi lần update.

## Biến môi trường

| Biến | Ý nghĩa |
|------|---------|
| `WPM_USERNAME` / `WPM_PASSWORD` | Tài khoản WPM (ưu tiên lưu từ UI) |
| `HEADLESS` | `false` (mặc định) / `true` (web/server) |
| `CHROME_PATH` | Path Chrome nếu không tự tìm được |
| `PORT` | Port UI (mặc định `3847`) |
| `DOWNLOAD_DIR` | Thư mục tải backup |
| `SPEED` | `fast` / `normal` / `slow` |

## Cấu trúc

```
server.js          Express + SSE log + /api/runs
public/            Form UI
src/browser.js     Chrome + stealth
src/runJob.js      Orchestration
src/tracking.js    Ghi nhận lượt chạy (v2)
src/steps/         wpm, backup, user, macRole, webInfo, task
```
