# Handoff: Bỏ giới hạn tài nguyên và độ trễ Live

| Field | Value |
|---|---|
| Status | Done (local — đẩy git) |
| Date | 2026-09-10 |
| Priority | P0 |
| Epic | E3 — VPS Performance |

## Yêu cầu và phạm vi

User yêu cầu bỏ mọi giới hạn gây chậm trải nghiệm (CPU/concurrent/Live throttle) vì đã chuyển VPS mạnh hơn; push phiên bản mới nhất. Module: Browser, Queue, Live, Health, Deploy.

## Acceptance Criteria

- [x] Chrome không bị truyền cờ tắt GPU.
- [x] Compose không có quota CPU; đã xóa `dockerCpuScale.js` / `hostPressure.js`.
- [x] Job mặc định không chờ slot (`MAX_CONCURRENT_JOBS=0`).
- [x] Live không throttle 4 fps / snapshot không trễ một dòng log.
- [x] CI gỡ cấu hình cũ khi recreate; version `2.1.1`.
- [x] `npm test` pass (liveSession).

## Log VPS cũ (báo cáo)

File nguồn: Docker volume `fugt_data` → `/app/data/runs.jsonl` (và có thể `users.json`).
VPS chết → phải lấy từ snapshot/disk/backup FlashPanel; VPS mới không tự có volume cũ.
