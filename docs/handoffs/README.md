# Handoffs

Brief PO → implement. Nguồn sản phẩm tổng: [`../PO-PRODUCT-PACK.md`](../PO-PRODUCT-PACK.md).

## Cách dùng (1 chat — khuyến nghị)

1. Copy `_TEMPLATE.md` → `YYYY-MM-DD-ten-viec.md`
2. Điền Epic / US / AC / Task / ưu tiên / dependency / risk
3. Trong chat: `@docs/handoffs/YYYY-MM-DD-ten-viec.md` rồi bảo implement theo AC
4. Xong → cập nhật **Status** + checklist AC + mục Kết quả

## Khi nào cần file

| Cần handoff | Không cần |
|---|---|
| Feature / tối ưu lớn (vd adaptive CPU) | Typo, copy, CSS nhỏ |
| Đụng nhiều module | Đổi log message |
| Đổi nghiệp vụ Fill / role / bước Run | Fix rõ 1 chỗ |

Rule tự áp dụng: `.cursor/rules/fugt-po-workflow.mdc`
