# Urban Survival Convergence — Working Doctrine

**Status:** Active from **2026-08-09**  
**Scope:** Dense-urban building / ground survival in `js/ai/pilot-ai.js` (and related urban helpers).  
**Gate for Phase B:** B0 完成；B1 碼已上 live `test_01`（`deferred=seekAngle` 已證實；A.0 **優先目錄 lag／beam＋不安全回退**，針 `tapRoleGate:`）。A.1 dump **已關**。A.2a dump **已關**。prep 超時 **booth 已關**。climb defer **已關**。collapse hold yield **無法過關**（碼留下）。A.2b hang yield **可達門過**（碼留下）。**B2 已關** 2026-10-03。B2 recommit 目錄閘 **dump 已關**（碼留下）。defend 目錄閘 **dump 有針、未關帳**。**現役 clear-stick 路徑選枝**（2026-10-11；`hit=1` 且有不撞樓枝則換淨路；不放寬 −160）。M23 已關。包線選彈已關。M24 **已關** 2026-10-10。FOX-2-only **已關** 2026-10-11（武器，不混）。**dead scored-escape reject 可達門過** 2026-10-11（碼留下）。Gold T150 是 building 回歸，不是稀有枝抽樣；驗收用已知巢重跑＋smoke。soft gate 2026-08-25 已關測量波。**tableGlue / collapse 已解凍（2026-08-28）**；**dirtBleed 已解凍（2026-08-28）**。

**Near-term route closed (2026-08-13):** dense-urban survival gate green on live `test_01` (3×T150 building **0/0/0**). Clean A/B vs prior control `Rei_01` was **0/0/0** vs **1/0/1**. Control freeze at that close was **`Rei_02`**.

**Mid-term dual-homotopy harden (2026-08-13):** `AirArenaAiMap.sampleDualHomotopyCorridors` samples L/R bake streets with `pocketRisk`; `buildCorridorHomotopyOptions` prefers `source=bakeDual`. Switch hysteresis: pocket margin ≈0.26, hold `untilTurn+8`, reasons include `combatGoal`. Dump: `bakeDualHt: pref=… L=… R=…`. Wave-2 seed: `buildFlyableCorridorGraph` / `findCorridorGraphPath` fills survival path when A* fails.

**bakeDualPref (2026-08-14):** dump T150a held `active=L why=hold` while `bakeDualHt pref=R L=1.00 R=0.08`. Fix: clear dual pocket gap (≥0.18) forces `why=bakeDualPref`; do not wash open bakeDual street with sticky WP funnel `pocketRisk`.

**Control freeze Rei_03 (2026-08-14):** live `test_01` snapshot after mid-term + bakeDualPref measurement (T150 streaks **1/0/0**, **0/1/0**). Primary A/B control is now **`Rei_03`** (see `AI-Control-Baseline.md`). **tableGlue / collapse thawed 2026-08-28** (`tableGlueHold` when flip would enter a still-dead nest). **dirtBleed thawed 2026-08-28** (`dirtBleedYield` when lock keeps pitch after the dive recovered under facade; `dirtBleedGap` keeps punch bank toward an owned gap). Phase B must not mix with this knife.

**Measurement A/B closed (2026-08-23):** Rei_03 vs Rei_02 T150×3 — building **1 vs 4**, gate **3/3 vs 2/3**, weapon activity Rei_03 ≥ Rei_02. Written back to `AI-Control-Baseline.md`. Still not a weapon knife.

**Soft gate + kills (2026-08-24/25):** 2v2 combat wipes often end before T150. This wave pass = turn ≥ 60, building ≤ 1, combat-end OK. Rei_03 T83 / T65 / T136 **3/3**. Optional gold T150 **16:46 0/0/2**. `kills/mslQ` landed. Stick still frozen. **Phase B** first look: all `test_01` T150 16:54 **0/0/0**; mixed 17:03 test_01 building `tableGlueFlip`/`collapse` — not 2 consecutive T150 same choke, **not thawed**.
---

## Why this exists

Dump-driven patches were oscillating on the **same family** of failures:

`neg roof / false open bowl / table undercroft / steep dive level / climbOut skim`

Typical flip-flops: hard climb into mesh ↔ weak skim dive into table ↔ dirt-arrest into slab ↔ high-alt glue ↔ low-alt ground.

Root cause is not “one more threshold,” but **stacked contradictory hard bans** without a single overhead class or stick owner.

---

## Hard rules (process)

1. **Stop adding dump bans.** Allowed edits: delete contradictions, merge gates, extract classifiers / single stick owner.  
   Forbidden: new `ban *` reason strings keyed to one dump turn.
2. **Pass definition (survival gate):** 3 consecutive dense-urban matches to **T150** with **≤1 building death per match**, and deaths not all the same choke class (e.g. not all `tableUndercroft`).  
   **Soft gate (2026-08-25 measurement wave):** turn ≥ 60, building ≤ 1, combat faction-wipe allowed — used to close the kills/`kills/mslQ` wave without grinding T150. Gold T150 remains the freeze-time standard.
3. **Perception before stick.** Classify overhead once; climb / skim / arrest / escape only read that class.
4. **Single escape owner.** When emergency urban escape owns the stick, climbOut / merge / soft combat must not silently overwrite pitch.
5. **Validate by death class counts**, not only alive/dead:
   - `tableGlue`
   - `falseSilhouette`
   - `spawnMergeDirt`
   - `energyGround`
   - `routePocket` — sticky WP / gapHold into funnel while opposite corridor open (選路，非近樓 stick)
   Same class in 2 consecutive matches → only then touch that class.
6. **Spawn / merge-dirt is a separate queue** from mid-match undercroft.
7. **Phase B** is open on live `test_01` (2026-08-25). Do not mix role retune with stick thaw or a weapon knife.
8. **Route vs stick:** close-range overhead: **tableGlue / collapse thawed 2026-08-28** (hold vs dead-nest flip); **dirtBleed thawed 2026-08-28** (yield recovered facade pitch; keep gap bank under table). Mid/long **route** work uses soft bake WP pocketRisk + earlier replan — do not add stick bans to fix bad corridors. **climb defer closed 2026-09-05.** **collapse hold yield 無法過關 2026-09-05**（碼留下；不放寬 −160）。**A.2b hang yield 可達門過 2026-09-08**（碼留下；不開槍、不放寬 envelope）。**B2 recommit TAP catalog dump 已關 2026-09-08.** **現役 defend catalog**（閘已接回 TAP；真來彈讓路不當失敗）。 **dead scored-escape 可達門過 2026-10-11**（碼留下）：P0 死切從 bake WP 延到任何當選評分枝：`hit=1` 且 `score < -160` 則換非死備選或逼 flip（針 `deadStick=1`）。80/140 重跑 6／6 有針，building 8→5。`hit1NoAlt`＋`levelBank` leftover 不當下一拍。不放寬 −160、不恢復 awayFlip、不重開 collapse hold yield、不混 FOX-2-only。

---

## Stick priority (single source of truth)

1. Steep dive + sinking altitude → **level / arrest** (ban ground smash)  
2. True **table close** → **lateral skim** (ban climb-into-slab)  
3. High alt (≥48) + silhouette / mid–far cov → **high facade escape** (ban weak skim forever)  
4. Else soft bake / route (少強制、優選路)

Code helpers should converge on `classifyUrbanOverhead(...)` (and thin wrappers), not parallel one-off gates.

---

## Route vs stick (near-term path selection)

| Layer | Job | Do not use for |
|-------|-----|----------------|
| Stick / pitch owner | Survive once already under table / facade glue | Choosing which street to enter |
| Bake WP / A* + `pocketRisk` | Prefer open corridor; early-break funnel sticky side | Overwriting dirtBleed pitch |
| gapHold / WP memory | Multi-turn commit | Staying in a U-trap when opposite gap is open |

**`routePocket` dump fingerprint:** death preceded by same-side `gapHold` / WP lock for several turns, rising roof / shrinking clear on WP chain (`isFunnel` / high `pocketRisk`), while opposite corridor gap was flyable. Count separately from `tableGlue` stick deaths.

Helpers: `AirArenaAiMap.scoreWaypointChainPocket`, PilotAI `resolveSurvivalWaypointSteer` replan reasons `funnelGapFlip` / `funnelAltPick` / `lowerPocket`, soft `pocketRisk` in `planUrbanRoute` / `applyBakeRouteCombatScore`.

**P0 dead-cut gate:** `pickScoredUrbanEscapeStick` must not finish on bake WP / bake-corridor with `hit=1` or collapsed score (`<-160`), **or** on a non-bake scored stick with `hit=1` **and** `score < -160` (80/140 T150 undercroft skim −407). Swap to best non-dead alternative or force flip; clear WP memory + gapHold (`pocketReject=* replan=deadWp`; non-bake also `deadStick=1`).

**P1 dual homotopy:** `corridorHomotopyMemory` keeps top-2 `{homotopyId: L|R|C, side, climbBias, pocketScore}`. Switch on `pocketMargin` / `facadeNarrow` / deadWp / **`funnelRejectC`** / **`funnelReplanLateral`** / **`slabRejectC`** / **`funnelEscapeSide`** / **`combatGoal`** / **`bakeDualPref`**. Mid-term: bake `sampleDualHomotopyCorridors` feeds `source=bakeDual`; hold hysteresis margin≈0.26 / `until+8`. Escape same-turn `resolveCorridorHomotopy`.

**Route observability (2026-08-13):** tree must show `survivalWpGate: … pocketRisk=… wpFunnel=…`, `routePocket: …`, and on replan `survivalWp: replan=funnelGapFlip|funnelAltPick|lowerPocket`. Sticky WP memory keeps **max** pocketRisk until replan (no wash). Funnel thresholds ≈0.28; `breakFunnelHold` gap strength ≥0.75. Soft `pocketRisk` weights raised in `planUrbanRoute` / `applyBakeRouteCombatScore`. `clampSoftUrbanStick` exempts `tableGlueCommit`.

**Pocket metric fix:** `scoreWaypointChainPocket` uses `localRoofMax` (neighborhood) + pinch (tall walls beside clear centerline); high-alt `clear`/`skyOpen` only credit open when local density is low — otherwise combat-alt paths were `pocketRisk≡0`.

**tableGlue knife:** undercroft skim `hit=1` → `tableGlueFlip=1` when (a) same-side hit streak≥2, or (b) single catastrophic hit (`score < -180`, cov&lt;14). Flip opposite scrape `joyX` (not sticky away alone); do not cancel solely because `away===side`. Fail recovery honors `forcedExitSide` so flip is not double-inverted. **Commit:** `armTableGlueFlipCommit` forces sticky (`forceFlip`) + `|joyX|≈0.78` for ~3 turns (`tableGlueCommit=1`); mid-alt flip bans soft `midAltLevel` skim.

**tableGlue / collapse thaw (2026-08-28):** consecutive gold T150s (15:50 blue2, 16:36 blue) died `scoreCollapseAwayFlip` / `tableGlueFlip` into still-dead nest (`hit=1`, score≪0, `gapOwnsSafe=0`). **Hold** current/away bank (`tableGlueHold=1`); do not keep 3-turn flip commit when opposite is not owned. Do not mix with Phase B or a weapon knife.

**dirtBleed thaw (2026-08-28):** consecutive gold T150s (01:41 red2 facade building, 01:59 blue2 table ground) died with `dirtBleedRecover=1` still pitch-owning. **Yield** lock when nose is no longer diving into dirt under facade glue (`dirtBleedYield=1`) — do not keep `alt<14` lock after sink recovered. Under true table, if a gap is owned, keep punch bank (`dirtBleedGap=1`) instead of Knife-7 `|joyX|≈0.36`. Near-dirt `dirtPunchThrottle` must not be clamped back to thr3 by nestExitSoft. Do not mix with Phase B, tableGlue hold retune, or a weapon knife.

**Weapon reclaim:** `shouldSoftYieldCombatForBakeRoute` — when `weaponWindowOpen` (or inferred FOX-1/missile prep window), do **not** soft-yield unless steep facade dive (`fwdY < -0.28`) or hard mesh. Stale `bakeYieldLock` alone must not cancel missiles.

---

## Overhead classes (target)

| Class | Meaning | Default stick bias |
|-------|---------|-------------------|
| `clear` | No useful building pressure | Combat / soft route |
| `openBowl` | Climbable courtyard bowl | Soft climb / corridor |
| `besideTall` | Neg AABB roof, not true undercroft | High escape or mild bank |
| `tableWide` | Table / deep roof, mid cover | Lateral skim, limited arrest |
| `tableClose` | True table / tight undercroft, close cov | Max lateral, ban climb-into-slab |
| `facadeClose` | Closing face / glued facade | Lateral + dive-level as priority allows |

---

## Workflow checklist (each session)

1. Classify deaths in the dump(s) into the four buckets above.  
2. If oscillating or adding a ban → **stop**; merge/delete instead.  
3. Prefer one classifier change + wire call sites over N threshold tweaks.  
4. Run `test:building-risk`, `test:decide-gates`, `test:phase3`.  
5. Ask for **Ctrl+F5 + new match** dumps; ignore identical fingerprints / stale exports.  
6. **Stick thaw still needs 2 consecutive T150 same choke.** **tableGlue / collapse** and **dirtBleed** thawed 2026-08-28 — do not mix with Phase B or a weapon knife.  
7. **驗收（2026-09-08）：** 稀有枝用已知巢重跑＋smoke，不要用金標抽新獨特 T150。金標最多 1 批只看 building；第 1 批 leftover 飽和就停。可達門過 = 重跑有針＋building 不退步。無法過關 = 門開了下一拍失敗且再修破凍結。

---

## Related

- Doctrine slogan: **少強制、優選路** (soft aiMap) — still valid; survival hard locks must be **few, ordered, and class-based**.  
- `TECH-DEBT.md` — M8 follow-up / H7 plateau.  
- Thin Phase B knife already landed; full roles live on `test_01` only — do not mix role retune with this dirtBleed thaw or a weapon knife.  
- 接敵走廊／雙機／新武器機體順序：`docs/Path-Cooperation-Roadmap.md`（現停在 A.2；**B2 已關**；包線已關；M24 已關；FOX-2-only 已關；**現役 defend 目錄閘驗收**）。
