# **📝 戰術開發與維護備忘錄 (Tactical Development & Maintenance Memo)**

* **適用專案**：3D 向量空戰模擬器 (Three.js / Canvas MFD System)  
* **記錄日期**：2026.06.24  
* **設計原則**：數據驅動 (Data-Driven)、物理大一統、未來高擴充性

## **🚀 已修復的核心 Bug 與數值調校**

本章節記錄了近期針對物理判定、視覺錯位及起步斷層進行的重要修復與優化。

### **1\. 開局起步航程縮水修復 (1.9m 修正為 3.2m)**

* **目標檔案**：js/core/game.js  
* **目標函數**：checkInit()  
* **核心邏輯**：原本開局初始化時將動能寫死為 t.ap \= 50，導致首回合飛機動能處於最低失速邊緣，路徑計算出來的初始距離極短（僅 1.9m），與後續回合的巡航航程產生嚴重視覺斷層。  
* **修改對照**：  
  // ❌ 舊代碼  
  t.ap \= 50;

  // 🟢 新代碼  
  t.ap \= 107; // 常態巡航動能，開局起步即完美對齊 3.2m 航程

### **2\. 戰術航程光帶 (Ribbon) 錯位與高度手動微調**

* **目標檔案**：js/view/render.js  
* **目標函數**：drawTrajectoryLine()  
* **核心邏輯**：移除了原本街機版中將光帶往屁股噴嘴後退的偏移量 (vis.tailOffsetZ)，改為 100% 精確對齊飛機幾何原點（中心點），並新增高度手動微調變數以防止任何視覺斷層。  
* **調整公式**：  
  let ribbonYOffset \= \-0.12; // 🟢 負數表示往下移，可手動微調對齊噴嘴高度  
  let centerPos \= pos.clone().add(new THREE.Vector3(0, ribbonYOffset, 0).applyQuaternion(q));

### **3\. 機砲向上仰角系統 (Elevation Angle)**

* **目標檔案**：js/core/config.js ![][image1] weapons.gun  
* **核心邏輯**：模擬真實戰機（如 F-16、A-10）的機砲向上偏置角度（約 2 度仰角）。這有助於飛行員在進行高 G 力追尾纏鬥時，更容易將準星拉到敵機的「前置量」上，同時也能有效抵銷長距離的重力下墜。  
* **核心參數**：  
  elevation: 2 \* (Math.PI / 180\) // 🟢 2度仰角 (自動轉換為弧度)

* **代碼連動依賴**：  
  * js/logic/combat.js ![][image1] resolveGunsForStep()：命中判定圓錐軸線同步向上抬高。  
  * js/view/render.js ![][image1] updateGunPreview()：黃色射擊預測線起點與仰角同步向上偏折。  
  * js/view/render.js ![][image1] renderCombatFrame()：3D 曳光彈飛行向量同步疊加仰角。

### **4\. 3D 真實戰機半透明投影 (Ghost Wrapper)**

* **目標檔案**：js/view/render.js  
* **目標函數**：drawTrajectoryLine()  
* **核心邏輯**：拋棄了寫死的 2D 向量線段剪影，改用 teamObj.wrapper.clone() 複製真實的 3D 米格機模型，使未來新增任何機型時 100% 自動相容預覽，極具擴充性。  
* **視覺與隔離處理**：  
  * **不透明度**：0.35（呈現極具科技感的半透明霓虹色）。  
  * **材質定義**：使用 THREE.MeshBasicMaterial 並關閉 depthWrite，防止其遮擋與干擾真實戰機。  
  * **尾焰隔離**：透過 traverse 模糊比對 'exhaust' 及 userData.isExhaustComponent 標籤，搭配 else if 邏輯，100% 關閉預覽機屁股的靜止後燃器火焰，確保投影乾淨。

## **🛠️ 未來擴充：航空炸彈 (Iron Bombs) 實裝指南**

得益於我們在 v2.5.0 中實裝的「世界重力乘數 (Gravity Multiplier)」架構，我們成功統一了世界物理常數（9.8），同時允許不同武器擁有獨立的空氣動力學表現。以下是未來實裝無導引航空炸彈的具體步驟：

### **步驟 1：在 config.js 的 weapons 區塊內註冊航空炸彈**

'mk82\_bomb': {  
    id: 'mk82',  
    name: 'Mk-82 航空炸彈',  
    damage: 150,            // 炸彈威力極高  
    range: 15,              // 投彈前置判定半徑  
    gravityMult: 1.0,       // 🌟 關鍵：無升力炸彈受 100% 完整物理重力下墜  
    releaseSpeedRatio: 0.3  // 繼承母機慣性速度的比例  
}

### **步驟 2：在 config.js 的戰機 pylons 掛架上替換武器**

將對應掛架的 weapon 屬性從 'fox2' 替換為 'mk82'。

💡 *系統會自動讀取新武器，不需重構飛機的 3D 模型載入器。*

### **步驟 3：在 combat.js 的推演大腦中套用重力運算**

在計算炸彈軌跡時，套用與機砲相同的 gravityMult 公式：

## **![][image2]📌 開發與維護專用：全域變數對照表**

| 變數名稱 | 物理含意與調整指南 | 當前設定值 |
| :---- | :---- | :---- |
| **CONFIG.rules.gravity** | 世界全域標準重力常數。保持真實比例，切勿隨意更改。 | 9.8 |
| **CONFIG.weapons.gun.gravityMult** | 機砲受重力影響係數。調大此數值下墜更嚴重，設為 0 則子彈變為筆直雷射。 | 0.2 (即 20% 重力) |
| **CONFIG.weapons.gun.elevation** | 機砲安裝仰角（弧度）。調大此數值可使預測線與彈道更往上抬。 | 2 \* (Math.PI / 180\) |
| **window.mslVisOffset** | 全域飛彈視覺偏移修正向量。用來手動對齊飛機掛架微小偏差。 | THREE.Vector3(0, 0, 0\) |

[image1]: <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABUAAAAZCAYAAADe1WXtAAAAeElEQVR4XmNgGAWjYOCBvLz8HHQxioGCgkIEkGJBF6cIKCsri8nJyRmji1MMgEEwC4SNjY1Z0eXIBuLi4txA184HGrwbXQ4MgGHUCJT8TwHOQTeTLCBPC+8DDdytpKTEjy5ONqBJkpKnQeJnlJGREUIXHAWjgIYAABtxI/IlED1GAAAAAElFTkSuQmCC>

[image2]: <data:image/png;base64,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>