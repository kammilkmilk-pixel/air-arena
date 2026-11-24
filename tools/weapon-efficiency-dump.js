#!/usr/bin/env node
/**
 * weapon-efficiency-dump.js — Knife6 survival + weapon A/B metrics from roster dumps
 *
 * Usage:
 *   node tools/weapon-efficiency-dump.js <dump.json> [more.json ...]
 *   node tools/weapon-efficiency-dump.js --group Rei_03 a.json b.json --group Rei_02 c.json d.json
 *
 * Lab weapon booth (closed 2026-09-05): npm.cmd run batch:ai:weapon
 *   1v1 blank chase T60. Score shot/prep = mslQ / mslPrep (illuminate queue counts).
 *   atk/prep is state-only and misses FOX-1 照射發射.
 *   GATE (T150) is gold-only. Lab dumps will print ---- — that is expected.
 *   Urban hang / shot-time is A.2b, not this booth knife.
 *
 * Prefers unit.weaponCounters (match-long tallies) when present; else falls back to trailMax≈40.
 * 2026-08-24+ dumps include killedBy / combatKills / weaponCounters.kills.
 * 2026-09-28+ dumps type missile kills (fox1/fox2) and per-shot missileShots
 * 2026-10-03+ FOX-1 shots also carry why=hit|held|chaff|los|dead|range|gate|nogeom|unk
 * FOX-2 shots carry why=hit|held|flare|range|gate|heat|nogeom|unk
 * (type, launch dist/ang, outcome hit/coast/building/exhausted).
 * Older combat/mslQ is own combat deaths per missile-queue — not kill efficiency.
 */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
    const groups = [];
    let cur = { name: 'default', files: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--group' && argv[i + 1]) {
            if (cur.files.length) groups.push(cur);
            cur = { name: argv[++i], files: [] };
            continue;
        }
        if (a.startsWith('-')) continue;
        cur.files.push(a);
    }
    if (cur.files.length) groups.push(cur);
    return groups;
}

const FOX1_WHYS = ['hit', 'held', 'chaff', 'los', 'dead', 'range', 'gate', 'nogeom', 'unk'];
const FOX2_WHYS = ['hit', 'held', 'flare', 'range', 'gate', 'heat', 'nogeom', 'unk'];

function formatWhyMap(map, allowed) {
    if (!map) return '';
    const keys = (allowed || []).concat(Object.keys(map).filter((k) => (allowed || []).indexOf(k) < 0));
    return keys.filter((k) => map[k] > 0).map((k) => `${k}:${map[k]}`).join(',');
}

function formatFox1WhyMap(map) {
    return formatWhyMap(map, FOX1_WHYS);
}

function formatFox2WhyMap(map) {
    return formatWhyMap(map, FOX2_WHYS);
}

function mergeWhyMaps(rows, key) {
    const out = {};
    (rows || []).forEach((r) => {
        const map = r && r[key];
        if (!map) return;
        Object.keys(map).forEach((k) => {
            out[k] = (out[k] || 0) + (Number(map[k]) || 0);
        });
    });
    return out;
}

function mergeFox1WhyMaps(rows) {
    return mergeWhyMaps(rows, 'fox1Why');
}

function countRe(text, re) {
    const m = text.match(re);
    return m ? m.length : 0;
}

function analyzeFile(filePath) {
    const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const raw = JSON.stringify(j);
    const roster = j.rosterSummary || [];
    let building = 0;
    let combat = 0;
    let ground = 0;
    let midair = 0;
    let airspace = 0;
    let other = 0;
    const models = new Set();
    for (const r of roster) {
        if (!r.isDestroyed) continue;
        const c = String(r.deathCause || '');
        if (c === 'building') building++;
        else if (c === 'combat') combat++;
        else if (c === 'ground') ground++;
        else if (c === 'midair') midair++;
        else if (c === 'airspace') airspace++;
        else other++;
    }
    for (const id of Object.keys(j.units || {})) {
        const u = j.units[id];
        if (u && u.aiModel) models.add(u.aiModel);
    }

    let mslQ = 0;
    let gunQ = 0;
    let chaffEsc = 0;
    let flareEsc = 0;
    let illuminate = 0;
    let missileAttackSel = 0;
    let missilePrepSel = 0;
    let dirtBleed = 0;
    let slabArrest = 0;
    let softMsl = 0;
    let countersUsed = 0;
    let counterTurns = 0;
    let prepTimeoutShoot = 0;
    let prepTimeoutHang = 0;
    let combatKills = 0;
    let killsGun = 0;
    let killsMsl = 0;
    let killsF1 = 0;
    let killsF2 = 0;
    let killFields = 0;
    let typedKillFields = 0;
    let killedByCombat = 0;
    let killedByF1 = 0;
    let killedByF2 = 0;
    let shotN = 0;
    let shotF1 = 0;
    let shotF2 = 0;
    let shotHit = 0;
    let shotCoast = 0;
    let shotBuilding = 0;
    let shotExhausted = 0;
    const fox1Why = {};
    const fox2Why = {};

    for (const id of Object.keys(j.units || {})) {
        const u = j.units[id];
        if (!u) continue;
        const wc = u.weaponCounters;
        if (wc && Number(wc.turns) > 0) {
            countersUsed += 1;
            counterTurns += Number(wc.turns) || 0;
            mslQ += Number(wc.mslQ) || 0;
            gunQ += Number(wc.gunQ) || 0;
            illuminate += Number(wc.illum) || 0;
            missileAttackSel += Number(wc.mslAtk) || 0;
            missilePrepSel += Number(wc.mslPrep) || 0;
            chaffEsc += Number(wc.chaffEsc) || 0;
            flareEsc += Number(wc.flareEsc) || 0;
        } else {
            const trails = []
                .concat(u.deathTrail || [])
                .concat(u.decisionTrail || []);
            for (const t of trails) {
                if (t.queue === 'missile' || t.queueAction === 'missile') mslQ++;
                if (t.queue === 'gun' || t.queueAction === 'gun') gunQ++;
                if (t.state === 'fox1Illuminate' || /illuminate/i.test(String(t.reason || ''))) illuminate++;
                if (t.state === 'defensiveChaff' || /chaffWhileEscape/i.test(String(t.reason || ''))) chaffEsc++;
                if (t.state === 'defensiveFlare' || /flareWhileEscape/i.test(String(t.reason || ''))) flareEsc++;
                if (/dirtBleedRecover|dirtUnderTable|slabDirtArrest/i.test(String(t.reason || ''))) dirtBleed++;
                if (/slabDirtArrest|dirt arrest/i.test(String(t.reason || ''))) slabArrest++;
                if (/mslKnife|mslClose|\bmsl\b/i.test(String(t.reason || ''))) softMsl++;
                if (t.prepTimeout === 'shoot') prepTimeoutShoot++;
                if (t.prepTimeout === 'hang') prepTimeoutHang++;
            }
            const tree = (u.preDeath && u.preDeath.debug && u.preDeath.debug.tree) || u.tree || [];
            for (const line of tree) {
                const s = String(line);
                if (/selected:\s*missileAttack/i.test(s)) missileAttackSel++;
                if (/selected:\s*missilePrep/i.test(s)) missilePrepSel++;
                if (/fox1Doctrine:\s*illuminate/i.test(s)) illuminate++;
            }
        }
        const unitKills = Number.isFinite(Number(u && u.combatKills))
            ? Number(u.combatKills)
            : (wc && Number.isFinite(Number(wc.kills)) ? Number(wc.kills) : null);
        if (unitKills != null) {
            combatKills += unitKills;
            killFields += 1;
            killsGun += Number(u.combatKillsGun != null ? u.combatKillsGun : (wc && wc.killsGun)) || 0;
            killsMsl += Number(u.combatKillsMsl != null ? u.combatKillsMsl : (wc && wc.killsMsl)) || 0;
            if (u.combatKillsFox1 != null || u.combatKillsFox2 != null
                || (wc && (wc.killsFox1 != null || wc.killsFox2 != null))) {
                typedKillFields += 1;
                killsF1 += Number(u.combatKillsFox1 != null ? u.combatKillsFox1 : (wc && wc.killsFox1)) || 0;
                killsF2 += Number(u.combatKillsFox2 != null ? u.combatKillsFox2 : (wc && wc.killsFox2)) || 0;
            }
        }
        const shots = Array.isArray(u.missileShots) ? u.missileShots : [];
        for (const s of shots) {
            if (!s) continue;
            shotN += 1;
            if (s.type === 'fox1') shotF1 += 1;
            else shotF2 += 1;
            if (s.outcome === 'hit') shotHit += 1;
            else if (s.outcome === 'coast') shotCoast += 1;
            else if (s.outcome === 'building') shotBuilding += 1;
            else if (s.outcome === 'exhausted') shotExhausted += 1;
            if (s.type === 'fox1' && s.why) {
                fox1Why[s.why] = (fox1Why[s.why] || 0) + 1;
            }
            if (s.type === 'fox2' && s.why) {
                fox2Why[s.why] = (fox2Why[s.why] || 0) + 1;
            }
        }
        const kb = u && u.killedBy;
        const cause = (roster.find((r) => r.id === id) || {}).deathCause
            || u.deathCause
            || (u.action && u.action.deathCause)
            || null;
        if (kb && kb.attackerId && String(cause) === 'combat') {
            killedByCombat += 1;
            if (kb.weapon === 'fox1') killedByF1 += 1;
            else if (kb.weapon === 'fox2') killedByF2 += 1;
        }
        // Dirt/slab tags still come from trails even when counters exist (survival, not weapon).
        if (wc && Number(wc.turns) > 0) {
            const trails = []
                .concat(u.deathTrail || [])
                .concat(u.decisionTrail || []);
            for (const t of trails) {
                if (/dirtBleedRecover|dirtUnderTable|slabDirtArrest/i.test(String(t.reason || ''))) dirtBleed++;
                if (/slabDirtArrest|dirt arrest/i.test(String(t.reason || ''))) slabArrest++;
                if (/mslKnife|mslClose|\bmsl\b/i.test(String(t.reason || ''))) softMsl++;
                if (t.prepTimeout === 'shoot') prepTimeoutShoot++;
                if (t.prepTimeout === 'hang') prepTimeoutHang++;
            }
        }
    }

    const fox1Env = countRe(raw, /envelope:\s*type=fox1/gi);
    const fox2Env = countRe(raw, /envelope:\s*type=fox2/gi);
    const gateOk = j.turn >= 150 && building <= 1 && ground === 0 && midair === 0;
    const spawnFacing = (j.batch && j.batch.spawnFacing) ? String(j.batch.spawnFacing) : '';
    const loadout = (j.batch && j.batch.loadout) ? String(j.batch.loadout) : '';

    return {
        file: path.basename(filePath),
        turn: j.turn,
        arena: j.arenaMode,
        mode: j.matchMode,
        models: [...models],
        building,
        combat,
        ground,
        midair,
        airspace,
        other,
        gateOk,
        spawnFacing,
        loadout,
        mslQ,
        gunQ,
        fox1Env,
        fox2Env,
        illuminate,
        missileAttackSel,
        missilePrepSel,
        chaffEsc,
        flareEsc,
        dirtBleed,
        slabArrest,
        softMsl,
        countersUsed,
        counterTurns,
        combatKills,
        killsGun,
        killsMsl,
        killsF1: typedKillFields > 0 ? killsF1 : killedByF1,
        killsF2: typedKillFields > 0 ? killsF2 : killedByF2,
        typedKillFields,
        killFields,
        killedByCombat,
        shotN,
        shotF1,
        shotF2,
        shotHit,
        shotCoast,
        shotBuilding,
        shotExhausted,
        fox1Why,
        fox2Why,
        // Own combat deaths per missile-queue (legacy; not kill efficiency).
        prepTimeoutShoot,
        prepTimeoutHang,
        atkPrep: missilePrepSel > 0
            ? Number((missileAttackSel / missilePrepSel).toFixed(3))
            : (missileAttackSel > 0 ? Infinity : 0),
        shotPrep: missilePrepSel > 0
            ? Number((mslQ / missilePrepSel).toFixed(3))
            : (mslQ > 0 ? Infinity : 0),
        combatPerMsl: mslQ > 0 ? Number((combat / mslQ).toFixed(3)) : (combat > 0 ? Infinity : 0),
        // True combat kills per missile-queue (null if dump lacks kill fields).
        killsPerMsl: killFields > 0
            ? (mslQ > 0 ? Number((combatKills / mslQ).toFixed(3)) : (combatKills > 0 ? Infinity : 0))
            : null
    };
}

function printRow(r) {
    console.log(
        [
            r.file.padEnd(56),
            `T${String(r.turn).padStart(3)}`,
            `b${r.building}/g${r.ground}/m${r.midair || 0}/a${r.airspace || 0}/c${r.combat}`,
            r.gateOk ? 'GATE' : '----',
            r.spawnFacing ? `face=${r.spawnFacing}` : 'face=-',
            r.loadout ? `lo=${r.loadout}` : 'lo=-',
            r.countersUsed ? `wc${r.countersUsed}` : 'trail',
            `mslQ=${r.mslQ}`,
            `gunQ=${r.gunQ}`,
            `f1/f2=${r.fox1Env}/${r.fox2Env}`,
            `illum=${r.illuminate}`,
            `atk/prep=${r.missileAttackSel}/${r.missilePrepSel}` +
            `(${r.atkPrep === Infinity ? 'inf' : r.atkPrep})`,
            `shot/prep=${r.mslQ}/${r.missilePrepSel}` +
            `(${r.shotPrep === Infinity ? 'inf' : r.shotPrep})`,
            `pt=${r.prepTimeoutShoot}/${r.prepTimeoutHang}`,
            `chaffEsc=${r.chaffEsc}`,
            `dirt=${r.dirtBleed}`,
            `kills=${r.killFields ? r.combatKills : 'n/a'}`,
            `killsF1/killsF2=${r.killsF1}/${r.killsF2}`,
            `shots=${r.shotF1}/${r.shotF2} h/c/b/e=${r.shotHit}/${r.shotCoast}/${r.shotBuilding}/${r.shotExhausted}` +
            (formatFox1WhyMap(r.fox1Why) ? ` f1why=${formatFox1WhyMap(r.fox1Why)}` : '') +
            (formatFox2WhyMap(r.fox2Why) ? ` f2why=${formatFox2WhyMap(r.fox2Why)}` : ''),
            `k/msl=${r.killsPerMsl == null ? 'n/a' : (r.killsPerMsl === Infinity ? 'inf' : r.killsPerMsl)}`,
            `ownC/msl=${r.combatPerMsl === Infinity ? 'inf' : r.combatPerMsl}`,
            `ai=${(r.models || []).join('|') || '?'}`
        ].join('  ')
    );
}

function summarize(name, rows) {
    if (!rows.length) return;
    const n = rows.length;
    const sum = (k) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    const avg = (k) => sum(k) / n;
    const wcMatches = rows.filter((r) => r.countersUsed > 0).length;
    console.log(`\n## group ${name} (n=${n})`);
    console.log(
        `  avgTurn=${avg('turn').toFixed(0)}  building=${sum('building')}  ground=${sum('ground')}  midair=${sum('midair')}  airspace=${sum('airspace')}  combat=${sum('combat')}  gatePass=${rows.filter((r) => r.gateOk).length}/${n}`
    );
    const atk = sum('missileAttackSel');
    const prep = sum('missilePrepSel');
    console.log(
        `  mslQ=${sum('mslQ')}  gunQ=${sum('gunQ')}  fox1Env=${sum('fox1Env')}  fox2Env=${sum('fox2Env')}  illuminate=${sum('illuminate')}`
    );
    console.log(
        `  atk/prep=${atk}/${prep} (${prep ? (atk / prep).toFixed(3) : (atk > 0 ? 'inf' : '0')})  shot/prep=${sum('mslQ')}/${prep} (${prep ? (sum('mslQ') / prep).toFixed(3) : (sum('mslQ') > 0 ? 'inf' : '0')})  prepTimeout shoot/hang=${sum('prepTimeoutShoot')}/${sum('prepTimeoutHang')}`
    );
    console.log(
        `  chaffEsc=${sum('chaffEsc')}  flareEsc=${sum('flareEsc')}  dirtBleedTags=${sum('dirtBleed')}  ownCombat/mslQ=${sum('mslQ') ? (sum('combat') / sum('mslQ')).toFixed(3) : 'n/a'}`
    );
    const killRows = rows.filter((r) => r.killFields > 0);
    if (killRows.length) {
        const kSum = (k) => killRows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
        const msl = kSum('mslQ');
        console.log(
            `  combatKills=${kSum('combatKills')}  killsGun=${kSum('killsGun')}  killsMsl=${kSum('killsMsl')}  killsF1/killsF2=${kSum('killsF1')}/${kSum('killsF2')}  killedByCombat=${kSum('killedByCombat')}  kills/mslQ=${msl ? (kSum('combatKills') / msl).toFixed(3) : 'n/a'}`
        );
        const f1WhyBit = formatFox1WhyMap(mergeFox1WhyMaps(killRows));
        const f2WhyBit = formatFox2WhyMap(mergeWhyMaps(killRows, 'fox2Why'));
        console.log(
            `  missileShots=${kSum('shotN')}  shotF1/F2=${kSum('shotF1')}/${kSum('shotF2')}  out h/c/b/e=${kSum('shotHit')}/${kSum('shotCoast')}/${kSum('shotBuilding')}/${kSum('shotExhausted')}` +
            (f1WhyBit ? `  f1why=${f1WhyBit}` : '') +
            (f2WhyBit ? `  f2why=${f2WhyBit}` : '')
        );
    } else {
        console.log('  combatKills=n/a (pre-2026-08-24 dump — ownCombat/mslQ is not kill efficiency)');
    }
    console.log(
        `  weaponCounters: matches=${wcMatches}/${n}  counterTurns=${sum('counterTurns')}`
    );
}

function main() {
    const groups = parseArgs(process.argv.slice(2));
    if (!groups.length) {
        console.log('Usage: node tools/weapon-efficiency-dump.js [--group name] dump.json ...');
        process.exit(1);
    }
    console.log('weapon-efficiency-dump — survival + weapon A/B');
    console.log('Lab booth: 1v1 blank chase T60 — score shot/prep=mslQ/mslPrep (illuminate queue counts). Hang 0.02–0.07; look ≥0.15. T150 GATE is gold-only.');
    console.log('Weapon look-for: atk/prep up, prepTimeout shoot>hang, fewer illuminate-only stalls');
    console.log('ownCombat/mslQ = own combat deaths per mslQ (legacy). kills/mslQ needs 2026-08-24+ dumps.\n');

    for (const g of groups) {
        const rows = [];
        for (const f of g.files) {
            if (!fs.existsSync(f)) {
                console.error('missing', f);
                continue;
            }
            const r = analyzeFile(f);
            printRow(r);
            rows.push(r);
        }
        summarize(g.name, rows);
    }
}

main();
