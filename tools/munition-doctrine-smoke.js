// ============================================================================
// munition-doctrine-smoke.js — FOX-1 gun-like launch / illuminate / sequel
// ============================================================================
const path = require('path');
const assert = require('assert');
const fs = require('fs');

const CONFIG = require(path.join(__dirname, '../js/core/config.js'));
global.CONFIG = CONFIG;

const env = require(path.join(__dirname, '../js/ai/weapon-envelope.js'));

function buildDoctrineHelpers() {
    return {
        fox1WasInFlightByTeam: Object.create(null),
        fox1SequelByTeam: Object.create(null),
        clamp(v, lo, hi) {
            return Math.max(lo, Math.min(hi, v));
        },
        normalizePolicyMode(mode) {
            return ['heuristic', 'hybrid', 'fox2-first', 'fox1-first'].includes(mode) ? mode : 'heuristic';
        },
        getMunitionDoctrine(missileType) {
            const table = CONFIG.doctrine && CONFIG.doctrine.munition;
            const key = missileType === 'fox1' ? 'fox1' : (missileType === 'gun' ? 'gun' : 'fox2');
            const row = table && table[key] ? table[key] : null;
            if (key === 'fox1') {
                return {
                    dualSalvoOk: !!(row && row.dualSalvoOk),
                    requireLos: row && row.requireLos != null ? !!row.requireLos : true,
                    illuminateHold: row && row.illuminateHold != null ? !!row.illuminateHold : true,
                    preferStandoff: row && row.preferStandoff != null ? !!row.preferStandoff : true,
                    maxLaunchAngleDeg: Number(row && row.maxLaunchAngleDeg) || 28,
                    holdNoseGain: Number(row && row.holdNoseGain) || 0.58,
                    holdMaxJoy: Number(row && row.holdMaxJoy) || 0.45,
                    minLaunchAlt: Number(row && row.minLaunchAlt) || 48,
                    minLaunchAltUrban: Number(row && row.minLaunchAltUrban) || 42,
                    clearPathTurns: Number(row && row.clearPathTurns) || 4,
                    clearPathMinAlt: Number(row && row.clearPathMinAlt) || 40,
                    useGunLeadHold: row && row.useGunLeadHold != null ? !!row.useGunLeadHold : true,
                    reattackPredictTurns: Number(row && row.reattackPredictTurns) || 3,
                    reattackStandoffMin: Number(row && row.reattackStandoffMin) || 95,
                    reattackStandoffIdeal: Number(row && row.reattackStandoffIdeal) || 130
                };
            }
            return {
                dualSalvoOk: true,
                illuminateHold: false,
                maxLaunchAngleDeg: 32
            };
        },
        hasOwnFox1InFlight(team) {
            const list = (team && team.activeMissiles) || [];
            return list.some((m) =>
                m && m.missileType === 'fox1' && !m.exploded && Number(m.ap) > 0
            );
        },
        peekNextMissileType(team, opts = {}) {
            return env.peekNextMissileType(team, {
                ...opts,
                preferFox1: opts.preferFox1 != null
                    ? opts.preferFox1
                    : this.normalizePolicyMode(team && team.aiPolicyMode) === 'fox1-first'
            });
        },
        isFox1IlluminateHardAbort(action, team, ctx = {}) {
            if (!action) return false;
            const alt = Number(ctx.altitude);
            if (action.state === 'groundAvoid' || action.state === 'terrainEscape') return true;
            if (action.state === 'safetyEmbedPushOut') return true;
            if (action.state === 'emergencyPullUp' && Number.isFinite(alt) && alt < 24) return true;
            if (action.state === 'postGroundClimbOut' && Number.isFinite(alt) && alt < 26) return true;
            const coverFwd = Number(ctx.coverForwardDistance);
            const hardBldg = !!(action.hardBuilding || ctx.hardBuildingContact);
            if (
                hardBldg &&
                action.state === 'obstacleEmergencyEscape' &&
                Number.isFinite(coverFwd) &&
                coverFwd < 10 &&
                Number.isFinite(alt) &&
                alt < 42
            ) {
                return true;
            }
            return false;
        },
        buildFox1HoldStick(_teamId, _team, ctx = {}, doctrine = null) {
            const doc = doctrine || this.getMunitionDoctrine('fox1');
            const maxJ = Math.max(0.55, Number(doc.holdMaxJoy) || 0.45);
            const gain = Number(doc.holdNoseGain) || 0.58;
            const lx = ctx.localToEnemy ? Number(ctx.localToEnemy.x) || 0 : 0;
            const ly = ctx.localToEnemy ? Number(ctx.localToEnemy.y) || 0 : 0;
            return {
                joyX: this.clamp(-lx * gain * 1.35, -maxJ, maxJ),
                joyY: this.clamp(ly * gain * 1.15, -maxJ * 0.9, maxJ * 0.9),
                roll: 0,
                throttle: 4,
                usedLead: false
            };
        },
        // Stub path eval: ctx.forcePathHit / forcePathOk drive results in smoke.
        evaluateFox1IlluminatePath(_teamId, _holdAction, doctrine = null) {
            const doc = doctrine || this.getMunitionDoctrine('fox1');
            if (this._smokeForcePathHit) {
                return { ok: false, buildingHit: true, minAltOk: true, eval: { buildingHit: true, safe: false, minAltitude: 50 } };
            }
            if (this._smokeForcePathLowAlt) {
                return {
                    ok: false,
                    buildingHit: false,
                    minAltOk: false,
                    eval: { buildingHit: false, safe: true, minAltitude: doc.clearPathMinAlt - 5 }
                };
            }
            return { ok: true, buildingHit: false, minAltOk: true, eval: { buildingHit: false, safe: true, minAltitude: 55 } };
        },
        getFox1MinLaunchAlt(ctx = {}, doctrine = null) {
            const doc = doctrine || this.getMunitionDoctrine('fox1');
            const arenaMode = ctx.arenaMode || 'buildings';
            const urban =
                ctx.urbanArenaMode === true ||
                arenaMode === 'dense-urban' ||
                arenaMode === 'medium-urban' ||
                arenaMode === 'buildings' ||
                arenaMode === 'obstacle-stress' ||
                arenaMode === 'sparse-urban';
            return urban ? (Number(doc.minLaunchAltUrban) || 42) : (Number(doc.minLaunchAlt) || 48);
        },
        canCommitFox1Launch(teamId, team, ctx = {}) {
            const doctrine = this.getMunitionDoctrine('fox1');
            const reasons = [];
            const alt = Number(ctx.altitude);
            const minAlt = this.getFox1MinLaunchAlt(ctx, doctrine);
            if (!Number.isFinite(alt) || alt < minAlt) reasons.push('alt');
            if (doctrine.requireLos && ctx.lineOfSightBlocked) reasons.push('los');
            if (Number.isFinite(ctx.angleDeg) && ctx.angleDeg > doctrine.maxLaunchAngleDeg) reasons.push('angle');
            const sequel = this.fox1SequelByTeam[teamId];
            const dist = Number(ctx.distance);
            if (sequel && sequel.active && Number.isFinite(dist) && dist < doctrine.reattackStandoffMin) {
                reasons.push('standoff');
            }
            const stick = this.buildFox1HoldStick(teamId, team, ctx, doctrine);
            const path = this.evaluateFox1IlluminatePath(teamId, stick, doctrine);
            if (!path.ok) reasons.push('path');
            return { ok: reasons.length === 0, reasons, path, stick, doctrine };
        },
        gateFox1MissileShoot(teamId, team, action, ctx = {}) {
            if (!action || action.queueAction !== 'missile') return action;
            if ((action.missileType || ctx.missileType) !== 'fox1') return action;
            const commit = this.canCommitFox1Launch(teamId, team, ctx);
            if (commit.ok) {
                action.debug = { ...(action.debug || {}), fox1LaunchOk: 1 };
                return action;
            }
            action.queueAction = 'none';
            action.singleMissile = false;
            action.state = 'missilePrep';
            action.debug = {
                ...(action.debug || {}),
                fox1LaunchHold: 1,
                fox1LaunchHoldReasons: commit.reasons.slice(),
                fox1LaunchHoldAlt: commit.reasons.includes('alt') ? 1 : undefined,
                fox1LaunchHoldPath: commit.reasons.includes('path') ? 1 : undefined
            };
            return action;
        },
        updateFox1SequelState(teamId, team, ctx = {}) {
            const inFlight = this.hasOwnFox1InFlight(team);
            const was = !!this.fox1WasInFlightByTeam[teamId];
            if (was && !inFlight) {
                const next = this.peekNextMissileType(team, {
                    preferFox1: this.normalizePolicyMode(team.aiPolicyMode) === 'fox1-first'
                });
                if (next === 'fox1') {
                    this.fox1SequelByTeam[teamId] = { active: true, nextMunition: 'fox1', predictPos: null };
                } else {
                    this.fox1SequelByTeam[teamId] = { active: false, nextMunition: next || 'fox2', predictPos: null };
                }
            }
            this.fox1WasInFlightByTeam[teamId] = inFlight;
            const sequel = this.fox1SequelByTeam[teamId];
            if (sequel && sequel.active) {
                const dist = Number(ctx.distance);
                const doctrine = this.getMunitionDoctrine('fox1');
                if (Number.isFinite(dist) && dist >= doctrine.reattackStandoffMin) {
                    sequel.active = false;
                    sequel.opened = true;
                }
            }
            return this.fox1SequelByTeam[teamId] || null;
        },
        applyFox1ReattackSetup(action, _teamId, _team, ctx, sequel, doctrine) {
            if (!sequel || !sequel.active || sequel.nextMunition !== 'fox1') return action;
            const dist = Number(ctx.distance);
            if (!Number.isFinite(dist) || dist >= doctrine.reattackStandoffMin) return action;
            action.state = 'fox1ReattackSetup';
            action.queueAction = 'none';
            action.debug = { ...(action.debug || {}), fox1ReattackSetup: 1, fox1NextMunition: 'fox1' };
            return action;
        },
        applyFox1DoctrineOverlay(action, team, ctx = {}) {
            const doctrine = this.getMunitionDoctrine('fox1');
            const angleDeg = Number(ctx.angleDeg);
            const missileType = ctx.missileType || 'fox1';
            const teamId = ctx.teamId || 'red';
            const inFlight = this.hasOwnFox1InFlight(team);
            const committingFox1 =
                missileType === 'fox1' &&
                (action.queueAction === 'missile' || !!action.powerPylons);

            if (action.queueAction === 'missile' && missileType === 'fox1' && !doctrine.dualSalvoOk) {
                action.singleMissile = true;
            }
            if (
                action.queueAction === 'missile' &&
                missileType === 'fox1' &&
                Number.isFinite(angleDeg) &&
                angleDeg > doctrine.maxLaunchAngleDeg
            ) {
                action.queueAction = 'none';
                action.debug = { ...(action.debug || {}), fox1LaunchHold: 1 };
            }
            if (action.queueAction === 'missile' && missileType === 'fox1') {
                this.gateFox1MissileShoot(teamId, team, action, ctx);
            }

            this.updateFox1SequelState(teamId, team, ctx);

            const needHold = doctrine.illuminateHold && (inFlight || committingFox1);
            const hardAbort = this.isFox1IlluminateHardAbort(action, team, ctx);
            if (needHold && hardAbort) {
                action.debug = { ...(action.debug || {}), fox1IlluminateAbort: 1 };
                return action;
            }
            if (needHold && !hardAbort && ctx.localToEnemy) {
                const stick = this.buildFox1HoldStick(teamId, team, ctx, doctrine);
                const prevState = action.state;
                action.joyX = stick.joyX;
                action.joyY = stick.joyY;
                action.debug = {
                    ...(action.debug || {}),
                    fox1IlluminateHold: 1,
                    fox1InFlight: inFlight ? 1 : 0,
                    fox1OverrodeState: prevState && prevState !== 'fox1Illuminate' ? prevState : undefined
                };
                if (inFlight) action.state = 'fox1Illuminate';
                return action;
            }

            const sequel = this.fox1SequelByTeam[teamId];
            if (sequel && sequel.nextMunition) {
                action.debug = { ...(action.debug || {}), fox1NextMunition: sequel.nextMunition };
            }
            if (sequel && sequel.active && sequel.nextMunition === 'fox1') {
                this.applyFox1ReattackSetup(action, teamId, team, ctx, sequel, doctrine);
            }
            return action;
        }
    };
}

function main() {
    const PilotAI = buildDoctrineHelpers();

    assert.ok(CONFIG.doctrine && CONFIG.doctrine.munition, 'munition doctrine table missing');
    assert.strictEqual(CONFIG.doctrine.munition.fox1.dualSalvoOk, false);
    assert.strictEqual(CONFIG.doctrine.munition.fox1.illuminateHold, true);
    assert.ok(CONFIG.doctrine.munition.fox1.minLaunchAlt >= 40);
    assert.ok(CONFIG.doctrine.munition.fox1.minLaunchAltUrban < CONFIG.doctrine.munition.fox1.minLaunchAlt);
    assert.ok(CONFIG.doctrine.munition.fox1.clearPathTurns >= 3);
    assert.ok(CONFIG.doctrine.munition.fox1.reattackStandoffMin >= 80);

    const fox1Doc = PilotAI.getMunitionDoctrine('fox1');
    assert.strictEqual(fox1Doc.useGunLeadHold, true);

    // --- launch gates ---
    const teamHi = {
        id: 'red',
        aiPolicyMode: 'fox1-first',
        activeMissiles: [],
        wrapper: { position: { y: 55 } },
        pylons: [
            { state: 'armed', weaponType: 'fox1' },
            { state: 'armed', weaponType: 'fox1' }
        ]
    };
    const okLaunch = PilotAI.gateFox1MissileShoot(
        'red',
        teamHi,
        { queueAction: 'missile', missileType: 'fox1', joyX: 0, joyY: 0 },
        {
            altitude: 55,
            angleDeg: 10,
            distance: 120,
            lineOfSightBlocked: false,
            localToEnemy: { x: 0.1, y: 0.05, z: 0.95 }
        }
    );
    assert.strictEqual(okLaunch.queueAction, 'missile');
    assert.strictEqual(okLaunch.debug.fox1LaunchOk, 1);

    const lowAlt = PilotAI.gateFox1MissileShoot(
        'red',
        teamHi,
        { queueAction: 'missile', missileType: 'fox1' },
        { altitude: 30, angleDeg: 10, distance: 120, lineOfSightBlocked: false, localToEnemy: { x: 0, y: 0, z: 1 }, arenaMode: 'dense-urban' }
    );
    assert.strictEqual(lowAlt.queueAction, 'none');
    assert.strictEqual(lowAlt.debug.fox1LaunchHoldAlt, 1);

    // T12-class: 47.3m rejected under open min(48) but allowed in dense-urban (42).
    const urbanBand = PilotAI.gateFox1MissileShoot(
        'red',
        teamHi,
        { queueAction: 'missile', missileType: 'fox1' },
        {
            altitude: 47.3,
            angleDeg: 10,
            distance: 98,
            lineOfSightBlocked: false,
            localToEnemy: { x: 0.1, y: 0.05, z: 0.95 },
            arenaMode: 'dense-urban',
            urbanArenaMode: true
        }
    );
    assert.strictEqual(urbanBand.queueAction, 'missile', 'dense-urban should allow ~47m FOX-1');
    assert.strictEqual(urbanBand.debug.fox1LaunchOk, 1);

    PilotAI._smokeForcePathHit = true;
    const pathHold = PilotAI.gateFox1MissileShoot(
        'red',
        teamHi,
        { queueAction: 'missile', missileType: 'fox1' },
        { altitude: 55, angleDeg: 10, distance: 120, lineOfSightBlocked: false, localToEnemy: { x: 0, y: 0, z: 1 } }
    );
    PilotAI._smokeForcePathHit = false;
    assert.strictEqual(pathHold.queueAction, 'none');
    assert.strictEqual(pathHold.debug.fox1LaunchHoldPath, 1);

    // --- illuminate ---
    const teamFlight = {
        id: 'red',
        activeMissiles: [{ missileType: 'fox1', active: false, exploded: false, ap: 100 }],
        wrapper: { position: { y: 55 } },
        pylons: [{ state: 'armed', weaponType: 'fox1' }]
    };
    PilotAI.fox1WasInFlightByTeam.red = true;
    const held = PilotAI.applyFox1DoctrineOverlay(
        { queueAction: 'none', joyX: 0, joyY: 0, throttle: 3, state: 'obstacleEmergencyEscape', hardBuilding: false },
        teamFlight,
        {
            teamId: 'red',
            localToEnemy: { x: 0.4, y: 0.1, z: 0.9 },
            angleDeg: 10,
            altitude: 55,
            distance: 80,
            coverForwardDistance: 35
        }
    );
    assert.strictEqual(held.state, 'fox1Illuminate');
    assert.strictEqual(held.debug.fox1IlluminateHold, 1);

    // --- sequel: another FOX-1 left → reattack setup ---
    const afterFox1 = {
        id: 'red',
        aiPolicyMode: 'fox1-first',
        activeMissiles: [],
        pylons: [
            { state: 'empty', weaponType: 'fox1' },
            { state: 'armed', weaponType: 'fox1' }
        ],
        wrapper: { position: { y: 55 } }
    };
    assert.strictEqual(env.peekNextMissileType(afterFox1, { preferFox1: true }), 'fox1');
    PilotAI.fox1WasInFlightByTeam.red = true;
    PilotAI.fox1SequelByTeam.red = undefined;
    const sequel = PilotAI.applyFox1DoctrineOverlay(
        { queueAction: 'none', missileType: 'fox1', joyX: 0, joyY: 0, state: 'searchIntercept' },
        afterFox1,
        {
            teamId: 'red',
            altitude: 55,
            angleDeg: 8,
            distance: 70,
            localToEnemy: { x: 0.2, y: 0, z: 0.9 },
            lineOfSightBlocked: false
        }
    );
    assert.strictEqual(sequel.debug.fox1NextMunition, 'fox1');
    assert.strictEqual(sequel.state, 'fox1ReattackSetup');
    assert.strictEqual(sequel.queueAction, 'none');

    // --- sequel: only FOX-2 left → no forced standoff ---
    const afterToFox2 = {
        id: 'blue',
        aiPolicyMode: 'fox1-first',
        activeMissiles: [],
        pylons: [
            { state: 'empty', weaponType: 'fox1' },
            { state: 'armed', weaponType: 'fox2' }
        ]
    };
    assert.strictEqual(env.peekNextMissileType(afterToFox2, { preferFox1: true }), 'fox2');
    PilotAI.fox1WasInFlightByTeam.blue = true;
    PilotAI.fox1SequelByTeam.blue = undefined;
    const sequel2 = PilotAI.applyFox1DoctrineOverlay(
        { queueAction: 'none', joyX: 0.1, joyY: 0, state: 'searchIntercept' },
        afterToFox2,
        { teamId: 'blue', altitude: 55, angleDeg: 12, distance: 60, localToEnemy: { x: 0, y: 0, z: 1 } }
    );
    assert.strictEqual(sequel2.debug.fox1NextMunition, 'fox2');
    assert.notStrictEqual(sequel2.state, 'fox1ReattackSetup');

    // Source contract
    const src = fs.readFileSync(path.join(__dirname, '../js/ai/pilot-ai.js'), 'utf8');
    assert.ok(src.includes('canCommitFox1Launch'), 'pilot-ai missing canCommitFox1Launch');
    assert.ok(src.includes('fox1ReattackSetup'), 'pilot-ai missing fox1ReattackSetup');
    assert.ok(src.includes('peekNextMissileType'), 'pilot-ai missing peekNextMissileType');
    assert.ok(src.includes('gateFox1MissileShoot'), 'pilot-ai missing gateFox1MissileShoot');

    console.log('munition-doctrine-smoke: PASS');
}

main();
