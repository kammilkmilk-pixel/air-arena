# AI Control Baseline（對照組）

**Updated:** 2026-08-14  
**Match-setup names:** **`Rei_03`** (control) · **`Rei_02`** (prior) · **`Rei_01`** (historical) · **`test_01`** (live)

---

## In-game selection

Match Setup → 機組配置 → control dropdown:

| Option | Meaning |
|--------|---------|
| **人工** | Human stick |
| **Rei_03** | Frozen control PilotAI (2026-08-14 mid-term + bakeDualPref) |
| **Rei_02** | Prior control (2026-08-13 route near-term freeze) |
| **Rei_01** | Older control (2026-08-11 ling_0 freeze) |
| **test_01** | Current working PilotAI (`js/ai/pilot-ai.js`) |

Files: `js/ai/baselines/rei_03-pilot-ai.js`, `rei_02-pilot-ai.js`, `rei_01-pilot-ai.js`, `js/ai/ai-model-registry.js`.

Legacy **`ling_0`** / **`Rei_00`** seat values migrate to **`Rei_01`**. Snapshot files `ling_0-pilot-ai.js` and `rei_00-pilot-ai.js` stay on disk but are not loaded.

---

## Freeze note (Rei_03)

| Item | Value |
|------|--------|
| **Source** | live `test_01` after mid-term dual-homotopy corridors + `bakeDualPref` + post-knife measurement |
| **Date** | 2026-08-14 |
| **Why** | Dense-urban survival gate green on live (T150 streaks **1/0/0**, **0/1/0**). Route/homotopy C pocket chain closed; residual building deaths are stick (`collapseLevel` / dirt) — frozen unless same choke on 2 consecutive T150s. Phase B not opened. |

At freeze, live `test_01` ≡ `Rei_03`. Do not rewrite `rei_03-pilot-ai.js` in place; next control freeze is `Rei_04`.

**Honest delta vs Rei_02 absolute zeros:** Rei_02 freeze-time A/B was building **0/0/0**. Rei_03 era passes ≤1/match but has not reclaimed sustained **0/0/0**. Prefer A/B `Rei_03` vs `Rei_02` for mid-term survival/weapon deltas.

---

## Freeze note (Rei_02 — prior)

| Item | Value |
|------|--------|
| **Source** | live `test_01` after route / homotopy near-term (pocketRisk, funnel replan, `slabRejectC`, escape same-turn resolve) |
| **Date** | 2026-08-13 |
| **Why** | Dense-urban A/B vs Rei_01: test_01 building **0/0/0** on 3×T150; Rei_01 **1/0/1**. |

---

## Freeze note (Rei_01 — historical)

| Item | Value |
|------|--------|
| **Source** | `ling_0` control freeze (= live `test_01` at 2026-08-11) |
| **Date** | Control seat renamed 2026-08-13; brain freeze 2026-08-11 |
| **Why** | Then-highest overall scored baseline after urban knives through dirtBleed / gapCut / collapseExit |

---

## Live A/B (survival + weapon efficiency)

1. **Ctrl+F5** → `http://127.0.0.1:8080/` → dense-urban **2v2**.
2. **Weapon A/B:** one batch all seats **Rei_03**, one batch all **test_01** (same arena/mode). For mid-term delta vs prior freeze, batch **Rei_02**. Export each match.
3. Score:

```bash
npm run analyze:weapon-dump -- --group Rei_03 path/to/rei03/*.json --group Rei_02 path/to/rei02/*.json
```

Compare: `building` / `ground` / `combat`, `mslQ`, `combat/mslQ`, `illuminate`, `chaffEsc`.

Dumps from 2026-08-15+ include per-seat `weaponCounters` (match-long `mslQ`/`gunQ`/`illum`/…); `analyze:weapon-dump` prefers those over the truncated decision trail.

---

## Freeze-time survival baseline (2026-08-14 Wave Rei_03)

At `Rei_03` freeze, live `test_01` ≡ `Rei_03`. Representative clean dense-urban **T150** building deaths:

| Group | Building deaths (examples) | Notes |
|-------|----------------------------|-------|
| **test_01 / Rei_03** | **1/0/0**, **0/1/0** | Gate PASS (≤1/match); stick residuals only |
| **Rei_02** (prior freeze era) | **0/0/0** at its freeze | Absolute-zero reference |
| **Rei_01** | **1/0/1** at Rei_02 freeze A/B | Classic `collapseLevel` undercroft |

Stick (`dirtBleed` / `tableGlue` / collapse) remains frozen unless the same choke repeats on **2 consecutive T150s**.

---

## Retired seats

| Id | Status | File |
|----|--------|------|
| **ling_0** | Migrates → Rei_01; same brain | `js/ai/baselines/ling_0-pilot-ai.js` (archive) |
| **Rei_00** | Migrates → Rei_01; older peak | `js/ai/baselines/rei_00-pilot-ai.js` (archive, git `15e85b4`) |
