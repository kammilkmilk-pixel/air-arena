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

Dumps from 2026-08-15+ include per-seat `weaponCounters` (match-long `mslQ`/`gunQ`/`illum`/…); `analyze:weapon-dump` prefers those over the truncated decision trail. 2026-08-24+ also exports `killedBy` (victim) and `combatKills` / `weaponCounters.kills` (attacker). 2026-09-28+ types missile kills (`killedBy.weapon` = `fox1`/`fox2`) and exports per-shot `missileShots` (launch dist/angle + outcome). 2026-10-03+ FOX-1／FOX-2 shots add `why`。Gold prints `killsF1/killsF2` and `f1why=`／`f2why=`.

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

**金標取樣（2026-09-27）：** 出生鎖死 = **一格**（dense-urban 2v2、City Map、十字切線、alt 80／sep 283＝斜鄰 200）。舊格 80／200、80／354 封存。四機首 trail **全同**才丟（殘頁／同場重播）。不要用「不同指紋」當獨立樣本，不要用 session 資料夾當 A/B 單位。T&lt;150 不當獨特金標。A.2a 的 trail n=6 是角色目錄例外，不當 stick 預設。

**驗收（2026-09-08）：** 稀有枝（prep hang yield、單回合 stick 針）**不要用金標抽新獨特 T150**。這格吸引子是 leftover（T90 `red@-53,32,-60`、19:45 rematch `red@88,39,49`）；再刷只重複。刀的門 = **已知巢重跑**（全同 leftover／T&lt;150）上的 trail／針 **+ 該刀 smoke**。金標最多 **1 批** `batch:ai:gold`（n=3）只看 **building 不退步**；全同 leftover 當針，不當失敗金標、不當獨特。硬頂仍 2 批；**第 1 批已是已知 leftover 飽和就停**，不准開第 2 批等新指紋。獨特 T150 若碰巧出現可當正證，**不是開門條件**。

**判定窗：**

| 到窗 | 判 |
|------|-----|
| 已知巢重跑有針，smoke 綠，金標 building 不退步（獨特 T150 可有可無） | **過** |
| 獨特 T150 沒走到該枝，但重跑有針、building 不退步 | **可達門過**（同 climb／A.2b） |
| 重跑仍當選舊模式進死巢（尤其因此撞樓） | **未過，留刀** |
| 門出現且下一拍失敗，再修會破凍結 | **無法過關**（同 collapse） |
| 第 1 批已是已知 leftover 飽和 | **停刷** |

**lab ≠ 實玩（2026-09-05）：** 武器／包線快測走 booth，不刷金標。`npm.cmd run batch:ai:weapon` = 1v1、`blank`、`spawnFacing=chase`（紅在藍後同向，禁對頭）、alt 80／sep 140、`maxTurns=60`、n=3。`keepSpawnFacing` 含 chase，AI enable 不 `faceOpponent`。實玩預設與金標凍結不動。金標 T150 是生存／building 回歸，不是稀有枝抽樣機。城裡 hang 不當 prep 超時關門。

| 項 | 現行門 | 結果 | 還要不要改碼 |
|----|--------|------|----------------|
| **量測幾何** | dense-urban 2v2、City Map、十字切線、屋頂 80／92、sep 100／140／200 | **夠用，停改出生** | 否 |
| **B2 生存** | 全席 `test_01` vs `Rei_03`；金標 T150、building ≤1；兩邊都有過連續 3 場 | **已關** 2026-10-03。切線 80／283 兩邊連續 3×T150 GATE 可對看。不為生存再開 stick | 否 |
| **B1 觀察（已證實）** | `alignFirstGate: deferred=seekAngle` 會觸發；`phaseBRole: seek_angle` dump 可讀 | **過** | — |
| **B1 當選** | TAP **真正擁有 stick** 時，`seek_angle` 走**優先目錄** lag／beam；全滅或不安全才回退 cruise／perch | **碼已上**（`pickSeekAngleTacticalWinner`／`tapRoleGate:`）。T92 分型：cruise 291 仍應選 lag。生存閘當選不當失敗 | 否（A.0 已落地） |
| **A.1 接敵走廊** | bake／dual／巷口圖沿機鼻採樣；L／R 只在已成形巷用接敵 XZ 決勝；金標 n=3 building 不退步 | **dump 已關**（獨立 80/200 T150：0/0/0、b1、0/0/0） | 否 |
| **A.2a press／extend 目錄閘** | TAP 當選時 `press` 優先 lead／cut、`extend` 優先 cruise（禁 lead）；不安全回退全目錄 | **dump 已關**（新取樣）。trail：`role`／`tap`／`tapGate` | 否 |
| **prep 超時** | 已在 envelope／鼻錐夠，超時錐不得比 lock 更緊（`shouldPrepTimeoutShoot`） | **booth 已關**（1v1 blank chase T60 shot／prep 1.75）。城裡 hang 是沒進窗（T115 `ang=110 lz=-0.34`）。**碼已不在**（2026-10-18 盤點：live／Rei_03／git 歷史皆無 `shouldPrepTimeoutShoot`） | 否（不重做） |
| **collapse hold yield** | 死巢 hold 不當選 `scoreCollapseLevel` | **無法過關** 2026-09-05。獨特 T150 18:48 T124 yield 後 T125 回選 level 撞樓。**碼已不在**（2026-10-18 盤點：無 `shouldYieldCollapseHoldIntoDeadNest`）。不放寬 −160 | 否 |
| **dead scored-escape** | 當選評分枝 `hit=1` 且 `score < -160` 換非死備選或逼 flip | **可達門過** 2026-10-11。80/140 重跑 6／6 `deadStick=1`，building 8→5。`hit1NoAlt`＋`levelBank` leftover 不當下一拍。碼留下。不放寬 −160、不恢復 awayFlip | 否 |
| **A.2b hang yield** | 超時 `why=hang` 讓路（`deferred=alleyHang`），不開槍、不放寬 envelope | **可達門過** 2026-09-08。注意針已證實。yield 枝這格抽不到（見進度表）。**碼已不在**（2026-10-18 盤點：無 `describeAlleyShotWindow`／`deferred=alleyHang`） | 否 |
| **B2 recommit 目錄閘** | TAP 當選時 `recommit` 優先 lead／cut；不安全回退全目錄 | **dump 已關** 2026-09-08。獨特 T150 `red@-66,96,-300` GATE b0；T114–117 `fallback=0` lead。碼留下 | 否 |
| **B2 defend 目錄閘** | TAP 當選時 `defend` 優先 beam；不安全回退 | **已關** 2026-10-11。80／140 n=3 `b2-test_01-1791697752764` 2／3 beam `fallback=0`。真來彈讓路不當失敗。碼留下 | 否 |
| **FOX-2 f2why=gate** | 解制前、仍在發射門內（10°／迎頭 6°）才跟目標 | **這格飽和、未過關** 2026-10-11。`coastSteer` 有針，迎頭 gate 窗沒再出現。不放寬 10°／6°。不再改 | 否（停刷） |
| **clear-stick 路徑選枝** | 當選 `hit=1` 且已有不撞樓枝（`score > -160`）則換淨路 | **這格飽和、未過關** 2026-10-11。三批 80／140 n=6：`clearStick` 0／18；building 5→4→4 不退步。T31 四機首 trail 全同反覆。不追新指紋。碼留下。不放寬 −160 | 否（停刷） |
| **B2 五角色** | 生存不差 **且** 四角色目錄閘已關 | **已關** 2026-10-03 — seek／press／extend／recommit dump 已關；生存已關。defend 已拆出，另刀 | 否 |

**舊門作廢：** 「Ctrl+F5 金標 T150 看到 `seek_angle` → lag／beam 就算有效性過」——被模擬分擋住，再刷 6 格只會克隆。**也不要把 ±28 加大到數百**（dump 調參、逼 lag 進樓）。A.0 用目錄閘＋安全回退。

### 目前進度

| 階段 | 狀態 | 證據 |
|------|------|------|
| B0 thin | **完成** 2026-08-05 | `applyEnemyPredictCombatScore`；針 `phaseB: predictAlign=`。已在 Rei_03 凍結腦裡。 |
| B0b rngTie | **完成** 2026-08-05 | `tacticalTieEps: 12`；針 `rngTie:`。 |
| 開門（生存） | **軟門關** 2026-08-25 | Rei_03 T83/T65/T136 **3/3**。Gold T150 可選；已有 16:46 **0/0/2**。Stick 仍凍。 |
| B1 角色 FSM | **碼已上** live `test_01` | `evaluateTacticalRole` / hold 2 / TAP 偏置 / 輕 thr clamp。快照 `tacticalRole`；TAP 當選才有 `phaseBRole:`。凍結腦**沒有**這層。 |
| B1 有效性 | **目錄閘刀（A.0）** | `pickSeekAngleTacticalWinner`：`seek_angle` 先 lag／beam；針 `tapRoleGate:`。T92 舊場若重跑應 `fallback=0` 選 lag／beam，除非優先集不安全。 |
| A.1 接敵走廊 | **dump 已關** | 獨立金標 80/200 T150：0/0/0（`red@82,72,74`）、b1（`red@80,63,34`）、0/0/0（`red@166,80,-40`）。針 `bakeDualHt: goal=`。 |
| A.2a press／extend | **dump 已關** 2026-09-05 | 新取樣：一格、丟全同克隆、不追新指紋。金標＋trail n=6（37／200／161／183／227／18；200 回放丟）。press→cut／lead、extend→cruise 皆 `fallback=0`。 |
| prep 超時 | **booth 已關** 2026-09-05 | **碼已不在**（2026-10-18 盤點）。smoke 移到 `test:ai:missing`。不要用城裡 hang≤shoot 關這把。 |
| mandatoryClimb defer | **已關** 2026-09-05 → **只剩一半** 2026-10-18 | 留下：`groundEmergency` 的 `facadeUnsafeGE` 延後（樹針 `mandatoryClimb: deferNearFacade=1`）、`isNavClimbOutFacadeUnsafe`、`mandatoryClimbAlt: 36`。不在：選枝層 `mandClimbLow`／`mandClimbNow` 的 facade 擋線、arm 前 `mandFacadeBan`。smoke 移到 `test:ai:missing`。 |
| collapse hold yield | **無法過關** 2026-09-05 | 窗到。獨特 T150 18:48 `red@202,50,152` 藍2 撞樓：T124 `collapseHoldYield=1`，T125 分數 −149＞−160 回選 `scoreCollapseLevel`。**碼已不在**（2026-10-18 盤點）。不放寬 −160。 |
| A.2b hang yield | **可達門過** 2026-09-08 | 注意針：獨特 T150 19:45 `red@88,39,49` 與 leftover 重跑皆 `why=hang`。yield 門 `deferred=alleyHang` 未在獨特 T150 出現（TAP／recommit hang、`skip=stick`、`held=0`，不進 cruise-prep 超時）。其後金標飽和 T90 leftover `red@-53,32,-60`。smoke `test:alley-time`（移到 `test:ai:missing`）。**碼已不在**（2026-10-18 盤點）。不開槍、不放寬 envelope、不開 `left`。不是無法過關（門沒開過）。 |
| dead scored-escape | **可達門過** 2026-10-11 | 80/140 重跑 `b2-test_01-1791692854129` 6／6 `deadStick=1`；building 8→5。舊巢 T141 −407 被否決後 `hit1NoAlt`＋`levelBank` leftover，不當下一拍（collapse 死區）。smoke `test:dead-scored-escape`。碼留下。不放寬 −160、不恢復 awayFlip。 |
| B2 recommit 目錄閘 | **dump 已關** 2026-09-08 | 獨特 T150 `red@-66,96,-300 | red2@-248,73,-141 | blue@11,31,15 | blue2@-421,97,78` GATE b0/g0。`tapRoleGate: role=recommit pref=tacticalLeadIntercept fallback=0`（T114–117）。T123／T126 `fallback=1` 是 pref 不安全回退 lag。smoke `test:tap-role-gate`。T90 leftover 不當獨特。 |
| B2 defend 目錄閘 | **已關** 2026-10-11 | 80／140 n=3 `b2-test_01-1791697752764` 2／3 beam `fallback=0`。碼留下。 |
| FOX-2 f2why=gate | **這格飽和、未過關** 2026-10-11 | 兩批 80／140 n=6：`1791705108295` building=6、`coastSteer` 13／13、`gate` 0、迎頭 0；`1791706138474` 首 trail 6／6 克隆、building=5、`coastSteer` 12／12、`gate` 0、迎頭 0。真正的 gate 窗（迎頭 3.3°／4.1°）沒再出現。不放寬 10°／6°。不再改、不再刷。 |
| clear-stick 路徑選枝 | **這格飽和、未過關** 2026-10-11 | 三批 80／140 n=6：`1791699654986` building=5、`1791700522685` building=4、`1791701151361` building=4。`clearStick` 0／18。T31 開局克隆 2＋3＋2。第三批仍有 3 條新首 trail，是交戰後散開，不當再刷條件。smoke `test:clear-stick`。碼留下。不放寬 −160、不恢復 awayFlip。不是可達門過（沒針）。 |
| B2 A/B | **已關** 2026-10-03 | 切線 80／283 兩邊連續 3×T150 GATE。四角色目錄閘已關。defend 已拆出。舊 pair／對頭／T&lt;60／克隆不當 A/B。 |
| 姿態／生存刀（2026-10-12～15） | **新基準 predivecm** | 80／140 cross／tangent／standard n=6，同 session A/B `b2-test_01-1791811185637`＋`1791812362391`（共 12 場）。T150 只是時間上限，不是過關門。各刀依序疊加，dump 資料夾後綴即版本名。 |
| ↳ 邊界內轉方向 | **留下** | `resolveAirspaceInwardSide` 用 `crossY >= 0 ? 1 : -1`。共用 `arena-envelope.js` 的 `inwardSide` 符號相反，只在 test_01 `applyArenaEnvelopeScore` 本地反號；核心檔未改（要同意）。smoke `test:airspace-roll`。 |
| ↳ align／merge bank target | **留下** | `bankTargetAction` 加 `mergeBreak`／`mandatoryMergeBreak`，roll 轉成 bank target 而不是一直累加。 |
| ↳ facade pull-over（`-pullover`） | **留下** | 開放天空的 facade 拉起：`isOverheadFootprintOpen`（平面 AABB，邊距 2 m，取代 headroom）＋`isOpenFacadePullOver`；評分原型 `scorePullOver`，免 undercroft −45；出口保持 `joyY≥0.62`、`|joyX|≤0.2`、針 `pullOverHold=1`。building 0、combat 24。smoke `test:pull-over`。**已由 `-pulloverlock`＋`-pulloverclean` 收尾：** T68→69、T130→131 不再切回 undercroft skim。 |
| ↳ beam bank target（`-beam`） | **留下** | `bankTargetAction` 加 `tacticalBeamReposition`。building 0、combat 24（紅 24、藍 0），因此挖出邊界 pitch 符號錯。 |
| ↳ 邊界 pitchCmd 符號（`-rimpitch`、`-punchsync`） | **留下** | `pitchCmd` 會覆蓋 joyY 且同號（負＝抬頭）。高空邊界改 `+maxPitchCmd*(0.45／0.32)`；punch-out 改 `-maxPitchCmd*joyY`。rimpitch building 0、combat 28；punchsync building 0、combat 23。 |
| ↳ pre-dive 依類型反制（`-predivecm`） | **留下** | `flare before shallowDive/level-out` 加 `!inboundFox1 && !shouldChaffNow`，FOX-1 不撒熱焰彈。building 0、combat 11＋10＝21。smoke `test:countermeasure-doctrine`。 |
| ↳ pre-urban 依類型反制＋pull-over 鎖（`-preurbanchaff`＋`-pulloverlock`） | **留下** 2026-10-18 | 開關／stick 不動，只換 `queueAction`。T131 閃爍用 `carry=1` 強制拉起。80／140 n=6×2 對 predivecm：building 0＝0、combat 21→15。T132 有 `chaff while obstacle-escaping`。 |
| ↳ 來彈硬切 diverge hold（`-inboundhold`） | **留下** 2026-10-20 | `hardInboundBreak && !cmNow` 只取 builder joyX／memory。n=6 對 pulloverlock：building 0＝0，combat 8→10。舊 S 彎 T120 −0.83→T121 +1.00 消失。殘頁：joyX≈0 微翻號；箔條／熱焰彈／mask 未接。smoke `test:inbound-diverge`。 |
| ↳ 包線 inwardSide 短轉（`-envside`） | **留下** 2026-10-20 | `arena-envelope.js` 改 `crossY >= 0 ? 1 : -1`，拿掉 test_01 本地反號。不改 Rei_03。n=6 對 inboundhold：building 0＝0，combat 10→11。rim long-side 0%。 |
| ↳ TAP 掛 typed CM（`-tapcm`） | **留下** 2026-10-21 | `pickTacticalApproach` 桿／state 不動，只掛 `shouldChaffNow`→chaff、`shouldFlareNow`→flare。n=6 對 envside：building 0＝0，combat 11→6，gate 1/6→6/6。針 T52 blue `tapCm=chaff`。T117 red FOX-2 死亡消失。 |
| ↳ 來彈 hold 補完（`-cmhold`） | **暫時凍結（撤回）** 2026-11-19 | `cmNow` 改吃 builder `joyX`＋`mask` 寫 memory＋`applyDecideSoftHints` 護 `joyX`。n=6 對 tapcm：building 0→6（T8 `blue2` 提早分岔 → `red T104` pull-over 後 `dead-route` 撞樓），退回 `-tapcm`。 |
| ↳ pull-over 補完（`-pulloverclean`） | **留下＝目前基準** 2026-11-19 | `decide()` 豁免 `isPullOverEsc`（不讓 `tableOwner=1` 壓成 `thr=3`／橫滾）、`chooseSafeAction` `glueLock` 豁免 `!action.pullOver`、`pitchScale` 0.58→0.62。n=6 對 tapcm：building 0＝0、combat 6＝6、gate 6/6（軌跡全同；T68→69 殘頁結案）。smoke `test:pull-over`。 |
| ↳ pre-urban 依類型反制（`-preurbancm`） | **撤回** | 同條件加到 `flare before urban route/climb` → building 9、combat 1。原碼不動。**殘頁：** T135 red2 在這枝撒熱焰彈後被 FOX-1 擊落；T117 red1 熱焰彈 0 發被 FOX-2 擊落。 |
| H7 Node 回歸 | **關帳 2026-10-21** | Live 城區安全以 80／140 building 0 為準（`-tapcm`）。Node `ai-regression.js` 不載入 `pilot-ai.js`；C／G 改平台鎖（C ≤0.15、G ≤0.20），對齊 10-18：C 0.125／0.15、G 0.175／0.1917。A／B／D／E／F 原門。不刪 runner。變差才紅。 |

**同週但不是 Phase B：** merge diverge hold — `buildCloseMidairBreakAction` 路徑 `divergeHold=1` 有生效（T9 保住符號）。來彈硬切 **已接** 2026-10-20（`-inboundhold`，只取 joyX）。Hold 到期後可再跟 localX 翻（T10）。箔條／熱焰彈／mask 枝仍不寫 memory。樹針 `mergeDiverge:` 只在 engagement TAP 前那條 merge；trail `divergeHold=` 才穩。

### 下一刀（只准一條）

**階段 A 狀態凍結（2026-11-19）。** 目前基準：`-pulloverclean`（`-tapcm` 上補齊 `pullOver` 的 `decide`/`chooseSafeAction` owner 豁免與 `pitchScale: 0.62`；n=6 building 0、combat 6、gate 6/6；T68→69 結案）。`-cmhold` 已暫時凍結並撤回（building 0→6）。A.2 不再開新刀；下一步依總序進 [`Path-Cooperation-Roadmap.md`](./Path-Cooperation-Roadmap.md) **階段 B（對地武器）**。

**現役：pre-urban 依類型換反制（2026-10-18）。** `missileDefenseUrgent` 的開關與 stick **完全不動**（上次跳過整枝 → building 0→9）；只把 `queueAction` 換成 `preUrbanCm`：純 FOX-1 來襲時，有干擾絲且冷卻好 → `chaff`，否則 `none`；有 FOX-2 → `flare`。樹針 `defensiveFlare-preUrban cm=`。門：80／140 n=6×2 同 session 對 predivecm，building 不退步（0），T135 red2 不再撒熱焰彈對 FOX-1。smoke `test:countermeasure-doctrine`。不改 Rei_03、不放寬 10°／6°、不改 M24。

**結果（`-preurbanchaff`）：building 退步，未過門。** combat 21→9（11→6、10→3），building 0→7。7 次全是同一指紋 red2 T131：前面省下熱焰彈 → red T117 撒熱焰彈活下來 → red2 從 T118 走新路 → T130 選 pull-over（`hit=0`）→ T131 切回 undercroft skim `score=-159.6 hit=1` 撞樓（差 0.4 沒被 −160 擋）。反制本身有效；撞樓是 pull-over 閃爍殘頁被引出。去留待決。

**現役補刀：pull-over 延續鎖（`-pulloverlock`）。** 上一拍選了 pull-over 且平面 footprint 仍開 → 強制 `joyY=0.62`，不再跟 skim 比分（針 `carry=1`）。table owner 不得搶 stick。**過門 2026-10-18：** 對 predivecm building 0＝0、combat 21→15（8＋7）。T131 撞樓指紋消失；red2 多場活到 T142 才空戰死亡。session `1791811185637`／`1791812362391`。

**前一刀（已拿掉）：** FOX-2 `f2why=gate` 80／140 兩批飽和、未過關（`coastSteer` 有針，迎頭 gate 窗沒再出現）。不放寬 10°／6°，不再改、不再刷。defend 目錄閘 **已關**。clear-stick 這格飽和、未過關。

B2 **已關** 2026-10-03（生存＋四角色目錄閘）。

collapse hold yield **無法過關**（碼已不在）。dead scored-escape **可達門過** 2026-10-11（碼留下）。climb defer **已關**（只剩 groundEmergency 那一半）。prep 超時 **booth 已關**（碼已不在）。A.2a dump **已關**。A.2b **可達門過**（碼已不在）。B2 recommit **dump 已關**（碼留下）。不要修 collapse／−160／awayFlip、不要再開 ±28、A.0／A.2a／recommit 閘、`left`。不要把 defend／選彈／M24 拆進同一把 dump。

**排隊：** FOX-2 `f2why=gate` **這格飽和、未過關**（碼留下，不再改）。defend 目錄閘 **已關**。clear-stick **這格飽和、未過關**。FOX-2-only **已關**。dead scored-escape **可達門過**。`left` 預測仍未開。目前基準：`-pulloverclean`（tapcm 上補齊 `pullOver` 後段豁免與 `pitchScale: 0.62`；n=6 building 0、combat 6）。

其後總序：**單機空戰完成 → 對地武器 → 編隊 AI**（階段 A 狀態凍結 2026-11-19；下一步開階段 B 對地武器）。見 [`Path-Cooperation-Roadmap.md`](./Path-Cooperation-Roadmap.md)。

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
