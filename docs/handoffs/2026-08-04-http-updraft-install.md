# Handoff: HTTP install/activate UpdraftPlus

| Field | Value |
|---|---|
| **Status** | Done (local — chưa push) |
| **Date** | 2026-08-04 |
| **Priority** | P1 |
| **Epic** | E2 — Hybrid HTTP 2.1 |
| **Requester** | Leo |
| **Owner** | PO+dev |

## Summary

Cài + activate UpdraftPlus bằng GET/POST HTTP (cookie sau Quick Login); **Backup Now** vẫn Chrome. Fallback Chrome nếu HTTP fail.

## Acceptance Criteria

- [x] AC1: HTTP install + activate UpdraftPlus (`ensureUpdraftInstalledAndActiveViaHttp`).
- [x] AC2: Đã active → skip (settings OK).
- [x] AC3: Fail → fallback Chrome; Backup Now vẫn DOM.
- [x] AC4: `USE_HTTP_STEPS=0` → chỉ Chrome.

## Kết quả

- `src/steps/backup.js`: HTTP check/install/activate + wrapper fallback; Backup Now không đổi.
- Out of scope: HTTP Backup Now.
