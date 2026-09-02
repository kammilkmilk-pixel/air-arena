# 接敵路徑／雙機合作／武器與機體 — 升級備忘錄

**狀態：現行準則**（2026-09-01）  
**對象：** live `test_01` 之後的選路與編隊，以及新武器／新機體該插在哪一步  
**相關：** [`README.md`](../README.md) · [`TECH-DEBT.md`](../TECH-DEBT.md) · [`Urban-Survival-Convergence.md`](./Urban-Survival-Convergence.md) · [`AI-Control-Baseline.md`](./AI-Control-Baseline.md) · [`PilotAI-Portability-Memo.md`](./PilotAI-Portability-Memo.md)

---

## 一句話

**總序：單機空戰完成 → 對地武器 → 編隊 AI。**  
城區已有 bake 選路，但接敵仍是幾何 TAP，不是「畫一條最快走廊去打人」。下一步長在現有 bake／L-R homotopy 上：先把單機空戰做完，再開對地，最後才兩架 AI 分契約。不另開全球規劃器。

一次一把刀。不混 stick、Phase B 角色、武器 envelope。人類僚機五鍵不沿用為 AI–AI 語彙。

---

## 現況（不是什麼）

| 已有 | 還不是 |
|------|--------|
| Bake 航點、A*、巷口圖、左右 homotopy、`pocketRisk` | 從出生點到敵機的任務 A* |
| 貼樓／桌板 **stick**（逃生評分；tableGlue／collapse hold、dirtBleed yield／gap 已於 2026-08-28 解凍） | 用路徑覆寫 pitch owner |
| TAP lead／lag／beam；`combatGoal` 只在逃生時偏戰鬥側 | 「這回合算出最快接敵走廊」 |
| Phase B：`deferred=seekAngle` 已證實；A.0 為 `seek_angle` 優先 lag／beam、全滅回退全目錄；A.1 接敵終點已進 bake／dual | 巷內時間／能量、五角色交戰像（**A.2**） |
| 人長機＋AI 僚機槽位（跟隨／掩護／攻擊我的目標） | 兩架 AI 互相當編隊（契約見下；`getWingmanLeadId` 只認人類） |

`dirtBleed` 已於 2026-08-28 解凍。**B2 生存**（切線全席 vs `Rei_03`）量測可對看、不單獨寫關。**B2 五角色交戰像**等 A.2。火箭佔位、對地 schema 未開。全 AI 2v2 仍各打各的。

---

## 總序（A → B → C）

蓋過舊句「對地可在雙機選路前或後」。沒做完 A 不開對地；沒做完 B 不上編隊 decide。

| 階段 | 內容 | 現況 |
|------|------|------|
| **A 單機空戰** | A.0：`seek_angle` 優先目錄＋回退；A.1 接敵走廊（碼已上）；其後 A.2 時間／能量。可選新 A2A（佔位、不進 `decide`） | **停在 A.1** |
| **B 對地武器** | 地圖地面目標 schema；bake 終點可改地面點；單機 A2G envelope＋decide | schema 未開 |
| **C 編隊 AI** | 兩架 AI 共用契約（不是人類 HUD）；A2G 已上才可選 `strike_cover` | 全 AI 仍各打各的 |

```
A 單機空戰 → B 對地武器 → C 編隊 AI
```

人長機＋AI 僚機五鍵（跟隨／攻擊我的目標／主動進攻／掩護／脫離）維持現狀，**不**當 AI–AI 語彙。

---

## 階段 A — 單機空戰（現役）

| 步 | 內容 | 驗收 | 非目標 |
|----|------|------|--------|
| **0 現役收尾** | `seek_angle` 擁有 TAP 時**優先目錄** `{lag, beam}`；全滅／不安全則**回退全目錄**（含 cruise／perch）。B2 生存已可對看；五角色交戰像等 A.2 | TAP 窗：`tacticalApproach: selected=` 為 lag／beam 且 `phaseBRole: seek_angle`；針 `tapRoleGate:`。生存閘當選不當 B1 失敗。金標 T150 building 不退步。**不寫 B2 五角色關** | 不把 ±28 加大到數百；不改 stick／武器／出生／press／extend；不上編隊；不再用「金標必出 lag」當再 dump 就過的門 |
| **1 單機接敵走廊** | bake／dual 終點改為可飛接敵點；L／R 選「能成形且較不漏斗」的巷。逃生 WP 仍沿機鼻 | TAP 已聽 `seek_angle` 之後：更少空 cruise／`alignFirst`；金標 n=3 building 不退步。針 `bakeDualHt: goal=intercept\|nose` | 不新寫全球 A*、不改 stick、不重開 TAP 目錄閘／±28 |
| **2 時間／能量** | A.1 dump 過後：`extend` 禁 lead、`press` 才 lead；薄「這條巷多久有射界」 | 對頭少直衝、遠距才 recommit。**之後**才寫 B2 五角色 | 不新模擬器 |

**現在停在 A.1：** 接敵終點已進 live dual-homotopy／bake heading（`bakeDualHt: goal=`）。逃生壓力仍走機鼻。等金標 n=3 dump building 不退步，再 A.2。B2 生存量測已過；B2 五角色等 A.2。不要跳 B／C，不要再開出生、不要加大 ±28、不要重開 TAP 目錄閘。

---

## 階段 B — 對地武器

先有地圖地面目標 schema，再單機 A2G envelope＋`decide`。bake 終點從敵機改成地面點。

- 不插進 A.1 dump 週期。改射界會讓 stick／角色 A/B 失效。
- `CONFIG.weapons.rocket` 已佔位（A2A／A2G dualRole），**不進 `decide`** 直到單獨武器刀。只加 envelope＋CONFIG，對 Rei_03 看 `kills/mslQ`。
- FOX-1 照射環、逃生箔條（M23／M24）是現有彈種 UX，可在 A 旁邊穿插，不是本階段。

---

## 階段 C — 編隊 AI

A 與 B 都過之後才實作。第一刀是 **`split` + 分側**，不是跟隨 FSM，也不是 `strike_cover`。

- M7：AI 可當長機（同陣營指定 lead，例如紅1→紅2）。
- 人＋AI 跟隨五鍵仍可用；AI–AI **不**複製那五鍵。
- 混機種雙機：C 的 `split`／分側穩了之後，先同機種。

### AI–AI 契約表（C 才實作；現在只鎖 id）

疊在單機 Phase B（`seek_angle` / `press` / `extend` / `recommit` / `defend`）之上。WE-GO：依上回合快照選契約，hold 2–3 回合。生存每機自己讓路。

| id | 何時 | 兩機 |
|----|------|------|
| `split` | 預設 2v2 | 各鎖一個空中目標 |
| `pinch` | 敵單機露出 | 同一人、分 L／R；一 press 一 seek |
| `drag_trap` | 對頭／巷口／能量差 | 一 extend 拖，一在口外 recommit |
| `cover_engaged` | 僚機被壓／來彈 | 打咬僚機的那架 |
| `pair_reset` | 兩機都爛 | 一起 extend |
| **`strike_cover`（預留）** | 有地面目標且 A2G 已開火 | **一機對地、一機空中掩護** |

`strike_cover` 規則（decide 不讀，階段 B 沒過之前契約選擇器**不得**回傳此 id）：

- 沒有地面目標＝永遠不選。
- 對地那架：bake／TAP 終點是地面點，不跟空中 `pinch` 搶同一套槽位。
- 掩護那架：空中 `cover_engaged` 邏輯對準威脅對地機的敵機，**不是**人類「跟隨槽位」。
- 之後可再加 `illuminate_pair`（FOX-1 分工），同樣不進人類五鍵。

---

## 新武器、新機體放哪

都不插進 **A.1 dump**。

| 東西 | 插入點 | 規則 |
|------|--------|------|
| FOX-1 照射環、逃生箔條（M23／M24） | **A 旁邊**，可穿插 UX | 現有彈種，不是新武器 |
| **新 A2A**（火箭等） | **A.1 dump 穩了之後**；可在 A.2 之前或剛做完 | 佔位不進 `decide` 直到單獨武器刀；不綁「B2 五角色全文」 |
| **對地（A2G）** | **階段 B**（A 完成之後、C 之前） | 先 schema，再單機开火；編隊的 `strike_cover` 等 C |
| **新機體外觀／掛架 UI** | 隨時 | 不進 `decide` |
| **新機體飛性／HP／AP** | **A.1 dump 穩了，最好 A.2 也過了** | 現在全場 `mig21`。換飛性＝換 stick 與接敵時間，須先凍結一架對照 |
| **混機種雙機** | **階段 C 的 split／分側之後** | 先同機種分側 |

---

## 檔案可維修性（之後再改，現在不拆）

**外殼可維修；決策核是巨石。** 2026-08-29：資料夾分層清楚，義大利麵條集中在 `js/ai/pilot-ai.js`（~23.4k）與凍結整份拷貝，不是 `core`／`logic`／`view` 糊成一鍋。TECH-DEBT **M17**。

| 現況 | 之後（A 穩了、真要動檔） |
|------|--------------------------|
| `decide-pipeline` 只鎖 gate 名；handler 在 live 腦 | 對地 envelope、階段 C `pair-doctrine` **新檔**，不先堆空 if |
| `building-risk`／`urban-avoid-side`／envelope／`ai-map` 已外置 | 新行為走這些入口，不把 23k 碎切成互相 `window` 呼叫 |
| `rei_01`–`03` 整份快照進 `index.html` | 凍結腦不手改；下一次 freeze 再拷 |
| `ui.js` ~3.4k 雜（setup／net／僚機／debug） | 可按畫面切，與 AI 無關、風險低 |

現在拆 M17 會打亂 B1／B2 對照。對地／編隊若再寫進 `pilot-ai.js`，巨石才會變成結構性麵條。

## 不要做

- 另開全球規劃器或用引擎物理取代 WEGO 評分（見 Portability 備忘）。
- 沒做完 A 就上對地或編隊；沒做完 B 就選 `strike_cover`。
- 把 `strike_cover` 做成人類 HUD 第六鍵。
- 為火箭／對地／編隊在 `pilot-ai.js` 先堆空 if；讀 `weapon-envelope`／`CONFIG.aircrafts`。
- 同把刀混 tableGlue、B1、武器。
- **A.1 dump 期間拆 `pilot-ai.js`**（M17 等之後；見上節）。

---

## 相關

- 城區 stick／bake：`docs/Urban-Survival-Convergence.md`
- Phase B／A/B：`docs/AI-Control-Baseline.md`
- 新地圖 bake：`docs/Arena-Map-Onboarding-Memo.md`
- 巨檔／拆檔時機：`TECH-DEBT.md` **M17** · 上節「檔案可維修性」
- `docs/Tactical-Development-Memo.md` — **過時**，勿當本路線
