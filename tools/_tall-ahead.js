// Beats with a taller building squarely ahead but risk not yet high: how many end in a building death?
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, 'reports', 'dumps');
const ROOF = Number(process.env.ROOF || -4);
const FWD = Number(process.env.FWD || 35);
let beats = 0, death = 0, firstHits = [];
const ttcRows = [];
const perUnit = [];
for (const d of process.argv.slice(2)) {
    const dir = path.isAbsolute(d) ? d : path.join(ROOT, d);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const id of Object.keys(j.units || {})) {
            const u = j.units[id];
            const trail = u.decisionTrail || [];
            const cause = String(u.deathCause || '');
            const lastTurn = trail.length ? trail[trail.length - 1].turn : -1;
            let episodes = 0;
            let inEp = false;
            for (let k = 0; k < trail.length; k++) {
                const b = trail[k];
                const prev = trail[k - 1];
                const fwd = Number(b.coverFwd), cov = Number(b.coverDist), roof = Number(b.roof);
                const c = Number.isFinite(roof) && roof < ROOF && fwd > 0 && fwd < FWD && fwd >= 0.8 * cov && b.risk !== 'high';
                if (!c) { inEp = false; continue; }
                beats++;
                const dies = /build/i.test(cause) && lastTurn - b.turn <= 5 && lastTurn - b.turn >= 0;
                if (dies) death++;
                const close = prev && Number.isFinite(Number(prev.coverFwd)) ? Number(prev.coverFwd) - fwd : NaN;
                const ttc = close > 0.5 ? fwd / close : Infinity;
                if (!inEp) {
                    let flips = 0, lastSign = 0;
                    const seq = [];
                    for (let m = k; m < Math.min(trail.length, k + 6); m++) {
                        const jx = Number(trail[m].joyX) || 0;
                        seq.push(`${String(trail[m].state).slice(0, 10)}:${jx.toFixed(2)}`);
                        const s = Math.abs(jx) > 0.3 ? Math.sign(jx) : 0;
                        if (s && lastSign && s !== lastSign) flips++;
                        if (s) lastSign = s;
                    }
                    ttcRows.push({ dies, ttc, close, fwd, roof, fy: b.fwdY, state: b.state, flips, seq: seq.join(' ') });
                }
                if (!inEp) { episodes++; inEp = true; if (dies) firstHits.push(`${d.slice(-12)} ${id} T${b.turn} fwd=${fwd} roof=${roof} -> death T${lastTurn}`); }
            }
            if (episodes) perUnit.push({ d, f, id, episodes, building: /build/i.test(cause) });
        }
    }
}
const eps = perUnit.reduce((a, u) => a + u.episodes, 0);
const deadEps = firstHits.length;
console.log(`ROOF<${ROOF} FWD<${FWD} head-on, risk!=high: beats=${beats} (followed by building death within 5: ${death}) episodes=${eps} fatalEpisodes=${deadEps}`);
for (const h of firstHits) console.log('  ' + h);
for (const lim of [2, 3, 4, 6]) {
    const sel = ttcRows.filter((r) => r.ttc <= lim);
    console.log(`  entry ttc<=${lim}: episodes=${sel.length} fatal=${sel.filter((r) => r.dies).length}`);
}
const stateCount = {};
for (const r of ttcRows) {
    const k = `${r.state}|${r.dies ? 'fatal' : 'ok'}`;
    stateCount[k] = (stateCount[k] || 0) + 1;
}
console.log('  entry states:', JSON.stringify(stateCount));
for (const fl of [0, 1, 2, 3]) {
    const sel = ttcRows.filter((r) => r.flips >= fl);
    console.log(`  side flips>=${fl} in next 6 beats: episodes=${sel.length} fatal=${sel.filter((r) => r.dies).length}`);
}
if (process.env.SEQ) for (const r of ttcRows.filter((x) => x.dies || x.flips >= 2)) console.log(`   ${r.dies ? 'FATAL' : 'ok   '} flips=${r.flips} ${r.seq}`);
if (process.env.ROWS) for (const r of ttcRows) console.log(`   ${r.dies ? 'FATAL' : 'ok   '} ttc=${r.ttc.toFixed(1)} close=${Number(r.close).toFixed(1)} fwd=${r.fwd} roof=${r.roof} fy=${r.fy} ${r.state}`);
