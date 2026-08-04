# HTTP Updraft Backup Now — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sau khi Updraft đã cài/active (HTTP), **bấm Backup Now + chờ backup mới xong** cũng đi AJAX/in-page HTTP; Chrome chỉ fallback. Không tải file về máy (giữ rule hiện tại).

**Architecture:** Giống install: thao tác **trong tab WP** (`fetch` + `credentials: 'include'`). Trigger backup qua AJAX Updraft (không click UI nếu có command ổn định); poll trạng thái job / Existing Backups bằng AJAX hoặc HTML parse; reuse logic “backup mới hơn beforeSnap” từ `waitUntilNewBackupReady`.

**Tech Stack:** Puppeteer page + in-page `fetch`, Updraft admin-ajax (`updraft_ajax` / tương đương đọc từ DOM), `USE_HTTP_STEPS`.

## Global Constraints

- Không đổi nghiệp vụ bước Backup (vẫn “có bản rollback trên site”).
- **Không** tải zip backup về máy / VPS (đã bỏ).
- `USE_HTTP_STEPS=0` → toàn bộ install + backup Chrome như cũ.
- Install/activate HTTP **đã xong** — plan này chỉ phần **Backup Now → chờ xong**.
- Timeout chờ ~6 phút (giữ); hủy job vẫn tôn trọng `shouldCancel`.
- Lesson từ install: **không** dùng GET nonce dễ “link expired”; ưu tiên AJAX + nonce `updates`/Updraft từ page localize.

---

## Hiện trạng

| Pha | Cách làm | Status |
|---|---|---|
| Install + Activate Updraft | HTTP in-page / admin-ajax `install-plugin` | **Done** |
| Mở settings | `page.goto` options-general `page=updraftplus` | Chrome |
| Backup Now + confirm modal | Click `#updraft-backupnow-button` + modal | Chrome |
| Chờ backup mới | Poll DOM progress + `snapshotNewestBackup` | Chrome |

File: `src/steps/backup.js` — `installAndBackupUpdraftPlus` từ dòng Backup Now trở đi.

---

## Nghiên cứu Updraft AJAX (Task 0 — bắt buộc trước code)

Updraft UI gọi JS kiểu `updraft_send_command(...)`. Cần **đọc trên 1 site thật** (DevTools / `page.evaluate`):

- [ ] Biến nonce: `ud_nonce`, `updraft_credentialtest_nonce`, script localize…
- [ ] `ajaxurl` + `action` / `subaction` khi bấm Backup Now (files + DB)
- [ ] Endpoint poll active jobs / khi nào coi là finished
- [ ] Response shape (JSON) khi start + khi complete

**Ghi kết quả** vào comment đầu helper HTTP hoặc bảng ngắn trong handoff trước khi merge.

Nếu AJAX không ổn định giữa bản Updraft: **Plan B** = HTTP chỉ poll Existing Backups; trigger vẫn click 2 nút (nhanh hơn chờ UI dài).

---

## Phase 1 — Trigger Backup Now (HTTP)

### Task 1: Helper `readUpdraftAjaxContext(page)`

- [ ] Từ DOM/script: `ajaxurl`, nonce(s), version hints
- [ ] Fail rõ nếu thiếu nonce → throw để fallback Chrome

### Task 2: `startUpdraftBackupViaHttp(page, log)`

- [ ] POST admin-ajax với đúng payload Backup Now (files+DB như UI mặc định — **không** đổi option remote storage)
- [ ] Log: `HTTP: Updraft backupnow…`
- [ ] Success: job id / “started”; fail → throw
- [ ] Xử lý “already running” nếu Updraft báo job đang chạy

**AC:** Không còn phụ thuộc click `#updraft-backupnow-button` khi HTTP OK.

---

## Phase 2 — Chờ backup mới (HTTP poll)

### Task 3: Snapshot “before” không chỉ DOM click-path

- [ ] `snapshotNewestBackupHttp(page)` — parse HTML Existing Backups **hoặc** AJAX list nếu có
- [ ] Cùng contract: `{ timestamp, label }` để so sánh với logic hiện tại
- [ ] Tái sử dụng parse ngày `Jul …` đã fix

### Task 4: `waitUntilNewBackupReadyHttp(...)`

- [ ] Poll mỗi 1.5–2s (giống hiện tại)
- [ ] Nguồn tín hiệu (ưu tiên AJAX activejobs nếu Task 0 xác nhận; không thì reload HTML tab backups)
- [ ] Điều kiện xong = **hàng mới hơn beforeSnap + finished** (copy rule từ `waitUntilNewBackupReady`)
- [ ] `shouldCancel` → abort
- [ ] Timeout 6 phút + message giống cũ

**AC:** Site có backup mới trên Existing Backups; log `✓ Backup trên site xong`.

---

## Phase 3 — Wire + fallback

### Task 5: Đổi `installAndBackupUpdraftPlus`

```text
ensure install/active (HTTP đã có)
→ if USE_HTTP_STEPS: try start+wait HTTP
→ catch → log fallback → Chrome click + waitUntilNewBackupReady hiện tại
```

- [ ] Không double-start backup (HTTP đã start rồi fail giữa chờ → Chrome không bấm Backup Now lại nếu detect job đang chạy)
- [ ] Sau HTTP success: optional `goto` settings chỉ để Live snapshot đẹp (không bắt buộc)

### Task 6: Verify

- [ ] Local: site chưa có Updraft → install HTTP + backup HTTP (hoặc hybrid)
- [ ] Site đã có Updraft → chỉ backup HTTP
- [ ] `USE_HTTP_STEPS=0` → pure Chrome
- [ ] Hủy job giữa lúc chờ

---

## Out of scope

- Tải file backup về `DOWNLOAD_DIR`
- HTTP hóa Sync WPM
- Đổi công thức password / security secrets

---

## Risks

| Risk | Mitigation |
|---|---|
| Updraft đổi tên `subaction` theo version | Task 0 discovery; fallback Chrome |
| Poll HTML không thấy hàng mới (cache tab) | Rescan / gọi AJAX list; giữ timeout + message rõ |
| HTTP start OK nhưng poll fail → Chrome bấm Backup lần 2 | Detect active job trước khi click fallback |
| Backup dài >6 phút | Giữ timeout; không tăng trừ khi user yêu cầu |

---

## Files

| File | Việc |
|---|---|
| `src/steps/backup.js` | Helpers HTTP backup + wire fallback |
| `docs/handoffs/2026-08-04-http-updraft-backup.md` | Tracking |
| (tuỳ) `docs/PO-PRODUCT-PACK.md` | Ghi E2: Backup Now HTTP |

---

## Implementation order

1. Task 0 — capture AJAX trên 1 site (5–15 phút tay / DevTools)  
2. Task 1–2 — start backup HTTP  
3. Task 3–4 — wait HTTP  
4. Task 5–6 — wire + test  

**Ước lượng:** ~0.5–1 ngày nếu Task 0 rõ; lâu hơn nếu phải Plan B (click trigger + HTTP poll only).
