# Handoff: Queue mọi người thấy + Import CSV admin

| Field | Value |
|---|---|
| **Status** | Done |
| **Date** | 2026-11-03 |
| **Priority** | P1 |
| **Epic** | Admin / Queue |
| **Requester** | Leo |
| **Owner** | Auto |

## Summary

User thường phải thấy hết job đang chạy/chờ (không chỉ của mình). Admin import CSV lịch sử từ User Guide cũ và Review Link cũ vào Dashboard.

## User Story

**Là** web team  
**tôi muốn** thấy ai đang chạy/chờ trong queue  
**để** biết vì sao job mình chưa chạy.

**Là** admin  
**tôi muốn** import CSV tool cũ  
**để** Dashboard còn lịch sử cũ.

## Acceptance Criteria

- [ ] AC1: `/api/queue` trả toàn bộ job cho mọi user đã login.
- [ ] AC2: UI hàng đợi hiện email người chạy; nút Hủy chỉ hiện với job mình hoặc admin.
- [ ] AC3: Admin upload CSV User Guide hoặc Review Link → ghi vào runs, Dashboard thấy được.
- [ ] AC4: Import bỏ qua dòng trùng (cùng khóa import).

## Out of scope

- Cho user thường hủy job người khác.
- Import QR logs (chưa có CSV mẫu).

## Tasks

| # | Task | Done |
|---|---|---|
| 1 | Bỏ scope queue theo user | x |
| 2 | UI Hủy theo quyền | x |
| 3 | `importRuns` + API | x |
| 4 | UI Dashboard Import | x |
| 5 | Test parse CSV | x |
| 6 | Cập nhật PO pack | x |
