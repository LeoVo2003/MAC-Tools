# Handoff: HTTP Updraft Backup Now

| Field | Value |
|---|---|
| **Status** | Done (local — chưa push) |
| **Date** | 2026-08-04 |
| **Priority** | P1 |
| **Epic** | E2 — Hybrid HTTP 2.1 |
| **Requester** | Leo |
| **Owner** | PO+dev |

## Summary

Install/Activate Updraft đã HTTP OK. Tiếp: **Backup Now + chờ backup mới trên site** qua AJAX/in-page; fallback Chrome. Không tải file.

## Plan

`docs/superpowers/plans/2026-08-04-http-updraft-backup.md`

## Acceptance Criteria

- [ ] AC1: `USE_HTTP_STEPS=1` → start backup + chờ xong không cần click Backup Now (khi AJAX OK).
- [ ] AC2: Existing Backups có bản mới hơn trước khi bấm.
- [ ] AC3: Fail HTTP → fallback Chrome; không double-backup nếu job đang chạy.
- [ ] AC4: `USE_HTTP_STEPS=0` → Chrome full như cũ.

## Out of scope

- Download backup về máy
- Đổi timeout 6 phút (trừ khi user yêu cầu)

## Tasks

| # | Task | Done |
|---|---|---|
| 0 | Discovery: `updraft_ajax` + `backupnow` + nonce `updraftplus-credentialtest-nonce`; poll `activejobs_list` | [x] |
| 1 | `readUpdraftAjaxContext` | [x] |
| 2 | `startUpdraftBackupViaHttp` | [x] |
| 3–4 | `waitUntilNewBackupReadyHttp` (activejobs + reload DOM snapshot) | [x] |
| 5 | Wire + anti double-start nếu đã HTTP start | [x] |
| 6 | Verify local | [ ] user chạy lại job |

## API dùng

- POST `action=updraft_ajax&subaction=backupnow&nonce=…`
- GET `action=updraft_ajax&subaction=activejobs_list&nonce=…`
