# Handoff: Admin reset password tài khoản tool

| Field | Value |
|---|---|
| **Status** | Done |
| **Date** | 2026-09-22 |
| **Priority** | P1 |
| **Epic** | E1 — Core / Auth |
| **Requester** | Leo |
| **Owner** | PO+dev |

## Summary

Admin chưa có UI quản lý user. Pass WPM lưu lúc login lần đầu (`data/users.json`). Nhập sai thì lần sau không vào được. Thêm tab **Tài khoản** cạnh Báo cáo: xem danh sách + Reset (xóa pass đã lưu). User login lại bằng pass đúng thì tool lưu mới.

## Acceptance Criteria

- [x] AC1: Admin thấy tab Tài khoản cạnh Báo cáo. User thường không thấy.
- [x] AC2: Danh sách email / role / đã lưu pass hay chưa — không hiện plaintext password.
- [x] AC3: Reset xóa `wpmPasswordEnc` + `passwordHash`. Login sau nhận pass mới.
- [x] AC4: Non-admin gọi API → 403.

## Out of scope

- Đổi role, xóa user, sửa pass hộ (admin không đặt pass mới).
- Hiện password đã lưu.
