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
- Không dùng lại xanh lá accent cũ (#3d9a6a).
- Nền tối charcoal; glow đỏ/cam nhẹ — không purple, không cream+serif terracotta.

## Typography
- Display / brand: **Bricolage Grotesque** (weight 700–800)
- Body / UI: **Plus Jakarta Sans**
- Mono / log: **IBM Plex Mono**

## Layout (đã chốt)
- Run: sidebar ~28% | Live ~72% khi `body.live-layout`
- Khi Live bật: `body` overflow hidden + flex viewport; sidebar scroll riêng; Live cố định (không sticky)
- Brand name là tín hiệu hero trên header — không để headline phụ át brand.

## Spacing
- Dùng scale `--space-1` … `--space-8` và `--text-xs` … `--text-xl` trong `style.css`
- Tránh magic number rem rải rác cho margin/padding/gap

## Motion
- 2–3 chuyển nhẹ: tab active, button hover, live badge pulse — không animation rườm.

## Copy
- Tiếng Việt, câu ngắn, nút theo hành động: Fill data, Run, Resume, Clear báo cáo.
- Live hint: ngắn, không nhắc tỉ lệ màn hình.
