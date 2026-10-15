const fs = require('fs');
const path = require('path');
const root = 'tools/reports/dumps';
const dirs = process.argv.slice(2);
const RADIUS = 500;
const WARN = 180;
let n = 0, wrong = 0, wrongDeep = 0, deep = 0, forced = 0, forcedWrong = 0;
const byCause = {};
for (const d of dirs) {
    for (const f of fs.readdirSync(path.join(root, d)).filter((x) => x.endsWith('.json'))) {
        const j = JSON.parse(fs.readFileSync(path.join(root, d, f), 'utf8'));
        const cause = {};
        for (const r of j.rosterSummary || []) cause[r.id] = r.isDestroyed ? r.deathCause : 'alive';
        for (const id of Object.keys(j.units || {})) {
            const u = j.units[id];
            for (const b of u.deathTrail || u.decisionTrail || []) {
                if (b.state !== 'airspaceAvoid' || !b.pos || !b.forward) continue;
                const radial = Math.hypot(b.pos.x, b.pos.z);
                if (radial < WARN || Math.abs(b.joyX) < 0.1) continue;
                const ox = b.pos.x / radial;
                const oz = b.pos.z / radial;
                const fl = Math.hypot(b.forward.x, b.forward.z) || 1;
                const fx = b.forward.x / fl;
                const fz = b.forward.z / fl;
                const outDot = fx * ox + fz * oz;
                if (outDot < 0.12) continue;
                const shortSide = (fx * oz - fz * ox) >= 0 ? -1 : 1;
                const bad = Math.sign(b.joyX) !== shortSide;
                n++;
                if (bad) wrong++;
                if (outDot > 0.45) { deep++; if (bad) wrongDeep++; }
                if (b.forcedInward) { forced++; if (bad) forcedWrong++; }
                const c = cause[id];
                byCause[c] = byCause[c] || { n: 0, wrong: 0 };
                byCause[c].n++;
                if (bad) byCause[c].wrong++;
            }
        }
    }
}
const pct = (a, b) => (a / Math.max(1, b) * 100).toFixed(0) + '%';
console.log(`airspaceAvoid beats past warn, nose outbound: n=${n} long-side=${pct(wrong, n)}`);
console.log(`  outDot>0.45: n=${deep} long-side=${pct(wrongDeep, deep)}`);
console.log(`  forcedInward beats: n=${forced} AI opposite the game=${pct(forcedWrong, forced)}`);
for (const [c, v] of Object.entries(byCause)) console.log(`  unit ${c}: n=${v.n} long-side=${pct(v.wrong, v.n)}`);
