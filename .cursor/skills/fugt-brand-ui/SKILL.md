---
name: fugt-brand-ui
description: >-
  Brand + UI conventions for F User Guide Tool (Auto F Package). Use when editing
  public/index.html, public/style.css, public/app.js, or redesigning the tool UI.
---

# F User Guide Tool — Brand UI

## Product
Internal ops console: Fill/Run WPM + WordPress F Package. Audience = team nội bộ. Job = chạy job nhanh, xem Live Chrome.

## Brand tokens (bắt buộc)
```css
--red: #E31E24;
--red-dark: #B5141A;
--orange: #FF6A2C;
--brand-gradient: linear-gradient(120deg, var(--red), var(--orange));
```

- Primary CTA / tab active / accent highlights → dùng `--brand-gradient` hoặc `--orange` / `--red`.
- Không dùng xanh làm **brand accent** (không quay lại #3d9a6a).
- Nền tối charcoal; glow đỏ/cam nhẹ — không purple, không cream+serif terracotta.

## Semantic colors (tách khỏi brand)
| Vai trò | Token / class | Màu |
|---------|---------------|-----|
| Success / Fill OK / Done | `--ok`, `--ok-text`, `.fill-chip.ok`, `.badge.done` | xanh |
| Progress / Running | `--progress` (= orange), `.badge.running`, `.queue-status.is-running` | cam |
| Waiting / cảnh báo | `--warn`, `.badge.warn`, `.queue-status.is-waiting` | amber |
| Error / thiếu / Hủy | `--danger`, `.fill-chip.bad`, `.badge.error`, `button.danger` | đỏ |

**Quy tắc:** Running ≠ Success. Không dùng xanh cho “đang chạy”. Không dùng cam brand cho “OK/Done”.

## Surfaces
- `--surface-input` (#12181f), `--surface-log`, `--surface-frame`, `--panel-elevated`

## Typography
- Display / brand: **Bricolage Grotesque** (weight 700–800)
- Body / UI: **Plus Jakarta Sans**
- Mono / log: **IBM Plex Mono**

## Layout (đã chốt)
- Run: sidebar ~28% | Live ~72% khi `body.live-layout`
- Khi Live bật: `body` overflow hidden + flex viewport; sidebar scroll riêng; Live cố định (không sticky)
- `#tab-run.run-workspace` phải `display: grid` (không flex cột — sẽ đẩy Live xuống dưới)
- Local không Live trừ khi `CHROME_LIVE=true`
- Brand name là tín hiệu hero trên header — không để headline phụ át brand.

## Spacing
- Dùng scale `--space-1` … `--space-8` và `--text-2xs` … `--text-xl` trong `style.css`
- Tránh magic number rem rải rác và inline `style=` cho màu/spacing
- Hint tone: class `.hint--ok|.hint--warn|.hint--error|.hint--muted` — không `el.style.color`

## Motion
- 2–3 chuyển nhẹ: tab active, button hover, live badge pulse — không animation rườm.

## Copy
- Tiếng Việt, câu ngắn, nút theo hành động: Fill data, Run, Resume, Clear báo cáo.
- Live hint: ngắn, không nhắc tỉ lệ màn hình.
