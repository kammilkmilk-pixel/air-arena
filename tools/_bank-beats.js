const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const n = Number(process.argv[3] || 10);
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();

const pad = (v, w) => String(v == null ? '-' : v).padStart(w);
let idx = 0;
const tally = {};
const all = [];
for (const f of files) {
    idx++;
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const r of j.rosterSummary || []) {
        const u = j.units[r.id] || {};
        const trail = u.deathTrail || u.decisionTrail || [];
        for (const b of trail) all.push({ cause: r.isDestroyed ? r.deathCause : 'alive', b });
        if (!r.isDestroyed) continue;
        tally[r.deathCause] = (tally[r.deathCause] || 0) + 1;
        console.log(`== match ${idx} ${r.id} ${r.deathCause}`);
        for (const b of trail.slice(-n)) {
            console.log(`  T${pad(b.turn, 3)} ${String(b.state).padEnd(26)} alt=${pad(b.alt, 6)} fy=${pad(b.fwdY, 6)} ap=${pad(b.ap, 5)}`
                + ` jx=${pad(b.joyX, 5)} jy=${pad(b.joyY, 5)} bank=${pad(b.bank, 6)}->${pad(b.bankEnd, 6)} upY=${pad(b.upY, 6)}`
                + ` roll=${pad(b.rollCmd, 6)} pitch=${pad(b.pitchCmd, 6)} yaw=${pad(b.yawCmd, 6)} fi=${b.forcedInward} st=${b.stalled}`);
        }
    }
}
console.log('deaths', JSON.stringify(tally));

const absB = all.filter((x) => typeof x.b.bank === 'number').map((x) => Math.abs(x.b.bank));
const share = (lo) => (absB.filter((v) => v >= lo).length / Math.max(1, absB.length) * 100).toFixed(1) + '%';
console.log(`all beats=${absB.length} |bank|>=30: ${share(30)} >=60: ${share(60)} >=90 (inverted): ${share(90)}`);
const byState = {};
for (const x of all) {
    if (typeof x.b.bank !== 'number') continue;
    const s = byState[x.b.state] || (byState[x.b.state] = { n: 0, sum: 0, inv: 0, zeroRoll: 0 });
    s.n++; s.sum += Math.abs(x.b.bank);
    if (Math.abs(x.b.bank) >= 90) s.inv++;
    if (x.b.rollCmd === 0) s.zeroRoll++;
}
const rows = Object.entries(byState).sort((a, b) => b[1].n - a[1].n).slice(0, 18);
for (const [s, v] of rows) {
    console.log(`  ${s.padEnd(28)} n=${pad(v.n, 4)} mean|bank|=${pad((v.sum / v.n).toFixed(1), 5)} inverted=${pad(v.inv, 3)} roll==0:${pad(v.zeroRoll, 3)}`);
}
