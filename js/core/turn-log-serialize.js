// ============================================================================
// turn-log-serialize.js - Strip THREE vectors/quats for host-authority snapshots
// ============================================================================
(function initTurnLogSerialize(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.AirArenaTurnLogSerialize = api;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {
    const PROTOCOL = 'airarena-wego-v1';

    function isVecLike(v) {
        return !!(v && typeof v === 'object' && Number.isFinite(Number(v.x))
            && Number.isFinite(Number(v.y)) && Number.isFinite(Number(v.z))
            && v.w == null);
    }

    function isQuatLike(v) {
        return !!(v && typeof v === 'object' && Number.isFinite(Number(v.x))
            && Number.isFinite(Number(v.y)) && Number.isFinite(Number(v.z))
            && Number.isFinite(Number(v.w)));
    }

    function plainVec(v) {
        if (!v) return null;
        if (Array.isArray(v) && v.length >= 3) {
            return { x: Number(v[0]) || 0, y: Number(v[1]) || 0, z: Number(v[2]) || 0 };
        }
        if (isVecLike(v) || isQuatLike(v)) {
            const o = { x: Number(v.x) || 0, y: Number(v.y) || 0, z: Number(v.z) || 0 };
            if (v.w != null && Number.isFinite(Number(v.w))) o.w = Number(v.w);
            return o;
        }
        return null;
    }

    function reviveVec(p, THREERef) {
        if (!p) return null;
        const THREEObj = THREERef || (typeof THREE !== 'undefined' ? THREE : null);
        if (p.w != null) {
            if (THREEObj) return new THREEObj.Quaternion(p.x, p.y, p.z, p.w);
            return { x: p.x, y: p.y, z: p.z, w: p.w };
        }
        if (THREEObj) return new THREEObj.Vector3(p.x, p.y, p.z);
        return { x: p.x, y: p.y, z: p.z };
    }

    function mapArr(arr, fn) {
        if (!Array.isArray(arr)) return arr;
        return arr.map(fn);
    }

    function serializeVfx(trigger) {
        if (!trigger || typeof trigger !== 'object') return trigger;
        const out = {
            type: trigger.type,
            step: trigger.step,
            rot: trigger.rot,
            scale: trigger.scale,
            opacity: trigger.opacity,
            life: trigger.life,
            streak: trigger.streak,
            gravity: trigger.gravity,
            windForce: trigger.windForce,
            fountain: !!trigger.fountain,
            seed: trigger.seed,
            count: trigger.count,
            power: trigger.power,
            color: trigger.color,
            radius: trigger.radius,
            surface: trigger.surface
        };
        if (trigger.pos) out.pos = plainVec(trigger.pos);
        if (trigger.fwd) out.fwd = plainVec(trigger.fwd);
        if (trigger.normal) out.normal = plainVec(trigger.normal);
        if (trigger.wind && trigger.wind.x != null) out.wind = plainVec(trigger.wind);
        if (trigger.drift) out.drift = plainVec(trigger.drift);
        if (trigger.quat) out.quat = plainVec(trigger.quat);
        // Omit velocities: replay regenerates from seed (hitch + payload).
        return out;
    }

    function serializeSeatBlock(block) {
        if (!block || typeof block !== 'object') return block;
        const out = {
            damageTaken: block.damageTaken,
            wasFlaresArmed: block.wasFlaresArmed,
            wasChaffArmed: block.wasChaffArmed,
            damageSteps: Array.isArray(block.damageSteps) ? block.damageSteps.slice() : undefined,
            gunStops: Array.isArray(block.gunStops) ? block.gunStops.slice() : undefined
        };
        if (Array.isArray(block.pts)) out.pts = block.pts.map(plainVec);
        if (Array.isArray(block.quats)) out.quats = block.quats.map(plainVec);
        if (Array.isArray(block.chain)) out.chain = block.chain.map((c) => (c && typeof c === 'object' ? { ...c } : c));
        return out;
    }

    function serializeMslTrack(track) {
        if (!Array.isArray(track)) return track;
        return track.map((pt) => {
            if (!pt) return null;
            return { pos: plainVec(pt.pos), quat: plainVec(pt.quat) };
        });
    }

    function serializeTurnLog(log) {
        if (!log || typeof log !== 'object') return null;
        const out = {
            protocol: PROTOCOL,
            turn: log.turn,
            winner: log.winner,
            destroyed: log.destroyed ? { ...log.destroyed } : undefined,
            deathCause: log.deathCause ? { ...log.deathCause } : undefined,
            deathFlags: log.deathFlags ? { ...log.deathFlags } : undefined,
            softWreck: log.softWreck ? { ...log.softWreck } : undefined,
            wreckGroundBurst: log.wreckGroundBurst ? { ...log.wreckGroundBurst } : undefined,
            killedBy: log.killedBy ? JSON.parse(JSON.stringify(log.killedBy)) : undefined,
            damageFrom: log.damageFrom ? JSON.parse(JSON.stringify(log.damageFrom)) : undefined,
            radioCues: Array.isArray(log.radioCues) ? log.radioCues.map((c) => ({ ...c })) : [],
            vfxTriggers: mapArr(log.vfxTriggers, serializeVfx) || [],
            hitch: log.hitch ? { ...log.hitch } : undefined
        };
        Object.keys(log).forEach((key) => {
            if (out[key] !== undefined) return;
            if (key === 'flaresTrack' || key === 'chaffTrack' || key === 'hpTrack') {
                out[key] = log[key];
                return;
            }
            if (/(?:Msl|Bomb|Rkt)Tracks$/.test(key) && log[key] && typeof log[key] === 'object') {
                const tracks = {};
                Object.keys(log[key]).forEach((pid) => {
                    tracks[pid] = serializeMslTrack(log[key][pid]);
                });
                out[key] = tracks;
                return;
            }
            if (/ExplodedAt$|MslIsSelfDestruct$/.test(key)) {
                out[key] = log[key] && typeof log[key] === 'object' ? { ...log[key] } : log[key];
                return;
            }
            if (log[key] && log[key].pts) {
                out[key] = serializeSeatBlock(log[key]);
            }
        });
        return out;
    }

    function hydrateTurnLog(plain, THREERef) {
        if (!plain || typeof plain !== 'object') return null;
        const T = THREERef || (typeof THREE !== 'undefined' ? THREE : null);
        const log = JSON.parse(JSON.stringify(plain));
        if (Array.isArray(log.vfxTriggers)) {
            log.vfxTriggers = log.vfxTriggers.map((t) => {
                if (!t) return t;
                if (t.pos) t.pos = reviveVec(t.pos, T);
                if (t.fwd) t.fwd = reviveVec(t.fwd, T);
                if (t.normal) t.normal = reviveVec(t.normal, T);
                if (t.wind) t.wind = reviveVec(t.wind, T);
                if (t.drift) t.drift = reviveVec(t.drift, T);
                if (t.quat) t.quat = reviveVec(t.quat, T);
                return t;
            });
        }
        Object.keys(log).forEach((key) => {
            const block = log[key];
            if (block && Array.isArray(block.pts)) {
                block.pts = block.pts.map((p) => reviveVec(p, T));
            }
            if (block && Array.isArray(block.quats)) {
                block.quats = block.quats.map((q) => reviveVec(q, T));
            }
            if (/(?:Msl|Bomb|Rkt)Tracks$/.test(key) && block && typeof block === 'object') {
                Object.keys(block).forEach((pid) => {
                    if (!Array.isArray(block[pid])) return;
                    block[pid] = block[pid].map((pt) => {
                        if (!pt) return null;
                        return { pos: reviveVec(pt.pos, T), quat: reviveVec(pt.quat, T) };
                    });
                });
            }
        });
        return log;
    }

    function canJsonRoundtrip(log) {
        const s = serializeTurnLog(log);
        JSON.stringify(s);
        return s;
    }

    return {
        PROTOCOL,
        plainVec,
        reviveVec,
        serializeTurnLog,
        hydrateTurnLog,
        serializeVfx,
        canJsonRoundtrip
    };
});
