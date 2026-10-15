// Per dump: one unit's beats in a turn window. env UNIT, FROM, TO.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, 'reports', 'dumps');
const UNIT = process.env.UNIT || 'red';
const FROM = Number(process.env.FROM || 40);
const TO = Number(process.env.TO || 55);
for (const d of process.argv.slice(2)) {
    const dir = path.isAbsolute(d) ? d : path.join(ROOT, d);
    const files = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort();
    files.forEach((f, i) => {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const u = (j.units || {})[UNIT];
        if (!u) return;
        console.log(`${d} m${i + 1} ${UNIT} cause=${u.deathCause || '-'}`);
        const trail = u.decisionTrail || u.deathTrail || [];
        const f2 = (v, n = 0) => (typeof v === 'number' ? v.toFixed(n) : '-');
        for (const b of trail) {
            if (b.turn < FROM || b.turn > TO) continue;
            console.log(`    T${b.turn} ${String(b.state).padEnd(26)} alt=${f2(b.alt ?? b.altitude)} fy=${f2(b.fwdY, 2)} jx=${f2(b.joyX, 2)} jy=${f2(b.joyY, 2)} cov=${f2(b.coverDist, 1)} fwd=${f2(b.coverFwd, 1)} roof=${f2(b.roof, 1)} head=${f2(b.headroom)} risk=${b.risk}`);
            if (process.env.REASON) console.log(`        ${String(b.reason || '').slice(0, 220)}`);
        }
    });
}
