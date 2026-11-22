// ============================================================================
// rocket.js — Rocket pod: 9 rnds, 3/turn @ ~1s spacing, VT proximity fuse
// ============================================================================

(function (global) {
    'use strict';

    const Rocket = {};

    function rocketConfig() {
        return (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.rocket)
            ? CONFIG.weapons.rocket
            : {};
    }

    function isRocketType(type) {
        return type === 'rocket';
    }

    function sanitizeFuzeMode(mode) {
        if (mode === 'impact') return 'impact';
        if (mode === 'vt') return 'vt';
        return rocketConfig().defaultFuze === 'impact' ? 'impact' : 'vt';
    }

    function getTeamFuzeMode(team) {
        return sanitizeFuzeMode(team && team.rocketFuze);
    }

    function setTeamFuzeMode(team, mode) {
        if (!team) return 'vt';
        const next = sanitizeFuzeMode(mode);
        team.rocketFuze = next;
        return next;
    }

    function roundsPerPod() {
        const n = Number(rocketConfig().roundsPerPod);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 9;
    }

    function salvoPerTurn() {
        const n = Number(rocketConfig().salvoPerTurn);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 3;
    }

    function intervalSteps() {
        const n = Number(rocketConfig().intervalSteps);
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 33;
    }

    /** Frames before first rocket in a salvo (~1s). */
    function launchDelaySteps() {
        const n = Number(rocketConfig().launchDelaySteps);
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 33;
    }

    function launchStepForIndex(index) {
        return launchDelaySteps() + (Number(index) || 0) * intervalSteps();
    }

    function teamRocketPylons(team) {
        if (!team || !team.pylons) return [];
        return team.pylons.filter((p) => {
            if (!p || p.state === 'empty') return false;
            const wt = (typeof pylonWeaponType === 'function') ? pylonWeaponType(p) : p.weaponType;
            return isRocketType(wt);
        });
    }

    function ensurePodAmmo(pylon) {
        if (!pylon) return 0;
        const max = roundsPerPod();
        if (!Number.isFinite(Number(pylon.ammoMax))) pylon.ammoMax = max;
        if (!Number.isFinite(Number(pylon.ammo))) pylon.ammo = max;
        return Number(pylon.ammo);
    }

    function armRocketPylons(team) {
        teamRocketPylons(team).forEach((p) => {
            ensurePodAmmo(p);
            if (p.ammo <= 0) {
                p.state = 'empty';
                if (p.mesh) p.mesh.visible = false;
                return;
            }
            if (p.state === 'standby' || p.state === 'powering') p.state = 'armed';
        });
    }

    function standbyRocketPylons(team) {
        teamRocketPylons(team).forEach((p) => {
            if (p.state === 'armed' || p.state === 'powering') {
                if (ensurePodAmmo(p) > 0) p.state = 'standby';
            }
        });
    }

    function ensureTeamRockets(team) {
        if (!team.activeRockets) team.activeRockets = [];
        return team.activeRockets;
    }

    /** Integration steps per obstacle ray segment (~5m chord; rocket arc is near-straight at that scale). */
    const OBS_SEG_STEPS = 6;
    const AIM_CACHE_SLOTS = 4;
    const AIM_LINE_MAX_PTS = 256;

    function ballisticKnobs() {
        const cfg = rocketConfig();
        const stepsPerTurn = (typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.stepsPerTurn)
            ? Number(CONFIG.rules.stepsPerTurn) : 100;
        return {
            stepsPerTurn,
            g: ((typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.gravity != null)
                ? Number(CONFIG.rules.gravity) : 9.8)
                * (cfg.gravityScale != null ? Number(cfg.gravityScale) : 0.55),
            drag: cfg.drag != null ? Number(cfg.drag) : 0.002,
            groundY: cfg.groundY != null ? Number(cfg.groundY) : 0,
            substeps: Math.max(1, Math.floor(cfg.substeps != null ? Number(cfg.substeps) : 2)),
            dt: 1 / Math.max(1, stepsPerTurn)
        };
    }

    let _tmp = null;
    function temps() {
        if (!_tmp) {
            _tmp = {
                before: new THREE.Vector3(),
                dir: new THREE.Vector3(),
                fwd: new THREE.Vector3(0, 0, 1)
            };
        }
        return _tmp;
    }

    /** @param {boolean} [skipOldPos] solver loops that never read oldPos skip the clone */
    function integrateRocketFrame(pos, vel, quat, knobs, skipOldPos) {
        const tmp = temps();
        const oldPos = skipOldPos ? null : pos.clone();
        const subDt = knobs.dt / knobs.substeps;
        const dragK = Math.max(0, 1 - knobs.drag * subDt * 60);
        let hitGround = false;
        for (let s = 0; s < knobs.substeps; s++) {
            const bx = pos.x, by = pos.y, bz = pos.z;
            vel.y -= knobs.g * subDt;
            vel.x *= dragK;
            vel.z *= dragK;
            pos.addScaledVector(vel, subDt);
            if (pos.y <= knobs.groundY && by > knobs.groundY) {
                const tHit = Math.max(0, Math.min(1, (by - knobs.groundY) / Math.max(1e-6, (by - pos.y))));
                pos.set(bx + (pos.x - bx) * tHit, knobs.groundY, bz + (pos.z - bz) * tHit);
                hitGround = true;
                break;
            }
        }
        if (quat) {
            const L2 = vel.lengthSq();
            if (L2 > 1e-6) {
                const inv = 1 / Math.sqrt(L2);
                tmp.dir.set(vel.x * inv, vel.y * inv, vel.z * inv);
                quat.setFromUnitVectors(tmp.fwd, tmp.dir);
            }
        }
        return { hitGround, oldPos };
    }

    // Obstacle broadphase: per-building world AABBs, rebuilt only when the obstacle list changes.
    const _obs = { len: -1, first: null, last: null, entries: [], raycaster: null, segBox: null };
    function obstacleEntries() {
        if (typeof obstacles === 'undefined' || !Array.isArray(obstacles) || obstacles.length === 0) return null;
        if (typeof THREE.Box3 !== 'function') return null;
        const first = obstacles[0];
        const last = obstacles[obstacles.length - 1];
        if (_obs.len !== obstacles.length || _obs.first !== first || _obs.last !== last) {
            _obs.entries = [];
            obstacles.forEach((obj) => {
                if (!obj) return;
                if (obj.updateMatrixWorld) obj.updateMatrixWorld(true);
                const box = new THREE.Box3().setFromObject(obj);
                if (!Number.isFinite(box.min.x) || !Number.isFinite(box.max.x)) return;
                _obs.entries.push({ obj, box });
            });
            _obs.len = obstacles.length;
            _obs.first = first;
            _obs.last = last;
        }
        return _obs.entries.length ? _obs.entries : null;
    }

    /**
     * First obstacle hit on segment a→b, or null. Raycasts only buildings whose AABB
     * overlaps the segment AABB — open-air segments cost a handful of box tests.
     */
    function segmentObstacleHit(a, b) {
        const entries = obstacleEntries();
        if (!entries) return null;
        if (!_obs.segBox) _obs.segBox = new THREE.Box3();
        const sb = _obs.segBox;
        sb.min.set(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z));
        sb.max.set(Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z));
        let candidates = null;
        for (let i = 0; i < entries.length; i++) {
            if (entries[i].box.intersectsBox(sb)) {
                if (!candidates) candidates = [];
                candidates.push(entries[i].obj);
            }
        }
        if (!candidates) return null;
        const dir = temps().dir.subVectors(b, a);
        const len = dir.length();
        if (len < 1e-4) return null;
        dir.multiplyScalar(1 / len);
        if (!_obs.raycaster) _obs.raycaster = new THREE.Raycaster();
        const ray = _obs.raycaster;
        ray.set(a, dir);
        ray.near = 0;
        ray.far = len;
        const hits = ray.intersectObjects(candidates, false);
        return hits.length ? hits[0] : null;
    }

    /**
     * Deterministic per-salvo dispersion (yaw/pitch radians about nose).
     * index 0..n-1 → slight left/right + up/down fan so 3 impacts are distinct.
     */
    function dispersionForIndex(index) {
        const cfg = rocketConfig();
        const yawAmp = cfg.aimDispersionYaw != null ? Number(cfg.aimDispersionYaw) : 0.028;
        const pitchAmp = cfg.aimDispersionPitch != null ? Number(cfg.aimDispersionPitch) : 0.018;
        const i = Number(index) || 0;
        // Pattern: center, right-down, left-up (or mirrored for even salvos).
        const pattern = [
            { yaw: 0, pitch: 0 },
            { yaw: yawAmp, pitch: -pitchAmp * 0.6 },
            { yaw: -yawAmp, pitch: pitchAmp * 0.7 }
        ];
        return pattern[i % pattern.length] || { yaw: 0, pitch: 0 };
    }

    /**
     * Launch pose at a point along the planned path (ratio 0..1).
     * Rockets fire mid-turn while the jet flies — each salvo uses its launch ratio.
     * @param {{ ratio?: number, dispersion?: { yaw:number, pitch:number } }} opts
     */
    function estimateLaunchState(team, pylon, opts) {
        const cfg = rocketConfig();
        const scale = cfg.launchSpeedScale != null ? Number(cfg.launchSpeedScale) : 1;
        const baseSpeed = cfg.launchSpeed != null ? Number(cfg.launchSpeed) : 55;
        const stepsPerTurn = (typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.stepsPerTurn)
            ? Number(CONFIG.rules.stepsPerTurn) : 100;
        const ratio = Math.max(0, Math.min(1, Number(opts && opts.ratio) || 0));
        const disp = (opts && opts.dispersion) || { yaw: 0, pitch: 0 };

        let pos;
        let quat;
        let vel;

        if (team.pathPoints && team.pathPoints.length >= 2 && typeof getPosAt === 'function') {
            const eps = 1 / Math.max(8, stepsPerTurn);
            const r0 = ratio;
            const r1 = Math.min(1, ratio + eps);
            const p0 = getPosAt(r0, team.pathPoints);
            const p1 = getPosAt(r1, team.pathPoints);
            pos = p0.clone();
            quat = (team.pathQuats && typeof getQuatAt === 'function')
                ? getQuatAt(r0, team.pathQuats)
                : ((team.wrapper && (team.wrapper.userData && team.wrapper.userData.logicalQuat || team.wrapper.quaternion))
                    || new THREE.Quaternion()).clone();
            // Aircraft velocity at this path point + rocket motor impulse along (dispersed) nose.
            const acVel = new THREE.Vector3().subVectors(p1, p0).multiplyScalar(1 / Math.max(1e-6, (r1 - r0) || eps));
            const aimQuat = quat.clone();
            if (disp.yaw) aimQuat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), disp.yaw));
            if (disp.pitch) aimQuat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), disp.pitch));
            const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(aimQuat);
            vel = acVel.add(fwd.multiplyScalar(baseSpeed * scale));
            quat = aimQuat;
        } else if (team.wrapper) {
            pos = team.wrapper.position.clone();
            quat = (team.wrapper.userData.logicalQuat || team.wrapper.quaternion).clone();
            if (disp.yaw) quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), disp.yaw));
            if (disp.pitch) quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), disp.pitch));
            const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
            vel = fwd.multiplyScalar(baseSpeed * scale);
        } else {
            pos = new THREE.Vector3();
            quat = new THREE.Quaternion();
            vel = new THREE.Vector3(0, 0, baseSpeed * scale);
        }

        if (pylon && pylon.localPosition && pos && quat) {
            // Pylon offset uses airframe attitude (pre-dispersion stored separately — use path quat).
            const bodyQuat = (team.pathQuats && typeof getQuatAt === 'function' && team.pathPoints)
                ? getQuatAt(ratio, team.pathQuats)
                : ((team.wrapper && (team.wrapper.userData && team.wrapper.userData.logicalQuat || team.wrapper.quaternion))
                    || quat).clone();
            pos.add(pylon.localPosition.clone().applyQuaternion(bodyQuat));
            pos.add(new THREE.Vector3(0, -0.05, 0.15).applyQuaternion(bodyQuat));
        }
        return { pos, quat, vel, ratio };
    }

    /**
     * Integrate rocket trajectory for surface impact ('impact') or VT airburst ('vt').
     * Checks ground plane and city building obstacles using contiguous 4-step segments.
     */
    function predictRocketImpact(origin, velocity, quatSeed, opts) {
        const knobs = ballisticKnobs();
        const cfg = rocketConfig();
        const fuze = sanitizeFuzeMode(opts && opts.fuze);
        const vtGround = cfg.vtGroundHeight != null ? Number(cfg.vtGroundHeight) : 3.5;
        const pos = origin.clone();
        const vel = velocity.clone();
        const quat = (quatSeed && quatSeed.clone) ? quatSeed.clone() : new THREE.Quaternion();
        const points = [pos.clone()];
        let impact = null;
        let impactNormal = new THREE.Vector3(0, 1, 0);
        let hitKind = 'air';
        let grounded = false;
        const maxSteps = cfg.maxFlightSteps != null ? Math.min(Number(cfg.maxFlightSteps), 220) : 180;
        const hasObs = !!obstacleEntries();
        let segStart = pos.clone();

        for (let i = 1; i <= maxSteps; i++) {
            const res = integrateRocketFrame(pos, vel, quat, knobs, true);

            if (hasObs && (i % OBS_SEG_STEPS === 0 || res.hitGround || i === maxSteps)) {
                const hit = segmentObstacleHit(segStart, pos);
                if (hit) {
                    impact = hit.point.clone();
                    if (hit.face && hit.object) {
                        impactNormal.copy(hit.face.normal)
                            .transformDirection(hit.object.matrixWorld)
                            .normalize();
                    }
                    points.push(impact.clone());
                    hitKind = 'building';
                    grounded = true;
                    break;
                }
                segStart.copy(pos);
            }

            points.push(pos.clone());

            if (res.hitGround) {
                impact = pos.clone();
                impactNormal.set(0, 1, 0);
                hitKind = 'ground';
                grounded = true;
                break;
            }
            if (fuze === 'vt' && pos.y <= knobs.groundY + vtGround) {
                impact = pos.clone();
                impactNormal.set(0, 1, 0);
                hitKind = 'vt_ground';
                grounded = true;
                break;
            }
        }
        if (!impact) impact = points[points.length - 1].clone();
        return { points, impact, normal: impactNormal, hitKind, grounded };
    }

    function estimateEnemyAtStep(enemy, totalStep, stepsPerTurn) {
        if (!enemy || !enemy.wrapper || enemy.isDestroyed) return null;
        const spt = Math.max(1, Number(stepsPerTurn) || 100);
        const turnDist = Number(enemy.flightLength) || ((Number(enemy.ap) || 120) * 0.015);
        const stepDist = turnDist / spt;
        if (enemy.pathPoints && enemy.pathPoints.length >= 2 && typeof getPosAt === 'function') {
            if (totalStep <= spt) {
                return getPosAt(Math.max(0, totalStep / spt), enemy.pathPoints).clone();
            }
            const n = enemy.pathPoints.length;
            const pEnd = enemy.pathPoints[n - 1];
            const pPrev = enemy.pathPoints[Math.max(0, n - 2)];
            const tan = new THREE.Vector3().subVectors(pEnd, pPrev);
            if (tan.lengthSq() > 1e-8) tan.normalize();
            else tan.set(0, 0, 1).applyQuaternion(enemy.wrapper.quaternion).normalize();
            return pEnd.clone().addScaledVector(tan, (totalStep - spt) * stepDist);
        }
        const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(enemy.wrapper.quaternion).normalize();
        return enemy.wrapper.position.clone().addScaledVector(fwd, Math.max(0, totalStep) * stepDist);
    }

    /**
     * Shared aim solver for both 3D preview and 2D LCOS pipper.
     * - 'vt': simulates airburst corridor against enemy trajectory, CPA, and 6m VT trigger.
     * - 'impact': simulates surface/building impact points and salvo impact centroid.
     */
    function computeRocketAimSolution(team, enemy) {
        if (!team || !team.wrapper || team.isDestroyed) return null;
        const pods = teamRocketPylons(team);
        const armed = pods.filter((p) => p.state === 'armed' && ensurePodAmmo(p) > 0);
        const pod = armed[0] || pods[0];
        if (!pod) return null;

        const fuze = getTeamFuzeMode(team);
        const ammo = ensurePodAmmo(pod);
        const salvo = Math.max(1, Math.min(salvoPerTurn(), ammo > 0 ? ammo : 1));
        const cfg = rocketConfig();
        const knobs = ballisticKnobs();
        const stepsPerTurn = knobs.stepsPerTurn;
        const vtR = cfg.vtRadius != null ? Number(cfg.vtRadius) : 6;
        const blastR = cfg.blastRadius != null ? Number(cfg.blastRadius) : 8;
        const airRange = cfg.range != null ? Number(cfg.range) : 120;
        const fuseDelay = cfg.fuseDelaySteps != null ? Number(cfg.fuseDelaySteps) : 4;
        const liveEnemy = (enemy && enemy.wrapper && !enemy.isDestroyed) ? enemy : null;

        // Lightweight signature cache so 3D preview + 2D HUD share one solve per input state.
        const tp = team.wrapper.position;
        const ep = liveEnemy ? liveEnemy.wrapper.position : null;
        const endPt = (team.pathPoints && team.pathPoints.length)
            ? team.pathPoints[team.pathPoints.length - 1]
            : tp;
        const sig = [
            team.id, fuze, pod.id, salvo,
            tp.x.toFixed(2), tp.y.toFixed(2), tp.z.toFixed(2),
            endPt.x.toFixed(2), endPt.y.toFixed(2), endPt.z.toFixed(2),
            Number(team.joyX || 0).toFixed(3), Number(team.joyY || 0).toFixed(3),
            Number(team.pendingRoll || team.roll || 0).toFixed(3), Number(team.throttle || 4).toFixed(2),
            ep ? `${ep.x.toFixed(2)},${ep.y.toFixed(2)},${ep.z.toFixed(2)},${(liveEnemy.flightLength || 0).toFixed(2)}` : 'noE'
        ].join('|');
        // Multi-slot: HUD lock check, LCOS pipper and 3D preview may solve against different
        // enemy inputs in one frame; a single slot made them evict each other every frame.
        const cache = Rocket._aimCache || (Rocket._aimCache = []);
        for (let c = 0; c < cache.length; c++) {
            if (cache[c].sig === sig) return cache[c].sol;
        }
        const remember = (sol) => {
            cache.unshift({ sig, sol });
            if (cache.length > AIM_CACHE_SLOTS) cache.length = AIM_CACHE_SLOTS;
            return sol;
        };

        const shots = [];
        let anyVtHit = false;

        const enemyMemo = [];
        const enemyAt = (totalStep) => {
            if (!liveEnemy) return null;
            const k = Math.max(0, Math.round(totalStep));
            if (enemyMemo[k] === undefined) enemyMemo[k] = estimateEnemyAtStep(liveEnemy, k, stepsPerTurn);
            return enemyMemo[k];
        };

        if (fuze === 'vt') {
            const hasObs = !!obstacleEntries();
            const vtGround = cfg.vtGroundHeight != null ? Number(cfg.vtGroundHeight) : 3.5;
            const maxAirDist = airRange * 1.15;
            const maxSteps = cfg.maxFlightSteps != null ? Math.min(Number(cfg.maxFlightSteps), 180) : 150;

            for (let i = 0; i < salvo; i++) {
                const launchStep = Math.min(stepsPerTurn, launchStepForIndex(i));
                const ratio = Math.min(1, launchStep / Math.max(1, stepsPerTurn));
                const rel = estimateLaunchState(team, pod, {
                    ratio,
                    dispersion: dispersionForIndex(i)
                });
                const pos = rel.pos.clone();
                const vel = rel.vel.clone();
                const quat = rel.quat.clone();
                const pts = [pos.clone()];
                let flown = 0;
                let segStart = pos.clone();

                // Estimate slant distance from release point to enemy around intercept time.
                const eAtLaunch = enemyAt(launchStep);
                const estFlightSteps = eAtLaunch
                    ? Math.min(90, Math.round(rel.pos.distanceTo(eAtLaunch) / Math.max(0.25, vel.length() * knobs.dt)))
                    : 45;
                const eGuess = enemyAt(launchStep + estFlightSteps);
                const targetSlant = eGuess ? Math.max(12, Math.min(maxAirDist, rel.pos.distanceTo(eGuess))) : 68;

                let cpaDist = Infinity;
                let cpaPos = null;
                let cpaQuat = quat.clone();
                let cpaEnemyPos = null;
                let gatePos = null;
                let gateQuat = quat.clone();
                let gateEnemyPos = null;
                let vtHit = false;

                const prev = temps().before;
                for (let f = 1; f <= maxSteps; f++) {
                    prev.copy(pos);
                    const res = integrateRocketFrame(pos, vel, quat, knobs, true);
                    flown += pos.distanceTo(prev);

                    if (hasObs && (f % OBS_SEG_STEPS === 0 || res.hitGround || f === maxSteps)) {
                        const hit = segmentObstacleHit(segStart, pos);
                        if (hit) {
                            pos.copy(hit.point);
                            pts.push(pos.clone());
                            break;
                        }
                        segStart.copy(pos);
                    }

                    pts.push(pos.clone());

                    const totalStep = launchStep + f;
                    if (!gatePos && flown >= targetSlant) {
                        gatePos = pos.clone();
                        gateQuat = quat.clone();
                        gateEnemyPos = enemyAt(totalStep);
                    }

                    if (liveEnemy && f >= fuseDelay) {
                        const ePos = enemyAt(totalStep);
                        if (ePos) {
                            const d = pos.distanceTo(ePos);
                            if (d < cpaDist) {
                                cpaDist = d;
                                cpaPos = pos.clone();
                                cpaQuat = quat.clone();
                                cpaEnemyPos = ePos.clone();
                            }
                            if (d <= vtR && flown <= maxAirDist) {
                                vtHit = true;
                                anyVtHit = true;
                                cpaDist = d;
                                cpaPos = pos.clone();
                                cpaQuat = quat.clone();
                                cpaEnemyPos = ePos.clone();
                                break;
                            }
                        }
                    }

                    if (res.hitGround || pos.y <= knobs.groundY + vtGround || flown >= maxAirDist) {
                        break;
                    }
                }

                const endPos = pts[pts.length - 1].clone();
                if (!gatePos) {
                    gatePos = endPos.clone();
                    gateQuat = quat.clone();
                    gateEnemyPos = liveEnemy
                        ? estimateEnemyAtStep(liveEnemy, launchStep + pts.length, stepsPerTurn)
                        : null;
                }
                const ringPos = vtHit ? cpaPos : (gatePos || cpaPos || endPos);
                const ringQuat = vtHit ? cpaQuat : (gateQuat || cpaQuat || quat);

                shots.push({
                    launchPos: rel.pos,
                    points: pts,
                    ringPos,
                    ringQuat,
                    vtHit,
                    cpaDist,
                    cpaEnemyPos,
                    gatePos,
                    gateEnemyPos,
                    grounded: true
                });
            }

            const midIdx = Math.floor((shots.length - 1) * 0.5);
            const lead = shots[midIdx] || shots[0];
            const sol = {
                fuze: 'vt',
                salvo,
                ammo,
                vtRadius: vtR,
                blastRadius: blastR,
                rangeMax: airRange,
                anyVtHit,
                aimWorld: lead ? lead.gatePos : null,
                targetEstWorld: lead ? lead.gateEnemyPos : null,
                slantDist: (lead && lead.gatePos) ? lead.launchPos.distanceTo(lead.gatePos) : NaN,
                bestCpaDist: shots.reduce((m, s) => Math.min(m, s.cpaDist), Infinity),
                grounded: true,
                shots
            };
            return remember(sol);
        }

        // IMPACT fuze: true ground / building collision + salvo impact centroid.
        const groundedImpacts = [];
        let hitBuilding = false;
        for (let i = 0; i < salvo; i++) {
            const launchStep = Math.min(stepsPerTurn, launchStepForIndex(i));
            const ratio = Math.min(1, launchStep / Math.max(1, stepsPerTurn));
            const rel = estimateLaunchState(team, pod, {
                ratio,
                dispersion: dispersionForIndex(i)
            });
            const pred = predictRocketImpact(rel.pos, rel.vel, rel.quat, { fuze: 'impact' });
            if (pred.grounded) {
                groundedImpacts.push(pred.impact);
                if (pred.hitKind === 'building') hitBuilding = true;
            }
            const ringQuat = new THREE.Quaternion().setFromUnitVectors(
                new THREE.Vector3(0, 0, 1),
                (pred.normal && pred.normal.lengthSq() > 1e-6) ? pred.normal : new THREE.Vector3(0, 1, 0)
            );
            shots.push({
                launchPos: rel.pos,
                points: pred.points,
                impact: pred.impact,
                normal: pred.normal,
                ringPos: pred.impact,
                ringQuat,
                grounded: pred.grounded,
                hitKind: pred.hitKind
            });
        }

        let centroid = null;
        if (groundedImpacts.length > 0) {
            centroid = new THREE.Vector3();
            groundedImpacts.forEach((p) => centroid.add(p));
            centroid.multiplyScalar(1 / groundedImpacts.length);
        }
        const midShot = shots[Math.floor((shots.length - 1) * 0.5)] || shots[0];
        const slantDist = (centroid && midShot)
            ? midShot.launchPos.distanceTo(centroid)
            : NaN;

        const sol = {
            fuze: 'impact',
            salvo,
            ammo,
            vtRadius: vtR,
            blastRadius: blastR,
            rangeMax: airRange,
            anyVtHit: false,
            aimWorld: centroid,
            targetEstWorld: null,
            slantDist,
            grounded: groundedImpacts.length > 0,
            hitBuilding,
            shots
        };
        return remember(sol);
    }

    function pushRocketExplosionVfx(ctx, step, pos, cfg) {
        if (!ctx || !ctx.log) return;
        if (!ctx.log.vfxTriggers) ctx.log.vfxTriggers = [];
        const exScale = cfg.explosionScale != null ? Number(cfg.explosionScale) : 1.6;
        const flScale = cfg.flashScale != null ? Number(cfg.flashScale) : 2.0;
        const pfScale = cfg.puffScale != null ? Number(cfg.puffScale) : 1.4;
        const sparkN = cfg.sparkCount != null ? Number(cfg.sparkCount) : 48;
        const sparkP = cfg.sparkPower != null ? Number(cfg.sparkPower) : 0.7;
        ctx.log.vfxTriggers.push({
            type: 'explosion', step, pos: pos.clone(),
            rot: Math.random() * Math.PI * 2, scale: exScale
        });
        ctx.log.vfxTriggers.push({
            type: 'flash', step, pos: pos.clone(),
            rot: Math.random() * Math.PI * 2, scale: flScale
        });
        ctx.log.vfxTriggers.push({
            type: 'puff', step, pos: pos.clone().add(new THREE.Vector3(0, 0.25, 0)),
            rot: Math.random() * Math.PI * 2, scale: pfScale
        });
        if (typeof sparkBurstTrigger === 'function') {
            ctx.log.vfxTriggers.push(sparkBurstTrigger(step, pos, sparkN, sparkP, {
                fountain: true,
                wind: new THREE.Vector3(0, 0.25, 0),
                gravity: 0.014,
                life: 16,
                streak: 0.7
            }));
        }
    }

    /** Queue a salvo from the first armed rocket pod that still has ammo. */
    function processRocketSalvos(ctx) {
        if (!ctx || !ctx.log) return;
        const ids = (typeof combatActiveIds === 'function')
            ? combatActiveIds()
            : Object.keys(typeof teams !== 'undefined' ? teams : {});
        const salvoN = salvoPerTurn();

        ids.forEach((id) => {
            const t = teams[id];
            if (!t || t.isDestroyed) return;
            ensureTeamRockets(t);
            ctx.log[`${id}RktTracks`] = ctx.log[`${id}RktTracks`] || {};
            ctx.log[`${id}RktExplodedAt`] = ctx.log[`${id}RktExplodedAt`] || {};

            // Continue in-flight rockets across turns.
            t.activeRockets.forEach((r) => {
                if (!r || r.exploded) return;
                if (!ctx.log[`${id}RktTracks`][r.trackId]) ctx.log[`${id}RktTracks`][r.trackId] = [];
                if (r.active) r.launchStep = -1;
            });
            t.activeRockets = t.activeRockets.filter((r) => r && !r.exploded);

            if (!t.pylons) return;
            if (!(t.wpnQueued && t.weapon === 'rocket' && t.queuedAction === 'rocket')) return;

            const pod = teamRocketPylons(t).find((p) => p.state === 'armed' && ensurePodAmmo(p) > 0);
            if (!pod) {
                t.wpnQueued = false;
                t.queuedAction = 'none';
                return;
            }

            const fuze = getTeamFuzeMode(t);
            const fireCount = Math.min(salvoN, ensurePodAmmo(pod));
            const turn = Math.max(
                1,
                Number((typeof GameContext !== 'undefined' && GameContext.state && GameContext.state.currentTurn) || 1)
            );
            const seqBase = (Number(t._rocketSeq) || 0);
            const stepsPerTurn = (typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.stepsPerTurn)
                ? Number(CONFIG.rules.stepsPerTurn) : 100;
            for (let i = 0; i < fireCount; i++) {
                t._rocketSeq = seqBase + i + 1;
                const trackId = `r${id}_p${pod.id}_t${turn}_${t._rocketSeq}`;
                const launchStep = Math.min(stepsPerTurn, launchStepForIndex(i));
                const rocket = {
                    pylonId: pod.id,
                    trackId,
                    weaponType: 'rocket',
                    active: false,
                    launchStep,
                    launchRatio: Math.min(1, launchStep / Math.max(1, stepsPerTurn)),
                    salvoIndex: i,
                    dispersion: dispersionForIndex(i),
                    ageSteps: 0,
                    pos: new THREE.Vector3(),
                    vel: new THREE.Vector3(),
                    quat: new THREE.Quaternion(),
                    exploded: false,
                    fuze,
                    vt: fuze === 'vt'
                };
                t.activeRockets.push(rocket);
                ctx.log[`${id}RktTracks`][trackId] = [];
                pod.ammo = Math.max(0, ensurePodAmmo(pod) - 1);
            }

            if (pod.ammo <= 0) {
                pod.state = 'empty';
                pod.emptySinceTurn = Math.max(
                    1,
                    Number((typeof GameContext !== 'undefined' && GameContext.state && GameContext.state.currentTurn) || 1)
                );
                // Keep pod mesh visible as empty nest; individual rockets are depleted.
                if (pod.mesh) pod.mesh.visible = true;
                pod.mesh && (pod.mesh.userData.emptyPod = true);
            }

            t.wpnQueued = false;
            t.queuedAction = 'none';
        });
    }

    function checkVtFuse(rocket, step, ratio, shooterId, knobs) {
        const cfg = rocketConfig();
        const fuseDelay = cfg.fuseDelaySteps != null ? Number(cfg.fuseDelaySteps) : 4;
        if (rocket.launchStep >= 0 && step < rocket.launchStep + fuseDelay) return null;
        if (rocket.launchStep < 0 && (Number(rocket.ageSteps) || 0) < fuseDelay) return null;

        const vtR = cfg.vtRadius != null ? Number(cfg.vtRadius) : 6;
        const vtGround = cfg.vtGroundHeight != null ? Number(cfg.vtGroundHeight) : 3.5;

        // Airburst near ground.
        if (rocket.pos.y <= knobs.groundY + vtGround) {
            return { reason: 'vt_ground', victimId: null };
        }

        const ids = (typeof combatActiveIds === 'function')
            ? combatActiveIds()
            : Object.keys(typeof teams !== 'undefined' ? teams : {});
        let best = null;
        let bestD = vtR;
        ids.forEach((vid) => {
            if (vid === shooterId) return;
            const vt = teams[vid];
            if (!vt || vt.isDestroyed || !vt.pathPoints) return;
            const vPos = (typeof getPosAt === 'function')
                ? getPosAt(ratio, vt.pathPoints)
                : (vt.wrapper && vt.wrapper.position);
            if (!vPos) return;
            const d = rocket.pos.distanceTo(vPos);
            if (d <= bestD) {
                bestD = d;
                best = { reason: 'vt_prox', victimId: vid };
            }
        });
        return best;
    }

    function resolveRocketsForStep(step, ratio, ctx) {
        if (!ctx || !ctx.log) return;
        const cfg = rocketConfig();
        const blastR = cfg.blastRadius != null ? Number(cfg.blastRadius) : 8;
        const damage = cfg.damage != null ? Number(cfg.damage) : 45;
        const maxFlight = cfg.maxFlightSteps != null ? Number(cfg.maxFlightSteps) : 220;
        const knobs = ballisticKnobs();
        const ids = (typeof combatActiveIds === 'function')
            ? combatActiveIds()
            : Object.keys(typeof teams !== 'undefined' ? teams : {});

        ids.forEach((id) => {
            const t = teams[id];
            if (!t || !t.activeRockets || !t.activeRockets.length) return;
            const tracks = ctx.log[`${id}RktTracks`] = ctx.log[`${id}RktTracks`] || {};
            const explodedAt = ctx.log[`${id}RktExplodedAt`] = ctx.log[`${id}RktExplodedAt`] || {};

            t.activeRockets.forEach((r) => {
                if (r.exploded) {
                    if (tracks[r.trackId]) tracks[r.trackId].push(null);
                    return;
                }
                if (!r.active) {
                    if (step < r.launchStep) {
                        if (!tracks[r.trackId]) tracks[r.trackId] = [];
                        tracks[r.trackId].push(null);
                        return;
                    }
                    if (step === r.launchStep) {
                        r.active = true;
                        const pylon = (t.pylons || []).find((p) => p.id === r.pylonId);
                        const launchRatio = (r.launchRatio != null)
                            ? Number(r.launchRatio)
                            : ratio;
                        const rel = estimateLaunchState(t, pylon, {
                            ratio: launchRatio,
                            dispersion: r.dispersion || dispersionForIndex(r.salvoIndex || 0)
                        });
                        r.pos.copy(rel.pos);
                        r.quat.copy(rel.quat);
                        r.vel.copy(rel.vel);
                        r.ageSteps = 0;
                        if (!tracks[r.trackId]) tracks[r.trackId] = [];
                        tracks[r.trackId].push({ pos: r.pos.clone(), quat: r.quat.clone() });
                        return;
                    }
                }

                const integ = integrateRocketFrame(r.pos, r.vel, r.quat, knobs);
                r.ageSteps = (Number(r.ageSteps) || 0) + 1;

                let hitSolid = integ.hitGround;
                if (!hitSolid) {
                    const hit = segmentObstacleHit(integ.oldPos, r.pos);
                    if (hit) {
                        r.pos.copy(hit.point);
                        hitSolid = true;
                    }
                }

                if (!tracks[r.trackId]) tracks[r.trackId] = [];
                tracks[r.trackId].push({ pos: r.pos.clone(), quat: r.quat.clone() });

                let fuse = hitSolid ? { reason: 'impact', victimId: null } : null;
                if (!fuse) {
                    const rFuze = r.fuze ? sanitizeFuzeMode(r.fuze) : (r.vt === false ? 'impact' : 'vt');
                    if (rFuze === 'vt') {
                        fuse = checkVtFuse(r, step, ratio, id, knobs);
                    } else {
                        // Impact fuze: no proximity or ground-height airburst; only direct body hit.
                        const directR = cfg.impactDirectRadius != null ? Number(cfg.impactDirectRadius) : 1.8;
                        const fuseDelay = cfg.fuseDelaySteps != null ? Number(cfg.fuseDelaySteps) : 4;
                        const armedStep = (r.launchStep >= 0) ? (step >= r.launchStep + fuseDelay) : ((Number(r.ageSteps) || 0) >= fuseDelay);
                        if (armedStep) {
                            ids.forEach((vid) => {
                                if (fuse || vid === id) return;
                                const vt = teams[vid];
                                if (!vt || vt.isDestroyed || !vt.pathPoints) return;
                                const vPos = (typeof getPosAt === 'function')
                                    ? getPosAt(ratio, vt.pathPoints)
                                    : (vt.wrapper && vt.wrapper.position);
                                if (vPos && r.pos.distanceTo(vPos) <= directR) {
                                    fuse = { reason: 'impact_direct', victimId: vid };
                                }
                            });
                        }
                    }
                }
                if (!fuse && r.ageSteps >= maxFlight) fuse = { reason: 'timeout', victimId: null };

                if (fuse) {
                    r.exploded = true;
                    explodedAt[r.trackId] = step;
                    pushRocketExplosionVfx(ctx, step, r.pos, cfg);
                    if (typeof AirArenaGroundTargets !== 'undefined'
                        && typeof AirArenaGroundTargets.applyBlastDamage === 'function') {
                        const gtHits = AirArenaGroundTargets.applyBlastDamage(r.pos, blastR, damage, {
                            ownerId: id, weapon: 'rocket'
                        });
                        if (gtHits.length) {
                            ctx.log.groundTargetHits = ctx.log.groundTargetHits || [];
                            gtHits.forEach((h) => ctx.log.groundTargetHits.push({
                                step, ownerId: id, weapon: 'rocket', ...h
                            }));
                        }
                    }

                    const applyBlast = (vid) => {
                        const vt = teams[vid];
                        if (!vt || vt.isDestroyed || !vt.pathPoints) return;
                        const vPos = (typeof getPosAt === 'function')
                            ? getPosAt(ratio, vt.pathPoints)
                            : (vt.wrapper && vt.wrapper.position);
                        if (!vPos) return;
                        if (r.pos.distanceTo(vPos) <= blastR) {
                            if (ctx.hp[vid] != null) {
                                ctx.hp[vid] = Math.max(0, ctx.hp[vid] - damage);
                                if (ctx.log.hpTrack && ctx.log.hpTrack[vid]) {
                                    ctx.log.hpTrack[vid][step] = (ctx.log.hpTrack[vid][step] || 0) + damage;
                                }
                            }
                        }
                    };
                    if (fuse.victimId) applyBlast(fuse.victimId);
                    ids.forEach((vid) => {
                        if (vid === fuse.victimId) return;
                        applyBlast(vid);
                    });
                }
            });
            t.activeRockets = t.activeRockets.filter((r) => r && !r.exploded);
        });
    }

    function sparkMap() {
        return (typeof window !== 'undefined' && window.sparkTexShared) ? window.sparkTexShared : null;
    }

    function trailMat() {
        if (typeof window !== 'undefined' && window.mslTrailMatShared) {
            return window.mslTrailMatShared.clone();
        }
        return new THREE.MeshBasicMaterial({
            color: 0xff8844, transparent: true, opacity: 0.7,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, vertexColors: true
        });
    }

    /** Missile-style nozzle plume. Plume extends −Z; place group at aft tip. */
    function createRocketExhaustGlow(nozzleLocal) {
        const map = sparkMap();
        const g = new THREE.Group();
        g.name = 'rocketExhaust';
        const mk = (w, h, color, opacity) => {
            const geo = new THREE.PlaneGeometry(w, h);
            geo.translate(0, -h * 0.5, 0);
            geo.rotateX(Math.PI / 2); // local −Y → −Z (aft)
            const mat = new THREE.MeshBasicMaterial({
                map: map || undefined,
                color,
                transparent: true,
                opacity,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide
            });
            const a = new THREE.Mesh(geo, mat);
            const b = new THREE.Mesh(geo, mat.clone());
            b.rotateZ(Math.PI / 2);
            return [a, b];
        };
        const outer = mk(0.12, 0.7, 0xff4400, 0.85);
        const inner = mk(0.05, 0.32, 0xffffff, 1.0);
        const halo = new THREE.Mesh(
            new THREE.PlaneGeometry(0.32, 0.32),
            new THREE.MeshBasicMaterial({
                map: map || undefined,
                color: 0xff8800,
                transparent: true,
                opacity: 0.9,
                blending: THREE.AdditiveBlending,
                depthWrite: false,
                side: THREE.DoubleSide
            })
        );
        halo.name = 'halo';
        g.add(outer[0], outer[1], inner[0], inner[1], halo);
        if (nozzleLocal && nozzleLocal.isVector3) g.position.copy(nozzleLocal);
        else if (nozzleLocal && typeof nozzleLocal.z === 'number') {
            g.position.set(nozzleLocal.x || 0, nozzleLocal.y || 0, nozzleLocal.z);
        } else {
            g.position.set(0, 0, -0.18);
        }
        return g;
    }

    function paintRocketBodyWhite(body) {
        if (!body) return;
        body.traverse((c) => {
            if (!c.isMesh || !c.material) return;
            const mats = Array.isArray(c.material) ? c.material : [c.material];
            const next = mats.map((m) => {
                const nm = m.clone ? m.clone() : m;
                if (nm.color && nm.color.setHex) nm.color.setHex(0xffffff);
                if (nm.metalness != null) nm.metalness = Math.min(Number(nm.metalness) || 0.2, 0.35);
                if (nm.roughness != null) nm.roughness = Math.max(Number(nm.roughness) || 0.45, 0.4);
                return nm;
            });
            c.material = Array.isArray(c.material) ? next : next[0];
        });
    }

    /** Thick ribbon smoke trail (same technique as FOX missiles). */
    function createRocketSmokeTrail(maxPts) {
        const n = Math.max(8, maxPts || 48);
        const tGeo = new THREE.BufferGeometry();
        tGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
        tGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 2 * 3), 3));
        tGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2 * 2), 2));
        const indices = [];
        for (let i = 0; i < n - 1; i++) {
            indices.push(i * 2, i * 2 + 1, i * 2 + 2);
            indices.push(i * 2 + 2, i * 2 + 1, i * 2 + 3);
        }
        tGeo.setIndex(indices);
        const mesh = new THREE.Mesh(tGeo, trailMat());
        mesh.frustumCulled = false;
        mesh.userData.maxPts = n;
        mesh.visible = false;
        return mesh;
    }

    function buildFlyingRocketMesh() {
        const cfg = rocketConfig();
        const bodyScale = cfg.flightBodyScale != null ? Number(cfg.flightBodyScale) : 0.833;
        const root = new THREE.Group();
        root.name = 'flyingRocket';

        let body;
        if (typeof missileMeshBase !== 'undefined' && missileMeshBase) {
            body = missileMeshBase.clone();
            body.traverse((c) => { if (c.isMesh) c.visible = true; });
            body.scale.set(bodyScale, bodyScale, bodyScale);
            paintRocketBodyWhite(body);
        } else if (typeof rocketMeshBase !== 'undefined' && rocketMeshBase) {
            body = rocketMeshBase.clone();
            body.scale.multiplyScalar(0.5);
            paintRocketBodyWhite(body);
        } else {
            body = new THREE.Mesh(
                new THREE.CylinderGeometry(0.03, 0.04, 0.4, 6),
                new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.25, roughness: 0.45 })
            );
            body.rotation.x = Math.PI / 2;
        }
        root.add(body);
        root.updateMatrixWorld(true);
        const nozzle = (typeof computeAftNozzleLocal === 'function')
            ? computeAftNozzleLocal(body, root, 0.02)
            : new THREE.Vector3(0, 0, -0.18);
        root.userData.body = body;
        root.userData.bodyPaintedWhite = true;
        root.userData.nozzleOffset = nozzle.clone();
        root.userData.glow = createRocketExhaustGlow(nozzle);
        root.add(root.userData.glow);
        root.userData.smoke = createRocketSmokeTrail(cfg.flightTrailPts != null ? Number(cfg.flightTrailPts) : 48);
        return root;
    }

    function updateRocketSmokeRibbon(smoke, arr, step, quat, nozzleLocal) {
        if (!smoke || !arr || typeof camera === 'undefined') return;
        const maxPts = smoke.userData.maxPts || 48;
        const posArr = smoke.geometry.attributes.position.array;
        const colArr = smoke.geometry.attributes.color.array;
        const uvArr = smoke.geometry.attributes.uv.array;
        let valid = 0;
        const nozzle = nozzleLocal || new THREE.Vector3(0, 0, -0.18);
        for (let h = 0; h < maxPts; h++) {
            const past = step - h;
            const tr = past >= 0 ? arr[past] : null;
            if (!(tr && tr.pos && tr.quat)) break;
            const q = tr.quat;
            const nozzlePos = tr.pos.clone().add(nozzle.clone().applyQuaternion(q));
            const life = h / maxPts;
            const width = 0.03 + life * 0.9;
            const toCam = new THREE.Vector3().subVectors(camera.position, nozzlePos).normalize();
            const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize();
            let right = new THREE.Vector3().crossVectors(fwd, toCam);
            if (right.lengthSq() < 1e-6) right.set(1, 0, 0).applyQuaternion(q);
            right.normalize().multiplyScalar(width);
            const L = nozzlePos.clone().add(right);
            const R = nozzlePos.clone().sub(right);
            const idx = valid * 2;
            posArr[idx * 3] = L.x; posArr[idx * 3 + 1] = L.y; posArr[idx * 3 + 2] = L.z;
            posArr[idx * 3 + 3] = R.x; posArr[idx * 3 + 4] = R.y; posArr[idx * 3 + 5] = R.z;
            const intensity = Math.pow(1.0 - life, 1.6);
            const r = intensity; const g = intensity * 0.85; const b = intensity * 0.7;
            colArr[idx * 3] = r; colArr[idx * 3 + 1] = g; colArr[idx * 3 + 2] = b;
            colArr[idx * 3 + 3] = r; colArr[idx * 3 + 4] = g; colArr[idx * 3 + 5] = b;
            uvArr[idx * 2] = 0; uvArr[idx * 2 + 1] = life;
            uvArr[idx * 2 + 2] = 1; uvArr[idx * 2 + 3] = life;
            valid++;
        }
        if (valid > 1) {
            smoke.geometry.setDrawRange(0, (valid - 1) * 6);
            smoke.geometry.attributes.position.needsUpdate = true;
            smoke.geometry.attributes.color.needsUpdate = true;
            smoke.geometry.attributes.uv.needsUpdate = true;
            smoke.visible = true;
        } else {
            smoke.visible = false;
        }
    }

    /** Pod muzzle flame — inside nest, slightly protruding aft (−Z). */
    function ensurePodMuzzleFlame(pylon) {
        if (!pylon || !pylon.mesh) return null;
        // Drop legacy flames that used belly (−Y) offset or extra rotateX.
        if (pylon.podFlame && (!pylon.podFlame.userData.aftAligned || !pylon.podFlame.parent)) {
            if (pylon.podFlame.parent) pylon.podFlame.parent.remove(pylon.podFlame);
            pylon.podFlame = null;
        }
        if (pylon.podFlame && pylon.podFlame.parent) return pylon.podFlame;
        const cfg = rocketConfig();
        const aft = new THREE.Vector3(
            0,
            cfg.podFlameOffsetY != null ? Number(cfg.podFlameOffsetY) : -0.02,
            cfg.podFlameOffsetZ != null ? Number(cfg.podFlameOffsetZ) : -0.14
        );
        const flame = createRocketExhaustGlow(aft);
        flame.name = 'podMuzzleFlame';
        flame.userData.aftAligned = true;
        flame.scale.set(0.7, 0.7, 0.85);
        flame.visible = false;
        pylon.mesh.add(flame);
        pylon.podFlame = flame;
        return flame;
    }

    function setPodFlameIntensity(flame, intensity) {
        if (!flame) return;
        const on = intensity > 0.02;
        flame.visible = on;
        if (!on) return;
        const pulse = 0.75 + Math.random() * 0.45;
        flame.scale.set(0.55 * pulse * intensity, 0.55 * pulse * intensity, 0.7 + 0.5 * intensity);
        flame.traverse((c) => {
            if (c.isMesh && c.material && c.material.opacity != null && c.name !== 'halo') {
                // leave base mats; scale handles punch
            }
        });
    }

    function syncPodMuzzleFlames(step, log, previewLit) {
        if (typeof teams === 'undefined') return;
        const ids = (typeof combatActiveIds === 'function') ? combatActiveIds() : Object.keys(teams);
        ids.forEach((id) => {
            const t = teams[id];
            if (!t || !t.pylons) return;
            teamRocketPylons(t).forEach((p) => {
                const flame = ensurePodMuzzleFlame(p);
                if (!flame) return;
                let intensity = 0;
                if (previewLit && t.weapon === 'rocket' && t.wpnQueued && t.queuedAction === 'rocket' && p.state === 'armed') {
                    intensity = 0.45 + 0.25 * Math.sin(Date.now() * 0.02);
                }
                if (log) {
                    const tracks = log[`${id}RktTracks`] || {};
                    Object.keys(tracks).forEach((tid) => {
                        // trackId encodes pylon: r{id}_p{pylonId}_…
                        if (tid.indexOf(`_p${p.id}_`) < 0) return;
                        const arr = tracks[tid];
                        // Bright flash around launch frames.
                        for (let d = 0; d <= 4; d++) {
                            const s = step - d;
                            if (s < 0) continue;
                            const cur = arr[s];
                            const prev = s > 0 ? arr[s - 1] : null;
                            if (cur && cur.pos && !(prev && prev.pos)) {
                                intensity = Math.max(intensity, 1.2 - d * 0.2);
                            }
                        }
                    });
                    // Also use live activeRockets launchStep.
                    (t.activeRockets || []).forEach((rk) => {
                        if (!rk || rk.pylonId !== p.id) return;
                        if (rk.launchStep >= 0 && Math.abs(step - rk.launchStep) <= 4) {
                            intensity = Math.max(intensity, 1.15 - Math.abs(step - rk.launchStep) * 0.2);
                        }
                    });
                }
                setPodFlameIntensity(flame, intensity);
            });
        });
    }

    function applyRocketVisuals(step, log) {
        if (!log || typeof teams === 'undefined' || typeof scene === 'undefined') return;
        if (!Rocket._flightMeshes) Rocket._flightMeshes = {};

        const ids = (typeof combatActiveIds === 'function')
            ? combatActiveIds()
            : Object.keys(teams);

        Object.keys(Rocket._flightMeshes).forEach((key) => {
            const m = Rocket._flightMeshes[key];
            if (m) m.visible = false;
            if (m && m.userData.smoke) m.userData.smoke.visible = false;
        });

        ids.forEach((id) => {
            const tracks = log[`${id}RktTracks`] || {};
            const explodedAt = log[`${id}RktExplodedAt`] || {};
            Object.keys(tracks).forEach((trackId) => {
                const arr = tracks[trackId];
                const tr = arr && arr[step];
                const boomAt = explodedAt[trackId];
                if (!(tr && tr.pos && (boomAt == null || step < boomAt))) return;

                let mesh = Rocket._flightMeshes[trackId];
                // Rebuild pre-aft / pre-white meshes.
                if (mesh && (!mesh.userData.nozzleOffset || !mesh.userData.bodyPaintedWhite)) {
                    scene.remove(mesh);
                    if (mesh.userData.smoke) scene.remove(mesh.userData.smoke);
                    delete Rocket._flightMeshes[trackId];
                    mesh = null;
                }
                if (!mesh) {
                    mesh = buildFlyingRocketMesh();
                    scene.add(mesh);
                    if (mesh.userData.smoke) scene.add(mesh.userData.smoke);
                    Rocket._flightMeshes[trackId] = mesh;
                }
                mesh.position.copy(tr.pos);
                if (tr.quat) mesh.quaternion.copy(tr.quat);
                mesh.visible = true;

                const glow = mesh.userData.glow;
                if (glow) {
                    const pulseXY = 0.85 + Math.random() * 0.25;
                    const pulseZ = 0.75 + Math.random() * 0.45;
                    glow.scale.set(pulseXY, pulseXY, pulseZ);
                    const halo = glow.children.find((c) => c.name === 'halo');
                    if (halo && typeof camera !== 'undefined') {
                        const invQ = mesh.quaternion.clone().invert();
                        halo.quaternion.copy(invQ.multiply(camera.quaternion));
                    }
                }
                if (mesh.userData.smoke) {
                    const nozzleLocal = mesh.userData.nozzleOffset || new THREE.Vector3(0, 0, -0.18);
                    updateRocketSmokeRibbon(mesh.userData.smoke, arr, step, tr.quat, nozzleLocal);
                }
            });
        });

        syncPodMuzzleFlames(step, log, false);
    }

    /** Every other trajectory point into the slot's preallocated buffer (no per-frame geometry churn). */
    function writeAimLine(line, shot) {
        const attr = line.geometry.getAttribute('position');
        const arr = attr.array;
        const pts = shot.points || [];
        const last = pts.length - 1;
        let n = 0;
        const put = (p) => {
            if (n >= AIM_LINE_MAX_PTS || !p) return;
            arr[n * 3] = p.x; arr[n * 3 + 1] = p.y; arr[n * 3 + 2] = p.z;
            n++;
        };
        const stride = Math.max(2, Math.ceil(pts.length / (AIM_LINE_MAX_PTS - 1)));
        for (let k = 0; k < last; k += stride) put(pts[k]);
        if (last >= 0) put(pts[last]);
        if (n < 2 && shot.ringPos) {
            n = 0;
            put(shot.launchPos);
            put(shot.ringPos);
        }
        attr.needsUpdate = true;
        line.geometry.setDrawRange(0, n);
    }

    function ensureAimVisuals(count) {
        if (typeof scene === 'undefined' || !scene) return null;
        if (!Rocket._aimGroup) {
            Rocket._aimGroup = new THREE.Group();
            Rocket._aimGroup.name = 'rocketAimPreview';
            Rocket._aimSlots = [];
            scene.add(Rocket._aimGroup);
        }
        if (!Rocket._aimDiscGeo) Rocket._aimDiscGeo = new THREE.CircleGeometry(1, 40);
        while (Rocket._aimSlots.length < count) {
            const color = 0xff9966;
            const lineGeo = new THREE.BufferGeometry();
            lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(AIM_LINE_MAX_PTS * 3), 3));
            lineGeo.setDrawRange(0, 0);
            const line = new THREE.Line(
                lineGeo,
                new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.78 })
            );
            line.frustumCulled = false;
            // Unit-radius translucent disc in XY plane (+Z normal) — scaled to vtRadius (6m) or blastRadius (8m).
            const ring = new THREE.Mesh(
                Rocket._aimDiscGeo,
                new THREE.MeshBasicMaterial({
                    color, transparent: true, opacity: 0.3,
                    side: THREE.DoubleSide, depthWrite: false,
                    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
                })
            );
            ring.renderOrder = 2;
            // Surface impact cross (XY plane, aligned with ring normal)
            const cross = new THREE.LineSegments(
                new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(-1.4, 0, 0.03),
                    new THREE.Vector3(1.4, 0, 0.03),
                    new THREE.Vector3(0, -1.4, 0.03),
                    new THREE.Vector3(0, 1.4, 0.03)
                ]),
                new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 })
            );
            // Release pip along aircraft path
            const pip = new THREE.Mesh(
                new THREE.SphereGeometry(0.05, 8, 8),
                new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 })
            );
            Rocket._aimGroup.add(line, ring, cross, pip);
            Rocket._aimSlots.push({ line, ring, cross, pip });
        }
        return Rocket._aimGroup;
    }

    /**
     * Dual-fuze 3D preview:
     * - VT (air-to-air): cyan/red airburst trajectories + upright 6m VT proximity rings.
     * - IMPACT (surface): orange trajectories to ground/buildings + 8m surface blast rings & crosses.
     */
    function updateRocketAimPreview(team) {
        if (!team || team.weapon !== 'rocket' || team.isDestroyed) {
            hideRocketAimPreview();
            return;
        }
        if (typeof GameContext !== 'undefined' && (GameContext.isAnimating() || GameContext.isReplayMode())) {
            hideRocketAimPreview();
            return;
        }
        const enemy = (typeof combatEnemyOf === 'function')
            ? combatEnemyOf(team.id)
            : null;
        const sol = computeRocketAimSolution(team, enemy);
        if (!sol || !sol.shots || !sol.shots.length) {
            hideRocketAimPreview();
            return;
        }
        if (sol.ammo <= 0) {
            hideRocketAimPreview();
            return;
        }

        const grp = ensureAimVisuals(Math.max(sol.shots.length, 3));
        if (!grp) return;
        if (Rocket._previewSol === sol && grp.visible) {
            syncPodMuzzleFlames(0, null, true);
            return;
        }
        Rocket._previewSol = sol;

        const isVt = sol.fuze === 'vt';
        const vtColors = [0x4dd0e1, 0x80deea, 0x26c6da];
        const impColors = [0xff9966, 0xffbb66, 0xff7755];

        for (let i = 0; i < Rocket._aimSlots.length; i++) {
            const slot = Rocket._aimSlots[i];
            const shot = sol.shots[i];
            const show = !!shot;
            slot.line.visible = show;
            slot.ring.visible = show;
            slot.cross.visible = false;
            slot.pip.visible = show;
            if (!show) continue;

            writeAimLine(slot.line, shot);
            slot.pip.position.copy(shot.launchPos);

            if (isVt) {
                const col = shot.vtHit ? 0xff0055 : vtColors[i % vtColors.length];
                slot.line.material.color.setHex(col);
                slot.line.material.opacity = shot.vtHit ? 0.95 : 0.68;
                slot.pip.material.color.setHex(col);
                slot.ring.material.color.setHex(col);
                slot.ring.material.opacity = shot.vtHit ? 0.38 : 0.16;
                slot.ring.scale.setScalar(sol.vtRadius);
                if (shot.ringPos) slot.ring.position.copy(shot.ringPos);
                if (shot.ringQuat) slot.ring.quaternion.copy(shot.ringQuat);
                slot.cross.visible = false;
            } else {
                const col = impColors[i % impColors.length];
                slot.line.material.color.setHex(col);
                slot.line.material.opacity = 0.8;
                slot.pip.material.color.setHex(col);
                slot.ring.visible = !!shot.grounded;
                slot.cross.visible = !!shot.grounded;
                if (shot.grounded && shot.ringPos) {
                    const lift = (shot.normal || new THREE.Vector3(0, 1, 0)).clone().multiplyScalar(0.06 + i * 0.01);
                    slot.ring.position.copy(shot.ringPos).add(lift);
                    slot.ring.quaternion.copy(shot.ringQuat);
                    slot.ring.scale.setScalar(sol.blastRadius);
                    slot.ring.material.color.setHex(col);
                    slot.ring.material.opacity = 0.26;
                    slot.cross.position.copy(shot.ringPos).add(lift);
                    slot.cross.quaternion.copy(shot.ringQuat);
                    slot.cross.material.color.setHex(col);
                }
            }
        }
        grp.visible = true;

        // Preview: idle glow in pod when rocket mode / queued salvo.
        syncPodMuzzleFlames(0, null, true);
    }

    function hideRocketAimPreview() {
        Rocket._previewSol = null;
        if (Rocket._aimGroup) Rocket._aimGroup.visible = false;
        // Dim pod flames when leaving rocket aim.
        if (typeof teams !== 'undefined') {
            const ids = (typeof combatActiveIds === 'function') ? combatActiveIds() : Object.keys(teams);
            ids.forEach((id) => {
                const t = teams[id];
                if (!t || !t.pylons) return;
                teamRocketPylons(t).forEach((p) => {
                    if (p.podFlame) setPodFlameIntensity(p.podFlame, 0);
                });
            });
        }
    }

    /** Hide or dispose in-flight rocket meshes/ribbons (replay exit or match reset). */
    function clearRocketVisuals(opts) {
        const dispose = !!(opts && opts.dispose);
        Rocket._aimCache = null;
        hideRocketAimPreview();
        if (!Rocket._flightMeshes) return;
        Object.keys(Rocket._flightMeshes).forEach((key) => {
            const m = Rocket._flightMeshes[key];
            if (!m) return;
            const smoke = m.userData && m.userData.smoke;
            if (dispose) {
                if (m.parent) m.parent.remove(m);
                if (smoke) {
                    if (smoke.parent) smoke.parent.remove(smoke);
                    if (smoke.geometry) smoke.geometry.dispose();
                    if (smoke.material) smoke.material.dispose();
                }
                delete Rocket._flightMeshes[key];
            } else {
                m.visible = false;
                if (smoke) smoke.visible = false;
            }
        });
    }

    Rocket.isRocketType = isRocketType;
    Rocket.sanitizeFuzeMode = sanitizeFuzeMode;
    Rocket.getTeamFuzeMode = getTeamFuzeMode;
    Rocket.setTeamFuzeMode = setTeamFuzeMode;
    Rocket.teamRocketPylons = teamRocketPylons;
    Rocket.ensurePodAmmo = ensurePodAmmo;
    Rocket.roundsPerPod = roundsPerPod;
    Rocket.salvoPerTurn = salvoPerTurn;
    Rocket.intervalSteps = intervalSteps;
    Rocket.launchDelaySteps = launchDelaySteps;
    Rocket.launchStepForIndex = launchStepForIndex;
    Rocket.armRocketPylons = armRocketPylons;
    Rocket.standbyRocketPylons = standbyRocketPylons;
    Rocket.predictRocketImpact = predictRocketImpact;
    Rocket.computeRocketAimSolution = computeRocketAimSolution;
    Rocket.processRocketSalvos = processRocketSalvos;
    Rocket.resolveRocketsForStep = resolveRocketsForStep;
    Rocket.applyRocketVisuals = applyRocketVisuals;
    Rocket.updateRocketAimPreview = updateRocketAimPreview;
    Rocket.hideRocketAimPreview = hideRocketAimPreview;
    Rocket.clearRocketVisuals = clearRocketVisuals;
    Rocket.syncPodMuzzleFlames = syncPodMuzzleFlames;
    Rocket.buildFlyingRocketMesh = buildFlyingRocketMesh;

    global.AirArenaRocket = Rocket;
    if (typeof GameContext !== 'undefined' && GameContext.registerService) {
        GameContext.registerService('processRocketSalvos', processRocketSalvos);
        GameContext.registerService('resolveRocketsForStep', resolveRocketsForStep);
        GameContext.registerService('applyRocketVisuals', applyRocketVisuals);
        GameContext.registerService('updateRocketAimPreview', updateRocketAimPreview);
    }
})(typeof window !== 'undefined' ? window : globalThis);
