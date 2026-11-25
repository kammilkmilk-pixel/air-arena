// ============================================================================
// bomb.js — Phase B unguided bomb: ballistic path, CCIP preview, SMS release
// (Human path first; AI decide / ground-target schema deferred.)
// ============================================================================

(function (global) {
    'use strict';

    const Bomb = {
        _previewGroup: null,
        _previewLine: null,
        _previewLineCapacity: 0,
        _previewImpact: null,
        _previewHud: null,
        _previewSig: '',
        _lastPreviewPath: null
    };

    function bombConfig() {
        if (typeof CONFIG !== 'undefined' && CONFIG && typeof CONFIG.getBombConfig === 'function') {
            return CONFIG.getBombConfig();
        }
        const w = (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.bomb)
            ? CONFIG.weapons.bomb
            : {};
        return w;
    }

    function bombBlastRadius(cfg) {
        if (cfg && cfg.blastRadius != null && Number.isFinite(Number(cfg.blastRadius))) {
            return Number(cfg.blastRadius);
        }
        if (typeof CONFIG !== 'undefined' && CONFIG && typeof CONFIG.getBombBlastRadius === 'function') {
            return CONFIG.getBombBlastRadius();
        }
        return 10;
    }

    function isBombType(type) {
        return type === 'bomb';
    }

    function isA2GStoreType(type) {
        return type === 'bomb' || type === 'rocket';
    }

    function teamBombPylons(team) {
        if (!team || !team.pylons) return [];
        return team.pylons.filter((p) => {
            if (!p || p.state === 'empty') return false;
            const wt = (typeof pylonWeaponType === 'function') ? pylonWeaponType(p) : p.weaponType;
            return isBombType(wt);
        });
    }

    function armBombPylons(team) {
        teamBombPylons(team).forEach((p) => {
            if (p.state === 'standby' || p.state === 'powering') p.state = 'armed';
        });
    }

    function standbyBombPylons(team) {
        teamBombPylons(team).forEach((p) => {
            if (p.state === 'armed' || p.state === 'powering') p.state = 'standby';
        });
    }

    function ballisticKnobs(opts) {
        const cfg = bombConfig();
        const o = opts || {};
        const stepsPerTurn = (typeof CONFIG !== 'undefined' && CONFIG && typeof CONFIG.getStepsPerTurn === 'function')
            ? CONFIG.getStepsPerTurn()
            : ((typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.stepsPerTurn)
                ? Number(CONFIG.rules.stepsPerTurn) : 100);
        const baseG = (typeof CONFIG !== 'undefined' && CONFIG && typeof CONFIG.getGravity === 'function')
            ? CONFIG.getGravity()
            : ((typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.gravity != null)
                ? Number(CONFIG.rules.gravity) : 9.8);
        return {
            stepsPerTurn,
            g: baseG * (o.gravityScale != null ? Number(o.gravityScale)
                    : (cfg.gravityScale != null ? Number(cfg.gravityScale) : 1)),
            drag: o.drag != null ? Number(o.drag) : (cfg.drag != null ? Number(cfg.drag) : 0.004),
            groundY: o.groundY != null ? Number(o.groundY) : (cfg.groundY != null ? Number(cfg.groundY) : 0),
            substeps: Math.max(1, Math.floor(o.substeps != null ? Number(o.substeps)
                : (cfg.substeps != null ? Number(cfg.substeps) : 2))),
            dt: 1 / Math.max(1, stepsPerTurn)
        };
    }

    /**
     * One combat-frame of bomb flight (optional substeps).
     * Horizontal drag only — vertical is gravity-dominated.
     * @returns {{ hit: boolean, oldPos: THREE.Vector3 }}
     */
    function integrateBombFrame(pos, vel, quat, knobs) {
        const oldPos = pos.clone();
        const subDt = knobs.dt / knobs.substeps;
        let hit = false;
        for (let s = 0; s < knobs.substeps; s++) {
            const before = pos.clone();
            vel.y -= knobs.g * subDt;
            // Drag on XZ only so fall time stays close to free-fall.
            vel.x *= Math.max(0, 1 - knobs.drag * subDt * 60);
            vel.z *= Math.max(0, 1 - knobs.drag * subDt * 60);
            pos.addScaledVector(vel, subDt);
            if (pos.y <= knobs.groundY && before.y > knobs.groundY) {
                const tHit = (before.y - knobs.groundY) / Math.max(1e-6, (before.y - pos.y));
                pos.copy(before).lerp(pos, Math.max(0, Math.min(1, tHit)));
                pos.y = knobs.groundY;
                hit = true;
                break;
            }
        }
        if (vel.lengthSq() > 1e-6 && quat) {
            const look = vel.clone().normalize();
            quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), look);
        }
        return { hit, oldPos };
    }

    /**
     * Integrate unguided ballistic fall until ground (or max steps).
     * @returns {{ points: THREE.Vector3[], impact: THREE.Vector3|null, steps: number, hitGround: boolean }}
     */
    function computeBallisticPath(origin, velocity, opts) {
        const knobs = ballisticKnobs(opts);
        const maxSteps = (opts && opts.maxSteps != null)
            ? Number(opts.maxSteps)
            : Math.max(knobs.stepsPerTurn * 10, 500);

        const pos = origin.clone();
        const vel = velocity.clone();
        const quat = new THREE.Quaternion();
        const points = [pos.clone()];
        let hitGround = false;
        let impact = null;
        let steps = 0;

        for (let i = 0; i < maxSteps; i++) {
            const res = integrateBombFrame(pos, vel, quat, knobs);
            steps = i + 1;
            if (res.hit) {
                impact = pos.clone();
                points.push(impact.clone());
                hitGround = true;
                break;
            }
            points.push(pos.clone());
            if (pos.y < knobs.groundY - 2) {
                impact = pos.clone();
                impact.y = knobs.groundY;
                hitGround = true;
                break;
            }
        }
        if (!impact) impact = points[points.length - 1].clone();
        return { points, impact, steps, hitGround };
    }

    /** Release pose: pylon world pos + aircraft forward velocity from planned path. */
    function estimateReleaseState(team, pylon) {
        const cfg = bombConfig();
        const scale = cfg.releaseSpeedScale != null ? Number(cfg.releaseSpeedScale) : 1;
        const stepsPerTurn = ballisticKnobs({}).stepsPerTurn;
        let pos = null;
        let quat = null;
        let vel = new THREE.Vector3(0, 0, 12);

        if (team.pathPoints && team.pathPoints.length >= 2 && typeof getPosAt === 'function') {
            // Velocity ≈ path derivative over one combat frame (turn duration = 1).
            const eps = 1 / Math.max(8, stepsPerTurn);
            const p0 = getPosAt(0, team.pathPoints);
            const p1 = getPosAt(Math.min(1, eps), team.pathPoints);
            pos = p0.clone();
            quat = (team.pathQuats && typeof getQuatAt === 'function')
                ? getQuatAt(0, team.pathQuats)
                : ((team.wrapper && (team.wrapper.userData && team.wrapper.userData.logicalQuat || team.wrapper.quaternion))
                    || new THREE.Quaternion()).clone();
            vel = new THREE.Vector3().subVectors(p1, p0).multiplyScalar(1 / Math.max(1e-6, eps));
        } else if (team.wrapper) {
            pos = team.wrapper.position.clone();
            quat = (team.wrapper.userData.logicalQuat || team.wrapper.quaternion).clone();
            const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
            const ap = Number(team.ap) || 100;
            // AP≈m/s game convention → world units per turn-second.
            vel = fwd.multiplyScalar(Math.max(8, ap * 0.35) * scale);
        }

        if (pylon && pylon.localPosition && pos && quat) {
            pos.add(pylon.localPosition.clone().applyQuaternion(quat));
            pos.add(new THREE.Vector3(0, -0.08, 0.05).applyQuaternion(quat));
        }
        if (vel.lengthSq() < 1e-4) {
            const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(quat || new THREE.Quaternion());
            vel.copy(fwd.multiplyScalar(12 * scale));
        } else {
            vel.multiplyScalar(scale);
        }
        return { pos, quat, vel };
    }

    function ensurePreviewObjects() {
        if (typeof scene === 'undefined' || !scene) return null;
        if (Bomb._previewGroup) return Bomb._previewGroup;

        const g = new THREE.Group();
        g.name = 'bombCcipPreview';
        g.visible = false;

        const lineMat = new THREE.LineBasicMaterial({
            color: 0xc8e06a,
            transparent: true,
            opacity: 0.85,
            depthTest: true
        });
        const lineGeo = new THREE.BufferGeometry();
        const initCap = 128;
        lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(initCap * 3), 3));
        lineGeo.setDrawRange(0, 0);
        const line = new THREE.Line(lineGeo, lineMat);
        line.frustumCulled = false;
        g.add(line);
        Bomb._previewLine = line;
        Bomb._previewLineCapacity = initCap;

        const ringGeo = new THREE.RingGeometry(0.9, 1.35, 32);
        const ringMat = new THREE.MeshBasicMaterial({
            color: 0xc8e06a,
            transparent: true,
            opacity: 0.9,
            side: THREE.DoubleSide,
            depthWrite: false
        });
        const ring = new THREE.Mesh(ringGeo, ringMat);
        ring.rotation.x = -Math.PI / 2;
        g.add(ring);
        Bomb._previewImpact = ring;

        const crossGeo = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(-1.8, 0.02, 0),
            new THREE.Vector3(1.8, 0.02, 0),
            new THREE.Vector3(0, 0.02, -1.8),
            new THREE.Vector3(0, 0.02, 1.8)
        ]);
        const cross = new THREE.LineSegments(
            crossGeo,
            new THREE.LineBasicMaterial({ color: 0xe8f5a0, transparent: true, opacity: 0.95 })
        );
        g.add(cross);
        Bomb._previewCross = cross;

        scene.add(g);
        Bomb._previewGroup = g;
        return g;
    }

    function hideCcipPreview() {
        if (Bomb._previewGroup) Bomb._previewGroup.visible = false;
    }

    function _writePointsToLineBuffer(line, pts, getCap, setCap) {
        if (!line || !line.geometry) return;
        const count = pts.length;
        let posAttr = line.geometry.attributes && line.geometry.attributes.position;
        if (!posAttr || getCap() < count) {
            const nextCap = Math.max(count + 16, 128);
            const nextGeo = new THREE.BufferGeometry();
            nextGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nextCap * 3), 3));
            line.geometry.dispose();
            line.geometry = nextGeo;
            posAttr = nextGeo.attributes.position;
            setCap(nextCap);
        }
        const arr = posAttr.array;
        for (let i = 0; i < count; i++) {
            const p = pts[i];
            const base = i * 3;
            arr[base] = p.x;
            arr[base + 1] = p.y;
            arr[base + 2] = p.z;
        }
        posAttr.needsUpdate = true;
        line.geometry.setDrawRange(0, count);
    }

    /** Update CCIP path + impact marker for human bomb mode. */
    function updateCcipPreview(team) {
        if (!team || team.isDestroyed || team.weapon !== 'bomb') {
            hideCcipPreview();
            return null;
        }
        if (typeof GameContext !== 'undefined' && (GameContext.isAnimating() || GameContext.isReplayMode())) {
            hideCcipPreview();
            return null;
        }
        const pylons = teamBombPylons(team);
        const armed = pylons.filter((p) => p.state === 'armed');
        const pylon = armed[0] || pylons[0];
        if (!pylon) {
            hideCcipPreview();
            return null;
        }

        const rel = estimateReleaseState(team, pylon);
        if (!rel.pos) {
            hideCcipPreview();
            return null;
        }
        const cfg = bombConfig();
        const knobs = ballisticKnobs({});
        const reqSamples = cfg.previewSamples != null ? Number(cfg.previewSamples) : 48;
        const sig = [
            team.id || '',
            pylon.id != null ? pylon.id : '',
            rel.pos.x.toFixed(3), rel.pos.y.toFixed(3), rel.pos.z.toFixed(3),
            rel.vel.x.toFixed(3), rel.vel.y.toFixed(3), rel.vel.z.toFixed(3),
            knobs.stepsPerTurn, knobs.g.toFixed(3), knobs.drag.toFixed(4), knobs.groundY.toFixed(2),
            reqSamples
        ].join('|');

        const grp = ensurePreviewObjects();
        if (Bomb._previewSig === sig && Bomb._lastPreviewPath) {
            if (grp) grp.visible = true;
            return Bomb._lastPreviewPath;
        }

        const path = computeBallisticPath(rel.pos, rel.vel, {});
        Bomb._previewSig = sig;
        Bomb._lastPreviewPath = path;
        if (!grp) return path;

        const samples = Math.min(path.points.length, reqSamples);
        const stride = Math.max(1, Math.floor(path.points.length / Math.max(1, samples)));
        const pts = [];
        for (let i = 0; i < path.points.length; i += stride) pts.push(path.points[i]);
        if (path.impact) pts.push(path.impact);
        if (Bomb._previewLine) {
            _writePointsToLineBuffer(
                Bomb._previewLine,
                pts,
                () => Bomb._previewLineCapacity,
                (c) => { Bomb._previewLineCapacity = c; }
            );
        }
        if (Bomb._previewImpact && path.impact) {
            Bomb._previewImpact.position.copy(path.impact);
            Bomb._previewImpact.position.y = knobs.groundY + 0.05;
        }
        if (Bomb._previewCross && path.impact) {
            Bomb._previewCross.position.copy(path.impact);
            Bomb._previewCross.position.y = knobs.groundY + 0.05;
        }
        grp.visible = true;
        return path;
    }

    function ensureTeamBombs(team) {
        if (!team.activeBombs) team.activeBombs = [];
        return team.activeBombs;
    }

    function pushBombExplosionVfx(ctx, step, pos, cfg, surface) {
        const exScale = cfg.explosionScale != null ? Number(cfg.explosionScale) : 2.6;
        const blastR = bombBlastRadius(cfg);
        const sparkN = cfg.sparkCount != null ? Number(cfg.sparkCount) : 90;
        const sparkP = cfg.sparkPower != null ? Number(cfg.sparkPower) : 0.95;
        const surf = surface || (pos && pos.y <= 1.8 ? 'ground' : 'building');
        const seed = (typeof sparkSeedFrom === 'function')
            ? sparkSeedFrom(step, pos)
            : ((Math.random() * 0xffffffff) >>> 0);
        ctx.log.vfxTriggers.push({
            type: 'ground_explosion',
            step,
            pos: pos.clone(),
            radius: blastR,
            scale: Math.max(0.95, Math.min(1.65, exScale * 0.52)),
            seed,
            surface: surf
        });
        if (typeof sparkBurstTrigger === 'function') {
            const sparkPos = pos.clone();
            if (surf === 'ground') sparkPos.y = Math.max(sparkPos.y, 0.2);
            ctx.log.vfxTriggers.push(sparkBurstTrigger(step, sparkPos, sparkN, sparkP, {
                fountain: true,
                wind: new THREE.Vector3(0, 0.42, 0),
                gravity: 0.014,
                life: 24,
                streak: 0.88
            }));
        }
    }

    /** Combat pipeline: queue new drops + keep multi-turn flying bombs tracked. */
    function processBombDrops(ctx) {
        if (!ctx || !ctx.log) return;
        const ids = (typeof combatActiveIds === 'function')
            ? combatActiveIds()
            : Object.keys(typeof teams !== 'undefined' ? teams : {});
        ids.forEach((id) => {
            const t = teams[id];
            if (!t || t.isDestroyed) return;
            ensureTeamBombs(t);
            ctx.log[`${id}BombTracks`] = ctx.log[`${id}BombTracks`] || {};
            ctx.log[`${id}BombExplodedAt`] = ctx.log[`${id}BombExplodedAt`] || {};

            // Continuing bombs from prior turns: open track lanes for this turn's resolve.
            t.activeBombs.forEach((b) => {
                if (!b || b.exploded) return;
                if (!ctx.log[`${id}BombTracks`][b.pylonId]) {
                    ctx.log[`${id}BombTracks`][b.pylonId] = [];
                }
                // Already in air: stay active, no re-launch.
                if (b.active) b.launchStep = -1;
            });
            // Prune finished bombs so arrays stay small.
            t.activeBombs = t.activeBombs.filter((b) => b && !b.exploded);

            if (!t.pylons) return;
            if (!(t.wpnQueued && t.weapon === 'bomb' && (t.queuedAction === 'bomb' || t.queuedAction === 'missile'))) {
                return;
            }
            let dropped = false;
            t.pylons.forEach((p) => {
                if (dropped) return;
                if (p.state !== 'armed') return;
                const wt = (typeof pylonWeaponType === 'function') ? pylonWeaponType(p) : p.weaponType;
                if (!isBombType(wt)) return;
                if (t.activeBombs.some((b) => b.pylonId === p.id && !b.exploded)) return;

                const bomb = {
                    pylonId: p.id,
                    weaponType: 'bomb',
                    active: false,
                    launchStep: 0,
                    ageSteps: 0,
                    pos: new THREE.Vector3(),
                    vel: new THREE.Vector3(),
                    quat: new THREE.Quaternion(),
                    exploded: false,
                    hitGround: false
                };
                t.activeBombs.push(bomb);
                ctx.log[`${id}BombTracks`][p.id] = [];
                p.state = 'empty';
                p.emptySinceTurn = Math.max(
                    1,
                    Number((typeof GameContext !== 'undefined' && GameContext.state && GameContext.state.currentTurn) || 1)
                );
                if (p.mesh) p.mesh.visible = false;
                dropped = true;
            });
            if (dropped) {
                t.wpnQueued = false;
                t.queuedAction = 'none';
            }
        });
    }

    function resolveBombsForStep(step, ratio, ctx) {
        if (!ctx || !ctx.log) return;
        const cfg = bombConfig();
        const fuseDelay = cfg.fuseDelaySteps != null ? Number(cfg.fuseDelaySteps) : 1;
        const blastR = bombBlastRadius(cfg);
        const damage = cfg.damage != null ? Number(cfg.damage) : 80;
        const knobs = ballisticKnobs({});
        const ids = (typeof combatActiveIds === 'function')
            ? combatActiveIds()
            : Object.keys(typeof teams !== 'undefined' ? teams : {});

        ids.forEach((id) => {
            const t = teams[id];
            if (!t || !t.activeBombs || !t.activeBombs.length) return;
            const tracks = ctx.log[`${id}BombTracks`] = ctx.log[`${id}BombTracks`] || {};
            const explodedAt = ctx.log[`${id}BombExplodedAt`] = ctx.log[`${id}BombExplodedAt`] || {};

            t.activeBombs.forEach((b) => {
                if (b.exploded) {
                    if (tracks[b.pylonId]) tracks[b.pylonId].push(null);
                    return;
                }
                if (!b.active) {
                    if (step < b.launchStep) {
                        if (!tracks[b.pylonId]) tracks[b.pylonId] = [];
                        tracks[b.pylonId].push(null);
                        return;
                    }
                    if (step === b.launchStep) {
                        b.active = true;
                        const acPos = (t.pathPoints && typeof getPosAt === 'function')
                            ? getPosAt(ratio, t.pathPoints)
                            : t.wrapper.position.clone();
                        const acQuat = (t.pathQuats && typeof getQuatAt === 'function')
                            ? getQuatAt(ratio, t.pathQuats)
                            : (t.wrapper.userData.logicalQuat || t.wrapper.quaternion).clone();
                        const pylon = (t.pylons || []).find((p) => p.id === b.pylonId);
                        const rel = estimateReleaseState(
                            Object.assign({}, t, {
                                pathPoints: t.pathPoints,
                                pathQuats: t.pathQuats,
                                wrapper: { position: acPos, quaternion: acQuat, userData: { logicalQuat: acQuat } },
                                ap: t.ap
                            }),
                            pylon
                        );
                        b.pos.copy(acPos);
                        if (pylon && pylon.localPosition) {
                            b.pos.add(pylon.localPosition.clone().applyQuaternion(acQuat));
                            b.pos.add(new THREE.Vector3(0, -0.08, 0.05).applyQuaternion(acQuat));
                        }
                        b.quat.copy(acQuat);
                        if (rel.vel) b.vel.copy(rel.vel);
                        else b.vel.copy(new THREE.Vector3(0, 0, 1).applyQuaternion(acQuat).multiplyScalar(12));
                        b.ageSteps = 0;
                        if (!tracks[b.pylonId]) tracks[b.pylonId] = [];
                        tracks[b.pylonId].push({ pos: b.pos.clone(), quat: b.quat.clone() });
                        return;
                    }
                }

                const integ = integrateBombFrame(b.pos, b.vel, b.quat, knobs);
                b.ageSteps = (Number(b.ageSteps) || 0) + 1;
                let hit = integ.hit;
                let hitSurface = integ.hit ? 'ground' : null;

                // Building collision (same ray idea as missiles).
                if (!hit && typeof obstacles !== 'undefined' && obstacles.length > 0) {
                    const moveVec = new THREE.Vector3().subVectors(b.pos, integ.oldPos);
                    const dist = moveVec.length();
                    if (dist > 1e-4) {
                        const ray = new THREE.Raycaster(integ.oldPos, moveVec.normalize());
                        const hits = ray.intersectObjects(obstacles, false);
                        if (hits.length && hits[0].distance <= dist) {
                            b.pos.copy(hits[0].point);
                            hit = true;
                            hitSurface = (b.pos.y <= 1.8) ? 'ground' : 'building';
                        }
                    }
                }

                if (!tracks[b.pylonId]) tracks[b.pylonId] = [];
                tracks[b.pylonId].push({ pos: b.pos.clone(), quat: b.quat.clone() });

                const fuseOk = b.launchStep < 0
                    ? true
                    : (step >= (b.launchStep + fuseDelay));
                if (hit && !fuseOk) {
                    // Hit surface before arming fuse completed: mark dud so bomb stops instead of falling underground.
                    b.exploded = true;
                    b.dud = true;
                    b.hitGround = true;
                    explodedAt[b.pylonId] = step;
                } else if (hit && fuseOk) {
                    b.exploded = true;
                    b.hitGround = true;
                    explodedAt[b.pylonId] = step;
                    pushBombExplosionVfx(ctx, step, b.pos, cfg, hitSurface || 'ground');
                    if (typeof AirArenaGroundTargets !== 'undefined'
                        && typeof AirArenaGroundTargets.applyBlastDamage === 'function') {
                        const gtHits = AirArenaGroundTargets.applyBlastDamage(b.pos, blastR, damage, {
                            ownerId: id, weapon: 'bomb'
                        });
                        if (gtHits.length) {
                            ctx.log.groundTargetHits = ctx.log.groundTargetHits || [];
                            gtHits.forEach((h) => ctx.log.groundTargetHits.push({
                                step, ownerId: id, weapon: 'bomb', ...h
                            }));
                        }
                    }
                    // Soft blast vs any aircraft in radius.
                    ids.forEach((vid) => {
                        const vt = teams[vid];
                        if (!vt || vt.isDestroyed || !vt.pathPoints) return;
                        // Friendly fire allowed for now (bomb is dumb).
                        const vPos = (typeof getPosAt === 'function')
                            ? getPosAt(ratio, vt.pathPoints)
                            : (vt.wrapper && vt.wrapper.position);
                        if (!vPos) return;
                        if (b.pos.distanceTo(vPos) <= blastR) {
                            if (ctx.hp[vid] != null) {
                                ctx.hp[vid] = Math.max(0, ctx.hp[vid] - damage);
                                if (ctx.log[vid]) {
                                    ctx.log[vid].damageTaken = (Number(ctx.log[vid].damageTaken) || 0) + damage;
                                    if (!Array.isArray(ctx.log[vid].damageSteps)) ctx.log[vid].damageSteps = [];
                                    ctx.log[vid].damageSteps.push(step);
                                }
                                if (typeof recordCombatHit === 'function') {
                                    recordCombatHit(ctx, vid, id, 'bomb', step);
                                }
                                if (!ctx.log.weaponDamageDealt) ctx.log.weaponDamageDealt = {};
                                if (!ctx.log.weaponDamageDealt[id]) ctx.log.weaponDamageDealt[id] = {};
                                ctx.log.weaponDamageDealt[id].bomb = (ctx.log.weaponDamageDealt[id].bomb || 0) + damage;
                            }
                        }
                    });
                }
            });
            // Drop finished bombs so multi-turn carry only keeps live rounds.
            t.activeBombs = t.activeBombs.filter((b) => b && !b.exploded);
        });
    }

    /** Replay / live combat visual for bombs in flight (+ short trail). */
    function applyBombVisuals(step, log) {
        if (!log || typeof teams === 'undefined') return;
        const ids = (typeof combatActiveIds === 'function')
            ? combatActiveIds()
            : Object.keys(teams);
        ids.forEach((id) => {
            const t = teams[id];
            if (!t || !t.pylons) return;
            const tracks = log[`${id}BombTracks`] || {};
            t.pylons.forEach((p) => {
                const trackArr = tracks[p.id];
                const track = trackArr && trackArr[step];
                const explodedAt = log[`${id}BombExplodedAt`] && log[`${id}BombExplodedAt`][p.id];
                if (track && track.pos && (explodedAt == null || step < explodedAt)) {
                    if (!p.bombFlyingMesh && typeof bombMeshBase !== 'undefined' && bombMeshBase) {
                        p.bombFlyingMesh = bombMeshBase.clone();
                        if (typeof scene !== 'undefined') scene.add(p.bombFlyingMesh);
                    }
                    if (p.bombFlyingMesh) {
                        p.bombFlyingMesh.position.copy(track.pos);
                        if (track.quat) p.bombFlyingMesh.quaternion.copy(track.quat);
                        p.bombFlyingMesh.visible = true;
                    }
                    // Short dashed trail behind the falling bomb.
                    if (trackArr && typeof scene !== 'undefined') {
                        const trailPts = [];
                        const back = Math.max(0, step - 18);
                        for (let i = back; i <= step; i++) {
                            const tr = trackArr[i];
                            if (tr && tr.pos) trailPts.push(tr.pos);
                        }
                        if (trailPts.length >= 2) {
                            if (!p.bombTrailLine) {
                                const tGeo = new THREE.BufferGeometry();
                                tGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(24 * 3), 3));
                                tGeo.setDrawRange(0, 0);
                                p.bombTrailLine = new THREE.Line(
                                    tGeo,
                                    new THREE.LineBasicMaterial({
                                        color: 0xb8c878,
                                        transparent: true,
                                        opacity: 0.55
                                    })
                                );
                                p.bombTrailLine.frustumCulled = false;
                                p._bombTrailCap = 24;
                                scene.add(p.bombTrailLine);
                            }
                            _writePointsToLineBuffer(
                                p.bombTrailLine,
                                trailPts,
                                () => p._bombTrailCap || 0,
                                (c) => { p._bombTrailCap = c; }
                            );
                            p.bombTrailLine.visible = true;
                        }
                    }
                } else {
                    if (p.bombFlyingMesh) p.bombFlyingMesh.visible = false;
                    if (p.bombTrailLine) p.bombTrailLine.visible = false;
                }
            });
        });
    }

    /** Hide or dispose in-flight bomb meshes/trails (replay exit or match reset). */
    function clearBombVisuals(opts) {
        const dispose = !!(opts && opts.dispose);
        hideCcipPreview();
        if (dispose) {
            Bomb._previewSig = '';
            Bomb._lastPreviewPath = null;
        }
        if (typeof teams === 'undefined') return;
        Object.keys(teams).forEach((id) => {
            const t = teams[id];
            if (!t || !t.pylons) return;
            t.pylons.forEach((p) => {
                if (!p) return;
                if (p.bombFlyingMesh) {
                    if (dispose) {
                        if (p.bombFlyingMesh.parent) p.bombFlyingMesh.parent.remove(p.bombFlyingMesh);
                        p.bombFlyingMesh = null;
                    } else {
                        p.bombFlyingMesh.visible = false;
                    }
                }
                if (p.bombTrailLine) {
                    if (dispose) {
                        if (p.bombTrailLine.parent) p.bombTrailLine.parent.remove(p.bombTrailLine);
                        if (p.bombTrailLine.geometry) p.bombTrailLine.geometry.dispose();
                        if (p.bombTrailLine.material) p.bombTrailLine.material.dispose();
                        p.bombTrailLine = null;
                    } else {
                        p.bombTrailLine.visible = false;
                    }
                }
            });
        });
    }

    Bomb.isBombType = isBombType;
    Bomb.isA2GStoreType = isA2GStoreType;
    Bomb.teamBombPylons = teamBombPylons;
    Bomb.armBombPylons = armBombPylons;
    Bomb.standbyBombPylons = standbyBombPylons;
    Bomb.computeBallisticPath = computeBallisticPath;
    Bomb.estimateReleaseState = estimateReleaseState;
    Bomb.updateCcipPreview = updateCcipPreview;
    Bomb.hideCcipPreview = hideCcipPreview;
    Bomb.clearBombVisuals = clearBombVisuals;
    Bomb.processBombDrops = processBombDrops;
    Bomb.resolveBombsForStep = resolveBombsForStep;
    Bomb.applyBombVisuals = applyBombVisuals;

    global.AirArenaBomb = Bomb;
    if (typeof GameContext !== 'undefined' && GameContext.registerService) {
        GameContext.registerService('updateBombCcipPreview', updateCcipPreview);
        GameContext.registerService('hideBombCcipPreview', hideCcipPreview);
        GameContext.registerService('processBombDrops', processBombDrops);
        GameContext.registerService('resolveBombsForStep', resolveBombsForStep);
        GameContext.registerService('applyBombVisuals', applyBombVisuals);
    }
})(typeof window !== 'undefined' ? window : globalThis);
