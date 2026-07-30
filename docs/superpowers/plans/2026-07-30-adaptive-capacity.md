# Adaptive CPU & Capacity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Khi host FlashVPS rảnh (MME không nặng), FUGT tự lấy thêm CPU (và tùy phase: concurrent); khi host bận thì chạy mức an toàn như hiện tại — không làm chậm MME.

**Architecture:** Mở rộng `dockerCpuScale.js` từ 2 mức cố định (`idle` / `boost`) thành **3 mức** (`idle` / `safe` / `max`) chọn theo **tín hiệu áp lực host** (loadavg + optional Docker stats peer MME). `jobQueue` giữ concurrent base; phase 2 mới nới concurrent động. Health/UI báo mode hiện tại.

**Tech Stack:** Node ESM hiện có, Docker Engine API qua `docker.sock` (đã mount), `/proc/loadavg`, env trên `docker-compose.yml`.

## Global Constraints

- Không đổi nghiệp vụ Fill/Run 1→6.
- Không tách host khỏi MME trong scope này.
- VPS mặc định concurrent base vẫn **1** trừ khi adaptive cho phép boost.
- Push `main` = deploy prod — chỉ ship khi AC pass + có rollback env (`ADAPTIVE_CAPACITY=false`).
- Realtime vẫn Socket.IO; không đụng Fill rules.

---

## Context (hiện trạng)

| Cơ chế | Hiện tại | Pain |
|---|---|---|
| CPU container | Idle `0.3` → boost `DOCKER_CPU_LIVE` (~2.5) khi có holder Fill/Run/Live | Boost cố định, không biết host đang bận MME |
| Concurrent | Compose `MAX_CONCURRENT_JOBS=1` | Queue dài; local nhanh hơn vì máy riêng |
| Đồng host | MME + FUGT trên FlashPanel | Tranh CPU/RAM |

User muốn: **server rảnh → tận dụng công suất; server bận → chạy bình thường (safe).**

---

## Quyết định thiết kế (đã chốt trong plan)

### Host thật (2026-07-30, đo trên VPS)

| Mục | Giá trị |
|---|---|
| **vCPU** | **1** (`nproc` / `lscpu`) |
| CPU model | Intel Xeon Gold 6148 @ 2.40GHz |
| Load lúc đo | `0.06, 0.03, 0.00` (rất rảnh) |
| FUGT container | `user-guide-fugt-1` |
| MME container | **`mac-menu-engine`** |
| Peer khác | `ds2api` (cũng tranh 1 core) |

**Hệ quả:** `DOCKER_CPU_LIVE=2.5` trên máy 1 core **không cho thêm 2.5 CPU** — Docker chỉ time-slice tối đa ~100% của 1 vCPU. Adaptive “max 3.5/4.0” **vô nghĩa** trên host này.

**Pivot Phase 1:** không “boost lên >1”, mà:

| Mode | Ý nghĩa | NanoCpus đề xuất |
|---|---|---|
| `idle` | Không job | `0.30` (giữ) |
| `safe` | Có job + host/peer **bận** | **`0.45–0.55`** — nhường MME/`ds2api` |
| `max` | Có job + host **rảnh** | **`1.0`** — gần full 1 core |

Peer mặc định: `ADAPTIVE_PEER_CONTAINER=mac-menu-engine` (có thể thêm theo dõi `ds2api` sau).

**P0 song song (product):** cân nhắc **nâng VPS ≥2–4 vCPU** — đây mới là cách job nhanh rõ; adaptive trên 1 core chỉ giảm tranh chấp, không magic bằng local nhiều core.

### Tín hiệu “rảnh / bận” — Option A (khuyến nghị)

**Không phụ thuộc API nội bộ MME.** Dùng:

1. **Primary:** `/proc/loadavg` (1-minute) so với ngưỡng env.  
2. **Optional:** Docker stats peer `mac-menu-engine` — CPU% cao → bận.

**Busy** nếu: `load1 >= ADAPTIVE_LOAD_BUSY` **hoặc** peer CPU% >= ngưỡng.  
Trên **1 vCPU**: đề xuất `ADAPTIVE_LOAD_BUSY=0.70`, `ADAPTIVE_LOAD_IDLE=0.35` (hysteresis chặt hơn máy nhiều core).

### Concurrent

**Phase 2 concurrent 1→2: KHÔNG làm trên 1 vCPU** (hai Chrome cùng lúc sẽ tệ hơn). Chỉ xét lại sau khi nâng host.

### Kill switch

`ADAPTIVE_CAPACITY=false` → hành vi y hệt hôm nay (idle 0.3 / live 2.5 — trên 1 core ≈ full slice khi có job).

---

## Files map

| File | Responsibility |
|---|---|
| `src/dockerCpuScale.js` | Đọc load/peer; chọn `safe`/`max`; apply NanoCpus; export snapshot adaptive |
| `src/hostPressure.js` *(new)* | Thuần: `readLoadavg()`, `readPeerCpuPct()` — dễ test |
| `src/jobQueue.js` | Phase 2: `setMaxConcurrent` / đọc limit động |
| `src/ops.js` / health | Thêm `adaptive: { mode, load1, peerCpu, … }` |
| `server.js` | Wire health; phase 2 reconfigure queue |
| `docker-compose.yml` / `.env.example` | Env mới |
| `public/app.js` *(nhẹ)* | Hint admin/health: mode safe/max (optional phase 1b) |
| `docs/handoffs/2026-07-30-adaptive-capacity.md` | Tracking PO |
| `docs/PO-PRODUCT-PACK.md` | Cập nhật backlog status sau ship |

**Out of scope plan này:** HTTP hóa Sync; tách VPS; đổi UI lớn; đo p50 thời gian job (có thể task phụ nhỏ nếu dễ lấy từ `runs.jsonl`).

---

## Phase 1 — Adaptive CPU tiers (P0)

### Task 1: `hostPressure.js`

- [x] Tạo `src/hostPressure.js`
- [x] `readLoadavg()` / `classifyPressure` / `readPeerCpuOptional` / `sampleHostPressure`

### Task 2: Mở rộng `dockerCpuScale.js`

- [x] 3 tiers + poll khi có holder + adaptive on
- [x] `cpuScaleConfig()` có adaptive fields

### Task 3: Health + docs env

- [x] `buildHealthReport` + compose + `.env.example` + DEPLOY + GH Actions (không còn force LIVE=2.5)

### Task 4: Verify

- [x] Local Windows smoke
- [ ] VPS sau deploy: health + log mode max/safe

---

## Phase 2 — Adaptive concurrent (P1, sau Phase 1 ổn)

### Task 5: Dynamic limit trên `jobQueue`

- [ ] Cho phép `getMaxConcurrent()` / `setMaxConcurrent(n)` (clamp 1..boostMax)
- [ ] `pump()` dùng limit hiện tại
- [ ] Controller: mỗi poll pressure idle + không quá N job → cho phép boost concurrent; busy → về base (không hủy job đang chạy; chỉ không start thêm)

**AC:** Busy giữa chừng không start job thứ 2; job đang chạy chạy hết.

### Task 6: UI hint

- [ ] Sửa hint “tối đa 4” → lấy từ health/queue snapshot thật + ghi chú adaptive max

---

## Env đề xuất (đã chốt theo host 1 vCPU)

```env
ADAPTIVE_CAPACITY=true
DOCKER_CPU_IDLE=0.3
DOCKER_CPU_LIVE=0.5          # safe khi host/peer bận (nhường MME)
DOCKER_CPU_MAX=1.0           # gần full 1 core khi rảnh
ADAPTIVE_LOAD_BUSY=0.70
ADAPTIVE_LOAD_IDLE=0.35
ADAPTIVE_PEER_CONTAINER=mac-menu-engine
ADAPTIVE_PEER_CPU_BUSY=50
ADAPTIVE_POLL_MS=15000
# KHÔNG bật concurrent boost trên 1 vCPU
# MAX_CONCURRENT_JOBS=1
```

---

## Risks

| Risk | Mitigation |
|---|---|
| `DOCKER_CPU_MAX` quá cao → OOM / steal MME | Default thấp; peer+load; kill switch |
| Loadavg nhiễu trên VPS nhỏ | Hysteresis + poll 15s |
| Windows local không có /proc | `unknown` → safe |
| 2 Chrome phase 2 | Chỉ sau khi phase 1 đo được benefit |
| Docker stats CPU tính sai | Peer optional; primary vẫn loadavg |

---

## Test plan (ship)

- [ ] Kill switch off: 1 job behavior = prod cũ
- [ ] Kill switch on + idle host: log `mode=max`
- [ ] Kill switch on + MME heavy: log `mode=safe`
- [ ] Health JSON có adaptive fields
- [ ] Không regress Fill/Run (1 smoke job)

---

## Rollback

1. `.env`: `ADAPTIVE_CAPACITY=false` (+ restart container)  
2. Hoặc revert image tag trước đó trên GHCR  

---

## Implementation order

1. ~~Chốt số~~ → **Đã chốt:** 1 vCPU; max=`1.0`; safe=`0.5`; peer=`mac-menu-engine`; không concurrent boost.
2. Phase 1 tasks 1→4.
3. Song song product: cân nhắc nâng VPS ≥2–4 vCPU nếu muốn gần tốc độ local.
4. Phase 2 concurrent — **chỉ sau khi nâng host**.
