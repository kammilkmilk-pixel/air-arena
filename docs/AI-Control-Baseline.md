# AI Control Baseline（對照組）

**Updated:** 2026-08-25  
**Match-setup names:** **`Rei_03`** (control) · **`Rei_02`** (prior) · **`Rei_01`** (historical) · **`test_01`** (live)

---

## In-game selection

目錄選 **測試**（或 `?lab=1`）才會出現對照下拉；玩家目錄只顯示人工／AI（`test_01`）。  
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

Compare: `building` / `ground` / `combat`, `mslQ`, **`kills/mslQ`** (true combat kills), `illuminate`, `chaffEsc`.

`combat/mslQ` in older reports is **own combat deaths ÷ mslQ**, not kill efficiency. Prefer `kills/mslQ` once dumps have `killedBy` / `combatKills` (2026-08-24+).

Dumps from 2026-08-15+ include per-seat `weaponCounters` (match-long `mslQ`/`gunQ`/`illum`/…); `analyze:weapon-dump` prefers those over the truncated decision trail. 2026-08-24+ also exports `killedBy` (victim) and `combatKills` / `weaponCounters.kills` (attacker).

---

## Freeze-time survival baseline (2026-08-14 Wave Rei_03)

At `Rei_03` freeze, live `test_01` ≡ `Rei_03`. Representative clean dense-urban **T150** building deaths:

| Group | Building deaths (examples) | Notes |
|-------|----------------------------|-------|
| **test_01 / Rei_03** | **1/0/0**, **0/1/0** | Gate PASS (≤1/match); stick residuals only |
| **Rei_02** (prior freeze era) | **0/0/0** at its freeze | Absolute-zero reference |
| **Rei_01** | **1/0/1** at Rei_02 freeze A/B | Classic `collapseLevel` undercroft |

**tableGlue / collapse** and **dirtBleed** thawed 2026-08-28 on live `test_01`. Remaining stick classes still need 2 consecutive T150s. Do not mix with Phase B or a weapon knife.

---

## Live A/B (2026-08-23 · dense-urban 2v2 · T150×3)

Measurement wave after Rei_03 freeze. All seats one brain per match. `weaponCounters` present. **No weapon knife / no stick thaw / no Phase B open.**

| | **Rei_03** | **Rei_02** |
|--|------------|------------|
| Independent T150 | 15:37, 17:10, 17:29 | 17:37, 17:46, 18:16 |
| Building / ground / combat | **1 / 1 / 2** | **4 / 0 / 2** |
| Gate (≤1 building / match) | **3/3** | **2/3** |
| mslQ / gunQ / illum | **31 / 82 / 54** | **22 / 57 / 54** |
| atk+prep (column sum) | 14+65 | 5+82 |
| chaffEsc | 8 | 8 |
| `combat/mslQ` (own deaths) | 0.065 | 0.091 |

**Read:** Rei_03 survives the city better (fewer building sticks, full gate). Weapon *activity* is not weaker than Rei_02. `combat/mslQ` here is still own-death ratio — **not enough to open a weapon knife**. Next dumps should use `kills/mslQ`.

**Do not:** thaw stick unless the same choke hits 2 consecutive T150s; chase 0/0/0 with endless rematches; mix Phase B full roles into this survival/weapon thread.

---

## Live A/B (2026-08-24/25 · Rei_03 · soft gate + kills)

Combat is lethal enough that 2v2 often ends on faction wipe before T150. This wave **does not require T150**.

**Soft gate (this wave):** dense-urban 2v2, all **Rei_03**, match ends by **combat wipe** (or reaches T150), **turn ≥ 60**, **building ≤ 1**. Stress/short stick dumps (T&lt;40) are diagnostic only.

| Match | Turn | Building / ground / combat | Soft gate | kills/mslQ |
|-------|------|----------------------------|-----------|------------|
| T83 16:13 | 83 | 0 / 0 / 2 | PASS | **0.250** (red2 gun+msl) |
| T65 16:16 | 65 | 0 / 0 / 2 | PASS | **0.200** (blue/blue2 msl) |
| T136 16:39 | 136 | **1** / 0 / 1 | PASS | **0.083** (red msl) |
| T35 16:30 stress | 35 | 1 / 1 / 0 | reject | n/a (no weapons) |

Soft gate **3/3**. T136 building death is `collapseLevel` stick — **not thawed** (not 2 consecutive T150 same choke). Gold T150×3 is optional, not blocking.

**Gold T150 (optional, 16:46):** all **Rei_03**, T150, **0 / 0 / 2**, GATE, kills/mslQ **0.250** (blue msl + red msl, 1v1 leftover). Stick tags (`tableGlueFlip`) present but no building death.

`killedBy` / `combatKills` / `weaponCounters.kills` work. **Still no weapon knife** (no Rei_02 kill A/B). **Phase B full roles** open on live `test_01` vs frozen **Rei_03**.

**Protocol:** `combat/mslQ` = own combat deaths ÷ mslQ (old dumps). Prefer **`kills/mslQ`** on dumps from 2026-08-24+ (`killedBy` / `combatKills` / `weaponCounters.kills`).

---

## Phase B — 預定目標 vs 目前進度（2026-08-25）

**Scope:** TAP 外層戰術角色。只改 live `test_01`。**不是** stick、不是武器 envelope、不是 merge-break。

### 預定目標（M8）

| 階段 | 目標 | 非目標 |
|------|------|--------|
| **B0 thin** | 預測敵方位 soft-score；survival 壓力下 softYield | 不覆寫 pitch owner / dirtBleed |
| **B0b rngTie** | 近分 TAP 候選 seeded 平手，避免永遠同一 state | 不是戰鬥 RNG 開火 |
| **B1 角色 FSM** | 五角色對應既有 TAP 目錄，hold 防抖，dump 可讀 | 不堆新 if；不改 Rei_03 凍結腦 |
| **B2 驗收** | 全席 `test_01` vs 全席凍結 **Rei_03**（dense-urban 2v2）；生存不差、交戰更像有角色 | 不混座；不拿 T&lt;60 當 A/B |

角色對 TAP（B1 **設計意圖**，不是現行過關門）：

| Role | 意圖 | 應偏的 TAP |
|------|------|------------|
| `seek_angle` | 拉方位／佔六 | lag / beam；轉向時降 AB |
| `press` | 已有角度優勢 | lead intercept |
| `extend` | 對頭／能量差 | energy cruise；禁 lead |
| `recommit` | 遠距且能量回來 | lead / corridor cut |
| `defend` | 來彈／鎖／照射 | beam（真正 inbound 時 TAP 本來就會讓路） |

### 現行驗收（2026-09-01）

**不再用「再 dump 就會過」當門。** 十字切線＋屋頂之後，同格克隆、T&lt;60、對頭場不當 A/B。密城裡角色常常只是旁觀，不是還沒抽到好場。

| 項 | 現行門 | 結果 | 還要不要改碼 |
|----|--------|------|----------------|
| **量測幾何** | dense-urban 2v2、City Map、十字切線、屋頂 80／92、sep 100／140／200 | **夠用，停改出生** | 否 |
| **B2 生存** | 全席 `test_01` vs `Rei_03`；金標 T150、building ≤1；兩邊都有過連續 3 場 | **量測已過、可對看；不單獨寫 B2 過關** | 否（不為生存再開 stick） |
| **B1 觀察（已證實）** | `alignFirstGate: deferred=seekAngle` 會觸發；`phaseBRole: seek_angle` dump 可讀 | **過** | — |
| **B1 當選** | TAP **真正擁有 stick** 時，`seek_angle` 走**優先目錄** lag／beam；全滅或不安全才回退 cruise／perch | **碼已上**（`pickSeekAngleTacticalWinner`／`tapRoleGate:`）。T92 分型：cruise 291 仍應選 lag。金標 TAP 窗 dump 確認；生存閘當選不當失敗 | 否（本刀已落地）。金標 building 不退步仍要 dump |
| **B2 五角色** | 生存不差 **且** press／extend／recommit 也像角色 | **未過關** — 等 **A.2**，不綁 A.0 一刀 | 等 A.2 |

**舊門作廢：** 「Ctrl+F5 金標 T150 看到 `seek_angle` → lag／beam 就算有效性過」——被模擬分擋住，再刷 6 格只會克隆。**也不要把 ±28 加大到數百**（dump 調參、逼 lag 進樓）。A.0 用目錄閘＋安全回退。

### 目前進度

| 階段 | 狀態 | 證據 |
|------|------|------|
| B0 thin | **完成** 2026-08-05 | `applyEnemyPredictCombatScore`；針 `phaseB: predictAlign=`。已在 Rei_03 凍結腦裡。 |
| B0b rngTie | **完成** 2026-08-05 | `tacticalTieEps: 12`；針 `rngTie:`。 |
| 開門（生存） | **軟門關** 2026-08-25 | Rei_03 T83/T65/T136 **3/3**。Gold T150 可選；已有 16:46 **0/0/2**。Stick 仍凍。 |
| B1 角色 FSM | **碼已上** live `test_01` | `evaluateTacticalRole` / hold 2 / TAP 偏置 / 輕 thr clamp。快照 `tacticalRole`；TAP 當選才有 `phaseBRole:`。凍結腦**沒有**這層。 |
| B1 有效性 | **目錄閘刀（A.0）** | `pickSeekAngleTacticalWinner`：`seek_angle` 先 lag／beam；針 `tapRoleGate:`。T92 舊場若重跑應 `fallback=0` 選 lag／beam，除非優先集不安全。 |
| B2 A/B | **生存可對看；五角色未過關** | 切線後兩邊連續 3×T150 GATE。五角色等 A.2。舊 pair／對頭／T&lt;60／克隆不當 A/B。 |

**同週但不是 Phase B：** merge diverge hold — `buildCloseMidairBreakAction` 路徑 `divergeHold=1` 有生效（T9 保住符號）。**缺口：** `Inbound missile too close: hard break` 不走 builder，不寫 memory（03:28 藍 T6→T7 仍翻邊）。Hold 到期後可再跟 localX 翻（T10）。樹針 `mergeDiverge:` 只在 engagement TAP 前那條 merge；trail `divergeHold=` 才穩。

### 下一刀（只准一條）

A.0 目錄閘落地後：金標 T150 確認 building 不退步，並抽 TAP 窗 `tapRoleGate: fallback=0`。**不要**再開 ±28 或出生。確認後才 A.1（bake 接敵終點）。press／extend 留 A.2。

其後總序：**單機空戰完成 → 對地武器 → 編隊 AI**（現停在單機空戰 A.0）。見 [`Path-Cooperation-Roadmap.md`](./Path-Cooperation-Roadmap.md)。

---

**First look dumps（保留）：**

| Match | Seats | b/g/c | Note |
|-------|-------|-------|------|
| T150 16:54 | all **test_01** | **0 / 0 / 0** | Roles live。0 kills, gunQ=53。 |
| T150 17:03 | red **Rei_03** vs blue **test_01** | **1 / 0 / 0** | 不是 A/B。test_01 blue `tableGlueFlip` / `collapse`。 |
| T150 03:28 | all **test_01** | **0 / 0 / 1** GATE | 1 msl kill。merge hold 部分生效；inbound hard-break 仍翻邊。 |
| T150 03:36 | all **test_01** | **2 / 0 / 0** | red2/blue2 building `collapse`/`dirtBleed`。不解凍。 |
| T150 03:46（=03:47） | all **test_01** | **0 / 1 / 1** GATE | blue ground `dirtBleed`；red combat。 |
| T150 03:59 | all **Rei_03** | **0 / 0 / 1** GATE | 紅 msl 擊落藍2。凍結腦無 merge hold → 藍 T130–132 仍 S 彎（對照組預期）。 |
| T93 04:03 | all **Rei_03** | **1 / 0 / 1** 軟門 | 紅 combat；紅2 building `collapseLevel`。不到 T150。 |
| T119 04:09 | all **Rei_03** | **1 / 0 / 1** 軟門 | 紅 building `dirtBleed`；紅2 combat。choke ≠ T93。 |
| T150 04:17 | all **Rei_03** | **0 / 0 / 2** GATE | 雙方各一發 msl。kills/mslQ **0.222**。 |
| T150 04:43 | all **test_01** | **0 / 0 / 1** GATE | 指紋≈03:28（同死法／同 merge 序列），不當第二場。 |
| T150 04:47 | all **test_01** | **0 / 0 / 0** GATE | 全活、0 擊殺、gunQ=58。藍 TAP `recommit` 卻選 lag（B1 偏置仍弱）。 |
| T129 05:00 | all **test_01** | **0 / 0 / 2** 軟門 | 藍2 兩發 msl 清紅。kills/mslQ **0.167**。0 building。 |
| T150 05:06 | all **test_01** | **2 / 0 / 0** FAIL | 紅2 T96、藍2 T50 皆 `scoreCollapseAwayFlip` + `dirtBleed` + `tableGlueFlip`。與 03:36 同族，但非連續 T150。不解凍。 |
| T150 15:25 | all **test_01** | **0 / 0 / 1** GATE | 紅 msl 擊落藍 T44（inbound hard-break）。0 building。 |
| T86 15:29 | all **test_01** | **1 / 0 / 1** 軟門 | 藍 `tableGlueFlip`/`awayFlip`；藍2 紅 msl。不到 T150。 |
| T150 15:50 | all **test_01** | **2 / 0 / 0** FAIL | 紅2 T36 `dirtBleed`/`collapseExit`；藍2 T120 `tableGlueFlip`/`awayFlip`。 |
| T150 16:36 | all **test_01** | **1 / 0 / 0** GATE | 藍 T37 `tableGlueFlip`/`awayFlip`。與 15:50 連續同族 → **thaw tableGlue/collapse**（2026-08-28）。 |
| T150 17:55 / 01:41 | all **test_01** | **2 / 0 / 0** FAIL | 指紋≈15:50：紅2 `dirtBleed` 撞樓；藍2 `tableGlueHold` 仍死巢。 |
| T150 01:59 | all **test_01** | **0 / 1 / 0** GATE | 藍2 桌下砸地 `dirtBleedRecover`/`slabDirtArrest`。與 01:41 連續同族 → **thaw dirtBleed**（2026-08-28）。 |

---

## Retired seats

| Id | Status | File |
|----|--------|------|
| **ling_0** | Migrates → Rei_01; same brain | `js/ai/baselines/ling_0-pilot-ai.js` (archive) |
| **Rei_00** | Migrates → Rei_01; older peak | `js/ai/baselines/rei_00-pilot-ai.js` (archive, git `15e85b4`) |
