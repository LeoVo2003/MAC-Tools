# F User Guide Tool — Product Pack (PO Onboarding)

> Nguồn: phỏng vấn PO (2026-07-30) + đối chiếu chat phát triển export.  
> Chủ sở hữu sản phẩm / code: Leo Vo. Người dùng: team Web.

---

## 1. Executive Summary

**F User Guide Tool** (repo/package: `f-user-guide-tool`; workspace còn gọi Auto F Package) tự động hóa quy trình tạo tài khoản khách **gói F** trên WordPress qua **WPM** (Web Project Manager).

Team Web trước đây làm tay ~15 phút/job (ít lỗi). Tool thay thế thao tác lặp để **tiết kiệm thời gian** và **chịu được volume task cao**: login WPM → Quick Login → Backup → tạo user Editor → sync WPM → Mac Role / F Package → Web Info → xuất Output (và điền Task nếu có).

Sản phẩm đã **dùng production** trên VPS (FlashPanel/FlashVPS), deploy bằng **push `main` → GitHub Actions**. Pain ưu tiên hiện tại: **job trên server chậm hơn local** do đồng host với MME + `MAX_CONCURRENT_JOBS=1` + CPU container thấp khi idle.

---

## 2. Product Vision

> Team Web hoàn tất setup tài khoản gói F chỉ bằng: dán Project/Task URL → Fill data → Run → copy Output — nhanh, nhất quán, an toàn trên Main Web; admin vẫn test subdomain và giám sát được.

**Không nhằm:** thay WPM, xử lý gói web khác (S/G/P/1…), hay bỏ hoàn toàn browser trong ngắn hạn.

---

## 3. Business Flow

```text
[AM / hệ thống] tạo task gói F trên WPM
        ↓
[Người làm web] nhận task trên WPM
        ↓
Mở F User Guide Tool → Login (email/pass WPM)
        ↓
Dán Project URL (+ Task URL nếu có) → Fill data
        ↓
Kiểm tra/sửa Website, Username, Password, Email
        ↓
Tick bước 1→6 (bỏ tick bước đã xong nếu Resume) → Run
        ↓
Tool: Login WPM → Quick Login → [1] Backup → [2] Tạo user
      → [3] Sync WPM → [4] Mac Core/Mac Role → [5] F Package User
      → [6] Web Info → Output (+ điền Task nếu có field)
        ↓
Copy Output → dán Task / gửi khách (hoặc AM tự lấy nếu Task không có field)
```

**Mã dự án WPM (ví dụ):** `32571SE1 PROX3 THE NAIL HUB`  
= zipcode + gói web + gói design + gói SEO + (pro…) + tên.  
**F** = gói web cần quan tâm của tool này.

---

## 4. User Flow (trên tool)

1. Mở tool  
2. Đăng nhập email + password WPM  
3. Dán WPM Project URL (+ Task URL nếu có)  
4. **Fill data** → tool điền 4 ô; user kiểm tra/sửa  
5. Target web: user thường luôn **Main Web**; admin có thể **Khớp ô Website** (test subdomain)  
6. Tick bước cần chạy (mặc định 1→6)  
7. **Run** → theo dõi Log (Socket.IO) đến `▶ Xong.`  
8. Copy Output: Login URL, Guide, User, Password  
9. Lỗi giữa chừng: bỏ tick bước đã xong → **Resume**

**Luôn chạy trước (không tick):** Login WPM + Quick Login site.

---

## 5. Danh sách Module

| Module | Mô tả | Trạng thái |
|---|---|---|
| Auth | Login/logout WPM, session, `users.json` | Production |
| Job form | Project/Task URL, 4 field, Target web (admin) | Production |
| Fill data | Đọc WPM + footer → điền form | Production |
| Steps runner | Tick 1→6, Run/Hủy/Resume, queue | Production |
| Log realtime | Socket.IO | Production |
| Output | 4 ô + Copy; điền Task nếu có | Production |
| Live Chrome | Snapshot (mặc định); noVNC legacy | Đủ dùng |
| Hàng đợi | Queue + cancel | Production |
| Báo cáo | Tab admin: runs / CSV / clear | Production |
| Health | `/api/health` | Production |
| HTTP hybrid 2.1 | createUser, Mac Core/Role, Web Info (+ fallback Chrome) | Production (theo dõi) |
| Deploy | Docker + GH Actions → VPS | Production |
| Backup files UI | API purge còn; UI tải gần như không | Chưa làm |

---

## 6. User Roles

| Role | Gán | Quyền |
|---|---|---|
| **user** | Mọi email WPM login lần đầu (không nằm admin list) | Fill, Run/Resume/Hủy **job mình**, Log/Output/Live, queue mình. Target = Main Web. Không Báo cáo / không API admin. |
| **admin** | `leo.vo@macusaone.com` + `ADMIN_EMAILS` | Thêm: Target web (Main / khớp Website), Báo cáo, thấy/hủy mọi job, API admin (runs, purge…). |

---

## 7. Functional Requirements

### FR-Auth
- FR-A1: Đăng nhập bằng email/password WPM; tạo user trong store nếu lần đầu.  
- FR-A2: Phân quyền user/admin theo email cố định + env.

### FR-Fill
- FR-F1: Từ Project URL lấy Website URL (Main Web hoặc web khớp ô Website).  
- FR-F2: Username = slug đầy đủ tên tiệm + `-admin`.  
- FR-F3: Password = `{slug}@{Zip}` — Zip ưu tiên footer site, không thì Zip Code Project Information.  
- FR-F4: Email ưu tiên footer; không có thì Email Project Information WPM.  
- FR-F5: User được sửa tay 4 ô trước Run.

### FR-Run
- FR-R0: Luôn Login WPM + Quick Login trước các bước tick.  
- FR-R1: Backup UpdraftPlus (rollback).  
- FR-R2: Tạo user WP role **Editor**; email đã tồn tại → skip tạo (và skip sync).  
- FR-R3: Sync user/pass lên WPM Website Information → Endpoint → Add Account.  
- FR-R4: Mac Core → cài + activate Mac Role.  
- FR-R5: Apply template **F Package User**.  
- FR-R6: Web Info: nếu nằm Settings → đưa lên Dashboard (JetEngine).  
- FR-R7: Resume / Hủy; queue khi concurrent đầy.  
- FR-R8: Output Login URL, Guide, User, Password; có Task URL thì điền field nếu tồn tại, không thì bỏ qua.

### FR-Admin
- FR-AD1: Báo cáo runs, CSV, clear.  
- FR-AD2: Target subdomain test.  
- FR-AD3: Health / purge backup API.

---

## 8. Non-functional Requirements

| ID | Yêu cầu |
|---|---|
| NFR-P1 | Local nhanh; VPS chấp nhận chậm hơn nhưng cần cải thiện (pain hiện tại). |
| NFR-P2 | VPS mặc định 1 job Chrome đồng thời; queue phần còn lại. |
| NFR-P3 | Container: CPU idle ~0.3; Fill/Run/Live scale ~2.5; shm 512m. |
| NFR-S1 | User thường không chạy subdomain test / không đụng job người khác. |
| NFR-R1 | Deploy: push `main` → CI (GHCR + SSH `/home/flashvps/User-Guide`). |
| NFR-C1 | Đồng host với MME — không được “ăn” hết máy khi MME đang nặng (adaptive capacity — mục tiêu). |
| NFR-O1 | Stealth/Puppeteer: tránh lộ `navigator.webdriver` (lý do không dùng Playwright). |

---

## 9. Product Roadmap (đề xuất)

| Phase | Mục tiêu |
|---|---|
| **Now** | Ổn định production; merge fix backup parse + email-exists nếu chưa `main`; sửa hint UI concurrent lệch VPS. |
| **Next (P0)** | **Performance & adaptive capacity** trên VPS đồng host MME. |
| **Next (P1)** | HTTP hóa thêm Sync (và dần Backup/Login WPM nếu khả thi). |
| **Later** | UI Backup files; giảm phụ thuộc Puppeteer; tài liệu SOP/PRD; (tuỳ) tách host khỏi MME. |

---

## 10. Product Backlog (ưu tiên)

| Priority | Item | Ghi chú |
|---|---|---|
| P0 | Tối ưu tốc độ job trên VPS + adaptive CPU/concurrent khi MME rảnh/bận | Pain vận hành #1 |
| P0 | Regression backup (parse ngày `Jul …`) + xác nhận đã deploy | Mới fix local |
| P0 | Email exists → skip tạo/sync — xác nhận đã lên `main` | Mới fix local |
| P1 | Đồng bộ UI hint concurrent với env VPS thật | Tránh hiểu nhầm “tối đa 4” |
| P1 | Sync WPM qua HTTP (bỏ Chrome bước này) | Còn Chrome |
| P2 | Web Info HTTP ổn định (giữ fallback Chrome) | Đang hybrid |
| P2 | Sửa README “SSE” → Socket.IO | Docs lệch code |
| P3 | Tab Backup files UI | API có, UI gần không |
| P3 | Full HTTP / bỏ Puppeteer dài hạn | Ngoài scope gần |
| P3 | Tạo bộ docs: PRD, SOP, API, Roadmap… | Hiện chưa có |

---

## 11. Epics

### E1 — Core F Package Automation (Done / maintain)
Tự động hóa Fill → Run 1→6 → Output trên web cho team.

### E2 — Hybrid HTTP 2.1 (In progress / harden)
Tăng tốc bước không cần full browser; fallback Chrome khi fail.

### E3 — VPS Performance & Adaptive Capacity (P0 — mới)
Khi server rảnh (MME idle) tận dụng công suất; khi MME/bận thì chạy mức an toàn.

### E4 — Ops & Observability (Done / improve)
Queue, báo cáo admin, health, Live snapshot, deploy CI.

### E5 — Product Documentation (Not started)
PRD, SOP user, API notes, roadmap living doc.

---

## 12. User Stories + Acceptance Criteria (ưu tiên gần)

### US-E3-01 — Adaptive concurrent / CPU
**Là** admin vận hành tool trên VPS đồng host MME,  
**tôi muốn** tool tự tăng công suất khi máy rảnh và hạ khi máy bận,  
**để** job nhanh hơn lúc trống mà không làm chậm MME.

**AC:**
- [ ] Có tín hiệu “máy rảnh / bận” (CPU/load hoặc rule đơn giản đã thống nhất).  
- [ ] Khi rảnh: cho phép tăng concurrent và/hoặc CPU limit trong ngưỡng an toàn đã cấu hình.  
- [ ] Khi bận: về mức an toàn (vd concurrent = 1, CPU thấp hơn).  
- [ ] Không làm crash container / OOM trong test với MME đang chạy job nặng.  
- [ ] Log/health phản ánh mode hiện tại (idle boost / safe).

### US-E3-02 — Baseline tốc độ
**Là** PO/dev,  
**tôi muốn** số liệu thời gian trung bình từng bước local vs VPS,  
**để** biết tối ưu chỗ nào.

**AC:**
- [ ] Có đo (từ runs/log) p50/p90 total time và theo bước.  
- [ ] So sánh được trước/sau thay đổi performance.

### US-P0-01 — Deploy fix email-exists & backup parse
**AC:**
- [ ] Trên `main`/prod: user email đã có → skip tạo + skip sync, job không fail.  
- [ ] Backup chờ xong đúng với log Updraft dạng tháng `Jul …`.  
- [ ] Có ít nhất 1 run regression trên prod hoặc staging tương đương.

### US-P1-01 — UI concurrent phản ánh config thật
**AC:**
- [ ] Hint UI lấy từ config/health thực tế (1 trên VPS nếu đang 1), không hardcode “4” sai.

---

## 13. Risks

| Risk | Impact | Mitigation hướng |
|---|---|---|
| Đồng host MME tranh CPU/RAM | Job chậm / MME chậm | Adaptive limits; hoặc tách VPS sau |
| `MAX_CONCURRENT_JOBS=1` + Chrome nặng | Queue dài khi volume cao | HTTP hóa thêm bước; adaptive concurrent có kiểm soát |
| Selector/UI WPM–WP đổi | Job fail giữa chừng | Screenshot lỗi; HTTP giảm phụ thuộc UI |
| Fix local chưa merge `main` | Prod vẫn bug cũ | Checklist release sau mỗi fix nóng |
| Docs/README lệch (SSE) | Onboard sai | Đồng bộ docs |
| WPM chặn IP egress VPS | Không login được | Whitelist IP (đã từng gặp) |
| Stealth bị phát hiện lại | Chặn automation | Giữ puppeteer-extra stealth; theo dõi |

---

## 14. Điểm còn thiếu / chưa chắc 100%

- Spec CPU/RAM **host** VPS thật (chỉ biết limit container).  
- Nguồn/công thức chính xác field **Guide** trong Output (link doc cố định hay lấy từ đâu).  
- Cách dựng **Login URL** (wp-login / hide-login path).  
- Chi tiết Notes/Role khi Add Account trên WPM (chat cũ từng có Notes=`chủ tiệm`).  
- `develop` còn dùng cho preview hay chỉ `main`?  
- SLA thời gian job mong muốn (vd &lt; X phút trên VPS).  
- MME load pattern (giờ nào nặng) để thiết kế adaptive.

---

## 15. Đề xuất cải tiến

1. **P0 — Adaptive capacity (E3):** không chỉ “tăng concurrent mù”; kết hợp (a) HTTP hóa bước còn Chrome, (b) scale CPU/concurrent theo load host, (c) đo baseline.  
2. **P0 — Release hygiene:** mọi fix nóng (backup/email) phải lên `main` + verify health/run.  
3. **P1 — Sửa lệch UX/docs:** concurrent hint, README Socket.IO.  
4. **P1 — Sync HTTP:** giảm thời gian và tải Chrome trên VPS.  
5. **P2 — SOP 1 trang cho team Web:** Fill → Run → copy Output / Resume khi lỗi.  
6. **P3 — Cân nhắc tách host** User Guide khỏi MME nếu adaptive vẫn không đủ.

---

## 16. Tech Snapshot (đã xác nhận)

- Node.js + Express + UI `public/`  
- `puppeteer-core` + stealth + Chrome/Chromium  
- Realtime: **Socket.IO** (không còn SSE)  
- Data: `users.json`, `runs.jsonl`, … (không DB)  
- Docker + GitHub Actions → GHCR + SSH FlashVPS (`/home/flashvps/User-Guide`)  
- HTTP hybrid 2.1: createUser, Mac Core/Role, Web Info; Sync/Backup vẫn Chrome  
- Repo: https://github.com/LeoVo2003/User-Guide  

---

## 17. Tài liệu hiện có / chưa có

| Loại | Trạng thái |
|---|---|
| PRD | Chưa có → pack này là bản nháp đầu |
| Figma | Chưa có |
| Database schema | N/A (file store); chưa có mô tả chính thức |
| API Docs | Chưa có |
| Roadmap | Chưa có → mục 9 |
| SOP | Chưa có |
| Coding Standard | Chưa có |
| Meeting Notes | Chưa có (có chat export + pack này) |
| Spec kỹ thuật rời | Có `docs/superpowers/specs/2026-07-29-v2.1-http-createuser-design.md` |
| PO workflow rule | Có `.cursor/rules/fugt-po-workflow.mdc` (`alwaysApply`) |
| Handoff template | Có `docs/handoffs/_TEMPLATE.md` + `README.md` |

---

*PO onboard hoàn tất. Workflow: 1 chat (PO + code) + pack này + handoff khi việc lớn. Mọi yêu cầu mới: phân tích ảnh hưởng module → Epic/US/AC/Task/ưu tiên/dependency/risk — hỏi lại nếu &lt;90% chắc.*
