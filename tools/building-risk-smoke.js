#!/usr/bin/env node
/**
 * building-risk-smoke.js — Step 2 / M2: gap profile + corridorClear contract.
 * Fast Node unit smoke (no Three.js install); mocks Vector3/Box3 for corridor math.
 */
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

function installThreeMock() {
    class Vector3 {
        constructor(x = 0, y = 0, z = 0) {
            this.x = x;
            this.y = y;
            this.z = z;
        }
        set(x, y, z) {
            this.x = x;
            this.y = y;
            this.z = z;
            return this;
        }
        copy(v) {
            this.x = v.x;
            this.y = v.y;
            this.z = v.z;
            return this;
        }
        clone() {
            return new Vector3(this.x, this.y, this.z);
        }
        add(v) {
            this.x += v.x;
            this.y += v.y;
            this.z += v.z;
            return this;
        }
        sub(v) {
            this.x -= v.x;
            this.y -= v.y;
            this.z -= v.z;
            return this;
        }
        multiplyScalar(s) {
            this.x *= s;
            this.y *= s;
            this.z *= s;
            return this;
        }
        length() {
            return Math.hypot(this.x, this.y, this.z);
        }
        lengthSq() {
            return this.x * this.x + this.y * this.y + this.z * this.z;
        }
        normalize() {
            const L = this.length() || 1;
            this.x /= L;
            this.y /= L;
            this.z /= L;
            return this;
        }
        dot(v) {
            return this.x * v.x + this.y * v.y + this.z * v.z;
        }
    }

    class Box3 {
        constructor() {
            this.min = new Vector3(Infinity, Infinity, Infinity);
            this.max = new Vector3(-Infinity, -Infinity, -Infinity);
        }
        copy(src) {
            this.min.copy(src.min);
            this.max.copy(src.max);
            return this;
        }
        clone() {
            return new Box3().copy(this);
        }
        makeEmpty() {
            this.min.set(Infinity, Infinity, Infinity);
            this.max.set(-Infinity, -Infinity, -Infinity);
            return this;
        }
        setFromObject(obj) {
            if (obj && obj._box) {
                this.min.copy(obj._box.min);
                this.max.copy(obj._box.max);
            }
            return this;
        }
        clampPoint(point, target) {
            target.x = Math.min(this.max.x, Math.max(this.min.x, point.x));
            target.y = Math.min(this.max.y, Math.max(this.min.y, point.y));
            target.z = Math.min(this.max.z, Math.max(this.min.z, point.z));
            return target;
        }
    }

    global.THREE = { Vector3, Box3 };
}

function makePillar(x, z, halfW = 2, halfD = 2, h = 40) {
    return {
        userData: {},
        _box: {
            min: new THREE.Vector3(x - halfW, 0, z - halfD),
            max: new THREE.Vector3(x + halfW, h, z + halfD)
        }
    };
}

function makeRaycaster(fwdHitDist) {
    return {
        near: 0,
        far: 0,
        set() {},
        intersectObjects() {
            if (!Number.isFinite(fwdHitDist)) return [];
            return [{ distance: fwdHitDist }];
        }
    };
}

installThreeMock();
const buildingRisk = require(path.join(ROOT, 'js', 'ai', 'building-risk.js'));
const fails = [];

const gap = buildingRisk.getBuildingRiskProfile('gap');
const legacy = buildingRisk.getBuildingRiskProfile('legacy');
if (!gap || gap.id !== 'gap') fails.push('getBuildingRiskProfile(gap) missing');
if (!legacy || legacy.id !== 'legacy') fails.push('getBuildingRiskProfile(legacy) missing');
if (!(gap.highDist < legacy.highDist && gap.medDist < legacy.medDist)) {
    fails.push(`gap radii must be tighter than legacy (gap high=${gap.highDist} med=${gap.medDist}, legacy high=${legacy.highDist} med=${legacy.medDist})`);
}

// Mid-lane: legacy still high, gap only medium (enables corridor flight).
const midDist = 10;
const midFwd = 20;
const midLat = 5;
const gapMid = buildingRisk.classifyHorizontalRisk(midDist, midFwd, midLat, gap);
const legacyMid = buildingRisk.classifyHorizontalRisk(midDist, midFwd, midLat, legacy);
if (gapMid !== 'medium') fails.push(`gap mid-lane expected medium, got ${gapMid}`);
if (legacyMid !== 'high') fails.push(`legacy mid-lane expected high, got ${legacyMid}`);

// Far enough for gap low; legacy may still medium.
const far = buildingRisk.classifyHorizontalRisk(20, 40, 12, gap);
if (far !== 'low') fails.push(`gap far-lane expected low, got ${far}`);

// Behind building: soft low when far enough.
const behind = buildingRisk.classifyHorizontalRisk(10, -8, 4, gap, true);
if (behind !== 'low') fails.push(`gap behind expected low, got ${behind}`);

// Headroom climb caps.
if (buildingRisk.maxJoyYForHeadroom(3) >= 0) fails.push('headroom hard must force non-positive climb');
if (buildingRisk.maxJoyYForHeadroom(20) < 1) fails.push('headroom clear must allow full climb');

const selfPos = new THREE.Vector3(0, 20, 0);
const forward = new THREE.Vector3(0, 0, 1);

// Open corridor between two pillars (~12m gap).
const openPillars = [makePillar(-8, 10), makePillar(8, 10)];
const open = buildingRisk.evaluateCorridorClear(selfPos, forward, openPillars, makeRaycaster(40), gap);
if (!open.clear) {
    fails.push(`open corridor expected clear (gapWidth=${open.gapWidth}, fwd=${open.fwdClear})`);
}
if (!(open.gapWidth >= gap.corridorMinGap)) {
    fails.push(`open corridor gapWidth ${open.gapWidth} < min ${gap.corridorMinGap}`);
}

// Forward wall blocks corridor.
const blocked = buildingRisk.evaluateCorridorClear(
    selfPos,
    forward,
    [makePillar(0, 8, 6, 2)],
    makeRaycaster(6),
    gap
);
if (blocked.clear) fails.push('forward wall must not be corridorClear');

// Tight pillars (~2m channel) below corridorMinGap.
const tight = buildingRisk.evaluateCorridorClear(
    selfPos,
    forward,
    [makePillar(-2.5, 0, 1.5, 4), makePillar(2.5, 0, 1.5, 4)],
    makeRaycaster(40),
    gap
);
if (tight.clear) {
    fails.push(`tight corridor must not clear (gapWidth=${tight.gapWidth})`);
}
if (!(tight.gapWidth < gap.corridorMinGap)) {
    fails.push(`tight corridor gapWidth ${tight.gapWidth} should be < min ${gap.corridorMinGap}`);
}

// Hard contact / embed / early under-roof: never soft-pedal after Scheme B.
if (!buildingRisk.isHardBuildingContact({ distance: 0, collisionRisk: 'medium', roofClearance: -2 })) {
    fails.push('dist=0 + negative roof must be hard contact');
}
if (!buildingRisk.isHardBuildingContact({ distance: 1, collisionRisk: 'low' })) {
    fails.push('dist<4 must be hard contact');
}
if (!buildingRisk.isHardBuildingContact({ distance: 5, collisionRisk: 'low', roofClearance: -1 })) {
    fails.push('dist<6 + roof<0 must be early hard contact');
}
if (!buildingRisk.isHardBuildingContact({ distance: 5, collisionRisk: 'medium', roofClearance: 1 })) {
    fails.push('dist<6 + soft roof must be early hard contact');
}
if (buildingRisk.isHardBuildingContact({ distance: 12, collisionRisk: 'medium', roofClearance: 4 })) {
    fails.push('mid-lane medium must not be hard contact');
}
if (buildingRisk.finalizeBuildingRisk('medium', { distance: 0, roofClearance: -1 }) !== 'high') {
    fails.push('finalizeBuildingRisk must promote embed to high');
}

// T14: central table / dead undercroft is a hard choke (not a flyable street).
const tableChoke = buildingRisk.classifyUrbanHardChoke({
    roofClearance: -6,
    distance: 0,
    forwardDistance: 0,
    corridorClear: false,
    corridorGap: 0,
    corridorLeftClear: 0,
    corridorRightClear: 0,
    collisionRisk: 'high'
});
if (!tableChoke.active || tableChoke.severity < 2 || tableChoke.kind !== 'tableUndercroft') {
    fails.push(`table undercroft must be hardChoke sev2 (got ${JSON.stringify(tableChoke)})`);
}

// T76: beside taller AABB (roof negative) must not look like open-sky low.
const roofBeside = buildingRisk.applyRoofClearanceToRisk('low', -6, 0.1, 30, 8);
if (roofBeside !== 'medium') {
    fails.push(`negative roof beside building expected medium, got ${roofBeside}`);
}

// M15/M16/M19: urban-avoid-side authority + handoff knobs.
const urbanAvoid = require(path.join(ROOT, 'js', 'ai', 'urban-avoid-side.js'));
if (urbanAvoid.getRoofHeightDelta(40, 55) !== -15) {
    fails.push('getRoofHeightDelta should be selfY - roofY');
}
if (urbanAvoid.isTrueUndercroft({ roofClearance: -10, distance: 30, headroom: 48 })) {
    fails.push('beside taller AABB must not be true undercroft');
}
if (!urbanAvoid.isTrueUndercroft({ roofClearance: -2, distance: 5, headroom: 48 })) {
    fails.push('near negative roof must be true undercroft');
}
const aabbOwn = urbanAvoid.resolveAvoidSideAuthority({
    aabbEscapeSide: -1,
    committedAvoidSide: 1,
    geometricAvoidSide: 1,
    urbanAvoidSide: 1,
    breakSide: 1,
    coverDistance: 4,
    turnNo: 70,
    lastFlipTurn: -999,
    gluePushStreak: 2,
    hardBuildingContact: true,
    meshGlueContact: true,
    deepEmbedContact: true,
    earlyBuildingApproach: false,
    facadeClosingNow: true,
    embeddedLane: true,
    collisionRisk: 'high'
});
if (aabbOwn.side !== -1 || aabbOwn.source !== 'aabbOverMemory') {
    fails.push(`AABB should own over memory (got side=${aabbOwn.side} src=${aabbOwn.source})`);
}
const handoff = urbanAvoid.shouldHandoffEscapeToEngage(
    { collisionRisk: 'low', distance: 40, forwardDistance: 30, roofClearance: 12, headroom: 48 },
    { altitude: 45, forwardY: 0.1, hardContact: false, hardLock: false },
    { engageHandoffLowDist: 16 }
);
if (!handoff) fails.push('clear low-risk should handoff to engage');
const noHandoff = urbanAvoid.shouldHandoffEscapeToEngage(
    { collisionRisk: 'high', distance: 8, forwardDistance: 6, roofClearance: -4, headroom: 48 },
    { altitude: 30, forwardY: -0.4, hardContact: true },
    {}
);
if (noHandoff) fails.push('hard contact must not handoff');

const defaultsSrc = fs.readFileSync(path.join(ROOT, 'js', 'ai', 'pilot-tuning-defaults.js'), 'utf8');
if (!defaultsSrc.includes("buildingRiskProfile: 'gap'")) {
    fails.push("pilot-tuning-defaults.js must default buildingRiskProfile to 'gap'");
}
if (!defaultsSrc.includes('engageHandoffLowDist')) {
    fails.push('pilot-tuning-defaults.js must expose engageHandoff* knobs (M19)');
}
if (!defaultsSrc.includes('missileSalvoDualChance')) {
    fails.push('pilot-tuning-defaults.js must expose missileSalvoDualChance');
}
if (!defaultsSrc.includes('flareSoftKeepChance')) {
    fails.push('pilot-tuning-defaults.js must expose flareSoftKeepChance');
}

// Live pilot wiring contracts (string smoke).
const pilotSrc = fs.readFileSync(path.join(ROOT, 'js', 'ai', 'pilot-ai.js'), 'utf8');
for (const needle of [
    "buildingRiskProfile: 'gap'",
    'evaluateCorridorClear',
    'corridorClear',
    'lockedByEnergy',
    'missileLosGate',
    'stallRecoverNoRoll',
    'isHardBuildingContact',
    'hardContact=',
    'isTrueUnderRoof',
    'pickScoredUrbanEscapeStick',
    'getCorridorGapAsymmetry',
    'scoreGapForce',
    'scoreGapCut',
    'classifyUrbanHardChoke',
    'hardChoke',
    'applyMissileSalvoAndFlareDoctrine',
    'resolveMissileSalvoMode',
    'estimateEnemyFlareWasteRisk',
    'shouldBlockOpeningForUrbanPressure',
    'shouldHandoffEscapeToEngage',
    'enforceFacadeLateralFloor',
    'resolveAvoidSideAuthority',
    'getRoofHeightDelta',
    'AirArenaUrbanAvoidSide'
]) {
    if (!pilotSrc.includes(needle)) fails.push(`pilot-ai.js missing contract: ${needle}`);
}

// M18: one-sided gap helper contract (T150 L≪R → side +1 strength 2).
if (!pilotSrc.includes('One-sided street opening')) {
    fails.push('pilot-ai.js missing getCorridorGapAsymmetry doctrine comment');
}
if (!pilotSrc.includes('all-hit — gap-side cut bias')) {
    fails.push('pilot-ai.js missing all-hit gapForce fallback');
}

const indexSrc = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
if (!indexSrc.includes('js/ai/urban-avoid-side.js')) {
    fails.push('index.html must load urban-avoid-side.js');
}

if (fails.length) {
    console.error('Building-risk smoke FAIL:');
    for (const f of fails) console.error(` - ${f}`);
    process.exit(1);
}

console.log('Building-risk smoke PASS');
console.log(`Profiles: gap high=${gap.highDist}/${gap.medDist} legacy high=${legacy.highDist}/${legacy.medDist}`);
console.log(`Corridor open gapWidth=${open.gapWidth} blocked.clear=${blocked.clear} tight.clear=${tight.clear}`);
console.log(`Avoid-side: aabbOverMemory side=${aabbOwn.side} handoffClear=${handoff ? 1 : 0}`);
