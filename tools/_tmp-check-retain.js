const fs = require('fs');
const paths = [
  'c:/Users/owner/Downloads/新增資料夾 (4)/ai-debug-roster-T150-2026-08-10T15-53-19-666Z.json',
  'c:/Users/owner/Downloads/新增資料夾 (4)/ai-debug-roster-T150-2026-08-10T15-59-25-052Z.json',
  'c:/Users/owner/Downloads/新增資料夾 (4)/ai-debug-roster-T150-2026-08-10T16-05-17-109Z.json'
];

function classState(st) {
  const s = String(st || '');
  if (/obstacleEmergency/.test(s)) return 'scored';
  if (/urbanRoute|urbanBuilding|urbanClimb|urbanRoof|urbanPreemptive|tacticalCorridor/.test(s)) return 'urban';
  if (/missile|gunAttack|shallow|reacquire|align|intercept|opening|energyCruise/.test(s)) return 'combat';
  if (/postGround|emergencyPull|groundAvoid|mandatoryMerge/.test(s)) return 'survivalOther';
  if (/airspace/.test(s)) return 'airspace';
  return 'other';
}

for (const p of paths) {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  const name = p.split(/[/\\]/).pop();
  console.log('\n========', name);
  console.log('T' + j.turn, j.arenaMode, j.exportedAt);
  const counts = { building: 0, ground: 0, combat: 0, airspace: 0, alive: 0 };
  for (const s of j.rosterSummary || []) {
    if (!s.isDestroyed) counts.alive += 1;
    else if (counts[s.deathCause] != null) counts[s.deathCause] += 1;
    console.log(' ', s.id, s.isDestroyed ? s.deathCause : 'alive', 'hp=' + Math.round(Number(s.hp) || 0));
  }
  console.log('counts', JSON.stringify(counts));

  for (const s of j.rosterSummary || []) {
    const u = j.units[s.id];
    if (!u) continue;
    const trail = (u.deathTrail && u.deathTrail.length ? u.deathTrail : u.decisionTrail) || [];
    let nestExit = 0;
    let retain = 0;
    let softOk = 0; // nestExit/retain frame with |jx|<=0.62 && thr<=3
    let softFail = 0; // tagged but |jx|>0.7 or thr>=4
    for (const fr of trail) {
      const r = String(fr.reason || '');
      const tagged = /nestExit=allHit|nestExitRetain/i.test(r);
      if (/nestExit=allHit/i.test(r)) nestExit += 1;
      if (/nestExitRetain/i.test(r)) retain += 1;
      if (tagged) {
        const jx = Math.abs(Number(fr.joyX) || 0);
        const thr = Number(fr.thr);
        if (jx <= 0.62 && thr <= 3) softOk += 1;
        else if (jx > 0.7 || thr >= 4) softFail += 1;
      }
    }

    if (s.deathCause !== 'building' && s.deathCause !== 'ground') {
      if (nestExit || retain) {
        console.log(
          ' alive',
          s.id,
          'nestExit=' + nestExit,
          'retain=' + retain,
          'softOk=' + softOk,
          'softFail=' + softFail
        );
      }
      continue;
    }

    const last = trail[trail.length - 1] || {};
    const preReason = (u.preDeath && u.preDeath.reason) || last.reason || '';
    console.log('\n --', s.id, s.deathCause);
    console.log(' lastAlive', u.action && u.action.lastAliveState, '|', u.action && u.action.lastAliveStatusText);
    console.log(' reason', String(preReason).slice(0, 280));
    console.log(
      ' deathStick jx=' + last.joyX,
      'jy=' + last.joyY,
      'thr=' + last.thr,
      'cov=' + last.coverDist,
      '| nestExit=' + nestExit,
      'retain=' + retain,
      'softOk=' + softOk,
      'softFail=' + softFail
    );
    for (const fr of trail.slice(-8)) {
      const r = String(fr.reason || '');
      let tag = '-';
      if (/nestExitRetain/i.test(r)) tag = 'retain';
      else if (/nestExit=allHit/i.test(r)) tag = 'nestExit';
      else {
        const m = r.match(/collapseRecover=([a-zA-Z]+)/);
        if (m) tag = 'cr=' + m[1];
      }
      const soft =
        tag !== '-'
          ? Math.abs(Number(fr.joyX) || 0) <= 0.62 && Number(fr.thr) <= 3
            ? 'SOFT'
            : 'HARD'
          : '';
      console.log(
        '  t' + fr.turn,
        classState(fr.state) + ':' + fr.state,
        'jx=' + fr.joyX,
        'jy=' + fr.joyY,
        'thr=' + fr.thr,
        'cov=' + fr.coverDist,
        'fwd=' + fr.coverFwd,
        'roof=' + fr.roof,
        'alt=' + fr.alt,
        'fy=' + fr.fwdY,
        'urb=' + (fr.urbanSrc || '-'),
        tag,
        soft
      );
    }
  }
}
