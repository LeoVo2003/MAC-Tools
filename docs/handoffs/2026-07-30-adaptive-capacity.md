# Handoff: Adaptive CPU & Capacity (E3)

| Field | Value |
|---|---|
| **Status** | Done (Phase 1 — chờ deploy) |
| **Date** | 2026-07-30 |
| **Priority** | P0 |
| **Epic** | E3 — VPS Performance & Adaptive Capacity |
| **Requester** | Leo |
| **Owner** | PO+dev |

## Summary

Host **1 vCPU**, peers `mac-menu-engine` + `ds2api`. Phase 1: adaptive idle/`safe=0.5`/`max=1.0` theo loadavg + peer MME. Concurrent boost không làm.

## Acceptance Criteria (Phase 1)

- [x] AC1: `ADAPTIVE_CAPACITY=false` → idle ↔ `DOCKER_CPU_LIVE` (như cũ).
- [x] AC2: Adaptive on + idle + job → mode `max` (`DOCKER_CPU_MAX=1.0`).
- [x] AC3: Adaptive on + busy/unknown + job → mode `safe` (`DOCKER_CPU_LIVE=0.5` trên VPS).
- [x] AC4: `/api/health` có `cpuScale` + `adaptive` (load1, thresholds).
- [x] AC5: Rollback env; không đổi Fill/Run nghiệp vụ.

## Tasks

| # | Task | Done |
|---|---|---|
| 0 | Chốt host 1 vCPU / max=1.0 / safe=0.5 / peer | [x] |
| 1 | `src/hostPressure.js` | [x] |
| 2 | `src/dockerCpuScale.js` 3 tiers + poll | [x] |
| 3 | Health + compose + `.env.example` + DEPLOY + GH Actions | [x] |
| 4 | Smoke local (no docker.sock → safe, không crash) | [x] |

## Kết quả

- Files: `hostPressure.js` (new), `dockerCpuScale.js`, `ops.js`, `docker-compose.yml`, `.env.example`, `DEPLOY.md`, `.github/workflows/docker-publish.yml`
- Local smoke: classify + acquire/release OK; unknown→safe
- **Chưa push** — cần push `main` để CI deploy VPS rồi verify `/api/health` + log `[cpu-scale] mode=...`

## Rollback

`.env`: `ADAPTIVE_CAPACITY=false` (+ tuỳ `DOCKER_CPU_LIVE=2.5`) → recreate container.
