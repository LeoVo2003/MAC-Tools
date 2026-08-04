# Handoff: Quick Login / lần 2 / 2 web — báo lỗi dù login sẵn

| Field | Value |
|---|---|
| **Status** | Done (local — chờ verify lần 2 / 2 web) |
| **Date** | 2026-08-04 |
| **Priority** | P1 |
| **Epic** | E1 — Core runner |
| **Requester** | Leo (team báo) |
| **Owner** | PO+dev |

## Summary

Team báo: login sẵn, lần 1 Done, lần 2 chạy lỗi — thường project **2 web**.

## Evidence (local)

```
Bấm Quick Login CHỈ trên card https://musenailslounge.macmar.us...
Đã vào WordPress (https://musenaillounge.com): https://wpm.../projects/3105/edit?tab=tab-web-info
```

→ Tool **log “Đã vào WordPress” dù vẫn ở WPM** (không tab WP / timeout / nhầm tab). Bước sau fail → người dùng hiểu là “login lỗi”.

## Root cause

`openProjectAndQuickLogin` chờ tab mới 15s; hết giờ vẫn `wpPage = page` (WPM) và **không verify** URL có `wp-admin` + đúng host target.

## Acceptance Criteria

- [ ] AC1: Sau Quick Login phải vào được URL host khớp target + `wp-admin`/`wp-login` (hoặc origin site).
- [ ] AC2: Không khớp → throw rõ (không log “Đã vào WordPress” giả).
- [ ] AC3: Ưu tiên tab mới có host = target; bỏ tab WP của web khác nếu có.
- [ ] AC4: Timeout chờ WP đủ dài (~45s).

## Clarification (Leo)

Không phải 2 card cùng 1 project — là **job khác / project khác / web khác** (lần 1 Done → lần 2 lỗi). “Login sẵn” = người báo đang / session đã login rồi mà Run lần 2 vẫn lỗi.

Cần **đúng dòng `❌ Lỗi: …`** từ Log lần 2 để chốt root cause (WPM login / Quick Login / bước khác).

Quick Login verify host vẫn giữ (tránh log giả “Đã vào WordPress”) nhưng có thể không phải case chính của báo cáo này.
