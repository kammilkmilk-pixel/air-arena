const fs = require('fs');
const path = require('path');
const [dirA, dirB] = process.argv.slice(2);

function load(dir) {
    const out = {};
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const idx = j.batch && j.batch.batchIndex;
        out[idx] = j;
    }
    return out;
}
const fmtPos = (p) => (p ? [p.x, p.y, p.z].map((v) => Math.round(v)).join(',') : '-');
function firstFrame(u) {
    const t = (u && (u.decisionTrail || u.deathTrail)) || [];
    return t.find((b) => b.turn === 1) || null;
}
const A = load(dirA);
const B = load(dirB);
const tot = { A: {}, B: {} };
for (const idx of Object.keys(A).sort((a, b) => a - b)) {
    const a = A[idx];
    const b = B[idx];
    if (!b) { console.log(`match ${idx}: missing in B`); continue; }
    const ids = Object.keys(a.units).sort();
    const same = ids.every((id) => {
        const fa = firstFrame(a.units[id]);
        const fb = firstFrame(b.units[id]);
        return fa && fb ? fmtPos(fa.pos) === fmtPos(fb.pos) : true;
    });
    const row = (j, key) => (j.rosterSummary || []).map((r) => {
        const c = r.isDestroyed ? r.deathCause : 'alive';
        tot[key][c] = (tot[key][c] || 0) + 1;
        const tr = (j.units[r.id] || {}).deathTrail || [];
        const t = r.isDestroyed && tr.length ? 'T' + tr[tr.length - 1].turn : '';
        return `${r.id}=${c}${t}`;
    }).join(' ');
    console.log(`match ${idx} T1 spawn same=${same ? 1 : 0} endTurn A=${a.turn} B=${b.turn}`);
    console.log(`   A ${row(a, 'A')}`);
    console.log(`   B ${row(b, 'B')}`);
}
console.log('A', JSON.stringify(tot.A));
console.log('B', JSON.stringify(tot.B));
