# Technical Debt Log — Air Arena v3.0+

**Snapshot date:** 2026-08-05（備份前複檢）  
**Context:** Post Phase 1–3 bake OS + Phase B thin knife + midair/undercroft P0–P1 + UI polish（交戰開始／收納不自動彈／鏡頭下移 10%）。Prior waves: soft-aiMap / typed CM / FOX-1 SARH / chase-cam-8 / top-bar fold / standard 2×F1+2×F2。  
**Purpose:** Living debt list. **High** = silent wrong combat/AI **or** curriculum safety gate collapse; Medium = UX or maintainability; Low = cleanup.

**Canonical docs:** `README.md`（系統字典）· 本檔（債）· `docs/Arena-Map-Onboarding-Memo.md`（**新場地：bake + envelope**）· `docs/PilotAI-Portability-Memo.md`（**PilotAI／引擎預先準備 · 現行 2026-08-05**）· `docs/Urban-Survival-Convergence.md`（**城區生存收斂 · 現行 2026-08-09**）· `docs/Path-Cooperation-Roadmap.md`（**接敵走廊／雙機／武器機體 · 現行 2026-08-28**）· `docs/Tactical-Development-Memo.md`（**歷史備忘，已過時**）

### 新場地提醒（勿跳過）

每次新增／更換地圖或改戰鬥區尺寸時，依 [`docs/Arena-Map-Onboarding-Memo.md`](./docs/Arena-Map-Onboarding-Memo.md)：

1. **AI 烘焙** — `bakeFromMapDoc`／載入 `_aiMap`；Phase 1–3 空間 OS 依賴此圖格網。  
2. **場地包絡** — 水平 AO（`combatAirspace`）＋垂直戰鬥帶；偏好／離心向心／貼地超高空 soft 分應掛場地 profile，**不要**寫死進 `pilot-ai` 核心。  
3. 換尺寸用相對量；生存閘（樓／地）永遠壓過包絡軟分。

### PilotAI 開發準則（現行）

依 [`docs/PilotAI-Portability-Memo.md`](./docs/PilotAI-Portability-Memo.md)：網頁試玩優先；新碼不加深 Three 耦合、不砍感知；調參外置；bake 當空間 OS；改 AI 跑 smoke／regression。

---

## Summary

| Severity | Count | Focus |
|----------|------:|-------|
| High     | 1     | Urban AI regression safety plateau（H7 — C / G-hybrid） |
| Medium   | ~19 open／partial | M23–M24 UX/CM；M17 mega-file；M4–M7 ACMI/wingman；M18/M21 T38／beam |
| Low      | 10    | Debris cleanup, naming/units, deprecated aliases, dump-tag comments, trail forensics |

**2026-08-05 audit:** Smokes（decide / building-risk / phase3 / envelope / doctrine / SARH / ai-map）預期綠；`npm run test:ai` 城區安全門仍 **未全綠**（H7 plateau）。M4–M7 / M10 / M23–M24 **仍在程式碼中成立**（已複核）。

---

## Plan progress (where we are)

| Track | Status | Notes |
|-------|--------|-------|
| Soft aiMap doctrine (少強制) | **Done** | ClearAbove / perch soft-yield; no forced re-engage sticks |
| Phase 1–3 bake / path / combat score | **Done** | spatial OS + planner + WP/path + soft-yield |
| H7 energy ECO + F opening yield | **Landed** | F / G-heur PASS; C + G-hybrid plateau |
| Typed CM + chaff VFX + snapshot ammo | **Done** | Residual: M24 urban escape no chaff |
| Chase cam + top-bar fold | **Done** | Dist 8; seat frame −10% viewport (no-lock); fold no auto-expand on engage |
| Phase B thin knife (M8) | **B0/B0b 完成** · **B1：A.0 優先目錄＋回退** · **B2 生存可對看、五角色等 A.2** | 見 baseline；不加大 ±28 |
| Urban survival convergence | **Active 2026-08-09** | See `docs/Urban-Survival-Convergence.md` — class-based overhead; **tableGlue/collapse + dirtBleed thawed 2026-08-28** |
| Midair yield beside-tall (T9) | **Landed 2026-08-05** | `canYieldToMidairBreak` → `isTrueUnderRoof`（非裸 roof&lt;0） |
| Undercroft stick P1 | **Landed 2026-08-05** | `P1 undercroftBoost` — dirt gate + lateral/skim（dump 待再驗） |
| Arena envelope ≠ AI core | **Done** | `arena-envelope.js` + map `envelope` |
| Map catalog / editor | **Landed (WIP)** | AI hazard tags deferred (M22) |
| Combat UX / CM (M23, M24) | **Open** | Ring vs 70m fire; no `chaffWhileEscape` |
| Radio cues / ACMI 電台 | **Landed thin** | 凍結 6 事件；字幕＋2D 半身＋TTS 測試；錄音包後補 |
| 起始頁目錄 | **Landed** | 玩家目錄＋「測試」；Host／Join／快速配對（`npm run room`） |
| 結算卡頓 | **Partial** | hitch marks（decide／paths／resolve）；火花改 seed 不進 log |
| 序列化 B / 房主權威 | **Landed** | `turn-log-serialize` + netplay protocol；Host/Join／queue；`npm run room`；`?hostRoom=` BC |
| 音訊 mixer | **Landed stub** | master／music／sfx／voice；BGM 尚未掛檔 |
| 火箭巢 | **Stub only** | `CONFIG.weapons.rocket`；decide／SMS **不讀**；插入點見 `docs/Path-Cooperation-Roadmap.md`（A.0 TAP 窗穩後、單獨武器刀） |
| Freeze / tag backup | **You are here** | 2026-08-25 下一波軌道落地 |

---

## Recently fixed (keep for regression awareness)

| Item | Notes |
|------|--------|
| ✅ Phase B thin + rngTie | predict soft-score; `tacticalTieEps=12`; needle `phaseB:` / `rngTie:` |
| ✅ Phase B full roles (M8) | B1 碼＋A.0 目錄閘（`tapRoleGate`）；`deferred=seekAngle` 已證實。B2 生存切線可對看；五角色等 A.2 |
| ✅ Merge diverge hold (T88) | 3-turn bank commit; needle `mergeDiverge:` — mesh away still wins |
| ✅ Midair P0 (T9) | bare `roof<0` @ long cov 不再擋 midair；`deferred=trueUndercroft\|nearDirt` |
| ✅ Undercroft P1 | dirtEmbed `alt<16`；側推 auth／skim joyY；needle `P1 undercroftBoost` |
| ✅ Stick priority align | dirt → undercroft/T38 → diveClosing → scored → climb → handoff → weapons |
| ✅ engageHandoff clears navClimbOut | obstacle + urbanCollision |
| ✅ nearDirtDive / band-ceiling | sensorBlind + HighPerch soft descend |
| ✅ UI: 交戰開始 ▶ | SMS exec label |
| ✅ Fold stays collapsed on engage | no auto-expand in `uiShowComputingOverlay` |
| ✅ Chase frame down 10% | no-lock seat select look-at bias |
| ✅ Soft aiMap / Phase 1–3 / H7 ECO | bake OS; F PASS; C/G plateau |
| ✅ Typed CM + chaff / chase-8 / top-bar | prior wave |
| ✅ True undercroft / handoff / facade / AABB>memory | T76 / T150 / T93 / T88 |
| ✅ H1–H6 closed | envelope / opening FSM / decide-pipeline / FOX2 regression / ambush / energy gate |

---

## High

### H1–H6 — **CLOSED 2026-07-30** (archive at bottom)

### H7. Urban / opening AI regression safety collapse — **OPEN 2026-08-04** (plateau · live 實測優先)
- Pre-Phase-1 baseline: B/C ~0.6–0.75, G ~0.98, F ~0.73.
- **Best Node plateau** (`regression-1785819921344.json` / same as `…9559085`):

| Stage | crash (heur / hybrid) | Notes |
|-------|----------------------:|-------|
| A / D / E | 0 | PASS |
| B-light-urban | **0 / 0** | **PASS** |
| C-medium-urban | **0.13 / 0.15** | FAIL (gate ≤0.10); energy↔building tradeoff |
| F-fox2-opening | **0.05** | **PASS** |
| G-urban-gap-corridor | **0.18 / 0.19** | heur **PASS**; hybrid FAIL by ~0.01 |

- Landed since: Phase B thin, midair P0, undercroft P1, handoff/nav clear — **Node gates not re-run this snapshot**; prefer live dumps then optional `npm run test:ai`.
- Smokes remain the fast contract.

---

## Medium

### M1. Magic spawn / perch / altitude
- spawn Y **28**, perch **44**, approach **72**, dozens of alt literals in `pilot-ai.js`.

### M2. Building bubble radii — **CLOSED 2026-07-30**

### M3. LCOS / HUD fragility
- DOM injection; `setInterval(2000)` rebind; lerp / `400` snap; bank lag from `joyX` not `pendingRoll`; missile “in range” = seeker flight; lead clamped to nose.

### M4. ACMI wreck debris missing from replay — **partial 2026-08-25**
- Live: `spawnAircraftDebris` from wreck mixin / soft-kill ground burst.
- Replay: hard-collision deaths now log `vfxTriggers` `type:'debris'` and `renderCombatFrame` spawns on first age frames. Soft-wreck delayed burst still live-only.

### M5. `wreckPhase` / `wreckBurstTurn` not serialized — **mitigated 2026-08-25**
- `getSerializableTeamState` now includes `wreckPhase`, `wreckBurstTurn`, `matchActive`, `pilotId` / `callsign`.
- Round-trip hydrate of live `wrapper` pose still needs host-authority apply (not a full restore API).

### M6. `aircraftDebris` not cleared on new match — **closed 2026-09-01**
- `clearAircraftDebris()` on `applyMatchConfig` (batch rematch / setup). Live spawn path unchanged.

### M7. Wingman orphan / status noise — **mitigated 2026-09-01**
- `getWingmanLeadId` still only returns a **human** lead (formation FSM unchanged).
- `｜無長機自由作戰` only when the faction actually has a human seat that is gone. All-AI 1v1/2v2 no longer tags every dump.
- Order label maps still duplicated (`state-machine.js` + `pilot-ai.js`). Frozen brains not edited.

### M8. Phase B tactical roles — **B0/B0b 完成** · **B1 A.0 目錄閘** · **B2 生存可對看、五角色等 A.2**
- **目標：** TAP 外層角色，不是 stick、不是武器刀。詳 `docs/AI-Control-Baseline.md`「現行驗收（2026-09-01）」。
- **B0 / B0b：** 已在 Rei_03。
- **B1：** `deferred=seekAngle` 過。A.0：`seek_angle` 優先 lag／beam，不安全回退全目錄（針 `tapRoleGate:`）。不加大 ±28。生存閘當選不當 B1 失敗。
- **B2：** 切線全席兩邊都有 3×T150 GATE；生存可對看。五角色交戰像等 A.2，**不寫過關**。
- **非 M8：** merge diverge；`kills/mslQ`；出生幾何是量測。

### M9. `StateMachine` mega-API + `window.*` globals
- AI doctrine, pilot input, HUD debug coupled.

### M10. Dead `DYNAMIC_GUN_RANGE` — **reconfirmed 2026-08-05**
- Alias of `GUN_RANGE` in `team-state.js` / `GameContext.constants`; no live call sites beyond export.

### M11. `hybridPress` dead under `fox2-first`
- Early return in `applyPolicyMode`; removing it reintroduces old bug.

### M12. `tryAttachAllPylons` can no-op before ambush arm
- Race if wrappers not ready.

### M13. Live AI CONFIG fallbacks stale — **closed with H1**

### M14. Soft-kill vs hard-kill debris asymmetry
- Design choice: ground/midair smash = no delayed debris.

### M15. `roofClearance` dual meaning — **mitigated**
- Named height-delta + `isTrueUndercroft`; field name kept for dump compat.

### M16. Multiple overlapping side-commitment systems — **mitigated**
- Single `resolveAvoidSideAuthority`; residual: `navClimbOut.side` still separate.

### M17. `pilot-ai.js` mega-file + dump-tagged branches — **~23.4k lines（2026-08-29 複檢）**
- 8/5 快照 ~14.1k；之後又長約 9k。Avoid-side／bake／envelope／building-risk **已外置**，但 `decide` 本體與 TAP／stick／僚機／Phase B 仍在同一物件。
- **分類可維修：** `js/core` · `logic` · `ai` · `view` · `tools` 分層清楚；電台／serialize／match 是新檔，不是倒回單體。
- **義大利麵條是單點、不是全庫：** 危險在 live 巨石 + 凍結整份拷貝（`rei_03`／`_02`／`_01` 各 ~21–23k，`index.html` 全載），不是資料夾分錯。`ui.js` ~3.4k（setup／net／僚機／debug 同檔）次要。`decide-pipeline.js` 只鎖 gate 名，handler 仍在巨檔。
- **現在不要拆。** A.0（B1 dump／B2）期間切檔會讓凍結腦對不齊。之後改：對地／編隊開**新層**（envelope／`pair-doctrine`），不要把 23k 切成互相 `window` 呼叫的碎片；凍結腦維持整份快照、不手改。詳 [`docs/Path-Cooperation-Roadmap.md`](./docs/Path-Cooperation-Roadmap.md)「檔案可維修性」。

### M18. Route horizon / beam underused — **partial** (feeds H7)
- Gap asymmetry / facade bias landed; residual: early `risk=low` skips beam; T38 glue fallback.

### M19. Escape↔engage oscillation — **mitigated**
- Handoff + clear navClimbOut landed; residual: handoff-too-early curriculum / dump edge cases.

### M20. Safety sim vs mesh-truth mismatch
- AABB soft vs raycast hard; fat city boxes false-positive streets.

### M21. T38 / hard escape sticks remain large fallback surface — **feeds H7**
- P1 undercroftBoost landed; still track % urban deaths with `T38` / `glued` / `P1 undercroftBoost` in reason.

### M22. Map / editor assets vs AI obstacle truth
- Catalog + editor landed; **deferred:** map-authored `aiHazard` until AI stable.

### M23. FOX-1 fire gate vs illuminate ring UX — **reconfirmed 2026-08-05**
- `supportMinRange: 8` → ring can go hot from ~**8–200m**.
- Queue launch hard-requires **70–200m**.
- Players read flickering ring as “locked → can fire.”

### M24. Typed CM starved by urban / illuminate priority — **partial 2026-08-11**
- Urban / obstacle / collision escape now use `resolveEscapeCountermeasure` → **chaffWhileEscape** (FOX-1/paint) or flare (IR).
- Soft illuminate break may still beam without chaff when reserve/cooldown empty.
- Decide order: `obstacleEmergency` before engagement / CM commit (unchanged).

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
### L9. Dump-tag comment sprawl (`T76`/`T93`/`T150`/`T109`)
### L10. Decision-trail forensics incomplete historically
- Pre-fix trails lack `queue` / `chaff` / `chaffAmmo`. New frames include them.

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
| Chase cam distance 8 + frame −10% | Player-tuned presence |
| Tactical near-tie RNG (`tacticalTieEps`) | Style only among good-enough candidates |
| No aim-ring jitter on lock warn | Explicit product choice |
| Map aiHazard specialization deferred | Stabilize AI first |
| Soft-kill vs hard-kill debris asymmetry | M14 design |

---

## Suggested backlog order (post-backup)

### Critical (safety / live)
1. **H7 / M21** — live dump 驗證 undercroft P1 + midair P0；再決定是否重跑 Node regression  
2. **M18 residual** — beam earlier vs T38 glue %  

### Combat UX / CM
3. **M23** — FOX-1 fire vs illuminate messaging (or unify min range)  
4. **M24** — `chaffWhileEscape` when inbound FOX-1 / paint  

### Product / maintainability
5. **M8 B1/B2** — A.0 目錄閘落地後：TAP 窗 dump ＋金標生存不退步。其後 A.1。B2 五角色等 A.2。禁止加大 ±28。  
6. **M17** — **之後再拆**（A.0 不切檔）。新層（對地／編隊）另檔；不把 live 23k 碎切。Portability：集中 pose／障礙入口仍有效。  
7. **M7** — all-AI 誤標已收；label map 重複仍在  
8. **M4–M5** — ACMI debris replay／serialize；**M6 已關**（新場清碎片）  
9. **M3 / M10 / L3** — HUD harden + dead aliases  

### Auto / health
- `npm run test:ai`（smoke + curriculum）  
- Dump needles: `phaseB:` / `phaseBRole:` / `rngTie:` / `mergeDiverge:` / `P1 undercroftBoost` / `deferred=trueUndercroft` / `deferred=engageHandoff`

---

## Freeze / health checklist

- [x] Match Setup 1v1 / 2v2 + seat control/loadout (standard = 2F1+2F2+gun)  
- [x] Wingman: `follow` / `attack` / `free` / `cover` / `break`  
- [x] Soft wreck fall + debris (live); ACMI debris still open  
- [x] Roof-aware building risk + Scheme B  
- [x] ACMI: restore destroyed aircraft mesh from log  
- [x] NPC destroyed → decision tree `被擊墜`  
- [x] LCOS / envelope / FOX2-FIRST / decide-pipeline / opening powering  
- [x] Soft aiMap + typed CM + chaff VFX + snapshot ammo  
- [x] Chase cam 8 + frame −10% + top-bar fold（交戰不強制展開）  
- [x] Phase 1–3 bake OS / path / combat soft-yield  
- [x] H7 energy ECO + F opening yield（F / G-heur PASS）  
- [x] Phase B thin knife + near-tie RNG  
- [x] **Phase B B1 role FSM 碼** — 2026-08-25 live `test_01`（有效性／A/B 仍開）  
- [x] Midair P0 + undercroft P1 sticks  
- [x] UI: 交戰開始 ▶  
- [ ] **Urban AI regression safety green (H7)** — C + G-hybrid；**live 實測**  
- [ ] FOX-1 fire vs ring UX (M23)  
- [ ] Chaff under urban escape (M24)  
- [x] **User save / tag release backup** — 本快照（2026-08-05）  

### Doc drift
- Prefer **本檔 + README 頂部「目前更新狀態」** 為真相。  
- `docs/Tactical-Development-Memo.md` = 歷史；勿依此改已不存在的 `game.js`／`combat.js` 路徑敘事。

## High (closed detail — archive)

### H1. Weapon envelope multi-source drift — **CLOSED 2026-07-30**
### H2. Opening arm bypasses pylon powering FSM — **CLOSED 2026-07-30**
### H3. Decide-gate order is comment-enforced — **CLOSED 2026-07-30**
### H4. Regression ≠ live FOX2-FIRST FSM — **CLOSED 2026-07-30**
### H5. Opening ambush fragile boolean + magic 0.2 — **CLOSED 2026-07-30**
### H6. Phase A energy gate still exempts soft obstacle escapes — **CLOSED 2026-07-30**

---

*See README.md for architecture dictionary. Update this file when closing High/Medium items.*
