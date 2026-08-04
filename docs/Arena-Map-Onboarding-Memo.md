# 場地／地圖加入備忘錄（Arena & Map Onboarding）

**狀態：現行準則**（2026-08-04）  
**對象：** 每次新增或更換地圖／場地尺寸時必讀  
**相關：** [`README.md`](../README.md) · [`TECH-DEBT.md`](../TECH-DEBT.md) · `js/ai/ai-map.js` · `js/core/combat-airspace.js`

---

## 一句話

**換場地 ≠ 改 AI 核心。**  
新地圖必須同時交付：**AI 烘焙（bake）** + **場地包絡限制（envelope）**；PilotAI 只消費接口，不寫死直徑／高度帶。

---

## 為何拆開

| 層 | 跟誰掛鉤 | 不該放哪 |
|----|----------|----------|
| **Bake（空間 OS）** | 該圖建築物屋頂格 | `pilot-ai` 硬編碼樓高／縫寬 |
| **Envelope（場地限制）** | 該圖戰鬥 AO 尺寸＋垂直戰鬥帶 | decide 閘裡寫死 radius／band 米數 |
| **PilotAI 核心** | 閘序＋交戰／逃生評分 | 場地魔術數字、地圖專用特例 |

之後場地會換不同尺寸；離心／向心、貼地／超高空等偏好，應落在 **場地 profile／envelope 模組**，由 AI **讀壓力／加 soft 分**，而不是寫進核心邏輯。

---

## 新場地檢查清單（必做）

每次加入 `assets/maps/*` 新圖、改地面尺寸、或改戰鬥圓直徑時，打勾：

### 1. AI 烘焙（bake）

- [ ] 地圖物件可被 `AirArenaAiMap.bakeFromMapDoc`／`npm run bake:ai-map` 產出格網（`roofMax`／`skyOpen`／`mapLane`）
- [ ] 遊戲載入該圖時安裝 `_aiMap`（與回歸每集 bake 一致）
- [ ] 煙測：`npm run test:ai-map`、`npm run test:phase3` 在該圖或等價 doc 上可跑
- [ ] 實測決策樹可見：`survivalWpGate`／corridor／`clearAbove` 等 bake 特徵有意義（非全圖空白）

### 2. 場地包絡（envelope／場地限制）

- [ ] **水平 AO：** `CONFIG.rules.combatAirspace`（或未來 `arena-envelope` profile）對應該圖：`diameter`／`center`／`softMargin`／`warnMargin`
- [ ] **垂直帶：** `combatBandMin`／`combatBandMax`／`combatBandHardMax`（或 profile 覆寫）與開局高度、屋頂尺度匹配
- [ ] 硬出界／硬撞地仍由場地／物理層定義；AI 只做 soft 偏向與 rim／高度閘**消費**壓力
- [ ] 換尺寸時用**相對量**（距硬邊比例、帶內歸一化高度），避免在 `pilot-ai.js` 新寫絕對米數特例

### 3. 回歸與實測

- [ ] 該圖納入或抽樣跑 `npm run test:ai` 相關 stage（至少城區／開闊各一，視地圖類型）
- [ ] 實測 dump：少無 bake 空轉；rim／超高／貼地行為符合該圖 envelope，而非舊圖尺寸殘留

---

## 架構掛點（提醒實作方向）

```text
地圖載入
  ├─ bake ai-map          → 空間 OS（樓、縫、航點／path）
  └─ arena envelope profile → 水平 AO + 垂直戰鬥帶 + soft score 曲線
           ↓
PilotAI：survival 閘 > 交戰候選 + envelope.score / bake.score
           ↓
airspaceBoundary / altitudeTerrain 只讀 envelope／combat-airspace 壓力，不內建該圖半徑公式
```

**模組（2026-08-04 落地）：**

- `js/core/arena-envelope.js` — `applyFromMapDoc`／`sample`／`scoreCandidate`
- 地圖 JSON 可帶 `envelope`（見 `assets/maps/citymap.json`、`default.json`）
- `MapLoader.buildMap` 與原版地圖還原時會 `applyFromMapDoc`
- Pilot：`applyArenaEnvelopeScore`；決策樹標籤 `arenaEnvelope:`
- 煙測：`npm run test:arena-envelope`
- **T69 續修：** 超高空＋貼 rim → `airspaceAvoid` 改 **inward + controlled descend**；`airspaceRimProtect` 防 safety 搶杆；envelope 在 `radialFrac` 偏高時提前離心懲罰

**準則：**

1. **少強制、優選路** — 包絡以 soft 分為主；硬殺（出界／撞地）不交給分數取消。  
2. **生存閘永遠壓過包絡軟分** — 樓／嵌樓／dirt 優先於「向心／回高度帶」。  
3. **FOX-1／高位 perch** — 超高空軟懲罰須減權或豁免，避免打殘照射。  
4. **雙軸同時貼邊** — 優先序：mesh／dirt ＞ 高度帶 ＞ 水平空域軟分。

---

## 與歷史備忘的關係

- `docs/Tactical-Development-Memo.md`：**過時**，勿當現行架構。  
- `docs/PilotAI-Portability-Memo.md`：PilotAI 優先、網頁試玩期預先準備、日後引擎移植邊界（**現行**）。  
- **本檔：** 場地／烘焙入職準則，與 `README` Phase 1–3、`TECH-DEBT` 並存。

*文件版本 2026-08-04*
