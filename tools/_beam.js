// Runs of one state per unit: bank in -> out, jx, roll, fy, upY. env STATE, MAXRUNS.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, 'reports', 'dumps');
const STATE = process.env.STATE || 'tacticalBeamReposition';
const MAXRUNS = Number(process.env.MAXRUNS || 12);
let shown = 0;
let runs = 0, runsEnd90 = 0, flips = 0, beats = 0;
for (const d of process.argv.slice(2)) {
    const dir = path.isAbsolute(d) ? d : path.join(ROOT, d);
    const files = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort();
    files.forEach((f, i) => {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        for (const id of Object.keys(j.units || {})) {
            const trail = j.units[id].deathTrail || j.units[id].decisionTrail || [];
            let run = [];
            const flush = () => {
                if (!run.length) return;
                runs++;
                beats += run.length;
                let prev = 0;
                for (const b of run) {
                    const s = Math.sign(Number(b.joyX) || 0);
                    if (prev && s && s !== prev) flips++;
                    if (s) prev = s;
                }
                if (run.some((b) => Math.abs(b.bankEnd) >= 90)) runsEnd90++;
                if (shown < MAXRUNS && run.some((b) => Math.abs(b.bankEnd) >= 60)) {
                    shown++;
                    console.log(`${d} m${i + 1} ${id} T${run[0].turn}-T${run[run.length - 1].turn}`);
                    const f2 = (v, n = 0) => (typeof v === 'number' ? v.toFixed(n) : '-');
                    for (const b of run) {
                        console.log(`    T${b.turn} bank=${f2(b.bank)}->${f2(b.bankEnd)} jx=${f2(b.joyX, 2)} jy=${f2(b.joyY, 2)} roll=${f2(b.roll, 2)} fy=${f2(b.fwdY, 2)} up=${f2(b.upY, 2)} alt=${f2(b.alt ?? b.altitude)}`);
                        if (process.env.REASON) console.log(`        ${String(b.reason || '').slice(0, 200)}`);
                    }
                }
                run = [];
            };
            for (const b of trail) {
                if (b.state === STATE) run.push(b);
                else flush();
            }
            flush();
        }
    });
}
console.log(`${STATE}: runs=${runs} beats=${beats} jxFlips=${flips} runsEnd>=90=${runsEnd90}`);
