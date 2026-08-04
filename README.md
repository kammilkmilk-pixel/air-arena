# 📖 Air Arena 核心系統字典 (v3.0)

## 目前更新狀態

**版本快照：v3.0+**（文件更新 **2026-08-04**）  
基於 v2.2 Stable 架構；v3.0 協作編隊／殘骸之後，續修 AI 城區、SARH／箔條、鏡頭與頂欄 UX。  
**備份前請以本節 + [`TECH-DEBT.md`](./TECH-DEBT.md) 為準。**

### 已完成（v2.2 基礎）

- **資料夾結構**：`index.html` 引用路徑已對齊 `css/`、`js/`、`assets/vfx/`、`assets/models/`、`assets/interface/`。
- **啟動方式**：`npm start` → `http://127.0.0.1:8080/`（建議用 `/?query`，勿直接雙擊 HTML）。
- **資源容錯**：`fallbacks.js` 戰機、城市、VFX 缺失時可降級運行。
- **LCOS 修正**：機砲準星大小綁定兩機實際距離，不受鏡頭遠近影響。
- **Phase 1–3 架構**：`GameContext` 收斂 state / services / three / stateMachine；TeamState / TeamView 分層。
- **AI MVP + 回歸**：`pilot-ai.js` FSM、城市避障、hybrid / fox2-first；`npm run test:ai` 課程＋煙測。

### 已完成（v3.0 新增）

| 階段 | 內容 |
|------|------|
| **0a Match Setup** | 開局 UI：1v1 / 2v2、各席位 Human / AI、掛載偏好 |
| **0b Multi-unit** | 四機編制：`red` / `red2` / `blue` / `blue2`；`matchActive`；陣營 API |
| **選取與鏡頭** | 點選切換；點敵鎖定；追蹤鏡頭以己機為軸、對準鎖定目標（距離 **8**） |
| **MFD 顯示規則** | 僅當前**人類**座席且非動畫中顯示 MFD |
| **Phase 1 Wingman** | 僚機五指令：`follow` / `attack` / `free` / `cover` / `break` |
| **殘骸墜落** | 擊毀緩墜 → 次回合碎裂；撞地／對撞即時殉爆 |
| **勝負延遲** | `wreckPhase: 'falling'` 時延後 `game_over` |

### 近期續修（2026-07 末 → 08-01）

| 項目 | 內容 |
|------|------|
| **AI 城區** | 屋頂淨空、Scheme B、`buildingRiskDowngrade: 0`、true undercroft／handoff／facade／AABB>memory |
| **Phase A 能量** | 大轉向降 thr；軟避障能量門（H6） |
| **ACMI** | 擊墜僚機可再顯示；碎片 VFX 仍缺（M4） |
| **Decide / envelope** | `decide-pipeline`、`weapon-envelope`、多項 smoke |
| **LCOS** | 相對拖曳、軸修正、遮擋仍顯示外環 |

### 本波已完成（2026-08-02）

| 項目 | 內容 |
|------|------|
| **Soft aiMap** | 儘量不強制 stick；clearAbove／perch 軟讓路 |
| **雷達鎖定 SMS** | 「被鎖定」跑馬燈；無瞄準環 jitter |
| **Typed CM** | FOX-1／SARH paint → chaff+beam；FOX-2 → flare |
| **Chaff** | 5 回合白煙+閃光；擋在鏡頭與機之間半透明；快照含 `chaffAmmo` |
| **標準掛載** | **2×FOX-1 + 2×FOX-2 + Gun**（內 F1／外 F2） |
| **頂欄 UX** | 「運算中」併入狀態列；播放列常駐；▾ 向下收合隊伍／狀態／決策樹 |
| **地圖** | `assets/maps` + `map-editor/`（AI hazard 標籤仍延後，見 M22） |

### 關鍵數值（當前平衡）

| 項目 | 值 |
|------|-----|
| 機砲射程 | 70 |
| FOX-2 有效窗 | **35–120** |
| FOX-1 射程／發射窗 | seeker **200**；發射排程 **70–200**（照射環可從 ~8m 顯示） |
| 標準掛載 | P1/P4 FOX-1、P2/P3 FOX-2 + SMS 機砲 |
| 開局高度 Y | **28**（Match Setup 可選 28／45／60／80） |
| 追蹤鏡頭距離 | **8**（己機軸心 → 鎖定目標） |
| FOX2 開局偷襲機率 | `fox2OpeningAmbushChance` 預設 **0.2** |
| 建築風險降級 | `buildingRiskDowngrade: 0` |
| Chaff 壽命 | 5 回合（`lifeSteps` 500） |

### 目前技術債（摘要）

- **High：** 城區 AI 回歸（H7）— Phase 1–2 後 B/D 已綠；C/F/G 仍待量測／收斂。
- **Medium 優先：** FOX-1 照射環 vs 發射窗 UX（M23）；CM 被城市逃生擠掉（M24）；T38／beam（M18/M21）；**Phase B thin knife 已落地（M8 完整角色層仍後）**；ACMI 碎片（M4–M6）。
- **詳表與計劃進度表：** [`TECH-DEBT.md`](./TECH-DEBT.md)（快照 **2026-08-04**）。`docs/Tactical-Development-Memo.md` 為歷史備忘，勿當現行架構。
- **新地圖必讀：** [`docs/Arena-Map-Onboarding-Memo.md`](./docs/Arena-Map-Onboarding-Memo.md) — 每次換場地／新圖必須做 **AI 烘焙 + 場地包絡限制**；尺寸／AO／高度帶掛場地 profile（`js/core/arena-envelope.js`），勿寫進 PilotAI 核心。
- **PilotAI／引擎預先準備：** [`docs/PilotAI-Portability-Memo.md`](./docs/PilotAI-Portability-Memo.md) — 網頁試玩優先；開發期不加深 Three 耦合、不砍感知；Godot 等為日後美術殼，試玩達標再脫鉤。

### Phase 1 架構（烘焙 = 空間 OS）

- **烘焙地圖**：soft `clearAbove` / `skyOpen` / `mapLane`（屋頂帶）權威；AABB 只確認硬接觸。
- **flightBand**（舊 `altitudeLane.lane`）：依自身高度，≠ `mapLane`。
- `clearAbove` 時禁止 `urbanPreemptiveAvoid` / `obstacleEnergyClimb` 耗能織避。
- 回歸：`tools/ai-regression.js` 每集 bake `_aiMap`。

### Phase 2（planner 吃烘焙走廊）

- `AirArenaAiMap.samplePlannerCorridor`：前向／左右屋頂與 sky 採樣 → `preferredSide` / `corridorOpen` / `forwardClear`。
- `planUrbanRoute` + `pickScoredUrbanEscapeStick` + 回歸 `planUrbanAction`：壓力／評分偏開側與開空，非 pathfinding。
- T38／hard-lock：僅真 mesh glue；bake clear 時不因旁邊高樓 AABB 落入 flat glue。

### Phase 3（生存航點 → full pathfinding）

- `AirArenaAiMap.sampleSurvivalWaypoints`：貪婪 6–12 步開空／低屋頂格 + `climbBias` / `targetAlt`（非僅側向）。
- `AirArenaAiMap.findBakePath`：bake 格短視窗 A*；代價含高屋頂／低淨空／掉頭；重規劃有 hysteresis。
- Pilot：`applyBakeRouteCombatScore` 把立面閉合＋俯衝＋corridor／WP 寫進 escape／urban route／tactical approach 評分；`shouldSoftYieldCombatForBakeRoute` 讓 align／shallowDive **軟讓路**（非硬擋）。
- 僅在建築壓力時 stick 偏置（`survivalWpGate`）；遠距 WP／path 可作分數特徵（`survivalWpHint`）。
- 決策樹：`survivalWpGate` + `alignFirstGate softYield=` / `shallowDiveGate: deferred=bakeRouteScore`。

---

## 專案結構

```
Air-Arena-v2.2-Stable/          # 目錄名保留；文件版本 v3.0+
├── index.html                  # 遊戲入口 + Match Setup + 頂欄
├── package.json
├── README.md                   # 系統字典（現行）
├── TECH-DEBT.md                # 技術債 + 計劃進度（現行）
├── css/style.css
├── docs/
│   ├── Arena-Map-Onboarding-Memo.md   # 新場地：bake + envelope 檢查清單（現行）
│   ├── PilotAI-Portability-Memo.md   # PilotAI 優先／引擎預先準備（現行）
│   └── Tactical-Development-Memo.md  # 歷史備忘（已過時）
├── map-editor/                 # 地圖編輯器（WIP polish）
├── js/
│   ├── game.js                 # 主迴圈、點選、鏡頭、模型載入
│   ├── core/
│   │   ├── config.js               # 數值、資源路徑、doctrine
│   │   ├── combat-airspace.js      # 硬／軟 AO 壓力（出界殺）
│   │   ├── arena-envelope.js       # 場地包絡 profile + soft 分（跟地圖掛）
│   │   ├── context.js              # GameContext、陣營/目標/對戰 API
│   │   ├── fallbacks.js
│   │   ├── map-catalog.js / map-loader.js
│   │   ├── team-state.js
│   │   ├── compat-aliases.js
│   │   ├── state-machine-match.js
│   │   ├── state-machine-wreck.js
│   │   └── state-machine.js
│   ├── logic/
│   │   ├── combat-helpers.js / combat-pipeline.js / combat-resolution.js / combat-turn.js
│   │   ├── physics.js / weapon.js / sarh.js
│   ├── ai/
│   │   ├── pilot-ai.js / decide-pipeline.js / building-risk.js / weapon-envelope.js
│   │   ├── ai-map.js / urban-avoid-side.js / pilot-tuning-defaults.js
│   └── view/
│       ├── render.js / ui.js / hud.js
├── tools/                      # regression、smoke、autotune、bake:ai-map
├── assets/
└── TECH-DEBT.md
```

## 快速啟動

```bash
npm install
npm start
```

瀏覽器：`http://127.0.0.1:8080/`  
開發面板：`?dev=1`  
跳過 Match Setup：`?skipSetup=1` 或 scenario URL。

---

## 對戰設定 (Match Setup)

- **模式**：`1v1`（僅 red/blue）｜`2v2`（啟用 red2/blue2）
- **席位**：`red-1` / `red-2` / `blue-1` / `blue-2` → `control: human | ai`、`loadout: standard | gun-priority | fox2-priority | fox1-priority`  
  - **standard** 預設掛載：`fox1, fox2, fox2, fox1` + SMS 機砲  
- **套用**：`GameContext.stateMachine.applyMatchConfig(config)` → 設 `matchActive`、AI 政策、武器預選
- **狀態**：`GameContext.state.matchReady`

### 陣營與目標 API（`context.js`）

| API | 說明 |
|-----|------|
| `getFaction(teamId)` | `red` / `blue` |
| `getActiveMatchIds()` | 本場參戰且有 wrapper 的機體 |
| `getLivingTeamIds()` | 參戰且未 `isDestroyed` |
| `getHostileIds(teamId)` | 敵陣營存活單位 |
| `getAllyIds(teamId)` | 同陣營僚機（不含自己） |
| `getNearestHostileId(teamId)` | 最近敵機 |
| `getTargetId(teamId)` | 手動鎖定優先，否則最近敵 |
| `setLockedTarget(teamId, targetId)` | 點選敵機鎖定；`null` 清除 |
| `isFactionEliminated(faction)` | 該陣營無存活單位 |
| `areAllLivingReady()` | 全員 ready 或已毀 |

---

## 僚機指令 (Wingman Orders) — Phase 1

適用：`aiEnabled` 的 wing 席位（如 `red2`）。

| 指令 | 行為摘要 |
|------|----------|
| `follow` | 跟隨長機隊形槽位 |
| `cover` | 掩護長機，偏威脅軸 |
| `break` | 脫離、拉開距離 |
| `attack` | 沿用長機 `getTargetId`，進入一般 combat decide |

- **設定**：`GameContext.stateMachine.setWingmanOrder(teamId, order)`
- **AI**：`pilot-ai.js` → `getWingmanLeadId` / `decideWingmanSupport`；支援狀態下跳過 `applyPolicyMode`
- **UI**：點選友軍 AI 僚機 → 白框 + `#wingman-order-hud`

---

## 殘骸生命週期 (Wreck Lifecycle)

擊毀方式決定演出路徑：

| 擊毀原因 | 當回合 | 下一回合 | 碎片 |
|----------|--------|----------|------|
| 機砲 / 飛彈（空中） | 緩墜軌跡 + 輕煙（`softWreck`） | `finalizeWreckBurst` 爆炸 | ✅ |
| 墜地 / 撞樓 / 對撞 | 即時爆炸 VFX | — | ❌（或僅軟殺+墜地時有） |

### 狀態欄位

- `wreckPhase`: `null` → `'falling'` → `'gone'`
- `wreckBurstTurn`: 預定爆碎回合（通常 `currentTurn + 1`）
- `isDestroyed`: 進入 falling 即為 true（仍佔用墜落回合）

### StateMachine

- `beginWreckFall(teamId, burstAfterTurns = 1)` — 開始緩墜
- `finalizeWreckBurst(teamId)` — 隱藏機體 + `spawnAircraftDebris`
- `markDestroyedFlightState(teamId)` — AP/ready 歸零

### 回合流程（combat-pipeline / resolution / turn）

1. 擊殺當回合：`resolveDamageAndDeathForStep` 標 `softWreck`，改寫剩餘路徑為緩墜
2. `finishTurnSimultaneously` → `beginWreckFall`
3. 若已一方全滅但仍有 `wreckPhase === 'falling'`：發 `planning` + `wreckFall: true`，**僅** `scheduleWreckFallTurn` 自動執行（不與 `uiScheduleBothAITurn` 重疊）
4. 下一回合結束：`finalizeWreckBurst` → `game_over`

### VFX

- `window.spawnAircraftDebris(pos, quat, color)` — 即時碎片 + 佔用 explosion/flash pool
- `window.updateAircraftDebris()` — `animate()` 每幀更新

---

## 選取、鏡頭與操控

- **點己機**：`selectTeam` + 追蹤鏡頭（距離 `CHASE_CAM_DIST = 8`）
- **點敵機**：`setLockedTarget`；鏡頭仍以己機為軸，沿「己機↔鎖定」對準目標（`getAircraftChaseCamPose`）
- **運算中**：頂欄狀態列轉圈 +「狀態: 運算中」；播放列常駐，隊伍／決策樹可向下收合
- **點友軍 AI 僚機**：選取 + Wingman 指令面板（不搶人類 MFD）
- **MFD**：僅人類座席、非 `isAnimating` 時顯示
- **動畫中追蹤**：`cameraFollowOverrideId` 鎖定己機

---

## AI 課程回歸測試

```bash
npm run test:ai
```

五關 A–E 見 `tools/curriculum/ai-curriculum.json`。改 `pilot-ai.js` 後應先跑此指令。

自動調參、合併、套用：`npm run autotune:pipeline`（詳見 v2.2 章節，流程不變）。

---

## 狀態寫入規範

UI、AI、回合流程應透過 `GameContext.stateMachine` 寫入核心戰術狀態。

常用入口：

- `setThrottle` / `setWeaponMode` / `togglePylonPower`
- `queueAction` / `toggleGunQueue` / `toggleMissileQueue` / `toggleFlares`
- `setJoystickInput` / `setRollInput` / `setReady`
- `setWingmanOrder` / `setAIEnabled` / `applyPilotAction`
- `applyMatchConfig` / `beginWreckFall` / `finalizeWreckBurst`

AI 只產生 pilot action，由 `applyPilotAction` 套用。

---

## TeamState / TeamView 分層

- **TeamState**：HP、AP、Heat、Weapon、Ready、`wingmanOrder`、`lockedTargetId`、`wreckPhase`、`matchActive`
- **TeamView**：wrapper、pylon mesh、trajectory、exhaust
- **序列化**：`getSerializableTeamState` / `getSerializableBattleState`（v3.0 尚未含 wreck 欄位）

---

## 📑 目錄 (Table of Contents)

1. [✈️ 核心狀態數值 (Core Stats)](#️-核心狀態數值-core-stats)
2. [⏱️ 時間與推演單位 (Time Mechanics)](#️-時間與推演單位-time-mechanics)
3. [🌪️ 飛行力學與環境](#️-飛行力學與環境-flight-mechanics--environment)
4. [🚀 武器與系統 (Weapons & Systems)](#-武器與系統-weapons--systems)
5. [💀 擊毀與殘骸 (Destruction & Wrecks)](#-擊毀與殘骸-destruction--wrecks)
6. [🎇 視覺與特效系統 (VFX & Rendering)](#-視覺與特效系統-vfx--rendering)
7. [🧠 模組職責與架構劃分 (Module Architecture)](#-模組職責與架構劃分-module-architecture)

---

### ✈️ 核心狀態數值 (Core Stats)

* **AP (Aerodynamic Power)**：動能/推力儲備。轉向與爬升消耗；AP < 45 或高度 < 0.5 觸發失速。
* **Heat**：引擎熱量；>100 鎖後燃器；FOX-2 尋標依據。
* **HP**：結構完整度；`StateMachine.applyDamage()` 扣除。歸零觸發擊毀流程（軟殺或硬毀，見下節）。

### ⏱️ 時間與推演單位 (Time Mechanics)

* **Turn**：核心時間單位，一回合 ≈ 1.5 秒實時間。
* **Step**：1 Turn = 100 Step；傷害、碰撞、飛彈在 Step 迴圈預演完成後寫入 `battleLog`。

### 🌪️ 飛行力學與環境 (Flight Mechanics & Environment)

* **5-Stage Throttle**：BRK / IDL / ECO / MIL / AB，各檔推力、轉彎極限、廢熱不同。
* **Stall**：AP < 45 → 操控 washout + 固定沉降率。
* **Urban Collision**：Raycaster 建築碰撞；遮蔽 LOS；撞擊即硬毀。

### 🚀 武器與系統 (Weapons & Systems)

* **Pylon FSM**：`empty` → `standby` → `powering` → `armed`
* **Ripple Fire**：多枚 armed 時 12 frame 發射間隔
* **Fox-2 Seeker**：餘弦衰減 + 熱焰彈干擾
* **Flare**：三階段溫度衰減，空中約 3 回合
* **目標選擇**：Combat / HUD / 飛彈預覽優先 `getTargetId`（含手動鎖定）

### 💀 擊毀與殘骸 (Destruction & Wrecks)

* **軟殺 (Soft Kill)**：空中被機砲/飛彈擊落 → `softWreck: true` → 當回合緩墜改寫路徑 → `beginWreckFall`
* **硬毀 (Hard Kill)**：墜地、撞樓、雙機對撞 → 當步即 `explosion` + `spark_explosion`，`softWreck: false`
* **墜落回合**：`wreckPhase === 'falling'` 時 `synthesizeWreckFallPath` 合成下墜軌跡；仍參與 ACMI 播放
* **爆碎回合**：`turn >= wreckBurstTurn` 或墜地標記 → `finalizeWreckBurst` + 碎片池動畫
* **勝負**：`isFactionEliminated` 為 true 時，若仍有 falling 殘骸，延後 `game_over` 一個自動回合

### 🎇 視覺與特效系統 (VFX & Rendering)

* **Object Pool**：explosion / flash / puff / smoke 預建池
* **VFX Triggers**：管線寫入 `battleLog`，`renderCombatFrame` 播放（碎片爆炸目前**例外**，見技術債）
* **Aircraft Debris**：`spawnAircraftDebris` 動態 Box 碎片 + 單次 explosion sprite
* **Damage Shader**：HP ≤ 0 時機身 RGB 壓暗、關尾焰
* **Infinite Bounding HUD**：極端機動下光帶/HUD 不被錯誤剔除

### 🧠 模組職責與架構劃分 (Module Architecture)

*(v3.0 管線化與單向資料流)*

| 模組 | 職責 |
|------|------|
| `context.js` | GameContext；陣營、目標、Match Config、序列化 |
| `config.js` | 魔法數值、資源路徑、掛架、VFX 上限 |
| `team-state.js` | 常數、隊伍工廠、TeamView accessors |
| `compat-aliases.js` | 舊版 window / script-scope 別名 |
| `state-machine-match.js` | Match Setup / seat activation mixin |
| `state-machine-wreck.js` | 殘骸墜落 / 碎片 mixin |
| `state-machine.js` | StateMachine 核心、AI、武器、回合結算；組裝 match/wreck mixin |
| `physics.js` | `simulateFlight`、`getPosAt` / `getQuatAt` |
| `combat-helpers.js` | 交戰 helper、pylon attach、火花生成 |
| `combat-pipeline.js` | 飛行路徑、flare、soft-wreck 緩墜路徑 |
| `combat-resolution.js` | per-step 機砲、飛彈、傷害與死亡 |
| `combat-turn.js` | turn runner、回合結算、wreckFall 排程、`executeTurnSimultaneously` 閘門 |
| `render.js` | ACMI 播放、城市、碎片、VFX 池 |
| `pilot-ai.js` | NPC FSM、Wingman 支援、感測器記憶 |
| `ui.js` | Match Setup、MFD、Wingman HUD、EnginePhase 監聽 |
| `hud.js` | LCOS、動態 3D HUD |
| `game.js` | 載入、點選、鏡頭、`animate()`、重播時間軸 |

### 交戰管線順序

```
processFlightPaths → processFlares
  → resolveGunsForStep → resolveMissilesForStep → resolveDamageAndDeathForStep (×101)
→ commitTurn → playing 動畫 → finishTurnSimultaneously
```

---

## 資源缺失行為

| 資源 | 缺失時 |
|------|--------|
| 戰機 `.glb` | 程序幾何替代機 |
| `city.glb` | `config.js` 內建方塊建築 |
| VFX PNG | JSON 推導檔名 → 占位貼圖 |
| UI 底圖 | 純色座艙面板 |

完整清單：`assets/manifest.json`。

---

## v3.0+ 健康檢查清單

- [x] Match Setup 1v1 / 2v2
- [x] 四機編制與陣營 API
- [x] 點選 / 鎖定 / 追蹤鏡頭
- [x] Wingman 五指令 AI（含 `free`）
- [x] 軟殺緩墜 → 下回合碎片
- [x] wreckFall 單一路徑自動回合（無雙重 execute）
- [x] 屋頂淨空 + Scheme B 建築風險降級
- [x] ACMI 擊墜機模可見；NPC「被擊墜」
- [x] LCOS 相對拖曳／軸向／遮擋可見
- [ ] ACMI 重播碎片（待辦）
- [ ] wreck 狀態序列化（待辦）
- [x] Phase B thin knife（predict soft-score）
- [ ] Phase B 完整戰術定位層
- [x] Envelope 單一來源 + regression 對齊
- [ ] 城區 AI 回歸安全門（H7）

---

*文件版本 v3.0+（2026-08-04）· 對應程式樹 `airarAir-Arena-v2.2-Stable` · 技術債詳 `TECH-DEBT.md`*
