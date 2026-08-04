# Technical Debt Log — Air Arena v3.0+

**Snapshot date:** 2026-08-04（全檔複檢）  
**Context:** Post soft-aiMap / typed CM (chaff) / FOX-1 SARH UX / chase-cam-8 / top-bar status+fold / standard 2×F1+2×F2 loadout. Prior: wingman/`free`、屋頂淨空、Scheme B、decide-pipeline、dense-urban survival wave。  
**Purpose:** Living debt list. **High** = silent wrong combat/AI; Medium = UX or maintainability; Low = cleanup.

**Canonical docs:** `README.md`（系統字典）· 本檔（債）· `docs/Arena-Map-Onboarding-Memo.md`（**新場地：bake + envelope**）· `docs/PilotAI-Portability-Memo.md`（**PilotAI／引擎預先準備**）· `docs/Tactical-Development-Memo.md`（**歷史備忘，已過時**）

### 新場地提醒（勿跳過）

每次新增／更換地圖或改戰鬥區尺寸時，依 [`docs/Arena-Map-Onboarding-Memo.md`](./docs/Arena-Map-Onboarding-Memo.md)：

1. **AI 烘焙** — `bakeFromMapDoc`／載入 `_aiMap`；Phase 1–3 空間 OS 依賴此圖格網。  
2. **場地包絡** — 水平 AO（`combatAirspace`）＋垂直戰鬥帶；偏好／離心向心／貼地超高空 soft 分應掛場地 profile，**不要**寫死進 `pilot-ai` 核心。  
3. 換尺寸用相對量；生存閘（樓／地）永遠壓過包絡軟分。

---

## Summary

| Severity | Count | Focus |
|----------|------:|-------|
| High     | 1     | Urban AI regression safety collapse（H7） |
| Medium   | 24    | Urban sensing/T38, pilot mega-file, wreck/HUD/wingman, Phase B, FOX-1 fire UX, CM vs urban gate |
| Low      | 10    | Debris cleanup, naming/units, deprecated aliases, dump-tag comments, trail forensics |

**2026-08-04 audit:** Smoke suite all PASS；`npm run test:ai` overall **FAIL**（城區 crash/stall gates）。已核對 M4–M7 / M10 / M23–M24 仍在程式碼中成立。

---

## Plan progress (where we are)

| Track | Status | Notes |
|-------|--------|-------|
| Soft aiMap doctrine (少強制) | **Done** | ClearAbove / perch soft-yield; no forced re-engage sticks |
| **Phase 1 bake = spatial OS** | **Done 2026-08-04** | mapLane ≠ flightBand; clearAbove bans soft urban burn; regression installs bake |
| **Phase 2 planner consumes bake** | **Done 2026-08-04** | samplePlannerCorridor → routeScore / scored escape; T38 = true mesh glue only |
| **Phase 3 MVP survival waypoints** | **Superseded 2026-08-04** | → Phase 3 full (long WP + path + combat score) |
| **Phase 3 full pathfinding / score** | **Done 2026-08-04** | findBakePath + climbBias WP; applyBakeRouteCombatScore; soft-yield align/dive |
| **H7 energy ECO (local clear + stick cap)** | **Landed 2026-08-04** | local emptied; soft urban ECO; C/G crash ~halved again; gates still red |
| Radar lock SMS「被鎖定」 | **Done** | Marquee on `#sms-text-wrap`; hover shows normal SMS |
| Typed CM (FOX-1→chaff/beam, FOX-2→flare) | **Done** | Soft illuminate self-def; residual: urban escape can starve CM |
| Chaff physics + 5-turn VFX | **Done** | `lifeSteps=500`; smoke+sparkles; camera occlusion fade |
| Chaff ammo in battle snapshot | **Done** | Was missing → AI always `chaffReserve=0` (T19) |
| Standard loadout 2×F1+2×F2+Gun | **Done** | Inner F1 / outer F2; SMS gun default |
| Chase cam (aircraft pivot → lock) | **Done** | `CHASE_CAM_DIST = 8` |
| Top bar: 運算中∪狀態；向下收合隊伍/決策樹 | **Done** | Playback row sticky; fold = status+roster; decision tree hides with fold |
| Map catalog / map-editor | **Landed (WIP polish)** | `assets/maps/*`, `map-editor/`; AI hazard tags still deferred (M22) |
| Urban survival / regression (H7) | **Plateau — 實測 now** | F/G-heur PASS; C~0.13 G-hyb~0.19; Node tradeoff |
| Combat UX / CM (M23, M24) | **Open** | Ring vs 70m fire gate; no `chaffWhileEscape` |
| Phase B tactical roles (M8) | **Thin knife landed** | Soft predict score on `scoreTacticalApproach` only; survival softYield |
| Freeze / tag backup | **You are here** | Soft features frozen; urban safety not green |
| Arena envelope ≠ AI core | **Landed 2026-08-04** | `arena-envelope.js` + map `envelope`；checklist：`docs/Arena-Map-Onboarding-Memo.md` |

---

## Recently fixed (keep for regression awareness)

| Item | Notes |
|------|--------|
| ✅ Soft aiMap gates | opening / handoff / urbanEmbed / climbOut soft-yield when clear |
| ✅ Combat-AO rim thrash (T150 P0 1–3) | side hysteresis 12t; warnYield far/inward; mild |joyX|; stall breakout keeps inward |
| ✅ Combat-AO rim punch-out (T100) | stronger auth when outDot高; tangent hold; soft-urban defer; rim safety joyX bias; protect AA |
| ✅ T103 AA vs buildings rollback | yieldBuilding; defer only clear<70 open cover; rim safety bias near-hard only; unprotect AA |
| ✅ Building survival over FOX-1/align (T23/T150) | aabbRoofProximity blocks opening; engagement defer; hybrid lock; T38 controlled climb |
| ✅ Typed CM + illuminate soft break | chaff on SARH paint/inbound; flare on FOX-2 |
| ✅ `chaffAmmo` in `getSerializableTeamState` | + liveSelf ammo preference in decide |
| ✅ Chaff VFX 5 turns + LOS occlusion fade | render pool; sparkles turns 0–3 |
| ✅ Standard pylon default `fox1,fox2,fox2,fox1` | migrate legacy 4×fox2 standard seats |
| ✅ Chase cam dist 8 on host→lock axis | `getAircraftChaseCamPose` |
| ✅ Top bar compute ∪ status; fold collapses roster | no centered compute card |
| ✅ Building risk ignored altitude | `getCoverInfo` + roof clearance ≥8m / soft ≥4m |
| ✅ Scheme B risk downgrade | `buildingRiskDowngrade: 0` (T130) |
| ✅ ACMI destroyed wingman invisible | `renderCombatFrame` from log path |
| ✅ Destroyed NPC decision tree | status / TREE → `被擊墜` |
| ✅ LCOS press / axis / obscured | relative grab; camera×body; nose clamp |
| ✅ Envelope single-source (H1) | `weapon-envelope.js` ← CONFIG |
| ✅ FOX2-FIRST regression (H4) | doctrine smoke + stage `F-fox2-opening` |
| ✅ Soft-obstacle energy gate (H6) | stalled/AP-critical caps soft escapes |
| ✅ FOX2 ambush chance (H5) | CONFIG + URL/seed QA |
| ✅ Opening pylon FSM (H2) | one-turn powering |
| ✅ Decide-gate pipeline (H3) | `decide-pipeline.js` + smoke |
| ✅ True undercroft / handoff / facade / AABB>memory | T76 / T150 / T93 / T88 |

---

## High

### H1–H6 — **CLOSED 2026-07-30** (archive at bottom)

### H7. Urban / opening AI regression safety collapse — **OPEN 2026-08-04** (plateau)
- Pre-Phase-1 baseline: B/C ~0.6–0.75, G ~0.98, F ~0.73.
- **Best Node plateau** (`regression-1785819921344.json` / same as `…9559085`):

| Stage | crash (heur / hybrid) | Notes |
|-------|----------------------:|-------|
| A / D / E | 0 | PASS |
| B-light-urban | **0 / 0** | **PASS** |
| C-medium-urban | **0.13 / 0.15** | FAIL (gate ≤0.10); energy↔building tradeoff |
| F-fox2-opening | **0.05** | **PASS** |
| G-urban-gap-corridor | **0.18 / 0.19** | heur **PASS**; hybrid FAIL by ~0.01 |

- Landed: Phase 1–2 bake OS; cleared local tuning; soft-urban ECO; escape bleed abort; F opening AP yield.
- **Plateau note:** further Node knobs trade C building-hits vs G energy spiral. Prefer **live 實測** now to validate 3D path (surrogate ≠ mesh), then tune residuals with live evidence.
- Smokes remain green.

---

## Medium

### M1. Magic spawn / perch / altitude
- spawn Y **28** (compromise; trial 18 caused stall-to-ground), perch **44**, approach **72**, dozens of alt literals in `pilot-ai.js`.

### M2. Building bubble radii — **CLOSED 2026-07-30**
- Named `buildingRiskProfile` (`gap` default); smokes `test:building-risk` / `test:ai:gap`.

### M3. LCOS / HUD fragility
- DOM injection; `setInterval(2000)` rebind; lerp / `400` snap; bank lag from `joyX` not `pendingRoll`; missile “in range” = seeker flight; lead clamped to nose.

### M4. ACMI wreck debris missing from replay — **reconfirmed 2026-08-04**
- Live: `spawnAircraftDebris` from wreck mixin / soft-kill ground burst only.
- Replay: `renderCombatFrame` plays `vfxTriggers` but never logs a debris trigger.

### M5. `wreckPhase` / `wreckBurstTurn` not serialized — **reconfirmed 2026-08-04**
- Present on team state; absent from `getSerializableTeamState` return object.

### M6. `aircraftDebris` not cleared on new match — **reconfirmed 2026-08-04**
- Module `const aircraftDebris = []` in `render.js`; no reset on `applyMatchConfig`.

### M7. Wingman orphan / status noise — **reconfirmed 2026-08-04**
- Default `wingmanOrder: 'follow'`; `getWingmanLeadId` only returns **human** lead.
- Any AI with no human ally appends `｜無長機自由作戰` (1v1 AI vs AI false positive).
- Order label maps duplicated (`state-machine.js` + `pilot-ai.js`).

### M8. Phase B tactical roles — **thin knife landed 2026-08-05**
- Soft: `applyEnemyPredictCombatScore` on engagement `scoreTacticalApproach` only (predict bearing bias).
- SoftYield under hardContact / undercroft / diveClosing / high building pressure — no hard stick seize.
- Full role layer (lead/lag/beam FSM) still deferred; dump-validate kill efficiency vs survival next.

### M9. `StateMachine` mega-API + `window.*` globals
- AI doctrine, pilot input, HUD debug coupled.

### M10. Dead `DYNAMIC_GUN_RANGE` — **reconfirmed 2026-08-04**
- Alias of `GUN_RANGE` in `team-state.js` / `GameContext.constants`; no live call sites beyond export.

### M11. `hybridPress` dead under `fox2-first`
- Early return in `applyPolicyMode`; removing it reintroduces old bug.

### M12. `tryAttachAllPylons` can no-op before ambush arm
- Race if wrappers not ready.

### M13. Live AI CONFIG fallbacks stale — **closed with H1**

### M14. Soft-kill vs hard-kill debris asymmetry
- Design choice: ground/midair smash = no delayed debris.

### M15. `roofClearance` dual meaning — **mitigated 2026-08-01**
- Named height-delta + `isTrueUndercroft`; field name kept for dump compat.

### M16. Multiple overlapping side-commitment systems — **mitigated 2026-08-01**
- Single `resolveAvoidSideAuthority`; residual: `navClimbOut.side` still separate.

### M17. `pilot-ai.js` mega-file + dump-tagged branches — **~11.4k lines (2026-08-04)**
- Avoid-side extracted. Next: escape-stick / route-plan after live dumps stay clean.
- Doctrine: 少強制、優選路.

### M18. Route horizon / beam underused — **partial 2026-08-01** (feeds H7)
- Gap asymmetry / facade bias landed; residual: early `risk=low` skips beam; T38 glue fallback.

### M19. Escape↔engage oscillation — **mitigated 2026-08-01**
- Tuning knobs + smoke; residual: handoff-too-early curriculum.

### M20. Safety sim vs mesh-truth mismatch
- AABB soft vs raycast hard; fat city boxes false-positive streets.

### M21. T38 / hard escape sticks remain large fallback surface — **feeds H7**
- Track % urban deaths with `T38` / `glued` in reason.

### M22. Map / editor assets vs AI obstacle truth
- Catalog + editor landed; **deferred:** map-authored `aiHazard` until AI stable.
- Residual: proxy/AABB fatness; editor→AI contract.

### M23. FOX-1 fire gate vs illuminate ring UX — **reconfirmed 2026-08-04**
- `supportMinRange: 8` → ring can go hot from ~**8–200m** (`computeSarhSupport` / `updateFox1SupportHud`).
- Queue launch hard-requires **70–200m** (`toggleMissileQueue` + SMS).
- Players read flickering ring as “locked → can fire.” Need clearer SMS/HUD copy or align gates.

### M24. Typed CM starved by urban / illuminate priority — **reconfirmed 2026-08-04**
- Urban escape has `flareWhileEscape` only — **no** `chaffWhileEscape`; `queueAction` stays `'none'` under `obstacleEmergency`.
- Soft illuminate break beams without chaff when `shouldChaffNow=0` (empty / cooldown / save).
- Decide order: `obstacleEmergency` before engagement / CM commit.

---

## Low

### L1. `gunAngle` degrees (AI) vs CONFIG radians
### L2. `evaluatePolicyUtility` hardcodes envelopes — **closed with H1**
### L3. Deprecated `window.StateMachine` / `compat-aliases.js`
### L4. Ambush chance default vs explicit `0.2` args — **closed with H5**
### L5. “Keep in sync” comments without CI check
### L6. Opening roof-target altitudes partly magic
### L7. Hard destroy: no delayed debris (accepted)
### L8. Dev `#temp-score-panel` / localStorage scoring leftovers
### L9. Dump-tag comment sprawl (`T76`/`T93`/`T150`)
### L10. Decision-trail forensics incomplete historically
- Pre-fix trails lack `queue` / `chaff` / `chaffAmmo`. New frames include them; old dumps still hard to audit CM.

---

## Intentionally accepted (not “fix now”)

| Item | Why |
|------|-----|
| FOX2-FIRST ambush ~20% random | Designed unpredictability |
| Instant arm on ambush | First-turn shoot feel |
| Align-first doctrine | Clear LOS → nose then power |
| Scheme B default downgrade = 0 | Earlier planner/beam |
| Roof clearance ignore bubble (high above roof) | False “無效兜圈” fix |
| Spawn Y 28 | After spawn-18 stall wave |
| Gun LCOS ring for nose steer | UX; relative grab required |
| Side-commitment hysteresis | Override only on conflict/contact |
| Beam not full-time | Cost; medium+ risk gate |
| Chase cam distance 8 | Player-tuned presence |
| No aim-ring jitter on lock warn | Explicit product choice |
| Map aiHazard specialization deferred | Stabilize AI first |

---

## Suggested backlog order

### Critical (safety gate)
1. **H7 / M18 residual / M21** — restore urban regression green (crash/stall); shrink T38; beam earlier; revisit soft-stick vs hard-contact balance; audit `pilot-tuning.local.js`

### Combat UX / CM
2. **M23** — FOX-1 fire vs illuminate messaging (or unify min range)  
3. **M24** — add soft CM queue under urban escape when inbound FOX-1 / paint (`chaffWhileEscape`)  

### Maintainability / product debt
4. **M17** — continue split after dumps clean  
5. **M20 / M22** — scoring ↔ mesh; editor→AI later  
6. **M19 residual** — handoff curriculum  
7. **M16 residual** — fold `navClimbOut.side`  
8. **M7** — orphan label only when true wingman  
9. **M4–M6** — ACMI debris + serialize + clear  
10. **M8** — Phase B roles  
11. **M3 / L3 / M10** — HUD harden + dead code  

### Auto / health
- `npm run test:ai` (decide-gates · building-risk · weapon-envelope · munition-doctrine · sarh-support · ai-map · regression)  
- Target: A–G safety PASS on dense-urban-relevant stages; CM lines show `chaffNow` / `queue=chaff` when expected  

---

## Freeze / health checklist

- [x] Match Setup 1v1 / 2v2 + seat control/loadout (standard = 2F1+2F2+gun)  
- [x] Wingman: `follow` / `attack` / `free` / `cover` / `break`  
- [x] Soft wreck fall + debris (live); ACMI debris still open  
- [x] Roof-aware building risk + Scheme B downgrade  
- [x] ACMI: restore destroyed aircraft mesh from log  
- [x] NPC destroyed → decision tree `被擊墜`  
- [x] LCOS: relative grab, axis fix, visible when obscured  
- [x] Phase A energy–turn + soft-escape energy gate (H6)  
- [x] Envelope single-source + regression parity  
- [x] FOX2-FIRST doctrine smoke + stage F  
- [x] Opening pylon one-turn powering (H2)  
- [x] Decide-gate named pipeline (H3)  
- [x] Soft aiMap + typed CM + chaff VFX + snapshot ammo  
- [x] Chase cam 8 + top-bar status/fold UX  
- [x] **Phase 1 bake = spatial OS** (mapLane ≠ flightBand; clearAbove bans soft burn; regression bake)  
- [x] **Phase 2 planner consumes bake corridor/roof** (samplePlannerCorridor → score/T38 gate)  
- [x] **Phase 3 MVP survival waypoints** (sampleSurvivalWaypoints → scored escape / urban side, building-pressure only)  
- [x] **Phase 3 full pathfinding / long waypoints** (`findBakePath` + long greedy climbBias; combat score soft-yield; replan hysteresis)  
- [x] **H7 energy ECO** (clear local tuning; soft-urban thr/joyX caps; urban energyRecover)  
- [x] **H7 escape bleed abort + F opening AP yield** (F PASS; G-heur PASS)  
- [ ] **Urban AI regression safety green (H7)** — C + G-hybrid plateau; **live 實測 recommended**  
- [x] **Phase B thin knife** (`applyEnemyPredictCombatScore` + softYield)  
- [ ] Phase B full tactical role layer (M8 remainder)  

- [ ] FOX-1 fire vs ring UX (M23)  
- [ ] Chaff under urban escape (M24)  
- [ ] User save / tag release backup  

### Doc drift noted (2026-08-04)
- `README.md` health checklist still marks「Envelope 單一來源」unchecked — actually **H1 closed**; bottom date still says 2026-07-30.  
- Prefer this file + README top status section as truth.

## High (closed detail — archive)

### H1. Weapon envelope multi-source drift — **CLOSED 2026-07-30**
### H2. Opening arm bypasses pylon powering FSM — **CLOSED 2026-07-30**
### H3. Decide-gate order is comment-enforced — **CLOSED 2026-07-30**
### H4. Regression ≠ live FOX2-FIRST FSM — **CLOSED 2026-07-30**
### H5. Opening ambush fragile boolean + magic 0.2 — **CLOSED 2026-07-30**
### H6. Phase A energy gate still exempts soft obstacle escapes — **CLOSED 2026-07-30**

---

*See README.md for architecture dictionary. Update this file when closing High/Medium items.*
