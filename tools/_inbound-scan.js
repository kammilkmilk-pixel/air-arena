'use strict';
const fs = require('fs');
const path = require('path');
const d = process.argv[2] || 'tools/reports/dumps/b2-test_01-1791811185637';
const files = fs.readdirSync(d).filter((x) => x.endsWith('.json'));
function idx(j) {
    return j.batch && j.batch.batchIndex;
}
const js = files
    .map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')))
    .sort((a, b) => idx(a) - idx(b));
for (const J of js) {
    console.log('== match', idx(J), 'T' + J.turn);
    for (const u of ['red', 'red2', 'blue', 'blue2']) {
        const tr = J.units[u].decisionTrail || [];
        const inbound = tr.filter((x) => /Inbound missile too close: hard break/.test(String(x.reason || '')));
        if (!inbound.length) continue;
        let flips = 0;
        let holds = 0;
        for (let i = 1; i < inbound.length; i++) {
            const a = inbound[i - 1];
            const b = inbound[i];
            if (b.turn !== a.turn + 1) continue;
            const sa = Math.sign(a.joyX || 0);
            const sb = Math.sign(b.joyX || 0);
            if (sa && sb && sa !== sb) flips++;
        }
        for (const x of inbound) {
            if (/divergeHold=1/.test(x.reason || '')) holds++;
        }
        const seq = inbound.slice(0, 8).map((x) => {
            const h = /divergeHold=1/.test(x.reason || '') ? 1 : (/divergeHold=0/.test(x.reason || '') ? 0 : '?');
            return 'T' + x.turn + ' jx=' + Number(x.joyX).toFixed(2) + ' h=' + h;
        }).join(' | ');
        console.log(' ', u, 'n=' + inbound.length, 'consecFlips=' + flips, 'hold1=' + holds, 'noHold=' + (inbound.length - holds));
        console.log('  ', seq);
    }
}
