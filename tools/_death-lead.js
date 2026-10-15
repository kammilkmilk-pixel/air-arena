// Per dump: each death, plus the last beats before it (state, bank, alt, fwdY).
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, 'reports', 'dumps');
const LEAD = Number(process.env.LEAD || 6);
for (const d of process.argv.slice(2)) {
    const dir = path.isAbsolute(d) ? d : path.join(ROOT, d);
    const files = fs.readdirSync(dir).filter((x) => x.endsWith('.json'));
    files.forEach((f, i) => {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const id of Object.keys(j.units || {})) {
            const u = j.units[id];
            const cause = u.deathCause || (u.death && u.death.cause) || (u.alive === false ? 'dead' : null);
            if (!cause) continue;
            const trail = u.deathTrail || u.decisionTrail || [];
            const tail = trail.slice(-LEAD);
            const last = tail[tail.length - 1] || {};
            console.log(`${d} m${i + 1} ${id} ${cause} T${last.turn}`);
            if (!/build|ground/i.test(String(cause))) continue;
            for (const b of tail) {
                const f2 = (v, n = 0) => (typeof v === 'number' ? v.toFixed(n) : '-');
                console.log(`    T${b.turn} ${String(b.state).padEnd(26)} alt=${f2(b.alt ?? b.altitude)} fy=${f2(b.fwdY, 2)} bank=${f2(b.bank)}->${f2(b.bankEnd)} jx=${f2(b.joyX, 2)} jy=${f2(b.joyY, 2)} pitch=${f2(b.pitchCmd, 2)} ap=${f2(b.ap)} cov=${f2(b.coverDist, 1)} fwd=${f2(b.coverFwd, 1)} roof=${f2(b.roof, 1)} head=${f2(b.headroom)} risk=${b.risk} gate=${b.gate} roofExit=${b.roofExit} climb=${b.straightClimb}`);
                if (process.env.REASON) console.log(`        ${String(b.reason || '').slice(0, 260)}`);
            }
        }
    });
}
