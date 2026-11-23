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
            bomb: 'assets/models/bomb.glb',
            rocket: 'assets/models/rocket.glb',
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
        /** Idle / floor engine temp (°C). Stored heat is absolute; AI uses getEngineHeatLevel(). */
        minHeat: 150,
        maxHeat: 250,        // was 100; span unchanged (+150 idle offset)
        abLockHeatOffset: 40, // cannot light AB when level (heat - minHeat) > this
        maxAp: 300,
        stepsPerTurn: 100,       // 每回合推演的總影格數 (時間解析度)
        maxEngagementTurns: 150,   // 雙 AI 長局上限，超過判和
        gravity: 9.8,            // 遊戲世界的重力常數
        missileLaunchDelay: 12,  // 飛彈連續齊射的間隔幀數 (防相撞)
        stallSpeedAP: 35,        // 觸發失速的最低 AP 門檻（放寬：原 45）
        minFlightHeight: 0.5,    // 強制判定墜機/失速的最低高度 (m)
        /**
         * Combat airspace cylinder (XZ). Diameter matches tactical ground plane.
         * Soft/warn margins are distance inward from hard radius (larger = earlier steer).
         * outsideKill:false → HP penalty + forced inward (default); true = legacy instant kill.
         */
        combatAirspace: {
            enabled: true,
            diameter: 900,
            softMargin: 320,
            warnMargin: 280,
            outsideKill: false,
            outsideHpPenalty: 14,
            // null → use battlefield / ground center at runtime
            centerX: null,
            centerZ: null
        }
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
                1: { thrust: 0, heat: -18, turnLimit: 1.0, speedProfile: [0.5, 0.4, 0.1], gunAngleMult: 1.35, gunRangeMult: 0.8 },
                // 2 檔：怠速 (IDL) - 快速散熱
                2: { thrust: 15, heat: -12, turnLimit: 1.0, speedProfile: [1.0, 0.8, 0.5], gunAngleMult: 1.2, gunRangeMult: 0.9 },
                // 3 檔：經濟巡航 (ECO) - 微量冷卻
                3: { thrust: 30, heat: -6,  turnLimit: 0.85, speedProfile: [1.1, 1.1, 1.0], gunAngleMult: 1.1, gunRangeMult: 1.0 },
                // 4 檔：軍用最大推力 (MIL) - 常規戰鬥極限
                4: { thrust: 65, heat: -2,  turnLimit: 0.7, speedProfile: [1.5, 1.5, 1.5], gunAngleMult: 1.0, gunRangeMult: 1.1 },
                // 5 檔：後燃器 (AB) - 狂暴推力，廢熱極速累積
                5: { thrust: 180, heat: 22, turnLimit: 0.4, speedProfile: [2.5, 3.0, 5.0], gunAngleMult: 0.4, gunRangeMult: 1.3 }
            },
            visuals: {
                ribbonWidth: 0.12, engineOffsetY: -0.08, noseOffsetZ: 0.65, tailOffsetZ: -0.6,
                /** Wrapper-local emitters for condensation VFX (MiG after setupModel scale).
                 *  Outer pylon ≈ ±0.25; tip sits just beyond (~±0.38). */
                wingTipL: [-0.38, -0.08, -0.15],
                wingTipR: [ 0.38, -0.08, -0.15],
                /** Leading-edge fog samples (span from root → tip, slightly forward of wing). */
                wingLeL: [[-0.14, 0.02, 0.16], [-0.26, 0.015, 0.12], [-0.36, 0.01, 0.06]],
                wingLeR: [[ 0.14, 0.02, 0.16], [ 0.26, 0.015, 0.12], [ 0.36, 0.01, 0.06]]
            },
            
            guns: [
                { id: 1, position: [-0.05, -0.12, 0.45] }, 
                { id: 2, position: [ 0.05, -0.12, 0.45] }  
            ],
            
            // Underwing hardpoints matched to reimported MiG mesh pylon tips (wrapper-local).
            // Y ≈ tip+0.02 so stores hang under the rail, not above the wing (old Y=0.37).
            pylons: [
                { id: 1, position: [-0.14, -0.06, 0.03], weapon: 'fox1' },
                { id: 2, position: [-0.25, -0.06, -0.01], weapon: 'fox2' },
                { id: 3, position: [ 0.25, -0.06, -0.01], weapon: 'fox2' },
                { id: 4, position: [ 0.14, -0.06, 0.03], weapon: 'fox1' }
            ]
        }
    },

    weapons: {
        'gun': {
            id: 'gun',
            name: '機砲',
            damage: 45,            
            range: 70,             
            // ~5° base cone (was π/24 ≈7.5°); throttle mult still widens slightly when slow.
            angle: Math.PI / 36,
            gravityMult: 1.2,
            /** Barrel heat 0–1: +heatPerShot on fire, −coolPerTurn when idle. */
            heatPerShot: 0.3,
            coolPerTurn: 0.4,
            overheatAt: 1.0,
            /**
             * Hit cylinder: coneRadius = range·tan(angle), then clamp to [hitRadiusFloor, hitRadiusMax].
             * Without max, long-range cone was ~8–14m — tracers looked like misses but still scored.
             * Fuselage visual scale ≈1.2 → keep max near ~1.5–2.0 airframe widths.
             */
            hitRadiusFloor: 0.65,
            hitRadiusMax: 1.75,
            /** Past hitFalloffStart, each hitFalloffBand of range cuts hit chance by hitFalloffPerBand. */
            hitFalloffStart: 45,
            hitFalloffBand: 10,
            hitFalloffPerBand: 0.15
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
            minArmingRange: 20,
            maxFlightRange: 120,
            frontAspectDot: 0.40,
            frontAspectHeatFloor: 0.04,
            frontAspectSeekerAngleMult: 0.40,
            frontAspectTurnRateMult: 0.42,
            frontAspectFuseRangeMult: 0.32,
            frontAspectDamageMult: 0.32,
            /** Empty pylon auto-restock after this many turns (combat tempo). */
            reloadTurns: 30,
            
            model: {
                // Applied via prepareStoreMeshBase (same XYZ map as bomb/rocket).
                scale: 0.3,
                offsetX: 0,
                offsetY: -0.06,
                offsetZ: 0,
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
            minArmingRange: 50,
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
            /** Empty pylon auto-restock after this many turns (combat tempo). */
            reloadTurns: 50,
            model: {
                scale: 0.3,
                offsetX: 0,
                offsetY: -0.06,
                offsetZ: 0,
                rotX: Math.PI / 2,
                rotY: 0,
                rotZ: 0
            }
        },
        /**
         * Rocket pod — dual-role: VT airburst (A2A) + Impact (A2G / low air).
         * AI decide uses doctrine.munition.rocket when aiEnabled.
         * 9 rounds/pod; 3 per turn; ~1s spacing (intervalSteps ≈ turn/3).
         */
        'rocket': {
            id: 'rocket',
            name: '火箭巢',
            aiEnabled: true,
            dualRole: true,
            damage: 22,
            range: 120,
            /** Ammo in one pod. */
            roundsPerPod: 9,
            /** Rockets released per ENT / turn. */
            salvoPerTurn: 3,
            /**
             * Combat frames between rockets in a salvo.
             * stepsPerTurn=100 ≈ one turn; 33 ≈ ~1s if a turn feels ~3s.
             */
            intervalSteps: 33,
            /** Delay before first rocket (~1s): launches at 33 / 66 / 99. */
            launchDelaySteps: 33,
            /** Launch speed (world units / turn-second) along nose. */
            launchSpeed: 55,
            launchSpeedScale: 1.0,
            /**
             * Per-rocket aim dispersion (radians) about nose: yaw/pitch jitter so
             * the 3 mid-path impact points fan slightly along the flight curve.
             */
            aimDispersionYaw: 0.028,
            aimDispersionPitch: 0.018,
            drag: 0.002,
            gravityScale: 0.55,
            substeps: 2,
            groundY: 0,
            /** Default fuze mode: 'vt' (airburst proximity) | 'impact' (surface/direct hit). */
            defaultFuze: 'vt',
            /** VT proximity fuse radius (m). Pre-5a0bd77 defaults (22 / 4.5 / 6). */
            vtRadius: 4.5,
            /** Also VT-trigger when altitude below this (airburst near ground). */
            vtGroundHeight: 3.5,
            /** Direct airframe collision radius (m) when fuze is 'impact'. */
            impactDirectRadius: 1.8,
            fuseDelaySteps: 4,
            blastRadius: 6,
            explosionScale: 1.6,
            flashScale: 2.0,
            puffScale: 1.4,
            sparkCount: 48,
            sparkPower: 0.7,
            maxFlightSteps: 220,
            /**
             * Flying visual: FOX missile mesh at 1/3 of in-flight missile body scale (2.5 → ≈0.833).
             * Pod muzzle flame sits inside the nest, slightly aft of the rail.
             */
            flightBodyScale: 0.833,
            /** Nozzle is computed from body aft AABB (−Z); kept for docs only. */
            flightTrailPts: 48,
            flightBodyColor: 0xffffff,
            podFlameOffsetZ: -0.14,
            podFlameOffsetY: -0.02,
            model: {
                /**
                 * Pylon-local nudge (aircraft axes, no clamp):
                 *   offsetX = left / right   (−X left, +X right)
                 *   offsetY = up / down      (−Y lower / hang)
                 *   offsetZ = aft / forward  (−Z toward tail, +Z toward nose)
                 * Station itself is CONFIG.aircrafts.mig21.pylons[i].position.
                 * Hard-refresh after edits (?storesPreview=1).
                 */
                scale: 0.18,
                offsetX: 0,
                offsetY: -0.08,
                offsetZ: 0.02,
                rotX: 0,
                rotY: 0,
                rotZ: 0,
                tint: 0x9aa3ad,
                metalness: 0.85,
                roughness: 0.28
            }
        },
        /**
         * Unguided bomb — ballistic + CCIP. AI uses against dirt-skimming foes
         * until map ground-target schema (Phase B) lands.
         */
        'bomb': {
            id: 'bomb',
            name: '炸彈',
            aiEnabled: true,
            dualRole: false,
            damage: 80,
            /** Ballistic (game units ≈ m; step = 1/stepsPerTurn of a turn). */
            releaseSpeedScale: 1.0,
            /** Horizontal drag (vertical mostly gravity). Lower = longer glide. */
            drag: 0.001,
            gravityScale: 1.15,
            /** Physics substeps per combat frame (smoother + reliable ground hit). */
            substeps: 2,
            groundY: 0,
            fuseDelaySteps: 1,
            blastRadius: 10,
            explosionScale: 2.6,
            flashScale: 3.2,
            puffScale: 2.0,
            sparkCount: 90,
            sparkPower: 0.95,
            /** CCIP preview sample count along fall. */
            previewSamples: 48,
            model: {
                // Same axis map as rocket.model (X=L-R, Y=up-down, Z=fore-aft).
                scale: 0.28,
                offsetX: 0,
                offsetY: -0.08,
                offsetZ: 0.02,
                rotX: 0,
                rotY: 0,
                rotZ: 0,
                tint: 0x556b2f
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
            /** When illumination hits cloud: multiply support angle (HUD / leftover shrink). */
            gateShrinkMult: 0.55,
            /** M24: LOS through cloud may drop SARH support (nose-on can lose lock). */
            breakSupportOnLos: true,
            /** Trial: P(break | LOS through cloud). 1 zeroed gold FOX-1 (all why=chaff). */
            breakChance: 0.5,
            /** How many WEGO turns one successful break lasts before a new roll. */
            breakTurns: 1,
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
                // Rear/side fire door 10°. Front squeeze still 15×0.40≈6°. Seeker 15°.
                // Last 6° n=6: mslQ without spawn. 11–12° waste stays gated. Pick 36° stays.
                maxLaunchAngleDeg: 10
            },
            fox1: {
                dualSalvoOk: false,
                requireLos: true,
                illuminateHold: true,
                preferStandoff: true,
                maxLaunchAngleDeg: 26,
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
            },
            /**
             * Rocket pod — VT (A2A proximity) / Impact (surface or dirt-skimming).
             * Soft decide overlay only; does not rewrite stick geometry.
             */
            rocket: {
                vtMaxLaunchAngleDeg: 22,
                vtMinRange: 18,
                vtMaxRange: 110,
                /** Fire VT when FOX dry, out of FOX envelope, or soft hold with a true VT window. */
                vtWhenMissileDry: true,
                vtWhenOutOfMissileEnvelope: true,
                vtFillSoftHold: true,
                /** Impact / blast vs very low air targets (Phase B ground schema still pending). */
                impactEnemyAltMax: 12,
                impactMissMaxFrac: 0.9,
                impactMinSlant: 12,
                impactMaxSlant: 140
            },
            bomb: {
                enemyAltMax: 10,
                missMaxFrac: 0.85,
                minSlant: 10,
                maxSlant: 160
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
        /**
         * Aircraft vapor: wingtip vortices + high-AoA leading-edge fog.
         * Pure visual — no combat / physics side effects.
         */
        /**
         * Aircraft wake & vapor:
         *  - Center white wake ribbon behind tail (replaces aft red/cyan ribbon; forward path stays team-colored)
         *  - Shorter white wake ribbons at wingtip emitters (CONFIG.aircrafts.mig21.visuals.wingTipL/R)
         *  - High-AoA leading-edge fog (combat anim / replay only)
         */
        condensation: {
            enabled: true,
            /** LE fog only during combat animation / ACMI replay — never while planning stick. */
            onlyDuringFlightAnim: true,
            /** Center white ribbon behind aircraft (length in turns, width matches forward ribbon 0.12). */
            centerWakeTurns: 1.6,
            centerWakeWidth: 0.12,
            centerWakeOpacity: 0.82,
            /** Shorter white ribbons from wingTipL / wingTipR emitters (length in turns). */
            tipWakeTurns: 0.55,
            tipWakeWidth: 0.085,
            tipWakeOpacity: 0.92,
            /** Ribbon segments kept in GPU buffer (covers ~2 turns of samples). */
            vortexPts: 96,
            trailPersistMs: 2800,
            /** Pitch-rate proxy (rad/s) → LE fog starts / full (physics velocity ≈ nose). */
            aoaFogStart: 0.55,
            aoaFogFull: 1.8,
            leFogMaxOpacity: 0.72,
            leFogScale: 0.28
        },
        /**
         * Multi-layer 3D ground / surface explosion VFX (ground-explosion-vfx.js):
         * scorch crater + ember glow + shockwave/dust rings + bottom-feathered base-surge
         * dust collar + multi-lobe rising fireball + dark mushroom smoke plume + 3D clods.
         */
        groundExplosion: {
            enabled: true,
            maxActiveBlasts: 8,
            maxCraters: 28,
            collarCount: 20,
            fireballLobes: 12,
            plumeCount: 18,
            clodCount: 26,
            hotChunkCount: 12,
            fireLife: 34,
            collarLife: 138,
            plumeLife: 172,
            shockLife: 13,
            dustWaveLife: 28,
            emberLife: 76,
            clodLife: 62,
            lightIntensity: 5.2,
            lightDistance: 48,
            craterPersistTurns: 12
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
    },

    /**
     * Visual-only A2G store eye-check (bomb/rocket on pylons).
     * Does not arm fire / decide / SMS. Tune weapons.bomb|rocket.model for size/pose.
     * URL: ?storesPreview=0 disables; ?storesPreview=1 forces on.
     */
    preview: {
        groundStores: true,
        bombPylonIndex: 0,
        rocketPylonIndex: 3
    }
};

/** Absolute idle engine temperature (°C). */
function getEngineHeatIdle() {
    const v = (typeof CONFIG !== 'undefined' && CONFIG.rules) ? Number(CONFIG.rules.minHeat) : NaN;
    return Number.isFinite(v) ? v : 150;
}

/** Absolute max engine temperature (°C). */
function getEngineHeatMax() {
    const v = (typeof CONFIG !== 'undefined' && CONFIG.rules) ? Number(CONFIG.rules.maxHeat) : NaN;
    return Number.isFinite(v) ? v : 250;
}

/**
 * Normalize absolute °C to the legacy 0–100 decision scale
 * (idle → 0, max → 100) so AI / AB-lock thresholds stay unchanged.
 */
function getEngineHeatLevel(heat) {
    const idle = getEngineHeatIdle();
    return (Number(heat) || idle) - idle;
}

/** Absolute °C above which AB ignition is blocked. */
function getEngineHeatAbLock() {
    const offset = (typeof CONFIG !== 'undefined' && CONFIG.rules && Number.isFinite(Number(CONFIG.rules.abLockHeatOffset)))
        ? Number(CONFIG.rules.abLockHeatOffset)
        : 40;
    return getEngineHeatIdle() + offset;
}

/**
 * Continuous throttle (1.0–5.0): lerp between discrete throttleStats bands.
 * AI may still send integers; humans get stepless 無段變速.
 */
function clampThrottleLevel(level) {
    const n = Number(level);
    if (!Number.isFinite(n)) return 4;
    return Math.max(1, Math.min(5, n));
}

function getThrottleStats(throttle, aircraftType) {
    const type = aircraftType || 'mig21';
    const table = (typeof CONFIG !== 'undefined'
        && CONFIG.aircrafts
        && CONFIG.aircrafts[type]
        && CONFIG.aircrafts[type].throttleStats)
        ? CONFIG.aircrafts[type].throttleStats
        : null;
    const fallback = {
        thrust: 65, heat: -2, turnLimit: 0.7,
        speedProfile: [1.5, 1.5, 1.5],
        gunAngleMult: 1.0, gunRangeMult: 1.1
    };
    if (!table) return Object.assign({}, fallback);

    const t = clampThrottleLevel(throttle);
    const lo = Math.floor(t);
    const hi = Math.ceil(t);
    const a = table[lo] || table[Math.max(1, lo)] || fallback;
    const b = table[hi] || a;
    if (lo === hi || !b) {
        return {
            thrust: Number(a.thrust) || 0,
            heat: Number(a.heat) || 0,
            turnLimit: Number(a.turnLimit) || 1,
            speedProfile: Array.isArray(a.speedProfile) ? a.speedProfile.slice() : [1, 1, 1],
            gunAngleMult: Number(a.gunAngleMult) || 1,
            gunRangeMult: Number(a.gunRangeMult) || 1,
            level: t
        };
    }
    const u = t - lo;
    const lerp = (x, y) => (Number(x) || 0) + ((Number(y) || 0) - (Number(x) || 0)) * u;
    const spa = Array.isArray(a.speedProfile) ? a.speedProfile : [1, 1, 1];
    const spb = Array.isArray(b.speedProfile) ? b.speedProfile : spa;
    return {
        thrust: lerp(a.thrust, b.thrust),
        heat: lerp(a.heat, b.heat),
        turnLimit: lerp(a.turnLimit, b.turnLimit),
        speedProfile: [
            lerp(spa[0], spb[0]),
            lerp(spa[1] != null ? spa[1] : spa[0], spb[1] != null ? spb[1] : spb[0]),
            lerp(spa[2] != null ? spa[2] : spa[0], spb[2] != null ? spb[2] : spb[0])
        ],
        gunAngleMult: lerp(a.gunAngleMult, b.gunAngleMult),
        gunRangeMult: lerp(a.gunRangeMult, b.gunRangeMult),
        level: t
    };
}

/** Map continuous throttle 1–5 → track handle top% (AB=0 … BRK=100). */
function throttleToHandlePercent(throttle) {
    const t = clampThrottleLevel(throttle);
    return ((5 - t) / 4) * 100;
}

/** Map track percent (0 bottom BRK → 1 top AB) → continuous throttle. */
function handlePercentToThrottle(percent) {
    const p = Math.max(0, Math.min(1, Number(percent) || 0));
    return clampThrottleLevel(1 + p * 4);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = CONFIG;
}