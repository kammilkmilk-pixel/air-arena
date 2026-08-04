# PilotAI 可移植性／引擎預先準備備忘錄

**狀態：現行準則**（2026-08-05）  
**對象：** 網頁試玩開發期間，以及日後若移植專用引擎（如 Godot）時  
**相關：** [`README.md`](../README.md) · [`TECH-DEBT.md`](../TECH-DEBT.md) · [`Arena-Map-Onboarding-Memo.md`](./Arena-Map-Onboarding-Memo.md) · `js/ai/pilot-ai.js` · `js/logic/physics.js`

---

## 一句話

**先完成網頁試玩、繼續打磨 PilotAI；移植引擎不擋現況。**  
開發期只做「不加深耦合、不砍感知」的預先準備。PilotAI 是遊戲本體；Godot 等引擎的現成美術／特效是外殼，不得倒過來要求 AI 長在場景樹上。

---

## 背景與優先序

| 優先 | 內容 |
|------|------|
| 1 | 網頁試玩版可玩＋PilotAI 持續迭代 |
| 2 | 開發習慣讓日後脫 Three／進引擎成本可控 |
| 3 | 專用引擎（Godot 等）——美術／VFX／發行殼；**試玩達標後再認真開** |

**為何會談 Godot：** 現成美術與特效資源可加速**呈現層**，不加速 PilotAI。選引擎的理由成立，但移植順序必須是 **AI 腦可搬 → 再接場景與資產**。

**架構對齊（與場地備忘一致）：**

```text
bake（軟權威）+ AABB／ray（硬接觸）+ envelope（場地 soft 分）
        ↓
PilotAI.decide → pilotAction（joy / throttle / weapon / CM…）
        ↓
applyPilotAction / simulateFlight / ACMI 播放
        ↓
渲染／VFX／HUD（Three 現況；日後可換 Godot）
```

---

## 會否降低 AI 能力？

| 做法 | 對能力 |
|------|--------|
| 開發期習慣（見下「現在就做」） | **不應明顯下降**——只改讀取路徑，決策公式不變 |
| 集中 pose／障礙入口、調參外置、bake 優先軟資訊 | **持平** |
| 用粗 AABB 一次取代全部 mesh ray（LOS／路徑硬撞／薄板） | **可能變笨** |
| 過早丟 ray 且 bake 未補同等硬資訊 | **城區變鈍** |
| 用引擎物理取代 `simulateFlight` | **WEGO 評分漂掉，嚴重退化** |
| live `decide` 與 regression surrogate 長期分叉且未標債 | **測／玩不一致** |

**結論：** 預先準備 ≠ 砍感知。網頁開發期**繼續用 ray／mesh 保城區手感完全沒問題**；只要新邏輯別把場景物件散進 `decide`。真正去 Raycaster（Wave 2）留到試玩後，小步＋`npm run test:ai` 對照。

---

## 現在就做（幾乎零成本，不擋試玩）

開發／改 AI 時遵守：

1. **新碼不加深耦合**  
   - 決策邏輯只讀純狀態（`pos`／`quat`／`ap`／ammo…），**不要新增** `wrapper.`、`Raycaster`、`GameContext.three` 散落讀取。  
   - 城區**軟**資訊優先 bake／AABB；mesh ray 只留給硬接觸，且盡量集中在現有少數函式。  
   - 輸出維持 `pilotAction` 形狀，由 `applyPilotAction` 寫入。

2. **調參與規則外置**  
   - 數字走 `pilot-tuning-defaults`、`weapon-envelope`、`arena-envelope`、地圖 profile。  
   - **不要**在 decide 分支寫死場地／射程魔術數（與 [`Arena-Map-Onboarding-Memo.md`](./Arena-Map-Onboarding-Memo.md) 一致）。

3. **Bake 當空間 OS**  
   - 新地圖／新行為先問：能否用 `.ai-map.json` 表達？能則勿新開 mesh 依賴。

4. **Regression 當契約**  
   - 改 PilotAI 必跑 `npm run test:ai`；新行為盡量加 smoke／curriculum，勿只靠手玩。

---

## 開發中可順手做（小投資）

5. **集中「髒」讀取**（若還碰 Three）：  
   - 理想入口：`getTeamPose(teamId)` → `{ pos, quat, forward }`；`getObstaclesAabb()` → `[{ min, max }, …]`。  
   - 新功能只呼叫這些，不直接 `team.wrapper.position`。試玩穩後 Wave 0 只改適配層。

6. **`simulateFlight` 預留純 pose**  
   - 暫時仍可從 `wrapper` 填入，內部朝「吃 plain pos/quat」收斂；AI lookahead 與主迴圈共用同一入口。

7. **資產與邏輯分開想**  
   - `.glb`／VFX = 播放層；AI 只認 bake＋包絡＋（必要時）硬接觸查詢。

8. **文件只記契約**  
   - `decide` 輸入／輸出、bake 欄位、envelope 擁有者；不必寫長篇移植計劃。

---

## 刻意先別做（會拖試玩或傷 AI）

- 整包脫 Three 或上 Godot 重寫  
- 為「可移植」重寫整份 `pilot-ai.js`  
- 用引擎物理／`RayCast3D` 重寫城區感知取代現有 bake＋評分  
- 未對齊 regression 就改 hard-contact 語義  
- 讓 live decide 與 `tools/ai-regression.js` surrogate 長期分叉卻不在 `TECH-DEBT` 記一筆

---

## 試玩達標後：脫鉤波次（備查，非現況任務）

目標介面：

```text
decide(teamId, worldSnapshot) → pilotAction
worldSnapshot：純數值 + bake + AABB（不含 wrapper / Object3D / Raycaster）
```

| Wave | 內容 | 門檻 |
|------|------|------|
| **0** | Pose 快照；`getObstacles`→AABB；aiMap 勿掛死在 `GameContext.three` | 適配器仍可從 Three 填；行為不變 |
| **1** | 小 Vec3／Quat 取代 `THREE.*` 數學 | 主路徑不再 `new THREE.*` |
| **2** | Safety／Cover／LOS 去 mesh Raycaster（或精簡保留硬接觸） | 城區 regression 不崩；**行為敏感，小步做** |
| **3** | `simulateFlight(pose, …)` 純資料；Node 可跑 decide | 不載 Three 也能預演＋評分 |
| **4** | 已偏純模組原樣保留／對齊 | `ai-map`、envelope、tuning；縮短 live↔surrogate 缺口 |

**可直接保留、勿為移植先大改：** `ai-map.js`、`weapon-envelope.js`、`arena-envelope.js`、`pilot-tuning-defaults.js`、多數 memory／gate、`pilotAction`→`applyPilotAction` 合約。

**Godot 美術／VFX：** 可與 Wave 0–1 並行掛在播放層；**不要**在 Wave 2 完成前把城區感知改成引擎場景查詢。

---

## 與其它文件的關係

| 文件 | 角色 |
|------|------|
| `README.md` | 系統字典（現行行為與架構） |
| `TECH-DEBT.md` | 債與計劃進度 |
| `docs/Arena-Map-Onboarding-Memo.md` | 新場地：bake + envelope |
| **本檔** | PilotAI 優先、網頁試玩期預先準備、日後引擎移植邊界 |
| `docs/Tactical-Development-Memo.md` | **過時**，勿當現行架構 |

---

*文件版本 2026-08-05*
