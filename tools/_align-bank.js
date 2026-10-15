// Per-state bank growth over the decision trail (bank -> bankEnd within one beat).
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, 'reports', 'dumps');
const stats = {};
let alignRuns = [];
for (const d of process.argv.slice(2)) {
    const dir = path.isAbsolute(d) ? d : path.join(ROOT, d);
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const id of Object.keys(j.units || {})) {
            const u = j.units[id];
            const trail = u.decisionTrail || u.deathTrail || [];
            let run = null;
            for (const b of trail) {
                if (typeof b.bank !== 'number' || typeof b.bankEnd !== 'number') continue;
                const s = b.state || '?';
                const st = stats[s] || (stats[s] = { n: 0, grew: 0, cross60: 0, inv: 0, dAbs: 0, sameSign: 0 });
                st.n++;
                const a0 = Math.abs(b.bank), a1 = Math.abs(b.bankEnd);
                st.dAbs += a1 - a0;
                if (a1 > a0) st.grew++;
                if (a0 < 60 && a1 >= 60) st.cross60++;
                if (a1 >= 90) st.inv++;
                if (Math.sign(b.joyX || 0) && Math.sign(b.joyX) === -Math.sign(b.bankEnd || 0)) st.sameSign++;
                if (s === 'alignFirst') {
                    if (!run) run = { file: f, id, t0: b.turn, b0: b.bank, len: 0, max: 0 };
                    run.len++;
                    run.max = Math.max(run.max, a1);
                    run.b1 = b.bankEnd;
                } else if (run) { alignRuns.push(run); run = null; }
            }
            if (run) alignRuns.push(run);
        }
    }
}
const rows = Object.entries(stats).sort((a, b) => b[1].n - a[1].n).slice(0, 40);
console.log('state                         n   grew  meanΔ|bank|  cross60  end>=90');
for (const [s, st] of rows) {
    console.log(`${s.padEnd(28)} ${String(st.n).padStart(4)}  ${(st.grew / st.n * 100).toFixed(0).padStart(3)}%  ${(st.dAbs / st.n).toFixed(1).padStart(8)}  ${String(st.cross60).padStart(6)}  ${String(st.inv).padStart(6)}`);
}
const long = alignRuns.filter((r) => r.len >= 3);
console.log(`alignFirst runs=${alignRuns.length} len>=3: ${long.length} ending >=60: ${alignRuns.filter((r) => Math.abs(r.b1) >= 60).length} max>=90: ${alignRuns.filter((r) => r.max >= 90).length}`);
for (const r of long.slice(0, 12)) {
    console.log(`  ${r.id} T${r.t0} len=${r.len} bank ${r.b0.toFixed(0)} -> ${r.b1.toFixed(0)} max=${r.max.toFixed(0)}`);
}
