// ============================================================================
// replay-director.js — Automatic ACMI Replay Camera & Aircraft Director
// Works seamlessly for 1v1 (2-plane) and multi-aircraft (2v2 / N-plane) battles.
// Deterministic & scrub-safe: builds a storyboard from battleLog, scores action
// beats (kills, missiles, gun bursts, ground strikes, dogfights, multi-plane
// furballs), enforces anti-thrash hold/hysteresis + roster fairness, and renders
// 6 collision-safe cinematic camera archetypes.
// ============================================================================
(function initAirArenaReplayDirector(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.AirArenaReplayDirector = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
    'use strict';

    const KNOWN_SEATS = ['red', 'red2', 'blue', 'blue2'];
    const CAMERA_MODES = [
        'chase_cinematic',
        'over_shoulder',
        'dogfight_pair',
        'missile',
        'flyby_hero',
        'tactical_wide'
    ];

    const MODE_LABELS = {
        chase_cinematic: '尾隨追擊',
        over_shoulder: '越肩鎖定',
        dogfight_pair: '纏鬥雙機',
        missile: '飛彈追蹤',
        flyby_hero: '機側掠影',
        tactical_wide: '戰術全景'
    };

    const REASON_LABELS = {
        kill_missile: '飛彈擊殺',
        kill_gun: '機砲擊殺',
        kill_crash: '墜毀瞬間',
        missile_intercept: '飛彈逼近',
        missile_launch: '飛彈發射',
        gun_hit: '機砲命中',
        gun_burst: '機砲掃射',
        ground_strike: '對地打擊',
        dogfight_merge: '近距纏鬥',
        opening_overview: '開場態勢',
        furball_overview: '多機混戰',
        maneuver: '機動追蹤',
        seat_lock: '鎖定機位'
    };

    const DEFAULT_CFG = {
        enabledByDefault: true,
        minHoldTurns: 0.85,
        criticalHoldTurns: 0.35,
        maxHoldTurns: 2.5,
        hysteresisMargin: 13,
        closeDogfightRange: 44,
        missileThreatRange: 38,
        minTerrainAltitude: 2.0,
        baseFov: 60
    };

    function getCfg() {
        const user = (typeof CONFIG !== 'undefined' && CONFIG && CONFIG.replayDirector)
            ? CONFIG.replayDirector
            : null;
        return user ? Object.assign({}, DEFAULT_CFG, user) : DEFAULT_CFG;
    }

    function factionOf(id) {
        if (typeof GameContext !== 'undefined' && GameContext && typeof GameContext.getFaction === 'function') {
            return GameContext.getFaction(id);
        }
        return String(id || '').startsWith('blue') ? 'blue' : 'red';
    }

    function seatLabel(id) {
        if (!id) return '全場';
        const map = { red: 'RED-1', red2: 'RED-2', blue: 'BLUE-1', blue2: 'BLUE-2' };
        return map[id] || String(id).toUpperCase();
    }

    // Minimal vector helpers (work both in browser with THREE and in Node tests with stubbed/plain vectors)
    function vSub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
    function vAdd(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }
    function vScale(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }
    function vLenSq(a) { return a.x * a.x + a.y * a.y + a.z * a.z; }
    function vLen(a) { return Math.sqrt(vLenSq(a)); }
    function vDist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }
    function vNorm(a, fallback) {
        const l = vLen(a);
        if (l < 1e-6) return fallback ? { x: fallback.x, y: fallback.y, z: fallback.z } : { x: 0, y: 0, z: 1 };
        return { x: a.x / l, y: a.y / l, z: a.z / l };
    }
    function vDot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }
    function vCross(a, b) {
        return {
            x: a.y * b.z - a.z * b.y,
            y: a.z * b.x - a.x * b.z,
            z: a.x * b.y - a.y * b.x
        };
    }
    function vApplyQuat(v, q) {
        if (!q) return { x: v.x, y: v.y, z: v.z };
        const x = v.x, y = v.y, z = v.z;
        const qx = q.x || 0, qy = q.y || 0, qz = q.z || 0, qw = (q.w != null ? q.w : 1);
        const ix = qw * x + qy * z - qz * y;
        const iy = qw * y + qz * x - qx * z;
        const iz = qw * z + qx * y - qy * x;
        const iw = -qx * x - qy * y - qz * z;
        return {
            x: ix * qw + iw * -qx + iy * -qz - iz * -qy,
            y: iy * qw + iw * -qy + iz * -qx - ix * -qz,
            z: iz * qw + iw * -qz + ix * -qy - iy * -qx
        };
    }
    function samplePos(pts, ratio) {
        if (!Array.isArray(pts) || !pts.length) return null;
        if (pts.length === 1) return { x: pts[0].x, y: pts[0].y, z: pts[0].z };
        const r = Math.max(0, Math.min(1, ratio));
        const f = r * (pts.length - 1);
        const i0 = Math.min(pts.length - 1, Math.floor(f));
        const i1 = Math.min(pts.length - 1, i0 + 1);
        const t = f - i0;
        const a = pts[i0], b = pts[i1];
        return {
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t,
            z: a.z + (b.z - a.z) * t
        };
    }
    function sampleQuat(quats, ratio) {
        if (!Array.isArray(quats) || !quats.length) return { x: 0, y: 0, z: 0, w: 1 };
        const r = Math.max(0, Math.min(1, ratio));
        const idx = Math.min(quats.length - 1, Math.round(r * (quats.length - 1)));
        const q = quats[idx];
        return q ? { x: q.x || 0, y: q.y || 0, z: q.z || 0, w: q.w != null ? q.w : 1 } : { x: 0, y: 0, z: 0, w: 1 };
    }

    /** Discover every aircraft seat ID present across the battleLog (1v1, 2v1, 2v2, N-plane). */
    function discoverRoster(battleLog, seatIdsOverride) {
        if (Array.isArray(seatIdsOverride) && seatIdsOverride.length) {
            return seatIdsOverride.slice();
        }
        const seen = Object.create(null);
        const ordered = [];
        const add = (id) => {
            if (!id || seen[id]) return;
            seen[id] = 1;
            ordered.push(id);
        };
        if (Array.isArray(battleLog)) {
            for (let t = 0; t < battleLog.length; t++) {
                const log = battleLog[t];
                if (!log || typeof log !== 'object') continue;
                for (let k = 0; k < KNOWN_SEATS.length; k++) {
                    const id = KNOWN_SEATS[k];
                    if (log[id] && Array.isArray(log[id].pts) && log[id].pts.length >= 2) add(id);
                }
                const keys = Object.keys(log);
                for (let k = 0; k < keys.length; k++) {
                    const key = keys[k];
                    if (seen[key]) continue;
                    const blk = log[key];
                    if (blk && typeof blk === 'object' && Array.isArray(blk.pts) && blk.pts.length >= 2 && Array.isArray(blk.quats)) {
                        add(key);
                    }
                }
            }
        }
        return ordered;
    }

    function getDeathStep(log, id) {
        if (!log || !log.destroyed) return -1;
        const d = log.destroyed[id];
        if (typeof d === 'number' && Number.isFinite(d) && d >= 0) return d;
        if (d === true) {
            if (log.killedBy && log.killedBy[id] && typeof log.killedBy[id].step === 'number') {
                return log.killedBy[id].step;
            }
            if (log.hpTrack && Array.isArray(log.hpTrack[id]) && log.hpTrack[id].length > 0) {
                const hpArr = log.hpTrack[id];
                if (Number(hpArr[0]) <= 0) return -1; // Already destroyed before this turn began.
                for (let k = 1; k < hpArr.length; k++) {
                    if (Number(hpArr[k]) <= 0) return k;
                }
            }
            return 50;
        }
        return -1;
    }

    function isSeatAliveAt(log, id, step) {
        if (!log || !log[id] || !Array.isArray(log[id].pts) || log[id].pts.length < 2) return false;
        const dStep = getDeathStep(log, id);
        if (dStep >= 0 && step > dStep + 22) return false;
        return true;
    }

    /** Collect active airborne missiles for `log` at `step`. */
    function findActiveMissiles(log, roster, step) {
        const out = [];
        for (let i = 0; i < roster.length; i++) {
            const ownerId = roster[i];
            const tracksMap = log[`${ownerId}MslTracks`];
            if (!tracksMap || typeof tracksMap !== 'object') continue;
            const explodedMap = log[`${ownerId}ExplodedAt`] || {};
            const selfDestructMap = log[`${ownerId}MslIsSelfDestruct`] || {};
            const pylonIds = Object.keys(tracksMap);
            for (let p = 0; p < pylonIds.length; p++) {
                const pid = pylonIds[p];
                const track = tracksMap[pid];
                if (!Array.isArray(track) || !track.length) continue;
                const expStep = (typeof explodedMap[pid] === 'number') ? explodedMap[pid] : -1;
                if (expStep >= 0 && step > expStep + 28) continue;
                const sampleIdx = (expStep >= 0 && step > expStep)
                    ? Math.min(track.length - 1, Math.max(0, Math.floor(expStep)))
                    : Math.min(track.length - 1, Math.max(0, Math.floor(step)));
                const pt = track[sampleIdx];
                if (!pt || !pt.pos) continue;
                out.push({
                    ownerId,
                    pylonId: pid,
                    key: `${ownerId}:${pid}`,
                    pos: pt.pos,
                    quat: pt.quat || { x: 0, y: 0, z: 0, w: 1 },
                    expStep,
                    justExploded: expStep >= 0 && step >= expStep,
                    isSelfDestruct: !!selfDestructMap[pid]
                });
            }
        }
        return out;
    }

    /** Collect active bombs / rockets or ground explosions in `log` around `step`. */
    function findGroundStrikeAction(log, roster, step) {
        let best = null;
        if (Array.isArray(log.vfxTriggers)) {
            for (let i = 0; i < log.vfxTriggers.length; i++) {
                const tr = log.vfxTriggers[i];
                if (!tr || tr.type !== 'ground_explosion' || !tr.pos) continue;
                const tStep = Number(tr.step) || 0;
                const delta = step - tStep;
                if (delta >= -18 && delta <= 42) {
                    const score = 76 - Math.abs(delta) * 0.45;
                    if (!best || score > best.score) {
                        best = { score, pos: tr.pos, step: tStep, ownerId: null };
                    }
                }
            }
        }
        // Check if any aircraft fired bomb/rocket this turn
        for (let i = 0; i < roster.length; i++) {
            const id = roster[i];
            const chain = log[id] && log[id].chain;
            const fire = chain && chain[0] && chain[0].fire;
            if (fire === 'bomb' || fire === 'rocket') {
                if (best && !best.ownerId) best.ownerId = id;
                else if (!best && step <= 70) {
                    const p = samplePos(log[id].pts, step / 100);
                    best = { score: 56, pos: p, step, ownerId: id };
                }
            }
        }
        return best;
    }

    /**
     * Evaluate all candidate cinematic shots for a single time slice `(turnIdx, progress)`.
     * Returns sorted list of candidate shots (highest priority first).
     */
    function evaluateSliceCandidates(battleLog, turnIdx, progress, roster, screenTime, lastShot) {
        const log = battleLog[turnIdx];
        if (!log) return [];
        const cfg = getCfg();
        const step = Math.round(progress * 100);
        const candidates = [];

        // Gather live aircraft poses at this beat
        const liveIds = [];
        const posById = Object.create(null);
        const quatById = Object.create(null);
        for (let i = 0; i < roster.length; i++) {
            const id = roster[i];
            if (!isSeatAliveAt(log, id, step)) continue;
            const p = samplePos(log[id].pts, progress);
            if (!p) continue;
            liveIds.push(id);
            posById[id] = p;
            quatById[id] = sampleQuat(log[id].quats, progress);
        }
        if (!liveIds.length) return [];

        const isMultiPlane = liveIds.length >= 3;
        const avgScreenTime = liveIds.reduce((acc, id) => acc + (screenTime[id] || 0), 0) / liveIds.length;
        const fairnessBonus = (id) => {
            if (!id || liveIds.length <= 1) return 0;
            const diff = avgScreenTime - (screenTime[id] || 0);
            return Math.max(-6, Math.min(10, diff * 4.5));
        };

        // Nearest hostile lookup per live aircraft
        const nearestHostile = Object.create(null);
        let closestPair = null;
        for (let i = 0; i < liveIds.length; i++) {
            const a = liveIds[i];
            const fa = factionOf(a);
            let bestDist = Infinity;
            let bestId = null;
            for (let j = 0; j < liveIds.length; j++) {
                if (i === j) continue;
                const b = liveIds[j];
                if (factionOf(b) === fa) continue;
                const d = vDist(posById[a], posById[b]);
                if (d < bestDist) {
                    bestDist = d;
                    bestId = b;
                }
            }
            if (bestId) {
                nearestHostile[a] = { id: bestId, dist: bestDist };
                if (!closestPair || bestDist < closestPair.dist) {
                    closestPair = { a, b: bestId, dist: bestDist };
                }
            }
        }

        // 1) Kills / crashes in this turn (highest drama!)
        for (let i = 0; i < roster.length; i++) {
            const victim = roster[i];
            if (!log[victim] || !Array.isArray(log[victim].pts) || log[victim].pts.length < 2) continue;
            // Skip aircraft that were already destroyed in an earlier turn (e.g. 2v2 post-kill turns).
            const prevLog = turnIdx > 0 ? battleLog[turnIdx - 1] : null;
            if (prevLog && prevLog.destroyed && prevLog.destroyed[victim]
                && !(log.destroyed && typeof log.destroyed[victim] === 'number')) {
                continue;
            }
            const dStep = getDeathStep(log, victim);
            if (dStep < 0) continue;
            const delta = step - dStep;
            if (delta >= -28 && delta <= 55) {
                const kb = log.killedBy && log.killedBy[victim];
                const killerId = kb && (kb.attackerId || kb.by);
                const killer = (killerId && posById[killerId]) ? killerId : null;
                const cause = (kb && kb.weapon) || (log.deathCause && log.deathCause[victim]) || 'crash';
                const killPos = samplePos(log[victim] && log[victim].pts, Math.min(1, dStep / 100));
                if (!killPos) continue;
                if (cause === 'gun' && killer) {
                    candidates.push({
                        priority: 98,
                        primaryId: killer,
                        secondaryId: victim,
                        mode: 'over_shoulder',
                        reason: 'kill_gun',
                        impactPos: killPos,
                        critical: true
                    });
                } else if ((cause === 'fox2' || cause === 'fox1' || cause === 'missile') && killer) {
                    // Try matching the killing missile
                    const activeMsls = findActiveMissiles(log, [killer], step);
                    const matchMsl = activeMsls.length ? activeMsls[0] : null;
                    candidates.push({
                        priority: 100,
                        primaryId: victim,
                        secondaryId: killer,
                        mode: matchMsl ? 'missile' : 'flyby_hero',
                        missileKey: matchMsl ? matchMsl.key : null,
                        reason: 'kill_missile',
                        impactPos: killPos,
                        critical: true
                    });
                } else {
                    candidates.push({
                        priority: 94,
                        primaryId: victim,
                        secondaryId: killer,
                        mode: 'flyby_hero',
                        reason: 'kill_crash',
                        impactPos: killPos,
                        critical: true
                    });
                }
            }
        }

        // 2) Active airborne missiles (intercept & launch drama)
        const activeMissiles = findActiveMissiles(log, roster, step);
        for (let i = 0; i < activeMissiles.length; i++) {
            const m = activeMissiles[i];
            if (m.isSelfDestruct && m.justExploded) continue;
            const ownerFac = factionOf(m.ownerId);
            let targetId = null;
            let bestD = Infinity;
            for (let j = 0; j < liveIds.length; j++) {
                const cand = liveIds[j];
                if (factionOf(cand) === ownerFac) continue;
                const d = vDist(m.pos, posById[cand]);
                if (d < bestD) { bestD = d; targetId = cand; }
            }
            if (m.justExploded && bestD < 25) {
                candidates.push({
                    priority: 88,
                    primaryId: targetId || m.ownerId,
                    secondaryId: m.ownerId,
                    mode: 'missile',
                    missileKey: m.key,
                    reason: 'missile_intercept',
                    impactPos: m.pos,
                    critical: true
                });
            } else if (bestD <= cfg.missileThreatRange) {
                candidates.push({
                    priority: 78 + Math.max(0, (cfg.missileThreatRange - bestD) * 0.25),
                    primaryId: targetId || m.ownerId,
                    secondaryId: m.ownerId,
                    mode: 'missile',
                    missileKey: m.key,
                    reason: 'missile_intercept',
                    critical: bestD < 16
                });
            } else if (step <= 38) {
                candidates.push({
                    priority: 62 + fairnessBonus(m.ownerId),
                    primaryId: m.ownerId,
                    secondaryId: targetId,
                    mode: 'missile',
                    missileKey: m.key,
                    reason: 'missile_launch'
                });
            }
        }

        // 3) Active autocannon bursts & gun hits
        for (let i = 0; i < liveIds.length; i++) {
            const id = liveIds[i];
            const entry = log[id];
            const fire = entry && entry.chain && entry.chain[0] && entry.chain[0].fire;
            if (fire !== 'gun') continue;
            const nh = nearestHostile[id];
            const tgt = nh ? nh.id : null;
            const tgtEntry = tgt ? log[tgt] : null;
            const dmgSteps = (tgtEntry && Array.isArray(tgtEntry.damageSteps)) ? tgtEntry.damageSteps : [];
            let hitNow = false;
            for (let k = 0; k < dmgSteps.length; k++) {
                if (Math.abs(dmgSteps[k] - step) <= 18) { hitNow = true; break; }
            }
            if (hitNow && tgt) {
                candidates.push({
                    priority: 85 + fairnessBonus(id) * 0.5,
                    primaryId: id,
                    secondaryId: tgt,
                    mode: 'over_shoulder',
                    reason: 'gun_hit',
                    critical: true
                });
            } else if (nh && nh.dist < 82) {
                candidates.push({
                    priority: 68 + fairnessBonus(id),
                    primaryId: id,
                    secondaryId: tgt,
                    mode: 'over_shoulder',
                    reason: 'gun_burst'
                });
            }
        }

        // 4) Ground strikes (bombs / rockets / ground explosions)
        const gs = findGroundStrikeAction(log, roster, step);
        if (gs) {
            candidates.push({
                priority: gs.score,
                primaryId: gs.ownerId || liveIds[0],
                secondaryId: null,
                mode: 'flyby_hero',
                reason: 'ground_strike',
                impactPos: gs.pos
            });
        }

        // 5) Close dogfight pair framing (1v1 merge or active duel inside 2v2)
        if (closestPair && closestPair.dist <= cfg.closeDogfightRange) {
            const closeness = 1 - (closestPair.dist / cfg.closeDogfightRange);
            // Pick attacker (the one pointing closer to the other) as primary
            const fwdA = vApplyQuat({ x: 0, y: 0, z: 1 }, quatById[closestPair.a]);
            const fwdB = vApplyQuat({ x: 0, y: 0, z: 1 }, quatById[closestPair.b]);
            const aToB = vNorm(vSub(posById[closestPair.b], posById[closestPair.a]));
            const dotA = vDot(fwdA, aToB);
            const dotB = vDot(fwdB, vScale(aToB, -1));
            const primary = dotA >= dotB ? closestPair.a : closestPair.b;
            const secondary = primary === closestPair.a ? closestPair.b : closestPair.a;
            candidates.push({
                priority: 56 + closeness * 16 + fairnessBonus(primary) * 0.6,
                primaryId: primary,
                secondaryId: secondary,
                mode: dotA > 0.72 || dotB > 0.72 ? 'over_shoulder' : 'dogfight_pair',
                reason: 'dogfight_merge'
            });
        }

        // 6) Multi-aircraft tactical wide overview (great for opening turn & 2v2 furball context)
        if (turnIdx === 0 && progress < 0.55) {
            candidates.push({
                priority: isMultiPlane ? 64 : 58,
                primaryId: liveIds[0],
                secondaryId: liveIds[1] || null,
                mode: 'tactical_wide',
                reason: 'opening_overview'
            });
        } else if (isMultiPlane) {
            // Count how many distinct hostile pairs are engaged (< 75m)
            let engagedCount = 0;
            for (let i = 0; i < liveIds.length; i++) {
                const nh = nearestHostile[liveIds[i]];
                if (nh && nh.dist < 75) engagedCount++;
            }
            const wideBoost = engagedCount >= 3 ? 58 : 44;
            const repeatPenalty = (lastShot && lastShot.mode === 'tactical_wide') ? -10 : 0;
            candidates.push({
                priority: wideBoost + repeatPenalty,
                primaryId: liveIds[0],
                secondaryId: liveIds[1] || null,
                mode: 'tactical_wide',
                reason: 'furball_overview'
            });
        }

        // 7) Fallback solo cinematic angles (rotates across ALL live aircraft fairly!)
        const soloModes = ['chase_cinematic', 'flyby_hero', 'dogfight_pair', 'tactical_wide'];
        for (let i = 0; i < liveIds.length; i++) {
            const id = liveIds[i];
            const nh = nearestHostile[id];
            const modeIdx = (turnIdx + i) % soloModes.length;
            let chosenMode = soloModes[modeIdx];
            if (chosenMode === 'dogfight_pair' && (!nh || nh.dist > 95)) {
                chosenMode = 'chase_cinematic';
            }
            const varietyAdj = (lastShot && lastShot.mode === chosenMode) ? -6 : 3;
            candidates.push({
                priority: 36 + fairnessBonus(id) + varietyAdj,
                primaryId: id,
                secondaryId: nh ? nh.id : null,
                mode: chosenMode,
                reason: 'maneuver'
            });
        }

        candidates.sort((a, b) => b.priority - a.priority);
        return candidates;
    }

    /**
     * Build a deterministic, scrub-safe storyboard covering the entire battleLog.
     * Supports 1v1 (2 aircraft) and multi-aircraft (2v2 / N-plane) seamlessly.
     */
    function analyzeTimeline(battleLog, seatIdsOverride) {
        const roster = discoverRoster(battleLog, seatIdsOverride);
        if (!Array.isArray(battleLog) || !battleLog.length || !roster.length) {
            return { roster, shots: [], turnCount: 0 };
        }
        const cfg = getCfg();
        const beatsPerTurn = 4; // 0.25-turn resolution
        const stepDt = 1 / beatsPerTurn;
        const screenTime = Object.create(null);
        roster.forEach((id) => { screenTime[id] = 0; });

        const shots = [];
        let current = null;

        for (let turnIdx = 0; turnIdx < battleLog.length; turnIdx++) {
            for (let b = 0; b < beatsPerTurn; b++) {
                const progress = b / beatsPerTurn;
                const time = 1.0 + turnIdx + progress;
                const cands = evaluateSliceCandidates(battleLog, turnIdx, progress, roster, screenTime, current);
                if (!cands.length) continue;

                const top = cands[0];
                if (!current) {
                    current = Object.assign({
                        startTime: time,
                        endTime: time + stepDt,
                        focusTurnIdx: turnIdx
                    }, top);
                    shots.push(current);
                } else {
                    const held = time - current.startTime;
                    const sameFocus = current.primaryId === top.primaryId
                        && current.mode === top.mode
                        && (current.missileKey || null) === (top.missileKey || null);

                    // Find how well the current shot still scores at this beat
                    let currentStillValid = false;
                    let currentScore = 0;
                    for (let k = 0; k < cands.length; k++) {
                        const c = cands[k];
                        if (c.primaryId === current.primaryId && c.mode === current.mode) {
                            currentStillValid = true;
                            currentScore = c.priority;
                            break;
                        }
                    }

                    let shouldCut = false;
                    if (!currentStillValid) {
                        shouldCut = true;
                    } else if (sameFocus) {
                        // Refresh impactPos/secondary/reason as shot escalates (e.g. missile_intercept -> kill_missile)
                        if (top.priority >= current.priority && top.reason) current.reason = top.reason;
                        current.priority = Math.max(current.priority * 0.92, top.priority);
                        if (top.impactPos) current.impactPos = top.impactPos;
                        if (top.secondaryId) current.secondaryId = top.secondaryId;
                        if (held >= cfg.maxHoldTurns) {
                            // Gently cycle angle or aircraft on long quiet stretches
                            const alt = cands.find((c) => c.mode !== current.mode || c.primaryId !== current.primaryId);
                            if (alt) {
                                current.endTime = time;
                                current = Object.assign({
                                    startTime: time,
                                    endTime: time + stepDt,
                                    focusTurnIdx: turnIdx
                                }, alt);
                                shots.push(current);
                            }
                        }
                    } else if (top.critical && held >= cfg.criticalHoldTurns && top.priority > currentScore + 6) {
                        shouldCut = true;
                    } else if (held >= cfg.minHoldTurns && top.priority >= currentScore + cfg.hysteresisMargin) {
                        shouldCut = true;
                    } else if (held >= cfg.maxHoldTurns) {
                        shouldCut = true;
                    }

                    if (shouldCut) {
                        current.endTime = time;
                        current = Object.assign({
                            startTime: time,
                            endTime: time + stepDt,
                            focusTurnIdx: turnIdx
                        }, top);
                        shots.push(current);
                    } else {
                        current.endTime = time + stepDt;
                    }
                }

                // Accumulate screen time for multi-plane fairness
                if (current && current.primaryId && screenTime[current.primaryId] != null) {
                    screenTime[current.primaryId] += stepDt;
                }
            }
        }

        if (shots.length) {
            shots[shots.length - 1].endTime = battleLog.length + 1.05;
        }
        return { roster, shots, turnCount: battleLog.length };
    }

    /** Deterministic O(log N) lookup of the active shot at `replayTime`. */
    function getShotAt(storyboard, replayTime) {
        if (!storyboard || !Array.isArray(storyboard.shots) || !storyboard.shots.length) return null;
        const shots = storyboard.shots;
        let lo = 0, hi = shots.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const s = shots[mid];
            if (replayTime < s.startTime) hi = mid - 1;
            else if (replayTime >= s.endTime) lo = mid + 1;
            else return s;
        }
        return shots[Math.max(0, Math.min(shots.length - 1, hi))];
    }

    /** Sample live world position & quaternion of an aircraft at `(turnIdx, progress)`. */
    function sampleAircraftPose(log, id, progress) {
        if (!log || !log[id] || !Array.isArray(log[id].pts) || !log[id].pts.length) return null;
        const pos = samplePos(log[id].pts, progress);
        const quat = sampleQuat(log[id].quats, progress);
        const fwd = vNorm(vApplyQuat({ x: 0, y: 0, z: 1 }, quat), { x: 0, y: 0, z: 1 });
        const up = vNorm(vApplyQuat({ x: 0, y: 1, z: 0 }, quat), { x: 0, y: 1, z: 0 });
        const right = vNorm(vCross(up, fwd), { x: 1, y: 0, z: 0 });
        return { pos, quat, fwd, up, right };
    }

    /** Sample live missile pose by `missileKey` (`ownerId:pylonId`). */
    function sampleMissilePose(log, missileKey, progress) {
        if (!log || !missileKey) return null;
        const parts = String(missileKey).split(':');
        if (parts.length < 2) return null;
        const ownerId = parts[0], pylonId = parts.slice(1).join(':');
        const tracksMap = log[`${ownerId}MslTracks`];
        const track = tracksMap && tracksMap[pylonId];
        if (!Array.isArray(track) || !track.length) return null;
        const expMap = log[`${ownerId}ExplodedAt`] || {};
        const expStep = (typeof expMap[pylonId] === 'number') ? expMap[pylonId] : -1;
        const step = progress * 100;
        const idx = (expStep >= 0 && step > expStep)
            ? Math.min(track.length - 1, Math.max(0, Math.floor(expStep)))
            : Math.min(track.length - 1, Math.max(0, Math.floor(step)));
        const pt = track[idx];
        if (!pt || !pt.pos) return null;
        const q = pt.quat || { x: 0, y: 0, z: 0, w: 1 };
        const fwd = vNorm(vApplyQuat({ x: 0, y: 0, z: 1 }, q), { x: 0, y: 0, z: 1 });
        return {
            pos: { x: pt.pos.x, y: pt.pos.y, z: pt.pos.z },
            quat: q,
            fwd,
            exploded: expStep >= 0 && step >= expStep
        };
    }

    // Scratch Three.js objects for zero-GC LOS raycast in browser
    let _raycaster = null;
    let _rayOrig = null;
    let _rayDir = null;

    function avoidObstacleCollision(targetPos, camPos, obstaclesRef) {
        const cfg = getCfg();
        if (camPos.y < cfg.minTerrainAltitude) camPos.y = cfg.minTerrainAltitude;
        if (typeof THREE === 'undefined' || !Array.isArray(obstaclesRef) || !obstaclesRef.length) {
            return camPos;
        }
        if (!_raycaster) {
            _raycaster = new THREE.Raycaster();
            _rayOrig = new THREE.Vector3();
            _rayDir = new THREE.Vector3();
        }
        const dx = camPos.x - targetPos.x;
        const dy = camPos.y - targetPos.y;
        const dz = camPos.z - targetPos.z;
        const dist = Math.hypot(dx, dy, dz);
        if (dist < 1.5) return camPos;
        _rayOrig.set(targetPos.x, targetPos.y, targetPos.z);
        _rayDir.set(dx / dist, dy / dist, dz / dist);
        _raycaster.set(_rayOrig, _rayDir);
        _raycaster.near = 0.8;
        _raycaster.far = dist;
        const hits = _raycaster.intersectObjects(obstaclesRef, false);
        if (hits && hits.length > 0 && hits[0].distance < dist - 0.6) {
            // Pull camera forward in front of blocking facade and slightly lift for clean sightline
            const safeDist = Math.max(2.6, hits[0].distance - 1.1);
            const frac = safeDist / dist;
            camPos.x = targetPos.x + dx * frac;
            camPos.y = Math.max(cfg.minTerrainAltitude, targetPos.y + dy * frac + 0.9);
            camPos.z = targetPos.z + dz * frac;
        }
        return camPos;
    }

    /**
     * Compute exact world-space `{ camPos, targetPos, fov }` for the given shot.
     */
    function computeShotPose(shot, battleLog, turnIdx, progress, obstaclesRef) {
        const log = battleLog && battleLog[turnIdx];
        const cfg = getCfg();
        const baseFov = cfg.baseFov;
        if (!log || !shot) return null;

        const replayTime = 1.0 + turnIdx + progress;
        const shotElapsed = Math.max(0, replayTime - (shot.startTime || replayTime));
        const mode = shot.mode || 'chase_cinematic';

        const p1 = sampleAircraftPose(log, shot.primaryId, progress);
        const p2 = shot.secondaryId ? sampleAircraftPose(log, shot.secondaryId, progress) : null;

        let camPos = null;
        let targetPos = null;
        let fov = baseFov;

        // 1) Tactical Wide Overview — auto-fits ALL live aircraft (1v1, 2v2, N-plane)
        if (mode === 'tactical_wide') {
            const roster = discoverRoster([log]);
            const pts = [];
            for (let i = 0; i < roster.length; i++) {
                const pose = sampleAircraftPose(log, roster[i], progress);
                if (pose) pts.push(pose.pos);
            }
            if (!pts.length && p1) pts.push(p1.pos);
            if (!pts.length) return null;

            let cx = 0, cy = 0, cz = 0;
            for (let i = 0; i < pts.length; i++) {
                cx += pts[i].x; cy += pts[i].y; cz += pts[i].z;
            }
            cx /= pts.length; cy /= pts.length; cz /= pts.length;
            let maxR = 12;
            for (let i = 0; i < pts.length; i++) {
                const r = Math.hypot(pts[i].x - cx, pts[i].y - cy, pts[i].z - cz);
                if (r > maxR) maxR = r;
            }
            const orbitDist = Math.max(26, Math.min(115, maxR * 1.95 + 18));
            const az = 0.65 + replayTime * 0.22;
            targetPos = { x: cx, y: Math.max(4, cy), z: cz };
            camPos = {
                x: cx + Math.cos(az) * orbitDist,
                y: Math.max(cfg.minTerrainAltitude + 10, cy + orbitDist * 0.56),
                z: cz + Math.sin(az) * orbitDist
            };
            fov = 56;
        }
        // 2) Missile Chase / Intercept Cam
        else if (mode === 'missile') {
            const mp = sampleMissilePose(log, shot.missileKey, progress);
            if (mp) {
                const aim = (p1 && !mp.exploded) ? p1.pos : (shot.impactPos || mp.pos);
                const toAim = vNorm(vSub(aim, mp.pos), mp.fwd);
                const backDir = mp.exploded
                    ? vNorm({ x: Math.cos(replayTime * 0.8), y: 0.35, z: Math.sin(replayTime * 0.8) })
                    : vNorm({ x: -mp.fwd.x * 0.85 - toAim.x * 0.15, y: 0.28, z: -mp.fwd.z * 0.85 - toAim.z * 0.15 });
                const dist = mp.exploded ? (11 + shotElapsed * 6) : 7.2;
                camPos = vAdd(mp.pos, vScale(backDir, dist));
                targetPos = mp.exploded
                    ? mp.pos
                    : {
                        x: mp.pos.x * 0.55 + aim.x * 0.45,
                        y: mp.pos.y * 0.55 + aim.y * 0.45,
                        z: mp.pos.z * 0.55 + aim.z * 0.45
                    };
                fov = 54;
            }
        }
        // 3) Over-the-Shoulder Gun / Attack Cam
        else if (mode === 'over_shoulder' && p1) {
            const aim = p2 ? p2.pos : (shot.impactPos || vAdd(p1.pos, vScale(p1.fwd, 40)));
            const axis = vNorm(vSub(aim, p1.pos), p1.fwd);
            const side = vNorm(vCross({ x: 0, y: 1, z: 0 }, axis), p1.right);
            camPos = {
                x: p1.pos.x - axis.x * 7.2 + side.x * 1.8,
                y: p1.pos.y - axis.y * 7.2 + 1.9,
                z: p1.pos.z - axis.z * 7.2 + side.z * 1.8
            };
            targetPos = {
                x: p1.pos.x * 0.35 + aim.x * 0.65,
                y: p1.pos.y * 0.35 + aim.y * 0.65 - 0.55,
                z: p1.pos.z * 0.35 + aim.z * 0.65
            };
            fov = 52;
        }
        // 4) Two-Ship Dogfight Pair Framing (keeps BOTH dueling jets inside frame)
        else if (mode === 'dogfight_pair' && p1 && p2) {
            const mid = {
                x: (p1.pos.x + p2.pos.x) * 0.5,
                y: (p1.pos.y + p2.pos.y) * 0.5,
                z: (p1.pos.z + p2.pos.z) * 0.5
            };
            const sep = vSub(p2.pos, p1.pos);
            const sepDist = Math.max(4, vLen(sep));
            const sepDir = vNorm(sep, p1.fwd);
            const perp = vNorm(vCross({ x: 0, y: 1, z: 0 }, sepDir), { x: 1, y: 0, z: 0 });
            const sway = Math.sin(replayTime * 0.6) * 0.28;
            const camDir = vNorm({
                x: perp.x * Math.cos(sway) - sepDir.x * Math.sin(sway),
                y: 0.34,
                z: perp.z * Math.cos(sway) - sepDir.z * Math.sin(sway)
            });
            const camDist = Math.max(12, Math.min(58, sepDist * 1.28 + 8));
            camPos = vAdd(mid, vScale(camDir, camDist));
            targetPos = mid;
            fov = 56;
        }
        // 5) Hero Flyby / Dramatic Impact Pass
        else if (mode === 'flyby_hero' && (p1 || shot.impactPos)) {
            if (shot.impactPos && (shot.reason === 'ground_strike' || shot.reason === 'kill_crash')) {
                const az = 0.4 + shotElapsed * 0.55;
                const d = shot.reason === 'ground_strike' ? 22 : 16;
                targetPos = { x: shot.impactPos.x, y: Math.max(3, shot.impactPos.y + 2.5), z: shot.impactPos.z };
                camPos = {
                    x: targetPos.x + Math.cos(az) * d,
                    y: Math.max(cfg.minTerrainAltitude + 4, targetPos.y + 8.5),
                    z: targetPos.z + Math.sin(az) * d
                };
                fov = 55;
            } else if (p1) {
                // Anchor slightly ahead & to the beam of the aircraft so it sweeps across frame
                const leadOffset = 6.5 - Math.min(13, shotElapsed * 11);
                const sideSign = ((shot.focusTurnIdx || 0) % 2 === 0) ? 1 : -1;
                camPos = {
                    x: p1.pos.x + p1.fwd.x * leadOffset + p1.right.x * (7.2 * sideSign),
                    y: p1.pos.y + p1.fwd.y * leadOffset + 2.4,
                    z: p1.pos.z + p1.fwd.z * leadOffset + p1.right.z * (7.2 * sideSign)
                };
                targetPos = p1.pos;
                fov = 50;
            }
        }

        // 6) Default / Fallback: Cinematic 3/4 Tail Chase
        if (!camPos || !targetPos) {
            if (!p1) return null;
            const swing = Math.sin(replayTime * 0.55) * 2.2;
            camPos = {
                x: p1.pos.x - p1.fwd.x * 8.6 + p1.right.x * swing,
                y: p1.pos.y - p1.fwd.y * 8.6 + 2.5,
                z: p1.pos.z - p1.fwd.z * 8.6 + p1.right.z * swing
            };
            targetPos = {
                x: p1.pos.x + p1.fwd.x * 3.5,
                y: p1.pos.y + p1.fwd.y * 3.5 + 0.5,
                z: p1.pos.z + p1.fwd.z * 3.5
            };
            fov = baseFov;
        }

        avoidObstacleCollision(targetPos, camPos, obstaclesRef);
        return { camPos, targetPos, fov };
    }

    // ------------------------------------------------------------------------
    // Runtime Director Controller (browser state, smoothing, manual override, HUD)
    // ------------------------------------------------------------------------
    const runtime = {
        enabled: true,
        userAutoPref: true,
        lockedSeatId: null,
        angleOverride: null,      // null = auto, or one of CAMERA_MODES
        storyboard: null,
        cachedLen: -1,
        cachedLastRef: null,
        activeShotKey: '',
        activePrimaryId: null,
        activeMode: null,
        activeReason: null,
        savedCamPose: null,
        controlsBound: false
    };

    function ensureStoryboard(battleLog) {
        if (!Array.isArray(battleLog) || !battleLog.length) {
            runtime.storyboard = null;
            runtime.cachedLen = 0;
            runtime.cachedLastRef = null;
            return null;
        }
        const lastRef = battleLog[battleLog.length - 1];
        if (runtime.storyboard && runtime.cachedLen === battleLog.length && runtime.cachedLastRef === lastRef) {
            return runtime.storyboard;
        }
        runtime.storyboard = analyzeTimeline(battleLog);
        runtime.cachedLen = battleLog.length;
        runtime.cachedLastRef = lastRef;
        return runtime.storyboard;
    }

    function bindManualOverrideListeners() {
        if (runtime.controlsBound) return;
        if (typeof controls !== 'undefined' && controls && typeof controls.addEventListener === 'function') {
            runtime.controlsBound = true;
            controls.addEventListener('start', () => {
                if (typeof GameContext !== 'undefined' && GameContext.isReplayMode && GameContext.isReplayMode()) {
                    onUserCameraInteract();
                }
            });
        }
    }

    function onUserCameraInteract() {
        if (!runtime.enabled) return;
        runtime.enabled = false;
        syncHud();
    }

    function onEnterReplay(cameraRef, controlsRef) {
        bindManualOverrideListeners();
        if (cameraRef && controlsRef && !runtime.savedCamPose) {
            runtime.savedCamPose = {
                pos: { x: cameraRef.position.x, y: cameraRef.position.y, z: cameraRef.position.z },
                target: { x: controlsRef.target.x, y: controlsRef.target.y, z: controlsRef.target.z },
                fov: Number(cameraRef.fov) || DEFAULT_CFG.baseFov
            };
        }
        runtime.enabled = runtime.userAutoPref;
        runtime.activeShotKey = '';
        runtime.cachedLen = -1;
        syncHud();
    }

    function onExitReplay(cameraRef, controlsRef) {
        if (cameraRef && controlsRef && runtime.savedCamPose) {
            cameraRef.position.set(runtime.savedCamPose.pos.x, runtime.savedCamPose.pos.y, runtime.savedCamPose.pos.z);
            controlsRef.target.set(runtime.savedCamPose.target.x, runtime.savedCamPose.target.y, runtime.savedCamPose.target.z);
            if (Math.abs((cameraRef.fov || 60) - runtime.savedCamPose.fov) > 0.1) {
                cameraRef.fov = runtime.savedCamPose.fov;
                if (typeof cameraRef.updateProjectionMatrix === 'function') cameraRef.updateProjectionMatrix();
            }
            if (typeof controlsRef.update === 'function') controlsRef.update();
        }
        runtime.savedCamPose = null;
        runtime.activeShotKey = '';
        runtime.activePrimaryId = null;
        runtime.activeMode = null;
        runtime.activeReason = null;
        runtime.lockedSeatId = null;
        runtime.angleOverride = null;
        clearSeatHighlight();
        syncHud();
    }

    function toggleEnabled() {
        runtime.enabled = !runtime.enabled;
        runtime.userAutoPref = runtime.enabled;
        if (runtime.enabled) {
            runtime.activeShotKey = ''; // Force immediate clean cut back onto active shot
        }
        syncHud();
        return runtime.enabled;
    }

    function setEnabled(flag) {
        runtime.enabled = !!flag;
        runtime.userAutoPref = runtime.enabled;
        if (runtime.enabled) runtime.activeShotKey = '';
        syncHud();
        return runtime.enabled;
    }

    function focusSeat(teamId) {
        if (!teamId) {
            runtime.lockedSeatId = null;
        } else if (runtime.lockedSeatId === teamId) {
            // Clicking already-locked seat releases back to full automatic multi-plane switching
            runtime.lockedSeatId = null;
        } else {
            runtime.lockedSeatId = teamId;
        }
        runtime.enabled = true;
        runtime.userAutoPref = true;
        runtime.activeShotKey = '';
        syncHud();
        return runtime.lockedSeatId;
    }

    function cycleAngleOverride() {
        const order = [null, 'chase_cinematic', 'over_shoulder', 'dogfight_pair', 'flyby_hero', 'tactical_wide'];
        const idx = order.indexOf(runtime.angleOverride);
        runtime.angleOverride = order[(idx + 1) % order.length];
        runtime.enabled = true;
        runtime.userAutoPref = true;
        runtime.activeShotKey = '';
        syncHud();
        return runtime.angleOverride;
    }

    function clearSeatHighlight() {
        if (typeof document === 'undefined') return;
        KNOWN_SEATS.forEach((id) => {
            const btn = document.getElementById(`btn-sel-${id}`);
            if (btn) btn.classList.remove('is-director-focus');
        });
    }

    function syncHud() {
        if (typeof document === 'undefined') return;
        const isReplay = (typeof GameContext !== 'undefined' && GameContext.isReplayMode && GameContext.isReplayMode());

        const btnDir = document.getElementById('btn-rep-director');
        if (btnDir) {
            btnDir.style.display = isReplay ? 'inline-block' : 'none';
            if (runtime.enabled) {
                btnDir.innerText = runtime.lockedSeatId
                    ? `🎬 鎖定:${seatLabel(runtime.lockedSeatId)}`
                    : '🎬 導播: 自動';
                btnDir.classList.add('is-director-on');
                btnDir.classList.remove('is-director-manual');
            } else {
                btnDir.innerText = '🎬 導播: 手動';
                btnDir.classList.remove('is-director-on');
                btnDir.classList.add('is-director-manual');
            }
        }

        const btnAngle = document.getElementById('btn-rep-angle');
        if (btnAngle) {
            btnAngle.style.display = isReplay ? 'inline-block' : 'none';
            btnAngle.innerText = runtime.angleOverride
                ? `🎥 ${MODE_LABELS[runtime.angleOverride] || runtime.angleOverride}`
                : '🎥 視角: 自動';
        }

        const badge = document.getElementById('replay-director-badge');
        if (badge) {
            if (!isReplay) {
                badge.hidden = true;
            } else {
                badge.hidden = false;
                if (!runtime.enabled) {
                    badge.textContent = 'CAM · 自由視角（拖曳中 — 點擊「導播」恢復自動切換）';
                } else {
                    const who = runtime.activeMode === 'tactical_wide'
                        ? '全場戰機'
                        : seatLabel(runtime.activePrimaryId);
                    const angleTxt = MODE_LABELS[runtime.activeMode] || '自動視角';
                    const reasonTxt = REASON_LABELS[runtime.activeReason] || '';
                    const lockTxt = runtime.lockedSeatId ? ' [手動鎖定]' : '';
                    badge.textContent = reasonTxt
                        ? `CAM · ${who} · ${angleTxt} · ${reasonTxt}${lockTxt}`
                        : `CAM · ${who} · ${angleTxt}${lockTxt}`;
                }
            }
        }

        clearSeatHighlight();
        if (isReplay && runtime.enabled && runtime.activePrimaryId && runtime.activeMode !== 'tactical_wide') {
            const btn = document.getElementById(`btn-sel-${runtime.activePrimaryId}`);
            if (btn) btn.classList.add('is-director-focus');
        }
    }

    /**
     * Build effective shot at `(turnIdx, progress)` factoring in optional seat lock
     * or manual camera angle override.
     */
    function resolveEffectiveShot(battleLog, turnIdx, progress) {
        const sb = ensureStoryboard(battleLog);
        if (!sb) return null;
        const replayTime = 1.0 + turnIdx + progress;
        const baseShot = getShotAt(sb, replayTime);
        if (!baseShot) return null;

        const shot = Object.assign({}, baseShot);
        if (runtime.lockedSeatId) {
            const log = battleLog[turnIdx];
            if (log && log[runtime.lockedSeatId] && Array.isArray(log[runtime.lockedSeatId].pts) && log[runtime.lockedSeatId].pts.length >= 2) {
                shot.primaryId = runtime.lockedSeatId;
                shot.reason = 'seat_lock';
                // Pick closest hostile to the locked seat as secondary
                const pLock = samplePos(log[runtime.lockedSeatId].pts, progress);
                const myFac = factionOf(runtime.lockedSeatId);
                let bestD = Infinity, bestEnemy = null;
                for (let i = 0; i < sb.roster.length; i++) {
                    const cand = sb.roster[i];
                    if (cand === runtime.lockedSeatId || factionOf(cand) === myFac) continue;
                    const pC = samplePos(log[cand] && log[cand].pts, progress);
                    if (!pC) continue;
                    const d = vDist(pLock, pC);
                    if (d < bestD) { bestD = d; bestEnemy = cand; }
                }
                shot.secondaryId = bestEnemy;
                if (shot.mode === 'missile' || shot.mode === 'tactical_wide') {
                    shot.mode = (bestEnemy && bestD < 55) ? 'over_shoulder' : 'chase_cinematic';
                }
            }
        }
        if (runtime.angleOverride) {
            shot.mode = runtime.angleOverride;
        }
        return shot;
    }

    /**
     * Main per-frame / per-scrub camera update invoked during ACMI replay.
     */
    function updateReplayCamera(battleLog, turnIdx, progress, dtMs, opts) {
        bindManualOverrideListeners();
        if (!runtime.enabled) {
            if (runtime.lastHudEnabled !== false) {
                runtime.lastHudEnabled = false;
                syncHud();
            }
            return null;
        }
        runtime.lastHudEnabled = true;
        if (typeof camera === 'undefined' || !camera || typeof controls === 'undefined' || !controls) {
            return null;
        }
        const shot = resolveEffectiveShot(battleLog, turnIdx, progress);
        if (!shot) return null;

        const obsRef = (typeof obstacles !== 'undefined' && Array.isArray(obstacles)) ? obstacles : null;
        const pose = computeShotPose(shot, battleLog, turnIdx, progress, obsRef);
        if (!pose) return null;

        const shotKey = `${shot.primaryId || ''}|${shot.mode || ''}|${shot.missileKey || ''}`;
        const hardCut = !!(opts && opts.snap)
            || !runtime.activeShotKey
            || (runtime.activePrimaryId !== shot.primaryId && shot.mode !== 'tactical_wide')
            || (runtime.activeShotKey !== shotKey && shot.mode === 'tactical_wide')
            || (runtime.activeMode === 'tactical_wide' && shot.mode !== 'tactical_wide')
            || (runtime.activeMode !== shot.mode && (runtime.activeMode === 'missile' || shot.mode === 'missile'))
            || (shot.mode === 'missile' && runtime.activeShotKey !== shotKey);

        if (hardCut) {
            camera.position.set(pose.camPos.x, pose.camPos.y, pose.camPos.z);
            controls.target.set(pose.targetPos.x, pose.targetPos.y, pose.targetPos.z);
            if (Math.abs((camera.fov || 60) - pose.fov) > 0.2) {
                camera.fov = pose.fov;
                if (typeof camera.updateProjectionMatrix === 'function') camera.updateProjectionMatrix();
            }
        } else {
            // Framerate-independent exponential damping for buttery smooth tracking
            const dtSec = Math.max(0.004, Math.min(0.1, (Number(dtMs) || 16.6) / 1000));
            const alphaPos = 1 - Math.exp(-7.5 * dtSec);
            const alphaTgt = 1 - Math.exp(-10.0 * dtSec);
            camera.position.x += (pose.camPos.x - camera.position.x) * alphaPos;
            camera.position.y += (pose.camPos.y - camera.position.y) * alphaPos;
            camera.position.z += (pose.camPos.z - camera.position.z) * alphaPos;
            controls.target.x += (pose.targetPos.x - controls.target.x) * alphaTgt;
            controls.target.y += (pose.targetPos.y - controls.target.y) * alphaTgt;
            controls.target.z += (pose.targetPos.z - controls.target.z) * alphaTgt;
            if (Math.abs((camera.fov || 60) - pose.fov) > 0.15) {
                camera.fov += (pose.fov - camera.fov) * (1 - Math.exp(-5.0 * dtSec));
                if (typeof camera.updateProjectionMatrix === 'function') camera.updateProjectionMatrix();
            }
        }

        controls.update();
        camera.updateMatrixWorld();

        const metaChanged = runtime.activeShotKey !== shotKey || runtime.activeReason !== shot.reason;
        runtime.activeShotKey = shotKey;
        runtime.activePrimaryId = shot.primaryId;
        runtime.activeMode = shot.mode;
        runtime.activeReason = shot.reason;
        if (metaChanged) syncHud();

        return { shot, pose, hardCut };
    }

    function getState() {
        return {
            enabled: runtime.enabled,
            lockedSeatId: runtime.lockedSeatId,
            angleOverride: runtime.angleOverride,
            activePrimaryId: runtime.activePrimaryId,
            activeMode: runtime.activeMode,
            activeReason: runtime.activeReason,
            shotCount: runtime.storyboard ? runtime.storyboard.shots.length : 0,
            roster: runtime.storyboard ? runtime.storyboard.roster.slice() : []
        };
    }

    return {
        CAMERA_MODES,
        MODE_LABELS,
        REASON_LABELS,
        discoverRoster,
        analyzeTimeline,
        getShotAt,
        computeShotPose,
        onEnterReplay,
        onExitReplay,
        onUserCameraInteract,
        toggleEnabled,
        setEnabled,
        focusSeat,
        cycleAngleOverride,
        updateReplayCamera,
        syncHud,
        getState
    };
});
