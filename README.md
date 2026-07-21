# F User Guide Tool

**v2.0-dev** — web multi-user (auth, queue, báo cáo, tải backup).

Xem [DEPLOY.md](DEPLOY.md) để deploy VPS/Docker.

```bash
npm install
npm start
```

UI: http://localhost:3847

Login:
- Team: **không cần login** — mở tool là vào thẳng (Run + Backup).
- Admin: bấm **Ctrl+Shift+A** → đăng nhập `admin` / `admin123`.
- WPM: mỗi người lưu trên **máy/trình duyệt của mình** (10 người dùng chung tool vẫn mỗi người 1 tk WPM).

## Tính năng v2
- Đăng nhập tool; WPM credentials theo từng user
- Queue 1 job Chrome tại một thời điểm
- Tab Báo cáo (`/api/runs`)
- Tab Backup files (tải file, không zip)
- Health: `/api/health`

Mốc v1: folder `Auto F Package-v1.0-milestone-2026-07-21` cạnh project.
