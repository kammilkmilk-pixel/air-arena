# Urban Survival Convergence — Working Doctrine

**Status:** Active from **2026-08-09**  
**Scope:** Dense-urban building / ground survival in `js/ai/pilot-ai.js` (and related urban helpers).  
**Gate for Phase B full role FSM (M8 remainder):** this track must be green first.

**Near-term route closed (2026-08-13):** dense-urban survival gate green on live `test_01` (3×T150 building **0/0/0**). Clean A/B vs prior control `Rei_01` was **0/0/0** vs **1/0/1**. Control freeze at that close was **`Rei_02`**.

**Mid-term dual-homotopy harden (2026-08-13):** `AirArenaAiMap.sampleDualHomotopyCorridors` samples L/R bake streets with `pocketRisk`; `buildCorridorHomotopyOptions` prefers `source=bakeDual`. Switch hysteresis: pocket margin ≈0.26, hold `untilTurn+8`, reasons include `combatGoal`. Dump: `bakeDualHt: pref=… L=… R=…`. Wave-2 seed: `buildFlyableCorridorGraph` / `findCorridorGraphPath` fills survival path when A* fails.

**bakeDualPref (2026-08-14):** dump T150a held `active=L why=hold` while `bakeDualHt pref=R L=1.00 R=0.08`. Fix: clear dual pocket gap (≥0.18) forces `why=bakeDualPref`; do not wash open bakeDual street with sticky WP funnel `pocketRisk`.

**Control freeze Rei_03 (2026-08-14):** live `test_01` snapshot after mid-term + bakeDualPref measurement (T150 streaks **1/0/0**, **0/1/0**). Primary A/B control is now **`Rei_03`** (see `AI-Control-Baseline.md`). Stick (`dirtBleed` / `tableGlue` / collapse) stays frozen unless the same choke repeats on 2 consecutive T150s. Phase B full roles not opened.
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
7. **Phase B full roles stay deferred** until the pass definition holds.
8. **Route vs stick:** close-range overhead stick (dirtBleed / pitch owner) is largely frozen; mid/long **route** work uses soft bake WP pocketRisk + earlier replan — do not add stick bans to fix bad corridors.

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

**P0 dead-cut gate:** `pickScoredUrbanEscapeStick` must not finish on bake WP / bake-corridor with `hit=1` or collapsed score (`<-160`). Swap to best non-dead alternative or force flip; clear WP memory + gapHold (`pocketReject=* replan=deadWp`).

**P1 dual homotopy:** `corridorHomotopyMemory` keeps top-2 `{homotopyId: L|R|C, side, climbBias, pocketScore}`. Switch on `pocketMargin` / `facadeNarrow` / deadWp / **`funnelRejectC`** / **`funnelReplanLateral`** / **`slabRejectC`** / **`funnelEscapeSide`** / **`combatGoal`** / **`bakeDualPref`**. Mid-term: bake `sampleDualHomotopyCorridors` feeds `source=bakeDual`; hold hysteresis margin≈0.26 / `until+8`. Escape same-turn `resolveCorridorHomotopy`.

**Route observability (2026-08-13):** tree must show `survivalWpGate: … pocketRisk=… wpFunnel=…`, `routePocket: …`, and on replan `survivalWp: replan=funnelGapFlip|funnelAltPick|lowerPocket`. Sticky WP memory keeps **max** pocketRisk until replan (no wash). Funnel thresholds ≈0.28; `breakFunnelHold` gap strength ≥0.75. Soft `pocketRisk` weights raised in `planUrbanRoute` / `applyBakeRouteCombatScore`. `clampSoftUrbanStick` exempts `tableGlueCommit`.

**Pocket metric fix:** `scoreWaypointChainPocket` uses `localRoofMax` (neighborhood) + pinch (tall walls beside clear centerline); high-alt `clear`/`skyOpen` only credit open when local density is low — otherwise combat-alt paths were `pocketRisk≡0`.

**tableGlue knife:** undercroft skim `hit=1` → `tableGlueFlip=1` when (a) same-side hit streak≥2, or (b) single catastrophic hit (`score < -180`, cov&lt;14). Flip opposite scrape `joyX` (not sticky away alone); do not cancel solely because `away===side`. Fail recovery honors `forcedExitSide` so flip is not double-inverted. **Commit:** `armTableGlueFlipCommit` forces sticky (`forceFlip`) + `|joyX|≈0.78` for ~3 turns (`tableGlueCommit=1`); mid-alt flip bans soft `midAltLevel` skim.

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
6. Re-check pass definition before any Phase B full-layer work.

---

## Related

- Doctrine slogan: **少強制、優選路** (soft aiMap) — still valid; survival hard locks must be **few, ordered, and class-based**.  
- `TECH-DEBT.md` — M8 remainder / H7 plateau.  
- Thin Phase B knife already landed; do not expand roles here.
