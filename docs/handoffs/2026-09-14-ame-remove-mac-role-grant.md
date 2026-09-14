# Handoff: Gỡ Admin Menu Editor + bật Grant caps Mac Role

| Field | Value |
|---|---|
| **Status** | Done |
| **Date** | 2026-09-14 |
| **Priority** | P1 |
| **Epic** | E2 — Hybrid HTTP 2.1 / F Package |
| **Requester** | Leo |
| **Owner** | PO+dev |

## Summary

1. Trong bước Backup: trước Updraft — nếu có plugin Admin Menu Editor thì Deactivate + Delete.
2. Sau Create F Package User: vào `mac-role-settings`, bật “Grant WordPress capabilities for allowed URLs”, Save. HTTP ưu tiên, Chrome fallback.

## Acceptance Criteria

- [x] AC1: Có AME (free/pro) → gỡ sạch; không có → log skip, tiếp Updraft.
- [x] AC2: Fail gỡ AME → log cảnh báo, vẫn tiếp Backup (không fail cả job trừ khi user muốn cứng — mặc định warn+continue).
- [x] AC3: Sau Create F → Grant caps ON + Save (HTTP rồi Chrome).
- [x] AC4: `USE_HTTP_STEPS=0` → chỉ Chrome cho cả hai.

## Out of scope

- Tick UI riêng cho AME.
- Đổi thứ tự bước 1→6 trên form.

## Notes

- AME gắn trong bước `backup` (check plugin trước Updraft).
- Slug: `admin-menu-editor` / file thường `admin-menu-editor/menu-editor.php`; cũng check pro.
- Files: `src/steps/pluginsCleanup.js`, wire `backup.js`, Grant caps trong `macRole.js` sau `configureFPackageUser`.
