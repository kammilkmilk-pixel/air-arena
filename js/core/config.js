// ============================================================================
// 🗄️ config.js - 遊戲核心數據庫 (Data-Driven Design)
// ============================================================================

const CONFIG = {
    debug: typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('dev'),

    assets: {
        models: {
            red: 'assets/models/mig21_red.glb',
            blue: 'assets/models/mig21_blue.glb',
            fox2: 'assets/models/fox_two.glb',
            city: 'assets/models/city.glb'
        },
        vfx: {
            smoke: 'assets/vfx/smoke_flipbook.json',
            explosion: 'assets/vfx/explosion_flipbook.json',
            flash: 'assets/vfx/flash_flipbook.json',
            puff: 'assets/vfx/puff_flipbook.json'
        },
        interface: {
            uiLarge: 'assets/interface/ui_l.png',
            uiSmall: 'assets/interface/ui_s.png'
        }
    },

    rules: {
        maxSteps: 3,         
        maxHeat: 100,        
        maxAp: 300,
        stepsPerTurn: 100,       // 每回合推演的總影格數 (時間解析度)
        maxEngagementTurns: 150,   // 雙 AI 長局上限，超過判和
        gravity: 9.8,            // 遊戲世界的重力常數
        missileLaunchDelay: 12,  // 飛彈連續齊射的間隔幀數 (防相撞)
        stallSpeedAP: 35,        // 觸發失速的最低 AP 門檻（放寬：原 45）
        minFlightHeight: 0.5     // 強制判定墜機/失速的最低高度 (m)
    },

    aircrafts: {
        'mig21': {
            id: 'mig21',
            name: 'MiG-21 Fishbed',
            maxHp: 100,
            baseAp: 165,
            maxYaw: Math.PI / 4,    
            maxPitch: Math.PI / 3,  
            maxRoll: Math.PI / 4,   
            turnRate: Math.PI / 4,    
            pitchRate: Math.PI / 3,   
            
            throttleStats: {
                // 1 檔：減速板 (BRK) - 極速冷卻，用於急煞
                1: { thrust: 0, heat: -18, turnLimit: 1.0, speedProfile: [0.5, 0.4, 0.1], gunAngleMult: 1.8, gunRangeMult: 0.8 },
                // 2 檔：怠速 (IDL) - 快速散熱
                2: { thrust: 15, heat: -12, turnLimit: 1.0, speedProfile: [1.0, 0.8, 0.5], gunAngleMult: 1.5, gunRangeMult: 0.9 },
                // 3 檔：經濟巡航 (ECO) - 微量冷卻
                3: { thrust: 30, heat: -6,  turnLimit: 0.85, speedProfile: [1.1, 1.1, 1.0], gunAngleMult: 1.2, gunRangeMult: 1.0 },
                // 4 檔：軍用最大推力 (MIL) - 常規戰鬥極限
                4: { thrust: 65, heat: -2,  turnLimit: 0.7, speedProfile: [1.5, 1.5, 1.5], gunAngleMult: 1.0, gunRangeMult: 1.1 },
                // 5 檔：後燃器 (AB) - 狂暴推力，廢熱極速累積
                5: { thrust: 180, heat: 22, turnLimit: 0.4, speedProfile: [2.5, 3.0, 5.0], gunAngleMult: 0.4, gunRangeMult: 1.3 }
            },
            visuals: {
                ribbonWidth: 0.12, engineOffsetY: -0.08, noseOffsetZ: 0.65, tailOffsetZ: -0.6
            },
            
            guns: [
                { id: 1, position: [-0.05, -0.12, 0.45] }, 
                { id: 2, position: [ 0.05, -0.12, 0.45] }  
            ],
            
            pylons: [
                { id: 1, position: [-0.1, 0.37, -0.2], weapon: 'fox1' },
                { id: 2, position: [-0.25, 0.37, -0.2], weapon: 'fox2' },
                { id: 3, position: [ 0.25, 0.37, -0.2], weapon: 'fox2' },
                { id: 4, position: [ 0.1, 0.37, -0.2], weapon: 'fox1' }
            ]
        }
    },

    weapons: {
        'gun': {
            id: 'gun',
            name: '機砲',
            damage: 45,            
            range: 70,             
            angle: Math.PI / 24,
            gravityMult: 1.2,
            /** Barrel heat 0–1: +heatPerShot on fire, −coolPerTurn when idle. */
            heatPerShot: 0.3,
            coolPerTurn: 0.4,
            overheatAt: 1.0,
            /** Past hitFalloffStart, each hitFalloffBand of range cuts hit chance by hitFalloffPerBand. */
            hitFalloffStart: 60,
            hitFalloffBand: 10,
            hitFalloffPerBand: 0.1
        },
        'fox2': {
            id: 'fox2',
            name: 'FOX-2 (紅外線飛彈)',
            damage: 62,
            speed: 0.55,
            maxAp: 360,
            turnRate: 0.082,
            drag: 2.5,
            guidance: 'ir',
            seekerRange: 120,
            seekerAngle: Math.PI / 12,
            seekerMinHeat: 16,
            fuseRange: 2.8,
            minArmingRange: 35,
            maxFlightRange: 120,
            frontAspectDot: 0.40,
            frontAspectHeatFloor: 0.04,
            frontAspectSeekerAngleMult: 0.40,
            frontAspectTurnRateMult: 0.42,
            frontAspectFuseRangeMult: 0.32,
            frontAspectDamageMult: 0.32,
            
            model: {
                scale: 0.3,        
                offsetX: -0.5,     
                offsetY: -0.10,    
                offsetZ: 0.0,      
                rotX: Math.PI / 2, 
                rotY: 0,
                rotZ: 0
            }
        },
        'fox1': {
            id: 'fox1',
            name: 'FOX-1 (半主動雷達)',
            damage: 58,
            speed: 0.55,
            maxAp: 320,
            turnRate: 0.09,
            drag: 2.2,
            guidance: 'sarh',
            seekerRange: 200,
            seekerAngle: Math.PI / 14,
            fuseRange: 3.0,
            minArmingRange: 70,
            maxFlightRange: 200,
            /** Illumination LOS min (not arming) — keep support when closing after launch. */
            supportMinRange: 8,
            /** Beam-crossing (lateral) shrinks effective gate / turn. */
            beamAspectDotMax: 0.35,
            beamGateMult: 0.62,
            beamTurnMult: 0.55,
            /** Base support half-angle (rad) before interference shrink. */
            supportBaseAngle: Math.PI / 18,
            supportMinAngle: Math.PI / 48,
            /** Radar look wander off nose (0 = stable illuminate ring on nose). */
            supportLookJitterRad: 0,
            model: {
                scale: 0.3,
                offsetX: -0.5,
                offsetY: -0.10,
                offsetZ: 0.0,
                rotX: Math.PI / 2,
                rotY: 0,
                rotZ: 0
            }
        },
        'flare': {
            id: 'flare',
            name: '熱焰彈',
            maxAmmo: 3,            
            stages: [
                { age: 0, heat: 560 }, { age: 0, heat: 560 }, 
                { age: 1, heat: 220 }, 
                { age: 2, heat: 40  }  
            ]
        },
        'chaff': {
            id: 'chaff',
            name: '箔條干擾',
            maxAmmo: 3,
            /** Lifetime: 5 turns × stepsPerTurn (visual + physics cloud). */
            lifeTurns: 5,
            lifeSteps: 500,
            /** Base radius; expands toward max around turn 2. */
            cloudRadius: 10,
            expandPerStep: 0.11,
            /** Soft cap so turn-2+ clouds don't grow forever. */
            cloudRadiusMax: 32,
            /** When illumination hits cloud: multiply support angle. */
            gateShrinkMult: 0.55,
            flickerHz: 14,
            /** Visual stage (turns 0-indexed ageTurn = floor(ageSteps/stepsPerTurn)). */
            visual: {
                sparkTurns: 4,
                sparksPerCloud: 32,
                smokeOpacity: [0.78, 0.88, 0.52, 0.28, 0.1],
                smokeScale: [0.55, 1.0, 0.95, 0.85, 0.7]
            }
        }
    },

    /**
     * AI doctrine knobs (not weapon physics) — keep here with weapons/aircrafts.
     * QA: URL `?fox2Ambush=1|0` forces roll; `?fox2AmbushSeed=N` makes roll deterministic.
     * CONFIG.doctrine.fox2OpeningAmbushForce = true|false|null also forces when URL absent.
     */
    doctrine: {
        fox2OpeningAmbushChance: 0.2,
        fox2OpeningAmbushForce: null,
        fox2OpeningAmbushSeed: null,
        /** QA only: skip standby→powering and jump to armed (same-turn launch). Default false. */
        fox2OpeningInstantArm: false,

        /**
         * Per-munition AI overlays (flags / soft biases — not new decide gates).
         * fox1: SARH needs nose illuminate after launch; prefer standoff; avoid dual salvo.
         */
        munition: {
            gun: {
                preferClose: true
            },
            fox2: {
                dualSalvoOk: true,
                requireLos: true,
                illuminateHold: false,
                preferStandoff: false,
                maxLaunchAngleDeg: 32
            },
            fox1: {
                dualSalvoOk: false,
                requireLos: true,
                illuminateHold: true,
                preferStandoff: true,
                maxLaunchAngleDeg: 28,
                holdNoseGain: 0.58,
                holdMaxJoy: 0.62,
                // Gun-like SARH: launch only with altitude + clear illuminate path.
                minLaunchAlt: 48,
                // Dense/medium urban: slightly lower so rooftop-band shots are not rejected at ~47m.
                minLaunchAltUrban: 42,
                clearPathTurns: 4,
                clearPathMinAlt: 40,
                useGunLeadHold: true,
                // After shot: if another FOX-1 remains, open range then reattack.
                reattackPredictTurns: 3,
                reattackStandoffMin: 95,
                reattackStandoffIdeal: 130
            }
        }
    },

    'visuals': {
        sparks: {
            count: 150,          
            size: 6.0,           
            streakProb: 1.40,    
            drag: 0.93,          
            gravity: 0.007,
            life: 16,
            streak: 0.65,
            wind: 0.18
        },
        smoke: {
            size: 6.0,           
            baseOpacity: 0.38,    
            fadeRate: 0.02,     
            color: 0xa8a8a8      
        },
        flipbookFps: 15,         
        
        poolLimits: {
            explosion: 10,       
            flash: 20,           
            puff: 80              
        }
    },

    // 🌆 戰術地圖：預設原版 city.glb → buildings；自訂地圖由開場「選擇地圖」在 ENGAGE 時套用
    map: {
        activeMap: null, // null = 原版；字串 URL 或由 MapCatalog 在 ENGAGE 注入
        buildings: [
            // === 🏢 左翼外圍群 ===
            { type: 'box', x: -10, z: 12, w: 4, d: 4, h: 18, color: 0x2c2c2c },
            { type: 'box', x: -5,  z: 32, w: 3, d: 4, h: 22, color: 0x2c2c2c },
            { type: 'box', x: -12, z: 48, w: 4, d: 3, h: 15, color: 0x2c2c2c },

            // === 🏢 右翼外圍群 ===
            { type: 'box', x: 25,  z: 15, w: 4, d: 3, h: 16, color: 0x2c2c2c },
            { type: 'box', x: 22,  z: 38, w: 3, d: 4, h: 24, color: 0x2c2c2c },
            { type: 'box', x: 28,  z: 55, w: 4, d: 4, h: 20, color: 0x2c2c2c },

            // === ⚡ 中央交錯穿梭群 (迫使戰機在中軸 Z=10~60 進行擺動蛇行) ===
            { type: 'box', x: 5,   z: 16, w: 3, d: 3, h: 20, color: 0x2c2c2c }, // 左偏阻擋大廈
            { type: 'box', x: 12,  z: 28, w: 4, d: 3, h: 26, color: 0x2c2c2c }, // 右偏阻擋大廈
            { type: 'box', x: 4,   z: 42, w: 3, d: 3, h: 22, color: 0x2c2c2c }, // 左偏阻擋大廈
            { type: 'box', x: 13,  z: 54, w: 4, d: 4, h: 19, color: 0x2c2c2c }  // 右偏阻擋大廈
        ]
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = CONFIG;
}