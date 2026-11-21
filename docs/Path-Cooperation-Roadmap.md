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
| Phase B：`deferred=seekAngle` 已證實；A.0／A.2a／recommit 目錄閘已關；A.2b hang yield 可達門過；**B2 已關** 2026-10-03；defend dump 有針；**現役 clear-stick** | 針 `clearStick=1`（不放寬 −160） |
| 人長機＋AI 僚機槽位（跟隨／掩護／攻擊我的目標） | 兩架 AI 互相當編隊（契約見下；`getWingmanLeadId` 只認人類） |

`dirtBleed` 已於 2026-08-28 解凍。**B2 已關** 2026-10-03（切線全席 vs `Rei_03` 生存＋四角色目錄閘）。B2 recommit 目錄閘 **dump 已關**。defend 目錄閘 **已關** 2026-10-11。**現役 FOX-2 `f2why=gate`。**火箭佔位、對地 schema 未開。全 AI 2v2 仍各打各的。

---

## 總序（A → B → C）

蓋過舊句「對地可在雙機選路前或後」。沒做完 A 不開對地；沒做完 B 不上編隊 decide。

| 階段 | 內容 | 現況 |
|------|------|------|
| **A 單機空戰** | A.0：`seek_angle` 優先目錄＋回退；A.1 dump 已關；A.2a press／extend 目錄閘（碼已上）。目前基準 `-pulloverclean`（80／140 n=6 building 0、combat 6、gate 6/6）。可選新 A2A（佔位、不進 `decide`） | **狀態凍結（2026-11-19）** |
| **B 對地武器** | 地圖地面目標 schema；bake 終點可改地面點；單機 A2G envelope＋decide | **下一步（schema 未開）** |
| **C 編隊 AI** | 兩架 AI 共用契約（不是人類 HUD）；A2G 已上才可選 `strike_cover` | 全 AI 仍各打各的 |

```
A 單機空戰 → B 對地武器 → C 編隊 AI
```

人長機＋AI 僚機五鍵（跟隨／攻擊我的目標／主動進攻／掩護／脫離）維持現狀，**不**當 AI–AI 語彙。

---

## 階段 A — 單機空戰（狀態凍結 2026-11-19）

> **凍結基準（2026-11-19）：** `test_01` 停在 `-pulloverclean`（80／140 n=6 **building 0、combat 6、gate 6/6**；H7 關帳改平台鎖；`-cmhold` 暫時凍結撤回）。A.2 單機空戰不再開新 stick／dump 刀。下一步依總序進 **階段 B — 對地武器**（先做地圖地面目標 schema）。

| 步 | 內容 | 驗收 | 非目標 |
|----|------|------|--------|
| **0 現役收尾** | `seek_angle` 擁有 TAP 時**優先目錄** `{lag, beam}`；全滅／不安全則**回退全目錄**（含 cruise／perch）。**B2 已關** | TAP 窗：`tacticalApproach: selected=` 為 lag／beam 且 `phaseBRole: seek_angle`；針 `tapRoleGate:`。生存閘當選不當 B1 失敗。金標 T150 building 不退步 | 不把 ±28 加大到數百；不改 stick／武器／出生／press／extend；不上編隊；不再用「金標必出 lag」當再 dump 就過的門 |
| **1 單機接敵走廊** | bake／dual／巷口圖沿機鼻採樣；L／R 在已成形、非漏斗巷裡才用接敵 XZ 決勝。逃生 WP 仍沿機鼻 | TAP 已聽 `seek_angle` 之後：更少空 cruise／`alignFirst`；金標 n=3 building 不退步。針 `bakeDualHt: goal=intercept\|nose` | 不新寫全球 A*、不改 stick、不重開 TAP 目錄閘／±28 |
| **2 時間／能量** | A.2a press／extend。A.2b hang yield 可達門過。B2 recommit dump 已關。**B2 已關。** defend 目錄閘 **已關**。**現役 FOX-2 `f2why=gate`** | 解制前只在發射門內跟目標。針 `coastSteer=1`。不放寬 10°／6° | 不新模擬器；不放寬 envelope；不重開已關目錄閘；不把 defend 和開火寫進同一把 dump |

**金標取樣：** 一格（十字切線 80／283＝斜鄰 200）；舊格 80／200、80／354 封存。四機首 trail 全同才丟；不追新指紋；不以 session 資料夾當 A/B。**驗收（2026-09-08）：** 稀有枝用已知巢重跑＋smoke，不要用金標抽新獨特 T150。金標最多 1 批只看 building；第 1 批 leftover 飽和就停。獨特 T150 可當正證，不是開門條件。可達門過 = 重跑有針＋building 不退步。無法過關 = 門開了下一拍失敗且再修破凍結。

**lab ≠ 實玩：** 武器／包線快測仍用 1v1 blank chase T60（`batch:ai:weapon`）。`chase` 只給 lab。金標 2v2 城區 T150 是生存／building 回歸，不是稀有枝抽樣機。

**A.2a dump 已關。prep 超時 booth 已關。climb defer 已關。collapse hold yield 無法過關（碼留下）。A.2b hang yield 可達門過（碼留下）。B2 已關 2026-10-03。B2 recommit 目錄閘 dump 已關（碼留下）。defend 目錄閘 **已關**。現役 FOX-2 `f2why=gate`（不放寬 10°／6°）。M23 已關。包線選彈已關 2026-10-04。M24 已關 2026-10-10。** FOX-2-only **已關** 2026-10-11（四掛 IR vs 混掛；不是 `fox2-first`、不是對地）。dead scored-escape **可達門過** 2026-10-11（碼留下）。不要修 collapse／−160、不要為 leftover／hang yield／recommit／deadStick 再開金標、不要跳 B／C、不要再開 ±28／A.0。不要恢復 awayFlip。不要開 `left`。不要把 defend／選彈／M24 拆進同一把刀。

---

## 階段 B — 對地武器

先有地圖地面目標 schema，再單機 A2G envelope＋`decide`。bake 終點從敵機改成地面點。

- 不插進 A.2 dump 週期。改射界會讓 stick／角色 A/B 失效。
- `CONFIG.weapons.rocket` 已佔位（A2A／A2G dualRole），**不進 `decide`** 直到單獨武器刀。只加 envelope＋CONFIG，對 Rei_03 看 `kills/mslQ`。
- FOX-1 照射環、逃生箔條（M23／M24）是現有彈種 UX，可在 A 旁邊穿插，不是本階段。**M23 已關。包線已關。M24 已關 2026-10-10。**
- **FOX-2-only（已關 2026-10-11，A2A）：** 混掛仍是 `standard` 2×FOX-1 + 2×FOX-2。四掛 IR 已是 setup `fox2-priority`。`fox2-first` 只是選彈政策，不是掛載。**不是對地、不是階段 B、不是 `fox2-first`。** 不重開。不混 M23／M24／defend。`f2why=gate` 另刀。

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

都不插進 **A.2 dump**。

| 東西 | 插入點 | 規則 |
|------|--------|------|
| FOX-1 照射環（M23） | **A 旁邊**，**已關** 2026-09-27 | 暗環／導引中／ENT 射程字。不重開。不混 M24／包線 |
| 逃生箔條（M24） | **A 旁邊**，**已關** 2026-10-10 | 擋線 50%／一回合。骰子含 shotId＋場次鹽。不重開。不混選彈／defend／FOX-2-only |
| **包線選彈** | **A 旁邊**，**已關** 2026-10-04 | 門 50／20。overlap：&lt;80／歪＝FOX-2，80–120 對準＝FOX-1。FOX-1／FOX-2 關帳 `why` 已上 |
| **FOX-2-only 掛載（A2A）** | **A 旁邊**，**已關** 2026-10-11 | 四掛 FOX-2（`fox2-priority`）vs 混掛 `standard`。**不是對地、不是 `fox2-first`。** 金標 leftover 不退步。`f2why=gate` 另刀。不重開 |
| **defend 目錄閘驗收** | **已關** 2026-10-11 | 80／140 n=3 `b2-test_01-1791697752764` 2／3 beam `fallback=0`。碼留下 |
| **FOX-2 f2why=gate** | **現役** 2026-10-11 | 解制前只在發射門內跟目標。不放寬 10°／6°。針 `coastSteer=1` |
| **新 A2A**（火箭等） | **A.1 dump 穩了之後**；可在 A.2 之前或剛做完 | 佔位不進 `decide` 直到單獨武器刀；不綁 B2 |
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
- **A.2 dump 期間拆 `pilot-ai.js`**（M17 等之後；見上節）。

---

## 相關

- 城區 stick／bake：`docs/Urban-Survival-Convergence.md`
- Phase B／A/B：`docs/AI-Control-Baseline.md`
- 新地圖 bake：`docs/Arena-Map-Onboarding-Memo.md`
- 巨檔／拆檔時機：`TECH-DEBT.md` **M17** · 上節「檔案可維修性」
- `docs/Tactical-Development-Memo.md` — **過時**，勿當本路線
