# Technical Debt Log — Air Arena v3.0

**Snapshot date:** 2026-07-27  
**Context:** Post coop/wingman, wreck-fall, match-setup pass.  
**Purpose:** Record known debt before v3.0 backup. Do not treat as a blocker list unless marked **High**.

---

## Summary

| Severity | Count | Focus |
|----------|------:|-------|
| High     | 5     | Envelope sync, pylon bypass, gate order, regression gap, ambush flag |
| Medium   | 14    | Wreck replay/serialize, magic numbers, HUD coupling, StateMachine growth |
| Low      | 7     | Debris cleanup, naming/units, deprecated aliases |

---

## v3.0 新增（Wreck / Coop）

### M12. ACMI 重播不含碎片爆炸
- **Where:** `render.js` (`spawnAircraftDebris`), `combat.js` (`finalizeWreckBurst`)
- **Issue:** 碎片為 `finishTurn` 即時生成，未寫入 `battleLog.vfxTriggers`。
- **Later fix:** 在 log 加 `debris_burst` trigger，或重播時依 `wreckPhase` 重播。

### M13. `wreckPhase` / `wreckBurstTurn` 未序列化
- **Where:** `context.js` `getSerializableTeamState`
- **Risk:** 存檔/重載或外部工具無法還原墜落中狀態。

### M14. `aircraftDebris` 新局未清空
- **Where:** `render.js` `aircraftDebris[]`
- **Risk:** 快速重開 Match 時碎片短暫殘留。

### L7. 硬毀無延遲碎片
- **Design:** 墜地/對撞即爆；僅軟殺+空中墜地有碎片。若需統一可後補。

### ✅ Fixed in v3.0: wreckFall 雙重 execute
- **Was:** `planning` + `uiScheduleBothAITurn` 與 `setTimeout(executeTurn)` 並行。
- **Fix:** `wreckFall: true` 跳過 AI 排程；`scheduleWreckFallTurn` + `turnExecutionLocked` 單一路徑。

---

## High

### H1. Weapon envelope multi-source drift
- **Where:** `js/core/config.js`, `js/ai/pilot-tuning-defaults.js`, `js/ai/pilot-tuning.local.js`, `js/ai/pilot-ai.js` (`getBuiltinDefaults`), `tools/ai-regression.js`
- **Issue:** Gun/FOX-2 ranges live in CONFIG **and** AI tuning **and** hardcoded fallbacks. Live values today: gun **70**, missile min **45** / max+seeker **120**. Regression still has stale `|| 42` / `|| 18` / `|| 95` style fallbacks.
- **Risk:** Tune one file, combat/AI/HUD disagree silently.
- **Later fix:** Single source (`CONFIG.weapons` → derived AI envelope); regression reads same module.

### H2. Opening arm bypasses pylon powering FSM
- **Where:** `js/core/state-machine.js` (`armFox2OpeningMissiles`), called from perch + mid-decide when ambush is on
- **Issue:** Forces `standby`/`powering` → `armed`, skipping normal turn tick (`powering` → `armed` in `resetTurnStatus`).
- **Risk:** Ambush feels correct, but diverges from human SMS / powering UX; edge cases if attach/pylons not ready.
- **Later fix:** Dedicated “instant arm” API with explicit combat log, or one-turn powering that still queues fire next turn.

### H3. Decide-gate order is comment-enforced
- **Where:** `js/ai/pilot-ai.js` (opening shot → alignFirst → urban/flare/shallowDive…)
- **Issue:** Doctrine depends on return-order and string comments (`before alignFirst steals the stick`, flare-before-dive, etc.).
- **Risk:** Reordering blocks or inserting a new early return breaks opening/flare/urban without compile error.
- **Later fix:** Named priority pipeline / scored agenda with unit tests per gate.

### H4. Regression surrogate ≠ live FOX2-FIRST FSM
- **Where:** `tools/ai-regression.js`
- **Issue:** Does not model `fox2-first`, `aiFox2OpeningAmbush`, `alignFirst`, opening immediate shot, or hybridPress lockout.
- **Risk:** Green regression while live opening/ambush/HUD doctrine regresses.
- **Later fix:** Scenario gates for fox2-first ambush on/off; or thin browser harness snapshot tests.

### H5. Opening ambush is a fragile boolean + magic 20%
- **Where:** `aiFox2OpeningAmbush`, `rollFox2OpeningAmbush(teamId, 0.2)`
- **Issue:** Rolled on AI enable / policy switch; gates perch, pre-arm, rush, immediate shot. Chance `0.2` duplicated at call sites.
- **Risk:** Non-deterministic QA; flag can desync from perch/arm if one path skipped.
- **Later fix:** Central constant `FOX2_OPENING_AMBUSH_CHANCE`; persist roll in debug snapshot; optional seed for tests.

---

## Medium

### M1. Magic envelope / spawn numbers outside CONFIG
- **Examples:** spawn Y **38** (`game.js`), perch Y **44**, approach **72** (`state-machine.js`), ambush **0.2**
- **Later fix:** `CONFIG.spawn` / `CONFIG.doctrine.fox2First` block.

### M2. Altitude literals scattered in `pilot-ai.js`
- **Issue:** Dozens of raw thresholds (8–52…) only partly driven by `combatBandMin/Max`.
- **Later fix:** Named altitude profile object shared with regression.

### M3. LCOS is DOM/`style` injection only
- **Where:** `js/view/hud.js`
- **Issue:** Pipper/ghost built in JS; no CSS hooks; hard to theme/test.
- **Later fix:** Static HTML/SVG + CSS classes; JS only updates transforms/colors.

### M4. Missile pipper “in range” = `SEEKER_RANGE`
- **Where:** `hud.js` ← `SEEKER_RANGE` (today equals `maxFlightRange` 120)
- **Risk:** If seeker and flight range diverge later, HUD red ≠ kill envelope.

### M5. LCOS bank lag uses `joyX`, not `pendingRoll`
- **Where:** `hud.js`
- **Risk:** Roll dial without stick under-reports turn lag for human pilots.

### M6. `tryAttachAllPylons` can no-op before arm
- **Where:** `combat.js` + `armFox2OpeningMissiles`
- **Risk:** Ambush arm finds no pylons if mesh/wrappers not ready.

### M7. Live AI CONFIG fallbacks stale vs live CONFIG
- **Where:** `pilot-ai.js` (e.g. lock fallback `60`, gun `|| 42`)
- **Risk:** Missing CONFIG silently shrinks AI envelope.

### M8. `StateMachine` mega-API
- **Where:** `state-machine.js` — heat/AP + fox2 perch/arm/policy/AI apply
- **Later fix:** Split `AiDoctrine` / `PilotInput` modules.

### M9. `window.*` globals for AI/HUD/debug
- **Examples:** `AirArenaAI`, `AIR_ARENA_AI_TUNING`, `lcosLastPos`, `StateMachine` alias
- **Later fix:** ES modules / GameContext registry only.

### M10. Dead `DYNAMIC_GUN_RANGE`
- **Where:** `team-state.js` (=70, exported, unused)
- **Later fix:** Remove or wire HUD/combat to it.

### M11. `hybridPress` dead for `fox2-first`
- **Where:** `applyPolicyMode` early-returns before hybrid scoring
- **Risk:** Accidental removal of early return reintroduces old hybridPress-over-flare bug.

---

## Low

### L1. `gunAngle` degrees (AI) vs `gun.angle` radians (CONFIG)
- Easy unit confusion when syncing.

### L2. `evaluatePolicyUtility` hardcodes envelopes
- Hybrid scoring may prefer shots outside tuned ranges.

### L3. Deprecated `window.StateMachine` alias retained

### L4. Ambush chance default vs explicit `0.2` call args
- Changing default alone does not change call sites.

### L5. “Keep in sync” comment without enforcement
- Defaults duplicated again inside `pilot-ai.js` builtins.

### L6. Opening roof-target altitudes still partly magic
- Tied loosely to spawn/perch; not in CONFIG.

---

## Intentionally accepted (not debt to “fix” before freeze)

| Item | Why keep for now |
|------|------------------|
| FOX2-FIRST ambush ~20% random | Designed unpredictability |
| Instant arm on ambush | Required for first-turn shoot feel |
| Align-first doctrine | Clear LOS → nose then power |
| Gun LCOS inverted-T after schedule | UX choice |
| Gun range 70 / FOX-2 45–120 | Current balance target |
| Spawn Y 38 | User-requested −10m |

---

## Suggested post-freeze backlog order

1. **H1** — single source of truth for weapon + AI envelopes  
2. **H4** — regression coverage for fox2-first ambush on/off  
3. **H5 / M1** — doctrine constants block (chance, perch, spawn)  
4. **H3** — gate priority table / tests  
5. **M10 / M11 / L3** — quick cleanup (dead code, comments)  
6. **M3–M5** — HUD hardening when revisiting sights  

---

## Freeze checklist (v3.0)

- [x] Match Setup 1v1 / 2v2 + seat control/loadout
- [x] 四機編制 `red`/`red2`/`blue`/`blue2` + 陣營 API
- [x] 點選 / 鎖定目標 / 追蹤鏡頭
- [x] Wingman：`follow` / `cover` / `break` / `attack`
- [x] 軟殺緩墜 → 下回合 `spawnAircraftDebris`
- [x] wreckFall 單一路徑（無雙重 execute）
- [x] FOX2-FIRST ambush ~20%；gun 70；FOX-2 45–120；spawn Y 38
- [ ] User save / tag v3.0 backup

---

*Updated for v3.0 backup. See README.md 核心系統字典 for feature dictionary.*
