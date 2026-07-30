# Handoff: Refactor — gỡ code không dùng trong `src`

| Field | Value |
|---|---|
| **Status** | Done |
| **Date** | 2026-07-30 |
| **Priority** | P2 |
| **Epic** | E1 — Core maintain / hygiene |
| **Requester** | Leo |
| **Owner** | PO+dev (chat này) |

## Summary

Gỡ code/file/`export` trong `src` (và chỉ đụng ngoài `src` nếu bắt buộc) không còn được gọi — giảm nhiễu, tránh nhầm SSE/noVNC/legacy.

## Context

- Pain: codebase còn remnant (SSE, noVNC, bước/API cũ) sau nhiều iteration.
- Pack: maintain / docs lệch.
- Module ảnh hưởng: có thể Runner, HTTP, Live, steps — **không đổi nghiệp vụ**.

## User Story

**Là** dev maintain tool,  
**tôi muốn** xóa phần không dùng trong `src`,  
**để** dễ đọc và giảm rủi ro sửa nhầm code chết.

## Acceptance Criteria

- [x] AC1: Liệt kê rõ file/symbol bị xóa (trong handoff Kết quả).
- [x] AC2: Không đổi hành vi Fill/Run 1→6 / Auth / Queue / HTTP 2.1 đang dùng.
- [x] AC3: `node` load được entry chính (require graph không gãy); smoke tối thiểu nếu có script sẵn.
- [x] AC4: Không xóa config/secret; không đụng `.env`.

## Out of scope

- Tối ưu performance VPS / adaptive CPU
- Refactor logic nghiệp vụ “cho đẹp”
- Đổi UI lớn / xóa noVNC nếu vẫn được wire vào route đang serve (chỉ gỡ nếu dead)

## Tasks

| # | Task | Depends on | Done |
|---|---|---|---|
| 1 | Map `src` entry + require/import graph | — | [x] |
| 2 | Đánh dấu dead files / dead exports / comment block lớn | 1 | [x] |
| 3 | Xóa an toàn + cập nhật require | 2 | [x] |
| 4 | Smoke / verify load | 3 | [x] |

## Kết quả (điền khi xong)

**Không có file `src/` orphan** — toàn bộ module vẫn được wire. Đã xóa symbol chết:

| File | Đã gỡ |
|---|---|
| `src/auth.js` | `optionalAuth` |
| `src/backupsApi.js` | `listBackupFiles`, `resolveBackupFile`, `safeResolveUnder` (giữ `listBackupFolders`) |
| `src/dockerCpuScale.js` | `scaleCpuLive`, `scaleCpuIdle` |
| `src/envStore.js` | `readEnvFile`, `upsertEnvVars` (+ bỏ `fs`) |
| `src/realtime.js` | `getIo` |
| `src/browser.js` | `newPage` |
| `src/steps/fillData.js` | `usernameFromWebsiteUrl` (deprecated) |
| `src/steps/wpm.js` | `resolveMainWeb`, `expandWebCard` |
| `src/jobQueue.js` | comment SSE → Socket.IO |
| `README.md` | SSE → Socket.IO (lệch docs) |

**Giữ nguyên (vẫn wire):** chromeLive / liveVnc / liveSession / noVNC path, HTTP hybrid, steps Run.

- Commit / PR: chưa (local only)
- Smoke: `node --check` + dynamic import các module đã sửa — OK
- Cập nhật pack/backlog: Không (hygiene)
