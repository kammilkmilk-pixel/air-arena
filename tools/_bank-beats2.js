const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
let n = 0, worse = 0, n60 = 0, worse60 = 0, invPull = 0, inv = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const id of Object.keys(j.units || {})) {
        const u = j.units[id];
        for (const b of u.deathTrail || u.decisionTrail || []) {
            if (typeof b.bank !== 'number' || typeof b.bankEnd !== 'number' || Math.abs(b.fwdY) > 0.8) continue;
            n++;
            const grew = Math.abs(b.bankEnd) > Math.abs(b.bank);
            if (grew) worse++;
            if (Math.abs(b.bank) >= 60) { n60++; if (grew) worse60++; }
            if (b.upY < 0) { inv++; if (b.pitchCmd < -0.15) invPull++; }
        }
    }
}
const pct = (a, b) => (a / Math.max(1, b) * 100).toFixed(0) + '%';
console.log(`beats=${n} bank grew=${pct(worse, n)} | at |bank|>=60: n=${n60} grew=${pct(worse60, n60)} | inverted n=${inv} pulling nose-up (pitch<-0.15)=${pct(invPull, inv)}`);
