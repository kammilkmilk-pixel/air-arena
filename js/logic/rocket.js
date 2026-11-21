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

    function integrateRocketFrame(pos, vel, quat, knobs) {
        const oldPos = pos.clone();
        const subDt = knobs.dt / knobs.substeps;
        let hitGround = false;
        for (let s = 0; s < knobs.substeps; s++) {
            const before = pos.clone();
            vel.y -= knobs.g * subDt;
            vel.x *= Math.max(0, 1 - knobs.drag * subDt * 60);
            vel.z *= Math.max(0, 1 - knobs.drag * subDt * 60);
            pos.addScaledVector(vel, subDt);
            if (pos.y <= knobs.groundY && before.y > knobs.groundY) {
                const tHit = (before.y - knobs.groundY) / Math.max(1e-6, (before.y - pos.y));
                pos.copy(before).lerp(pos, Math.max(0, Math.min(1, tHit)));
                pos.y = knobs.groundY;
                hitGround = true;
                break;
            }
        }
        if (vel.lengthSq() > 1e-6 && quat) {
            quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), vel.clone().normalize());
        }
        return { hitGround, oldPos };
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

    /** Integrate until VT ground / impact; returns path samples + impact. */
    function predictRocketImpact(origin, velocity, quatSeed) {
        const knobs = ballisticKnobs();
        const cfg = rocketConfig();
        const vtGround = cfg.vtGroundHeight != null ? Number(cfg.vtGroundHeight) : 3.5;
        const pos = origin.clone();
        const vel = velocity.clone();
        const quat = (quatSeed && quatSeed.clone) ? quatSeed.clone() : new THREE.Quaternion();
        const points = [pos.clone()];
        let impact = null;
        const maxSteps = cfg.maxFlightSteps != null ? Math.min(Number(cfg.maxFlightSteps), 240) : 160;
        for (let i = 0; i < maxSteps; i++) {
            const res = integrateRocketFrame(pos, vel, quat, knobs);
            points.push(pos.clone());
            if (res.hitGround || pos.y <= knobs.groundY + vtGround) {
                impact = pos.clone();
                break;
            }
        }
        if (!impact) impact = points[points.length - 1].clone();
        return { points, impact };
    }

    function pushRocketExplosionVfx(ctx, step, pos, cfg) {
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
                    vt: true
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

        const vtR = cfg.vtRadius != null ? Number(cfg.vtRadius) : 4.5;
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
        const blastR = cfg.blastRadius != null ? Number(cfg.blastRadius) : 6;
        const damage = cfg.damage != null ? Number(cfg.damage) : 22;
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
                if (!hitSolid && typeof obstacles !== 'undefined' && obstacles.length > 0) {
                    const moveVec = new THREE.Vector3().subVectors(r.pos, integ.oldPos);
                    const dist = moveVec.length();
                    if (dist > 1e-4) {
                        const ray = new THREE.Raycaster(integ.oldPos, moveVec.normalize());
                        const hits = ray.intersectObjects(obstacles, false);
                        if (hits.length && hits[0].distance <= dist) {
                            r.pos.copy(hits[0].point);
                            hitSolid = true;
                        }
                    }
                }

                if (!tracks[r.trackId]) tracks[r.trackId] = [];
                tracks[r.trackId].push({ pos: r.pos.clone(), quat: r.quat.clone() });

                let fuse = hitSolid ? { reason: 'impact', victimId: null } : null;
                if (!fuse) fuse = checkVtFuse(r, step, ratio, id, knobs);
                if (!fuse && r.ageSteps >= maxFlight) fuse = { reason: 'timeout', victimId: null };

                if (fuse) {
                    r.exploded = true;
                    explodedAt[r.trackId] = step;
                    pushRocketExplosionVfx(ctx, step, r.pos, cfg);

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

    function applyRocketVisuals(step, log) {
        if (!log || typeof teams === 'undefined' || typeof scene === 'undefined') return;
        if (!Rocket._flightMeshes) Rocket._flightMeshes = {};

        const ids = (typeof combatActiveIds === 'function')
            ? combatActiveIds()
            : Object.keys(teams);

        // Hide all first.
        Object.keys(Rocket._flightMeshes).forEach((key) => {
            const m = Rocket._flightMeshes[key];
            if (m) m.visible = false;
            if (m && m.userData.trail) m.userData.trail.visible = false;
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
                if (!mesh) {
                    if (typeof rocketMeshBase !== 'undefined' && rocketMeshBase) {
                        mesh = rocketMeshBase.clone();
                        mesh.scale.multiplyScalar(0.85);
                    } else {
                        mesh = new THREE.Mesh(
                            new THREE.CylinderGeometry(0.04, 0.06, 0.55, 6),
                            new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.85, roughness: 0.3 })
                        );
                        mesh.rotation.x = Math.PI / 2;
                    }
                    mesh.userData.trail = new THREE.Line(
                        new THREE.BufferGeometry(),
                        new THREE.LineBasicMaterial({ color: 0xffaa66, transparent: true, opacity: 0.55 })
                    );
                    scene.add(mesh);
                    scene.add(mesh.userData.trail);
                    Rocket._flightMeshes[trackId] = mesh;
                }
                mesh.position.copy(tr.pos);
                if (tr.quat) mesh.quaternion.copy(tr.quat);
                mesh.visible = true;

                const trailPts = [];
                const back = Math.max(0, step - 14);
                for (let i = back; i <= step; i++) {
                    const p = arr[i];
                    if (p && p.pos) trailPts.push(p.pos);
                }
                if (mesh.userData.trail && trailPts.length >= 2) {
                    mesh.userData.trail.geometry.dispose();
                    mesh.userData.trail.geometry = new THREE.BufferGeometry().setFromPoints(trailPts);
                    mesh.userData.trail.visible = true;
                }
            });
        });
    }

    function ensureAimVisuals(count) {
        if (typeof scene === 'undefined' || !scene) return null;
        if (!Rocket._aimGroup) {
            Rocket._aimGroup = new THREE.Group();
            Rocket._aimGroup.name = 'rocketAimPreview';
            Rocket._aimSlots = [];
            scene.add(Rocket._aimGroup);
        }
        const colors = [0xff9966, 0xffcc66, 0xff7755];
        while (Rocket._aimSlots.length < count) {
            const idx = Rocket._aimSlots.length;
            const color = colors[idx % colors.length];
            const line = new THREE.Line(
                new THREE.BufferGeometry(),
                new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.75 })
            );
            const ring = new THREE.Mesh(
                new THREE.RingGeometry(0.55, 0.95, 20),
                new THREE.MeshBasicMaterial({
                    color, transparent: true, opacity: 0.9,
                    side: THREE.DoubleSide, depthWrite: false
                })
            );
            ring.rotation.x = -Math.PI / 2;
            // Small cross at impact
            const cross = new THREE.LineSegments(
                new THREE.BufferGeometry().setFromPoints([
                    new THREE.Vector3(-1.2, 0.03, 0),
                    new THREE.Vector3(1.2, 0.03, 0),
                    new THREE.Vector3(0, 0.03, -1.2),
                    new THREE.Vector3(0, 0.03, 1.2)
                ]),
                new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95 })
            );
            // Release pip along aircraft path
            const pip = new THREE.Mesh(
                new THREE.SphereGeometry(0.14, 8, 8), // half of prior 0.28 release marker
                new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 })
            );
            Rocket._aimGroup.add(line, ring, cross, pip);
            Rocket._aimSlots.push({ line, ring, cross, pip });
        }
        return Rocket._aimGroup;
    }

    /**
     * Aim preview: one impact per salvo rocket, launched mid-path at 0 / 33 / 66…
     * Impacts move when the planned flight curve changes; each has slight dispersion.
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
        const pods = teamRocketPylons(team);
        const armed = pods.filter((p) => p.state === 'armed' && ensurePodAmmo(p) > 0);
        const pod = armed[0] || pods[0];
        if (!pod) {
            hideRocketAimPreview();
            return;
        }

        const ammo = ensurePodAmmo(pod);
        const max = Number(pod.ammoMax) || roundsPerPod();
        const salvo = Math.min(salvoPerTurn(), ammo);
        const stepsPerTurn = (typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.stepsPerTurn)
            ? Number(CONFIG.rules.stepsPerTurn) : 100;
        const knobs = ballisticKnobs();
        const groundY = knobs.groundY || 0;

        const grp = ensureAimVisuals(Math.max(salvo, 3));
        if (!grp) return;

        const impactSummaries = [];
        for (let i = 0; i < Rocket._aimSlots.length; i++) {
            const slot = Rocket._aimSlots[i];
            const show = i < salvo;
            slot.line.visible = show;
            slot.ring.visible = show;
            slot.cross.visible = show;
            slot.pip.visible = show;
            if (!show) continue;

            const launchStep = Math.min(stepsPerTurn, launchStepForIndex(i));
            const ratio = Math.min(1, launchStep / Math.max(1, stepsPerTurn));
            const rel = estimateLaunchState(team, pod, {
                ratio,
                dispersion: dispersionForIndex(i)
            });
            const pred = predictRocketImpact(rel.pos, rel.vel, rel.quat);
            const sample = pred.points.filter((_, idx) => idx % 2 === 0);
            if (sample.length < 2) sample.push(rel.pos.clone(), pred.impact.clone());

            slot.line.geometry.dispose();
            slot.line.geometry = new THREE.BufferGeometry().setFromPoints(sample);
            slot.ring.position.copy(pred.impact);
            slot.ring.position.y = groundY + 0.05 + i * 0.01;
            slot.cross.position.copy(pred.impact);
            slot.cross.position.y = groundY + 0.05 + i * 0.01;
            slot.pip.position.copy(rel.pos);

            impactSummaries.push({
                i: i + 1,
                step: launchStep,
                range: team.wrapper ? team.wrapper.position.distanceTo(pred.impact) : NaN
            });
        }
        grp.visible = true;

        let hud = document.getElementById('rocket-aim-hud');
        if (!hud) {
            hud = document.createElement('div');
            hud.id = 'rocket-aim-hud';
            hud.style.cssText = [
                'position:absolute', 'left:50%', 'bottom:18%', 'transform:translateX(-50%)',
                'z-index:7500', 'pointer-events:none',
                'font:600 13px/1.3 Consolas,monospace', 'color:#ffb07a',
                'text-shadow:0 0 6px #401800,0 1px 2px #000',
                'background:rgba(40,18,8,0.45)', 'padding:6px 12px',
                'border:1px solid rgba(255,153,102,0.45)'
            ].join(';');
            document.body.appendChild(hud);
        }
        const ranges = impactSummaries
            .map((s) => (Number.isFinite(s.range) ? `${s.range.toFixed(0)}m@${s.step}fr` : `—@${s.step}fr`))
            .join('  ');
        hud.innerText = `RKT VT  ${ammo}/${max}  ·  ${salvo}彈著  ${ranges}  ·  ENT 齊射`;
        hud.style.display = 'block';
    }

    function hideRocketAimPreview() {
        if (Rocket._aimGroup) Rocket._aimGroup.visible = false;
        const hud = document.getElementById('rocket-aim-hud');
        if (hud) hud.style.display = 'none';
    }

    Rocket.isRocketType = isRocketType;
    Rocket.teamRocketPylons = teamRocketPylons;
    Rocket.ensurePodAmmo = ensurePodAmmo;
    Rocket.roundsPerPod = roundsPerPod;
    Rocket.salvoPerTurn = salvoPerTurn;
    Rocket.intervalSteps = intervalSteps;
    Rocket.launchDelaySteps = launchDelaySteps;
    Rocket.launchStepForIndex = launchStepForIndex;
    Rocket.armRocketPylons = armRocketPylons;
    Rocket.standbyRocketPylons = standbyRocketPylons;
    Rocket.processRocketSalvos = processRocketSalvos;
    Rocket.resolveRocketsForStep = resolveRocketsForStep;
    Rocket.applyRocketVisuals = applyRocketVisuals;
    Rocket.updateRocketAimPreview = updateRocketAimPreview;
    Rocket.hideRocketAimPreview = hideRocketAimPreview;

    global.AirArenaRocket = Rocket;
    if (typeof GameContext !== 'undefined' && GameContext.registerService) {
        GameContext.registerService('processRocketSalvos', processRocketSalvos);
        GameContext.registerService('resolveRocketsForStep', resolveRocketsForStep);
        GameContext.registerService('applyRocketVisuals', applyRocketVisuals);
        GameContext.registerService('updateRocketAimPreview', updateRocketAimPreview);
    }
})(typeof window !== 'undefined' ? window : globalThis);
