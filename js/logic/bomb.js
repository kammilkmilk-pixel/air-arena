// ============================================================================
// bomb.js — Phase B unguided bomb: ballistic path, CCIP preview, SMS release
// (Human path first; AI decide / ground-target schema deferred.)
// ============================================================================

(function (global) {
    'use strict';

    const Bomb = {
        _previewGroup: null,
        _previewLine: null,
        _previewImpact: null,
        _previewHud: null
    };

    function bombConfig() {
        const w = (typeof CONFIG !== 'undefined' && CONFIG.weapons && CONFIG.weapons.bomb)
            ? CONFIG.weapons.bomb
            : {};
        return w;
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

    /**
     * Integrate unguided ballistic fall until ground (or max steps).
     * @returns {{ points: THREE.Vector3[], impact: THREE.Vector3|null, steps: number, hitGround: boolean }}
     */
    function computeBallisticPath(origin, velocity, opts) {
        const cfg = bombConfig();
        const o = opts || {};
        const stepsPerTurn = (typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.stepsPerTurn)
            ? Number(CONFIG.rules.stepsPerTurn) : 100;
        const g = ((typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.gravity != null)
            ? Number(CONFIG.rules.gravity) : 9.8)
            * (o.gravityScale != null ? Number(o.gravityScale) : (cfg.gravityScale != null ? Number(cfg.gravityScale) : 1));
        const drag = o.drag != null ? Number(o.drag) : (cfg.drag != null ? Number(cfg.drag) : 0.012);
        const groundY = o.groundY != null ? Number(o.groundY) : (cfg.groundY != null ? Number(cfg.groundY) : 0);
        const maxSteps = o.maxSteps != null ? Number(o.maxSteps) : Math.max(stepsPerTurn * 8, 400);
        const dt = 1 / Math.max(1, stepsPerTurn);

        const pos = origin.clone();
        const vel = velocity.clone();
        const points = [pos.clone()];
        let hitGround = false;
        let impact = null;
        let steps = 0;

        for (let i = 0; i < maxSteps; i++) {
            // Simple semi-implicit Euler: gravity + linear drag.
            vel.y -= g * dt;
            vel.multiplyScalar(Math.max(0, 1 - drag * dt * 60));
            const next = pos.clone().addScaledVector(vel, dt);
            steps = i + 1;

            if (next.y <= groundY && pos.y > groundY) {
                const tHit = (pos.y - groundY) / Math.max(1e-6, (pos.y - next.y));
                impact = pos.clone().lerp(next, Math.max(0, Math.min(1, tHit)));
                impact.y = groundY;
                points.push(impact.clone());
                hitGround = true;
                break;
            }
            pos.copy(next);
            points.push(pos.clone());
            if (pos.y < groundY - 2) {
                impact = pos.clone();
                impact.y = groundY;
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
        let pos = null;
        let quat = null;
        let vel = new THREE.Vector3(0, 0, 12);

        if (team.pathPoints && team.pathPoints.length >= 2 && typeof getPosAt === 'function') {
            // Drop at start of turn (immediate release after ENT).
            const p0 = getPosAt(0, team.pathPoints);
            const p1 = getPosAt(Math.min(1, 2 / Math.max(2, team.pathPoints.length - 1)), team.pathPoints);
            pos = p0.clone();
            quat = (team.pathQuats && typeof getQuatAt === 'function')
                ? getQuatAt(0, team.pathQuats)
                : (team.wrapper.userData.logicalQuat || team.wrapper.quaternion).clone();
            vel = new THREE.Vector3().subVectors(p1, p0).multiplyScalar(
                ((typeof CONFIG !== 'undefined' && CONFIG.rules && CONFIG.rules.stepsPerTurn)
                    ? Number(CONFIG.rules.stepsPerTurn) : 100) / 2
            );
        } else if (team.wrapper) {
            pos = team.wrapper.position.clone();
            quat = (team.wrapper.userData.logicalQuat || team.wrapper.quaternion).clone();
            const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(quat);
            const ap = Number(team.ap) || 100;
            vel = fwd.multiplyScalar((ap / 20) * scale);
        }

        if (pylon && pylon.localPosition && pos && quat) {
            pos.add(pylon.localPosition.clone().applyQuaternion(quat));
            pos.add(new THREE.Vector3(0, -0.08, 0.05).applyQuaternion(quat));
        }
        if (vel.lengthSq() < 1e-4) {
            const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(quat || new THREE.Quaternion());
            vel.copy(fwd.multiplyScalar(8 * scale));
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
        const line = new THREE.Line(lineGeo, lineMat);
        g.add(line);
        Bomb._previewLine = line;

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

    function ensureHud() {
        if (Bomb._previewHud) return Bomb._previewHud;
        let el = document.getElementById('bomb-ccip-hud');
        if (!el) {
            el = document.createElement('div');
            el.id = 'bomb-ccip-hud';
            el.style.cssText = [
                'position:absolute', 'left:50%', 'bottom:18%', 'transform:translateX(-50%)',
                'z-index:7500', 'pointer-events:none', 'display:none',
                'font:600 13px/1.3 Consolas,monospace', 'letter-spacing:0.04em',
                'color:#dce88a', 'text-shadow:0 0 6px #223300,0 1px 2px #000',
                'background:rgba(20,28,8,0.45)', 'padding:6px 12px', 'border:1px solid rgba(200,224,106,0.45)'
            ].join(';');
            document.body.appendChild(el);
        }
        Bomb._previewHud = el;
        return el;
    }

    function hideCcipPreview() {
        if (Bomb._previewGroup) Bomb._previewGroup.visible = false;
        const hud = Bomb._previewHud || document.getElementById('bomb-ccip-hud');
        if (hud) hud.style.display = 'none';
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
        const path = computeBallisticPath(rel.pos, rel.vel, {});
        const grp = ensurePreviewObjects();
        if (!grp) return path;

        const samples = Math.min(
            path.points.length,
            (bombConfig().previewSamples != null ? Number(bombConfig().previewSamples) : 48)
        );
        const stride = Math.max(1, Math.floor(path.points.length / samples));
        const pts = [];
        for (let i = 0; i < path.points.length; i += stride) pts.push(path.points[i]);
        if (path.impact) pts.push(path.impact.clone());
        if (Bomb._previewLine) {
            Bomb._previewLine.geometry.dispose();
            Bomb._previewLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
        }
        if (Bomb._previewImpact && path.impact) {
            Bomb._previewImpact.position.copy(path.impact);
            Bomb._previewImpact.position.y = (bombConfig().groundY != null ? Number(bombConfig().groundY) : 0) + 0.05;
        }
        if (Bomb._previewCross && path.impact) {
            Bomb._previewCross.position.copy(path.impact);
            Bomb._previewCross.position.y = (bombConfig().groundY != null ? Number(bombConfig().groundY) : 0) + 0.05;
        }
        grp.visible = true;

        const hud = ensureHud();
        const range = path.impact && team.wrapper
            ? team.wrapper.position.distanceTo(path.impact)
            : NaN;
        const fall = path.hitGround ? `${path.steps}fr` : 'NO IMPACT';
        hud.innerText = Number.isFinite(range)
            ? `CCIP  ${range.toFixed(0)}m  ·  ${fall}  ·  ENT 投放`
            : `CCIP  —  ·  ENT 投放`;
        hud.style.display = 'block';
        return path;
    }

    function ensureTeamBombs(team) {
        if (!team.activeBombs) team.activeBombs = [];
        return team.activeBombs;
    }

    /** Combat pipeline: queue armed bomb drop when SMS bomb mode + ENT. */
    function processBombDrops(ctx) {
        if (!ctx || !ctx.log) return;
        const ids = (typeof combatActiveIds === 'function')
            ? combatActiveIds()
            : Object.keys(typeof teams !== 'undefined' ? teams : {});
        ids.forEach((id) => {
            const t = teams[id];
            if (!t || t.isDestroyed || !t.pylons) return;
            ensureTeamBombs(t);
            ctx.log[`${id}BombTracks`] = ctx.log[`${id}BombTracks`] || {};
            ctx.log[`${id}BombExplodedAt`] = ctx.log[`${id}BombExplodedAt`] || {};

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
        const fuseDelay = cfg.fuseDelaySteps != null ? Number(cfg.fuseDelaySteps) : 2;
        const blastR = cfg.blastRadius != null ? Number(cfg.blastRadius) : 8;
        const damage = cfg.damage != null ? Number(cfg.damage) : 80;
        const groundY = cfg.groundY != null ? Number(cfg.groundY) : 0;
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
                        const pylon = t.pylons.find((p) => p.id === b.pylonId);
                        const rel = estimateReleaseState(
                            Object.assign({}, t, { pathPoints: t.pathPoints, pathQuats: t.pathQuats, wrapper: { position: acPos, quaternion: acQuat, userData: { logicalQuat: acQuat } }, ap: t.ap }),
                            pylon
                        );
                        // Prefer exact airframe pose at launch step.
                        b.pos.copy(acPos);
                        if (pylon && pylon.localPosition) {
                            b.pos.add(pylon.localPosition.clone().applyQuaternion(acQuat));
                            b.pos.add(new THREE.Vector3(0, -0.08, 0.05).applyQuaternion(acQuat));
                        }
                        b.quat.copy(acQuat);
                        if (rel.vel) b.vel.copy(rel.vel);
                        else {
                            b.vel.copy(new THREE.Vector3(0, 0, 1).applyQuaternion(acQuat).multiplyScalar(10));
                        }
                        if (!tracks[b.pylonId]) tracks[b.pylonId] = [];
                        tracks[b.pylonId].push({ pos: b.pos.clone(), quat: b.quat.clone() });
                        return;
                    }
                }

                // One ballistic micro-step (matches computeBallisticPath dt).
                const stepsPerTurn = (CONFIG.rules && CONFIG.rules.stepsPerTurn) || 100;
                const dt = 1 / stepsPerTurn;
                const g = (CONFIG.rules.gravity != null ? Number(CONFIG.rules.gravity) : 9.8)
                    * (cfg.gravityScale != null ? Number(cfg.gravityScale) : 1);
                const drag = cfg.drag != null ? Number(cfg.drag) : 0.012;
                const oldPos = b.pos.clone();
                b.vel.y -= g * dt;
                b.vel.multiplyScalar(Math.max(0, 1 - drag * dt * 60));
                b.pos.addScaledVector(b.vel, dt);
                // Align nose with velocity.
                if (b.vel.lengthSq() > 1e-6) {
                    const look = b.vel.clone().normalize();
                    const q = new THREE.Quaternion();
                    q.setFromUnitVectors(new THREE.Vector3(0, 0, 1), look);
                    b.quat.copy(q);
                }

                let hit = false;
                if (b.pos.y <= groundY && oldPos.y > groundY) {
                    const tHit = (oldPos.y - groundY) / Math.max(1e-6, (oldPos.y - b.pos.y));
                    b.pos.copy(oldPos).lerp(b.pos, Math.max(0, Math.min(1, tHit)));
                    b.pos.y = groundY;
                    hit = true;
                }

                // Building collision (same ray idea as missiles).
                if (!hit && typeof obstacles !== 'undefined' && obstacles.length > 0) {
                    const moveVec = new THREE.Vector3().subVectors(b.pos, oldPos);
                    const dist = moveVec.length();
                    if (dist > 1e-4) {
                        const ray = new THREE.Raycaster(oldPos, moveVec.normalize());
                        const hits = ray.intersectObjects(obstacles, false);
                        if (hits.length && hits[0].distance <= dist) {
                            b.pos.copy(hits[0].point);
                            hit = true;
                        }
                    }
                }

                if (!tracks[b.pylonId]) tracks[b.pylonId] = [];
                tracks[b.pylonId].push({ pos: b.pos.clone(), quat: b.quat.clone() });

                if (hit && step >= (b.launchStep + fuseDelay)) {
                    b.exploded = true;
                    b.hitGround = true;
                    explodedAt[b.pylonId] = step;
                    ctx.log.vfxTriggers.push({
                        type: 'explosion', step, pos: b.pos.clone(),
                        rot: Math.random() * Math.PI * 2, scale: 1.8
                    });
                    ctx.log.vfxTriggers.push({
                        type: 'flash', step, pos: b.pos.clone(),
                        rot: Math.random() * Math.PI * 2, scale: 2.2
                    });
                    // Soft blast vs any aircraft in radius (ground targets deferred).
                    ids.forEach((vid) => {
                        if (vid === id) return;
                        const vt = teams[vid];
                        if (!vt || vt.isDestroyed || !vt.pathPoints) return;
                        const vPos = (typeof getPosAt === 'function')
                            ? getPosAt(ratio, vt.pathPoints)
                            : (vt.wrapper && vt.wrapper.position);
                        if (!vPos) return;
                        if (b.pos.distanceTo(vPos) <= blastR) {
                            if (ctx.hp[vid] != null) {
                                ctx.hp[vid] = Math.max(0, ctx.hp[vid] - damage);
                                if (ctx.log.hpTrack && ctx.log.hpTrack[vid]) {
                                    ctx.log.hpTrack[vid][step] = (ctx.log.hpTrack[vid][step] || 0) + damage;
                                }
                            }
                        }
                    });
                }
            });
        });
    }

    /** Replay / live combat visual for bombs in flight. */
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
                const wt = (typeof pylonWeaponType === 'function') ? pylonWeaponType(p) : p.weaponType;
                if (!isBombType(wt) && !(tracks[p.id] && tracks[p.id].length)) {
                    if (p.bombFlyingMesh) p.bombFlyingMesh.visible = false;
                    return;
                }
                const track = tracks[p.id] && tracks[p.id][step];
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
                } else if (p.bombFlyingMesh) {
                    p.bombFlyingMesh.visible = false;
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
