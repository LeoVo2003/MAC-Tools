# Handoff: Task Output điền nhưng không lưu

| Field | Value |
|---|---|
| **Status** | Done (local — chờ verify có Task URL) |
| **Date** | 2026-08-04 |
| **Priority** | P1 |
| **Epic** | E1 — Core runner |
| **Requester** | Leo |
| **Owner** | PO+dev |

## Summary

Sau khi job xong, tool mở Task URL → điền Output fields → Save; giá trị không còn khi reload (hoặc Save không thật sự persist).

## Root cause (code)

`fillByLabelIfPresent` gán `input.value = …` rồi coi OK nếu DOM `.value` khớp. WPM form (Vue/React) thường **không** cập nhật model từ gán trực tiếp → Save POST giá trị cũ. `wpm.js` đã dùng `type` thật (`fillNative`).

## Acceptance Criteria

- [ ] AC1: Điền Login Url / Guide File / User name / Password bằng type thật (hoặc native setter + InputEvent).
- [ ] AC2: Bấm Save (ưu tiên exact / submit trong form task).
- [ ] AC3: Reload task → ít nhất Login Url + User name vẫn còn; fail thì log rõ / retry 1 lần.
- [ ] AC4: Không có Output fields → vẫn skip như cũ.

## Out of scope

- HTTP POST task API (trừ khi Chrome fail ổn định).
