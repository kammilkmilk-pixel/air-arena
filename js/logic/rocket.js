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

    function estimateLaunchState(team, pylon) {
        const cfg = rocketConfig();
        const scale = cfg.launchSpeedScale != null ? Number(cfg.launchSpeedScale) : 1;
        const baseSpeed = cfg.launchSpeed != null ? Number(cfg.launchSpeed) : 55;
        const stepsPerTurn = (typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.stepsPerTurn)
            ? Number(CONFIG.rules.stepsPerTurn) : 100;

        let pos;
        let quat;
        let vel;

        if (team.pathPoints && team.pathPoints.length >= 2 && typeof getPosAt === 'function') {
            const eps = 1 / Math.max(8, stepsPerTurn);
            const p0 = getPosAt(0, team.pathPoints);
            const p1 = getPosAt(Math.min(1, eps), team.pathPoints);
            pos = p0.clone();
            quat = (team.pathQuats && typeof getQuatAt === 'function')
                ? getQuatAt(0, team.pathQuats)
                : ((team.wrapper && (team.wrapper.userData && team.wrapper.userData.logicalQuat || team.wrapper.quaternion))
                    || new THREE.Quaternion()).clone();
            // Aircraft velocity + rocket motor impulse along nose.
            const acVel = new THREE.Vector3().subVectors(p1, p0).multiplyScalar(1 / Math.max(1e-6, eps));
            const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
            vel = acVel.add(fwd.multiplyScalar(baseSpeed * scale));
        } else if (team.wrapper) {
            pos = team.wrapper.position.clone();
            quat = (team.wrapper.userData.logicalQuat || team.wrapper.quaternion).clone();
            const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
            vel = fwd.multiplyScalar(baseSpeed * scale);
        } else {
            pos = new THREE.Vector3();
            quat = new THREE.Quaternion();
            vel = new THREE.Vector3(0, 0, baseSpeed * scale);
        }

        if (pylon && pylon.localPosition && pos && quat) {
            pos.add(pylon.localPosition.clone().applyQuaternion(quat));
            pos.add(new THREE.Vector3(0, -0.05, 0.15).applyQuaternion(quat));
        }
        return { pos, quat, vel };
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
        const gap = intervalSteps();

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
            for (let i = 0; i < fireCount; i++) {
                t._rocketSeq = seqBase + i + 1;
                const trackId = `r${id}_p${pod.id}_t${turn}_${t._rocketSeq}`;
                const rocket = {
                    pylonId: pod.id,
                    trackId,
                    weaponType: 'rocket',
                    active: false,
                    launchStep: i * gap,
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
                        const acPos = (t.pathPoints && typeof getPosAt === 'function')
                            ? getPosAt(ratio, t.pathPoints)
                            : t.wrapper.position.clone();
                        const acQuat = (t.pathQuats && typeof getQuatAt === 'function')
                            ? getQuatAt(ratio, t.pathQuats)
                            : (t.wrapper.userData.logicalQuat || t.wrapper.quaternion).clone();
                        const pylon = (t.pylons || []).find((p) => p.id === r.pylonId);
                        const rel = estimateLaunchState(
                            Object.assign({}, t, {
                                pathPoints: t.pathPoints,
                                pathQuats: t.pathQuats,
                                wrapper: { position: acPos, quaternion: acQuat, userData: { logicalQuat: acQuat } },
                                ap: t.ap
                            }),
                            pylon
                        );
                        r.pos.copy(rel.pos || acPos);
                        r.quat.copy(rel.quat || acQuat);
                        r.vel.copy(rel.vel || new THREE.Vector3(0, 0, 1).applyQuaternion(acQuat).multiplyScalar(50));
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

    /** Lightweight aiming hint: forward cone / impact estimate for rocket mode. */
    function updateRocketAimPreview(team) {
        if (!team || team.weapon !== 'rocket' || team.isDestroyed) {
            if (Rocket._aimGroup) Rocket._aimGroup.visible = false;
            const hud = document.getElementById('rocket-aim-hud');
            if (hud) hud.style.display = 'none';
            return;
        }
        if (typeof GameContext !== 'undefined' && (GameContext.isAnimating() || GameContext.isReplayMode())) {
            if (Rocket._aimGroup) Rocket._aimGroup.visible = false;
            return;
        }
        const pods = teamRocketPylons(team);
        const armed = pods.filter((p) => p.state === 'armed' && ensurePodAmmo(p) > 0);
        const pod = armed[0] || pods[0];
        if (!pod) {
            if (Rocket._aimGroup) Rocket._aimGroup.visible = false;
            return;
        }

        const rel = estimateLaunchState(team, pod);
        const knobs = ballisticKnobs();
        const pos = rel.pos.clone();
        const vel = rel.vel.clone();
        const quat = rel.quat.clone();
        const pts = [pos.clone()];
        let impact = null;
        for (let i = 0; i < 160; i++) {
            const res = integrateRocketFrame(pos, vel, quat, knobs);
            pts.push(pos.clone());
            if (res.hitGround || pos.y <= (rocketConfig().vtGroundHeight || 3.5)) {
                impact = pos.clone();
                break;
            }
        }
        if (!impact) impact = pts[pts.length - 1].clone();

        if (typeof scene !== 'undefined' && scene) {
            if (!Rocket._aimGroup) {
                Rocket._aimGroup = new THREE.Group();
                Rocket._aimLine = new THREE.Line(
                    new THREE.BufferGeometry(),
                    new THREE.LineBasicMaterial({ color: 0xff9966, transparent: true, opacity: 0.8 })
                );
                const ring = new THREE.Mesh(
                    new THREE.RingGeometry(0.7, 1.1, 24),
                    new THREE.MeshBasicMaterial({
                        color: 0xff9966, transparent: true, opacity: 0.85,
                        side: THREE.DoubleSide, depthWrite: false
                    })
                );
                ring.rotation.x = -Math.PI / 2;
                Rocket._aimImpact = ring;
                Rocket._aimGroup.add(Rocket._aimLine, ring);
                scene.add(Rocket._aimGroup);
            }
            Rocket._aimLine.geometry.dispose();
            Rocket._aimLine.geometry = new THREE.BufferGeometry().setFromPoints(pts.filter((_, i) => i % 2 === 0));
            Rocket._aimImpact.position.copy(impact);
            Rocket._aimImpact.position.y = (knobs.groundY || 0) + 0.06;
            Rocket._aimGroup.visible = true;
        }

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
        const ammo = ensurePodAmmo(pod);
        const max = Number(pod.ammoMax) || roundsPerPod();
        const salvo = Math.min(salvoPerTurn(), ammo);
        hud.innerText = `RKT VT  ${ammo}/${max}  ·  本回 ${salvo}× / ${intervalSteps()}fr  ·  ENT 齊射`;
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
