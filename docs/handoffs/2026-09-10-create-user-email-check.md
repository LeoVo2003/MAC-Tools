# Handoff: Check email trước tạo user HTTP (không kẹt)

| Field | Value |
|---|---|
| **Status** | Done (local) |
| **Date** | 2026-09-10 |
| **Priority** | P0 |
| **Epic** | E2 — Hybrid HTTP 2.1 |

## Summary

Tạo user HTTP dùng Node `wpFetch` check `users.php` — hay hang/WAF hoặc miss “email đã có” → job đứng. Đổi in-page fetch + timeout; fail → Chrome Users search; POST tạo user cũng timeout 45s; nhận diện “already registered” rộng hơn.
