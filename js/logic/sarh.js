// ============================================================================
// sarh.js - FOX-1 semi-active radar support gate + chaff / clutter helpers
// ============================================================================

function sanitizePylonWeapon(w) {
    if (w === 'fox1') return 'fox1';
    if (w === 'bomb') return 'bomb';
    if (w === 'rocket') return 'rocket';
    return 'fox2';
}

/** Per-slot loadout: fox1 | fox2 | bomb | rocket | empty (gun-only seats). */
function sanitizePylonSlot(w) {
    if (w === 'empty' || w === 'none' || w === 'gun') return 'empty';
    if (w === 'fox1') return 'fox1';
    if (w === 'fox2') return 'fox2';
    if (w === 'bomb') return 'bomb';
    if (w === 'rocket') return 'rocket';
    return null;
}

function defaultPylonLoadout() {
    // Standard combat mix: 2×FOX-1 + 2×FOX-2 (inner SARH / outer IR) + gun via SMS.
    return ['fox1', 'fox2', 'fox2', 'fox1'];
}

/** Seat preset → four pylon types. fox2-priority is A2A four-IR, not fox2-first policy. */
function pylonsForLoadout(loadout) {
    if (loadout === 'gun-priority') return ['empty', 'empty', 'empty', 'empty'];
    if (loadout === 'fox1-priority') return ['fox1', 'fox1', 'fox1', 'fox1'];
    if (loadout === 'fox2-priority') return ['fox2', 'fox2', 'fox2', 'fox2'];
    return defaultPylonLoadout();
}

function sanitizePylonLoadout(arr) {
    const base = defaultPylonLoadout();
    if (!Array.isArray(arr)) return base.slice();
    return [0, 1, 2, 3].map((i) => {
        const slot = sanitizePylonSlot(arr[i]);
        if (slot) return slot;
        return sanitizePylonWeapon(base[i]);
    });
}

function getMissileWeaponConfig(missileType) {
    let type = sanitizePylonWeapon(missileType === 'empty' ? 'fox2' : missileType);
    // Bomb/rocket are not FOX seekers — fall back to fox2 envelope if mis-queried.
    if (type === 'bomb' || type === 'rocket') type = 'fox2';
    if (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons[type]) {
        return CONFIG.weapons[type];
    }
    return (CONFIG && CONFIG.weapons && CONFIG.weapons.fox2) ? CONFIG.weapons.fox2 : {};
}

function pylonWeaponType(pylon) {
    if (!pylon) return 'fox2';
    // Prefer stored weaponType even while empty (reload / SMS); only default fox2 for true gun-empty.
    if (pylon.weaponType === 'fox1' || pylon.weaponType === 'fox2'
        || pylon.weaponType === 'bomb' || pylon.weaponType === 'rocket') {
        return pylon.weaponType;
    }
    if (pylon.weaponType === 'empty' || pylon.state === 'empty') return 'fox2';
    return sanitizePylonWeapon(pylon.weaponType || pylon.weapon || 'fox2');
}

function teamLiveMissileType(team) {
    if (!team || !team.pylons) return null;
    const live = team.pylons.find((p) => {
        if (!(p.state === 'armed' || p.state === 'powering')) return false;
        const wt = pylonWeaponType(p);
        return wt !== 'bomb' && wt !== 'rocket';
    });
    return live ? pylonWeaponType(live) : null;
}

/**
 * Own FOX-1 still on the rail or in the air. Do NOT require m.active —
 * missiles spawn active:false until launchStep, and sequel / leftover
 * shots must keep SMS on 導引中 when the next pylon is selected.
 */
function teamHasFox1InFlight(team) {
    return !!(team && team.activeMissiles && team.activeMissiles.some(
        (m) => m && m.missileType === 'fox1' && !m.exploded && Number(m.ap) > 0
    ));
}

/**
 * Drop all powering/armed pylons whose weapon type differs from keepType.
 * @returns {number} count dropped
 */
function dropConflictingPylonPower(team, keepType) {
    if (!team || !team.pylons) return 0;
    const keep = sanitizePylonWeapon(keepType);
    // A2G stores do not share the FOX seeker bus — never auto-drop them here.
    if (keep === 'bomb' || keep === 'rocket') return 0;
    let n = 0;
    team.pylons.forEach((p) => {
        if (p.state !== 'powering' && p.state !== 'armed') return;
        const wt = pylonWeaponType(p);
        if (wt === 'bomb' || wt === 'rocket') return;
        if (wt === keep) return;
        p.state = 'standby';
        n += 1;
    });
    return n;
}

function resolveSarhTurn(opts) {
    const t = Number(opts && opts.turn);
    if (Number.isFinite(t) && t > 0) return Math.floor(t);
    if (typeof GameContext !== 'undefined' && GameContext.state) {
        const g = Number(GameContext.state.currentTurn);
        if (Number.isFinite(g) && g > 0) return Math.floor(g);
    }
    return 0;
}

/** Deterministic 0..1 from a string (HUD / AI / missile must agree in the same turn). */
function hashUnitInterval(seed) {
    const s = String(seed || '');
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0) / 4294967296;
}

/**
 * M24: while LOS hits a cloud, maybe drop support. Same shooter+target+turn
 * +shot+match always gets the same answer (not per-frame random). Shot and
 * batch session keep gold openings from locking the same pair-turn roll.
 */
function resolveSarhChaffBreak(opts, chaffCfg, losHitsCloud) {
    if (!losHitsCloud) return false;
    if (!chaffCfg || chaffCfg.breakSupportOnLos === false) return false;
    if (typeof opts.chaffBreakForce === 'boolean') return opts.chaffBreakForce;
    const chance = Number(chaffCfg.breakChance);
    if (!Number.isFinite(chance) || chance <= 0) return false;
    if (chance >= 1) return true;
    const breakTurns = Math.max(1, Math.floor(Number(chaffCfg.breakTurns) || 1));
    const turn = resolveSarhTurn(opts);
    const slot = Math.floor(Math.max(0, turn - 1) / breakTurns);
    const shooter = opts.shooterId != null ? String(opts.shooterId) : '';
    const target = opts.targetId != null ? String(opts.targetId) : '';
    const shot = opts.shotId != null ? String(opts.shotId) : '';
    let match = opts.matchSalt != null ? String(opts.matchSalt) : '';
    if (!match && typeof AirArenaBatchRun !== 'undefined' && AirArenaBatchRun.readQuery) {
        const q = AirArenaBatchRun.readQuery();
        if (q && q.session) match = `${q.session}:${q.batchIndex || 1}`;
    }
    return hashUnitInterval(`${slot}|${shooter}|${target}|${shot}|${match}|m24chaff`) < chance;
}

function segmentHitsSphere(a, b, center, radius) {
    if (!a || !b || !center || !(radius > 0)) return false;
    const ab = b.clone().sub(a);
    const len = ab.length();
    if (len < 1e-6) return a.distanceTo(center) <= radius;
    const dir = ab.multiplyScalar(1 / len);
    const toC = center.clone().sub(a);
    const t = Math.max(0, Math.min(len, toC.dot(dir)));
    const closest = a.clone().add(dir.multiplyScalar(t));
    return closest.distanceTo(center) <= radius;
}

/**
 * SARH support / hit-gate evaluation for FOX-1.
 * Smaller angle = harder to keep target inside (harder hit).
 * Look direction includes config supportLookJitterRad wander (“head” motion).
 */
function applySarhLookJitter(forward, nowStep, cfg) {
    const amp = Number(cfg && cfg.supportLookJitterRad);
    if (!(amp > 0) || !forward) return forward.clone().normalize();
    const t = Number(nowStep) || 0;
    // Slow wander + faster twitch + light hashed noise
    const yaw =
        Math.sin(t * 0.073) * amp +
        Math.sin(t * 0.211 + 1.7) * amp * 0.45;
    const pitch =
        Math.cos(t * 0.097) * amp * 0.85 +
        Math.sin(t * 0.163 + 0.4) * amp * 0.35;
    const hash = Math.sin(t * 12.9898 + 78.233) * 43758.5453;
    const frac = hash - Math.floor(hash);
    const yawN = (frac - 0.5) * 2 * amp * 0.28;
    const hash2 = Math.sin(t * 9.173 + 19.19) * 23421.631;
    const frac2 = hash2 - Math.floor(hash2);
    const pitchN = (frac2 - 0.5) * 2 * amp * 0.22;

    const f = forward.clone().normalize();
    const worldUp = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(f, worldUp);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    else right.normalize();
    const up = new THREE.Vector3().crossVectors(right, f).normalize();
    return f
        .add(right.multiplyScalar(yaw + yawN))
        .add(up.multiplyScalar(pitch + pitchN))
        .normalize();
}

function computeSarhSupport(opts = {}) {
    const cfg = getMissileWeaponConfig('fox1');
    const chaffCfg = (CONFIG.weapons && CONFIG.weapons.chaff) ? CONFIG.weapons.chaff : {};
    const shooterPos = opts.shooterPos;
    const shooterQuat = opts.shooterQuat;
    const targetPos = opts.targetPos;
    const targetVel = opts.targetVel || null;
    const chaffList = opts.chaffList || [];
    const nowStep = Number(opts.step) || 0;
    const losBlocked = !!opts.losBlocked;

    let baseAngle = Number(cfg.supportBaseAngle) || (Math.PI / 18);
    const minAngle = Number(cfg.supportMinAngle) || (Math.PI / 48);
    const maxRange = Number(cfg.seekerRange) || 200;
    // Illumination range ≠ missile arming range. Using minArmingRange here dropped support
    // as soon as the fight closed inside 70m → FOX-1 flew ballistic (zero AI hits).
    const minSupportRange = Number.isFinite(Number(cfg.supportMinRange))
        ? Number(cfg.supportMinRange)
        : 8;

    const noseFwd = shooterQuat
        ? new THREE.Vector3(0, 0, 1).applyQuaternion(shooterQuat).normalize()
        : new THREE.Vector3(0, 0, 1);
    const lookDir = applySarhLookJitter(noseFwd, nowStep, cfg);

    if (!shooterPos || !targetPos || !shooterQuat) {
        return {
            supported: false,
            inGate: false,
            inRange: false,
            angle: baseAngle,
            angleDeg: baseAngle * 180 / Math.PI,
            dist: Infinity,
            shrink: 1,
            flicker: false,
            breathe: 1,
            beamHard: false,
            lookDir,
            reason: 'no-geometry'
        };
    }

    const toTarget = targetPos.clone().sub(shooterPos);
    const dist = toTarget.length();
    const inRange = dist >= minSupportRange && dist <= maxRange;
    const forward = lookDir;
    const toNorm = dist > 1e-4 ? toTarget.clone().normalize() : forward.clone();
    const offBore = forward.angleTo(toNorm);

    let shrink = 1;
    // Distance: farther → slightly tighter (scaled for 200m seeker)
    if (dist > 130) shrink *= 0.92;
    if (dist > 170) shrink *= 0.88;

    // Ground clutter: low target / look-down → slight shrink + breathe
    const shooterAlt = shooterPos.y;
    const targetAlt = targetPos.y;
    const lookDown = shooterAlt - targetAlt;
    let breathe = 1;
    if (targetAlt < 28 || lookDown > 12) {
        shrink *= 0.9;
        breathe = 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(nowStep * 0.12));
    } else if (targetAlt < 40) {
        shrink *= 0.96;
        breathe = 0.85 + 0.15 * (0.5 + 0.5 * Math.sin(nowStep * 0.1));
    }

    // Beam aspect: target velocity perpendicular to LOS → harder
    let beamHard = false;
    if (targetVel && targetVel.lengthSq() > 1e-6) {
        const closing = targetVel.clone().normalize().dot(toNorm);
        const lateral = 1 - Math.abs(closing);
        const beamMax = Number(cfg.beamAspectDotMax);
        if (lateral > (Number.isFinite(beamMax) ? (1 - beamMax) : 0.65)) {
            beamHard = true;
            shrink *= Number(cfg.beamGateMult) || 0.62;
        }
    }

    // CHAFF: illumination LOS through cloud → flicker; M24 may drop support (roll / turn).
    let flicker = false;
    let losHitsCloud = false;
    const cloudR0 = Number(chaffCfg.cloudRadius) || 10;
    const cloudRMax = Number(chaffCfg.cloudRadiusMax) || 32;
    const gateShrink = Number(chaffCfg.gateShrinkMult) || 0.55;
    for (let i = 0; i < chaffList.length; i++) {
        const c = chaffList[i];
        if (!c || !c.pos) continue;
        const age = Number(c.ageSteps != null ? c.ageSteps : c.age) || 0;
        const r =
            c.radius != null
                ? Number(c.radius)
                : Math.min(cloudRMax, cloudR0 + age * (Number(chaffCfg.expandPerStep) || 0.11));
        const hitCloud =
            segmentHitsSphere(shooterPos, targetPos, c.pos, r) ||
            (typeof targetPos.distanceTo === 'function' && targetPos.distanceTo(c.pos) <= r);
        if (hitCloud) {
            shrink *= gateShrink;
            flicker = true;
            losHitsCloud = true;
            break;
        }
    }
    const chaffBreak = resolveSarhChaffBreak(opts, chaffCfg, losHitsCloud);

    if (losBlocked) {
        return {
            supported: false,
            inGate: false,
            inRange,
            angle: minAngle,
            angleDeg: minAngle * 180 / Math.PI,
            dist,
            shrink: 0,
            flicker: true,
            breathe,
            beamHard,
            lookDir,
            reason: 'los-blocked'
        };
    }

    const angle = Math.max(minAngle, baseAngle * shrink);
    const inGate = !chaffBreak && offBore <= angle;
    const supported = !chaffBreak && inRange && inGate && forward.dot(toNorm) > 0.35;

    return {
        supported,
        inGate,
        inRange,
        angle,
        angleDeg: angle * 180 / Math.PI,
        offBoreDeg: offBore * 180 / Math.PI,
        dist,
        shrink,
        flicker,
        breathe,
        beamHard,
        lookDir,
        reason: chaffBreak ? 'chaff' : (supported ? 'ok' : (!inRange ? 'range' : 'gate'))
    };
}

/**
 * M23: FOX-1 ring look vs fire gate. Physics support stays 8–200 (computeSarhSupport).
 * Launch floor is minArmingRange (50). Pre-launch inside 50 must not look fireable;
 * in-flight 8–200 stays support-hot so the shooter keeps illuminating.
 *
 * @returns {{
 *   mode: 'none'|'hold'|'fire'|'support',
 *   launchMin: number,
 *   supportMin: number,
 *   supportMax: number,
 *   inSupportBand: boolean,
 *   lookFire: boolean,
 *   lookSupport: boolean,
 *   caption: string
 * }}
 */
function describeFox1RingMode(opts = {}) {
    const cfg = getMissileWeaponConfig('fox1');
    const dist = Number(opts.distance);
    const inFlight = !!opts.inFlight;
    const minArm = Number(cfg.minArmingRange);
    const launchMin = Number.isFinite(minArm) ? minArm : 50;
    const minSup = Number.isFinite(Number(cfg.supportMinRange)) ? Number(cfg.supportMinRange) : 8;
    const maxR = Number(cfg.seekerRange) || Number(cfg.maxFlightRange) || 200;
    const out = {
        mode: 'none',
        launchMin,
        supportMin: minSup,
        supportMax: maxR,
        inSupportBand: false,
        lookFire: false,
        lookSupport: false,
        caption: ''
    };
    if (!Number.isFinite(dist) || dist < minSup || dist > maxR) return out;
    out.inSupportBand = true;
    if (inFlight) {
        out.mode = 'support';
        out.lookSupport = true;
        return out;
    }
    if (dist < launchMin) {
        out.mode = 'hold';
        out.lookSupport = true;
        return out;
    }
    out.mode = 'fire';
    out.lookFire = true;
    return out;
}

/** M23: tactical-computer (SMS) line. Ring itself stays caption-free.
 *  導引中 only while a FOX-1 is actually in the air. After a hit, selecting
 *  the next pylon must not keep 「照射中」 — that line meant live support. */
function describeFox1SmsLine(opts = {}) {
    const mode = opts.mode || describeFox1RingMode(opts).mode;
    if (mode === 'support') {
        return { mode, text: 'FOX-1 導引中', color: '#ffcc66' };
    }
    return { mode: mode || 'none', text: '', color: '' };
}

/**
 * Human fire-button range gate (armed / 綠燈). Same band as launch, not illuminate.
 * tooFar → 未進入射程；tooClose → 少於最短射程.
 */
function describeMissileLaunchRange(opts = {}) {
    const type = sanitizePylonWeapon(opts.missileType);
    const cfg = getMissileWeaponConfig(type);
    const dist = Number(opts.distance);
    const minArm = Number(cfg.minArmingRange);
    const maxR = Number(cfg.seekerRange) || Number(cfg.maxFlightRange);
    const min = Number.isFinite(minArm) ? minArm : (type === 'fox1' ? 50 : 20);
    const max = Number.isFinite(maxR) ? maxR : (type === 'fox1' ? 200 : 120);
    const out = { ok: false, reason: 'noTarget', missileType: type, min, max, dist };
    if (!Number.isFinite(dist)) return out;
    out.dist = dist;
    if (dist < min) {
        out.reason = 'tooClose';
        return out;
    }
    if (dist > max) {
        out.reason = 'tooFar';
        return out;
    }
    out.ok = true;
    out.reason = 'ok';
    return out;
}

function missileLaunchRangeSms(reason) {
    if (reason === 'tooClose') return '少於最短射程';
    if (reason === 'tooFar' || reason === 'noTarget') return '未進入射程';
    return '';
}

function isMissileKillWeapon(weapon) {
    return weapon === 'missile' || weapon === 'fox1' || weapon === 'fox2';
}

function normalizeMissileShotOutcome(outcome) {
    if (outcome === 'hit' || outcome === 'coast' || outcome === 'building' || outcome === 'exhausted') {
        return outcome;
    }
    return 'exhausted';
}

function fox2MaxLaunchAngleDeg() {
    if (typeof CONFIG !== 'undefined' && CONFIG.doctrine && CONFIG.doctrine.munition && CONFIG.doctrine.munition.fox2) {
        const n = Number(CONFIG.doctrine.munition.fox2.maxLaunchAngleDeg);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return 10;
}

function fox2FrontAspectDot() {
    if (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.fox2) {
        const n = Number(CONFIG.weapons.fox2.frontAspectDot);
        if (Number.isFinite(n)) return n;
    }
    return 0.40;
}

function fox2SeekerAngleDeg() {
    if (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.fox2) {
        const rad = Number(CONFIG.weapons.fox2.seekerAngle);
        if (Number.isFinite(rad) && rad > 0) return rad * 180 / Math.PI;
    }
    return 15;
}

/** Front squeeze from seeker 15° × 0.40 ≈ 6°, then min with fire door. Physics unchanged. */
function fox2FrontLaunchAngleDeg() {
    let mult = 0.40;
    if (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.fox2) {
        const m = Number(CONFIG.weapons.fox2.frontAspectSeekerAngleMult);
        if (Number.isFinite(m) && m > 0) mult = m;
    }
    const squeezed = fox2SeekerAngleDeg() * mult;
    const n = Math.min(fox2MaxLaunchAngleDeg(), Number.isFinite(squeezed) && squeezed > 0 ? squeezed : 6);
    return Number.isFinite(n) && n > 0 ? n : 6;
}

function fox2ReadVec3(p) {
    if (!p) return null;
    const x = Number(p.x);
    const y = Number(p.y);
    const z = Number(p.z);
    if (![x, y, z].every(Number.isFinite)) return null;
    return { x, y, z };
}

function fox2ForwardFromQuat(q) {
    if (!q) return null;
    const x = Number(q.x);
    const y = Number(q.y);
    const z = Number(q.z);
    const w = Number(q.w);
    if (![x, y, z, w].every(Number.isFinite)) return null;
    const vx = 2 * (x * z + w * y);
    const vy = 2 * (y * z - w * x);
    const vz = 1 - 2 * (x * x + y * y);
    const len = Math.hypot(vx, vy, vz) || 1;
    return { x: vx / len, y: vy / len, z: vz / len };
}

function fox2ReadForward(fwdOrQuat) {
    if (!fwdOrQuat) return null;
    if (fwdOrQuat.w != null && Number.isFinite(Number(fwdOrQuat.w))) {
        return fox2ForwardFromQuat(fwdOrQuat);
    }
    return fox2ReadVec3(fwdOrQuat);
}

/** Target nose toward shooter → front-aspect (same dot as getMissileAspect). Missing vectors are not front. */
function fox2IsFrontAspect(shooterPos, targetPos, targetForwardOrQuat) {
    const shooter = fox2ReadVec3(shooterPos);
    const target = fox2ReadVec3(targetPos);
    const fwd = fox2ReadForward(targetForwardOrQuat);
    if (!shooter || !target || !fwd) return false;
    const ox = shooter.x - target.x;
    const oy = shooter.y - target.y;
    const oz = shooter.z - target.z;
    const ol = Math.hypot(ox, oy, oz);
    if (!(ol > 0.01)) return false;
    const fl = Math.hypot(fwd.x, fwd.y, fwd.z) || 1;
    const dot = (fwd.x * ox + fwd.y * oy + fwd.z * oz) / (fl * ol);
    return dot > fox2FrontAspectDot();
}

/** Fail-closed: missing angle is not inside the seeker cone. Number(null) is 0 — do not treat as on-boresight. Front-aspect uses the squeezed cone. */
function fox2LaunchAngleOk(geom, maxDeg) {
    if (!geom || geom.angDeg == null || geom.angDeg === '') return false;
    const a = Number(geom.angDeg);
    const cap = Number(maxDeg);
    const base = Number.isFinite(cap) && cap > 0 ? cap : fox2MaxLaunchAngleDeg();
    const limit = geom.frontAspect ? Math.min(base, fox2FrontLaunchAngleDeg()) : base;
    return Number.isFinite(a) && a <= limit;
}

/** Flight-truth pose: logicalQuat drives sim / launch. Visual quat can drift during anim. */
function fox2ReadLaunchPose(team) {
    const w = team && team.wrapper;
    if (!w) return { pos: null, quat: null };
    return {
        pos: w.position || null,
        quat: (w.userData && w.userData.logicalQuat) || w.quaternion || null
    };
}

function fox2CommitTurnNow() {
    if (typeof GameContext !== 'undefined' && GameContext.state) {
        const n = Number(GameContext.state.currentTurn);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

/** Same-turn AI commit already passed the fire door — spawn must not re-veto with a second pose. */
function fox2SameTurnCommitOk(team, maxDeg) {
    const c = team && team.fox2LaunchCommit;
    if (!c) return false;
    const now = fox2CommitTurnNow();
    if (now == null || Number(c.turn) !== now) return false;
    return fox2LaunchAngleOk({ angDeg: c.angDeg, frontAspect: !!c.front }, maxDeg);
}

function computeMissileLaunchGeometry(shooterPos, shooterQuat, targetPos, targetForwardOrQuat) {
    if (!shooterPos || !targetPos) return { dist: null, angDeg: null, frontAspect: false };
    const sx = Number(shooterPos.x);
    const sy = Number(shooterPos.y);
    const sz = Number(shooterPos.z);
    const tx = Number(targetPos.x);
    const ty = Number(targetPos.y);
    const tz = Number(targetPos.z);
    if (![sx, sy, sz, tx, ty, tz].every(Number.isFinite)) {
        return { dist: null, angDeg: null, frontAspect: false };
    }
    const dx = tx - sx;
    const dy = ty - sy;
    const dz = tz - sz;
    const dist = Math.hypot(dx, dy, dz);
    let angDeg = null;
    if (dist > 0.01 && shooterQuat && typeof THREE !== 'undefined' && THREE.Vector3) {
        const fwd = new THREE.Vector3(0, 0, 1);
        if (typeof fwd.applyQuaternion === 'function') fwd.applyQuaternion(shooterQuat);
        const fl = Math.hypot(fwd.x, fwd.y, fwd.z) || 1;
        const tl = dist;
        const dot = Math.max(-1, Math.min(1, (fwd.x * dx + fwd.y * dy + fwd.z * dz) / (fl * tl)));
        angDeg = Math.acos(dot) * 180 / Math.PI;
    }
    return {
        dist: Number(dist.toFixed(1)),
        angDeg: Number.isFinite(angDeg) ? Number(angDeg.toFixed(1)) : null,
        frontAspect: fox2IsFrontAspect(shooterPos, targetPos, targetForwardOrQuat)
    };
}

const MISSILE_SHOT_WHYS = [
    'hit', 'held', 'chaff', 'los', 'dead', 'range', 'gate', 'nogeom', 'flare', 'heat', 'unk'
];
const FOX1_SHOT_WHYS = ['hit', 'held', 'chaff', 'los', 'dead', 'range', 'gate', 'nogeom', 'unk'];
const FOX2_SHOT_WHYS = ['hit', 'held', 'flare', 'range', 'gate', 'heat', 'nogeom', 'unk'];

function normalizeMissileShotWhy(why) {
    return MISSILE_SHOT_WHYS.indexOf(why) >= 0 ? why : null;
}

function normalizeFox1ShotWhy(why) {
    return FOX1_SHOT_WHYS.indexOf(why) >= 0 ? why : null;
}

function normalizeFox2ShotWhy(why) {
    return FOX2_SHOT_WHYS.indexOf(why) >= 0 ? why : null;
}

function stampMissileShotWhy(missile, why, extras) {
    if (!missile) return null;
    const token = normalizeMissileShotWhy(why);
    if (!token) return null;
    missile.shotLastWhy = token;
    if (extras && extras.canGuide && token !== 'held' && !missile.shotDropWhy) {
        missile.shotDropWhy = token;
    }
    return token;
}

function resolveMissileShotWhy(missile, outcome) {
    if (normalizeMissileShotOutcome(outcome) === 'hit') return 'hit';
    if (missile && missile.shotDropWhy) {
        return normalizeMissileShotWhy(missile.shotDropWhy) || 'unk';
    }
    if (missile && missile.fox1DropWhy) {
        return normalizeFox1ShotWhy(missile.fox1DropWhy) || 'unk';
    }
    if (missile && missile.fox2DropWhy) {
        return normalizeFox2ShotWhy(missile.fox2DropWhy) || 'unk';
    }
    if (missile && missile.shotLastWhy) {
        return normalizeMissileShotWhy(missile.shotLastWhy) || 'unk';
    }
    if (missile && missile.fox1LastWhy) {
        return normalizeFox1ShotWhy(missile.fox1LastWhy) || 'unk';
    }
    if (missile && missile.fox2LastWhy) {
        return normalizeFox2ShotWhy(missile.fox2LastWhy) || 'unk';
    }
    return 'unk';
}

/** Map computeSarhSupport.reason (+ shooter live) to a dump token. */
function classifyFox1SupportWhy(support, extras) {
    if (extras && extras.shooterAlive === false) return 'dead';
    if (!support) return 'nogeom';
    const r = support.reason;
    if (r === 'ok') return 'held';
    if (r === 'chaff') return 'chaff';
    if (r === 'los-blocked') return 'los';
    if (r === 'range') return 'range';
    if (r === 'gate') return 'gate';
    if (r === 'no-geometry') return 'nogeom';
    return 'gate';
}

/** First post-arm drop wins; last frame always updated. Physics unchanged. */
function stampFox1SupportWhy(missile, support, extras) {
    if (!missile || missile.missileType !== 'fox1') return null;
    const why = classifyFox1SupportWhy(support, extras || {});
    missile.fox1LastWhy = why;
    if (extras && extras.canGuide && why !== 'held' && !missile.fox1DropWhy) {
        missile.fox1DropWhy = why;
    }
    return stampMissileShotWhy(missile, why, extras);
}

function resolveFox1ShotWhy(missile, outcome) {
    return resolveMissileShotWhy(missile, outcome);
}

function classifyFox2TrackWhy(info) {
    if (!info) return 'nogeom';
    if (info.trackKind === 'flare') return 'flare';
    if (info.trackKind === 'aircraft') return 'held';
    if (!info.canGuide) return 'held';
    if (info.nearDist == null) return 'nogeom';
    if (Number.isFinite(Number(info.seekerRange)) && info.nearDist > Number(info.seekerRange)) return 'range';
    if (info.inFovCold) return 'heat';
    return 'gate';
}

function stampFox2TrackWhy(missile, info, extras) {
    if (!missile || missile.missileType === 'fox1') return null;
    const why = classifyFox2TrackWhy(info || {});
    missile.fox2LastWhy = why;
    if (extras && extras.canGuide && why !== 'held' && !missile.fox2DropWhy) {
        missile.fox2DropWhy = why;
    }
    return stampMissileShotWhy(missile, why, extras);
}

function formatShotWhyCounts(shots, type, allowed) {
    const counts = {};
    allowed.forEach((k) => { counts[k] = 0; });
    (shots || []).forEach((s) => {
        if (!s || s.type !== type || !s.why) return;
        const k = allowed.indexOf(s.why) >= 0 ? s.why : null;
        if (k) counts[k] += 1;
    });
    return allowed.filter((k) => counts[k] > 0).map((k) => `${k}:${counts[k]}`).join(',') || '';
}

function formatFox1WhyCounts(shots) {
    return formatShotWhyCounts(shots, 'fox1', FOX1_SHOT_WHYS);
}

function formatFox2WhyCounts(shots) {
    return formatShotWhyCounts(shots, 'fox2', FOX2_SHOT_WHYS);
}

function openMissileShot(team, missile, geom, turn, targetId) {
    if (!team || !missile || missile.shotOpened) return null;
    if (!Array.isArray(team.missileShots)) team.missileShots = [];
    const rec = {
        type: missile.missileType === 'fox1' ? 'fox1' : 'fox2',
        turn: Number(turn) || 0,
        dist: geom && Number.isFinite(Number(geom.dist)) ? Number(geom.dist) : null,
        angDeg: geom && Number.isFinite(Number(geom.angDeg)) ? Number(geom.angDeg) : null,
        front: !!(geom && geom.frontAspect),
        targetId: targetId || missile.supportTargetId || null,
        outcome: null,
        why: null,
        endTurn: null
    };
    team.missileShots.push(rec);
    missile.shotOpened = true;
    missile.shotIndex = team.missileShots.length - 1;
    return rec;
}

function closeMissileShot(team, missile, outcome, turn) {
    if (!team || !missile || missile.shotClosed) return null;
    if (!Array.isArray(team.missileShots) || !Number.isInteger(missile.shotIndex)) return null;
    const rec = team.missileShots[missile.shotIndex];
    if (!rec) return null;
    rec.outcome = normalizeMissileShotOutcome(outcome);
    rec.endTurn = Number(turn) || rec.turn || 0;
    rec.why = resolveMissileShotWhy(missile, rec.outcome);
    if (missile.fox2CoastSteer) rec.coastSteer = 1;
    missile.shotClosed = true;
    return rec;
}

function summarizeMissileShots(shots) {
    const out = {
        n: 0, fox1: 0, fox2: 0, hit: 0, coast: 0, building: 0, exhausted: 0, open: 0,
        fox1Why: formatFox1WhyCounts(shots),
        fox2Why: formatFox2WhyCounts(shots)
    };
    (shots || []).forEach((s) => {
        if (!s) return;
        out.n += 1;
        if (s.type === 'fox1') out.fox1 += 1;
        else out.fox2 += 1;
        if (!s.outcome) out.open += 1;
        else if (Object.prototype.hasOwnProperty.call(out, s.outcome)) out[s.outcome] += 1;
    });
    return out;
}

const _sarhRoot = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null);
if (_sarhRoot) {
    _sarhRoot.sanitizePylonWeapon = sanitizePylonWeapon;
    _sarhRoot.sanitizePylonSlot = sanitizePylonSlot;
    _sarhRoot.defaultPylonLoadout = defaultPylonLoadout;
    _sarhRoot.pylonsForLoadout = pylonsForLoadout;
    _sarhRoot.sanitizePylonLoadout = sanitizePylonLoadout;
    _sarhRoot.getMissileWeaponConfig = getMissileWeaponConfig;
    _sarhRoot.pylonWeaponType = pylonWeaponType;
    _sarhRoot.teamLiveMissileType = teamLiveMissileType;
    _sarhRoot.teamHasFox1InFlight = teamHasFox1InFlight;
    _sarhRoot.dropConflictingPylonPower = dropConflictingPylonPower;
    _sarhRoot.computeSarhSupport = computeSarhSupport;
    _sarhRoot.resolveSarhChaffBreak = resolveSarhChaffBreak;
    _sarhRoot.describeFox1RingMode = describeFox1RingMode;
    _sarhRoot.describeFox1SmsLine = describeFox1SmsLine;
    _sarhRoot.describeMissileLaunchRange = describeMissileLaunchRange;
    _sarhRoot.missileLaunchRangeSms = missileLaunchRangeSms;
    _sarhRoot.isMissileKillWeapon = isMissileKillWeapon;
    _sarhRoot.normalizeMissileShotOutcome = normalizeMissileShotOutcome;
    _sarhRoot.fox2MaxLaunchAngleDeg = fox2MaxLaunchAngleDeg;
    _sarhRoot.fox2FrontAspectDot = fox2FrontAspectDot;
    _sarhRoot.fox2FrontLaunchAngleDeg = fox2FrontLaunchAngleDeg;
    _sarhRoot.fox2IsFrontAspect = fox2IsFrontAspect;
    _sarhRoot.fox2LaunchAngleOk = fox2LaunchAngleOk;
    _sarhRoot.fox2ReadLaunchPose = fox2ReadLaunchPose;
    _sarhRoot.fox2SameTurnCommitOk = fox2SameTurnCommitOk;
    _sarhRoot.computeMissileLaunchGeometry = computeMissileLaunchGeometry;
    _sarhRoot.normalizeMissileShotWhy = normalizeMissileShotWhy;
    _sarhRoot.normalizeFox1ShotWhy = normalizeFox1ShotWhy;
    _sarhRoot.normalizeFox2ShotWhy = normalizeFox2ShotWhy;
    _sarhRoot.stampMissileShotWhy = stampMissileShotWhy;
    _sarhRoot.resolveMissileShotWhy = resolveMissileShotWhy;
    _sarhRoot.classifyFox1SupportWhy = classifyFox1SupportWhy;
    _sarhRoot.stampFox1SupportWhy = stampFox1SupportWhy;
    _sarhRoot.resolveFox1ShotWhy = resolveFox1ShotWhy;
    _sarhRoot.classifyFox2TrackWhy = classifyFox2TrackWhy;
    _sarhRoot.stampFox2TrackWhy = stampFox2TrackWhy;
    _sarhRoot.formatFox1WhyCounts = formatFox1WhyCounts;
    _sarhRoot.formatFox2WhyCounts = formatFox2WhyCounts;
    _sarhRoot.openMissileShot = openMissileShot;
    _sarhRoot.closeMissileShot = closeMissileShot;
    _sarhRoot.summarizeMissileShots = summarizeMissileShots;
    _sarhRoot.applySarhLookJitter = applySarhLookJitter;
    _sarhRoot.segmentHitsSphere = segmentHitsSphere;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        sanitizePylonWeapon,
        sanitizePylonSlot,
        defaultPylonLoadout,
        pylonsForLoadout,
        sanitizePylonLoadout,
        getMissileWeaponConfig,
        pylonWeaponType,
        teamLiveMissileType,
        teamHasFox1InFlight,
        dropConflictingPylonPower,
        computeSarhSupport,
        resolveSarhChaffBreak,
        describeFox1RingMode,
        describeFox1SmsLine,
        describeMissileLaunchRange,
        missileLaunchRangeSms,
        isMissileKillWeapon,
        normalizeMissileShotOutcome,
        fox2MaxLaunchAngleDeg,
        fox2FrontAspectDot,
        fox2FrontLaunchAngleDeg,
        fox2IsFrontAspect,
        fox2LaunchAngleOk,
        fox2ReadLaunchPose,
        fox2SameTurnCommitOk,
        computeMissileLaunchGeometry,
        normalizeMissileShotWhy,
        normalizeFox1ShotWhy,
        normalizeFox2ShotWhy,
        stampMissileShotWhy,
        resolveMissileShotWhy,
        classifyFox1SupportWhy,
        stampFox1SupportWhy,
        resolveFox1ShotWhy,
        classifyFox2TrackWhy,
        stampFox2TrackWhy,
        formatFox1WhyCounts,
        formatFox2WhyCounts,
        openMissileShot,
        closeMissileShot,
        summarizeMissileShots,
        applySarhLookJitter,
        segmentHitsSphere
    };
}
