// ============================================================================
// sarh.js - FOX-1 semi-active radar support gate + chaff / clutter helpers
// ============================================================================

function sanitizePylonWeapon(w) {
    return w === 'fox1' ? 'fox1' : 'fox2';
}

function defaultPylonLoadout() {
    // Standard combat mix: 2×FOX-1 + 2×FOX-2 (inner SARH / outer IR) + gun via SMS.
    return ['fox1', 'fox2', 'fox2', 'fox1'];
}

function sanitizePylonLoadout(arr) {
    const base = defaultPylonLoadout();
    if (!Array.isArray(arr)) return base.slice();
    return base.map((_, i) => sanitizePylonWeapon(arr[i]));
}

function getMissileWeaponConfig(missileType) {
    const type = sanitizePylonWeapon(missileType);
    if (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons[type]) {
        return CONFIG.weapons[type];
    }
    return (CONFIG && CONFIG.weapons && CONFIG.weapons.fox2) ? CONFIG.weapons.fox2 : {};
}

function pylonWeaponType(pylon) {
    if (!pylon) return 'fox2';
    return sanitizePylonWeapon(pylon.weaponType || pylon.weapon || 'fox2');
}

function teamLiveMissileType(team) {
    if (!team || !team.pylons) return null;
    const live = team.pylons.find((p) => p.state === 'armed' || p.state === 'powering');
    return live ? pylonWeaponType(live) : null;
}

/**
 * Drop all powering/armed pylons whose weapon type differs from keepType.
 * @returns {number} count dropped
 */
function dropConflictingPylonPower(team, keepType) {
    if (!team || !team.pylons) return 0;
    const keep = sanitizePylonWeapon(keepType);
    let n = 0;
    team.pylons.forEach((p) => {
        if (p.state !== 'powering' && p.state !== 'armed') return;
        if (pylonWeaponType(p) === keep) return;
        p.state = 'standby';
        n += 1;
    });
    return n;
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

    // CHAFF: illumination LOS through cloud → shrink + flicker (5-turn clouds)
    let flicker = false;
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
            targetPos.distanceTo(c.pos) <= r;
        if (hitCloud) {
            shrink *= gateShrink;
            flicker = true;
            break;
        }
    }

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
    const inGate = offBore <= angle;
    const supported = inRange && inGate && forward.dot(toNorm) > 0.35;

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
        reason: supported ? 'ok' : (!inRange ? 'range' : 'gate')
    };
}

const _sarhRoot = typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : null);
if (_sarhRoot) {
    _sarhRoot.sanitizePylonWeapon = sanitizePylonWeapon;
    _sarhRoot.defaultPylonLoadout = defaultPylonLoadout;
    _sarhRoot.sanitizePylonLoadout = sanitizePylonLoadout;
    _sarhRoot.getMissileWeaponConfig = getMissileWeaponConfig;
    _sarhRoot.pylonWeaponType = pylonWeaponType;
    _sarhRoot.teamLiveMissileType = teamLiveMissileType;
    _sarhRoot.dropConflictingPylonPower = dropConflictingPylonPower;
    _sarhRoot.computeSarhSupport = computeSarhSupport;
    _sarhRoot.applySarhLookJitter = applySarhLookJitter;
    _sarhRoot.segmentHitsSphere = segmentHitsSphere;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        sanitizePylonWeapon,
        defaultPylonLoadout,
        sanitizePylonLoadout,
        getMissileWeaponConfig,
        pylonWeaponType,
        teamLiveMissileType,
        dropConflictingPylonPower,
        computeSarhSupport,
        applySarhLookJitter,
        segmentHitsSphere
    };
}
