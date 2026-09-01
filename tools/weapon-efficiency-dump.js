#!/usr/bin/env node
/**
 * weapon-efficiency-dump.js — Knife6 survival + weapon A/B metrics from roster dumps
 *
 * Usage:
 *   node tools/weapon-efficiency-dump.js <dump.json> [more.json ...]
 *   node tools/weapon-efficiency-dump.js --group Rei_03 a.json b.json --group Rei_02 c.json d.json
 *
 * A/B protocol (live):
 *   1) Ctrl+F5 → dense-urban 2v2
 *   2) All seats AI: one match all Rei_03, one match all Rei_02 (or split sides)
 *      Optional historical batch: all Rei_01 / live test_01
 *   3) Export roster at end (T150 preferred)
 *   4) Run this tool on both groups; compare combat kills, mslQueues, illuminateHold, ground deaths
 *
 * Prefers unit.weaponCounters (match-long tallies) when present; else falls back to trailMax≈40.
 * 2026-08-24+ dumps include killedBy / combatKills / weaponCounters.kills.
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
    let airspace = 0;
    let other = 0;
    const models = new Set();
    for (const r of roster) {
        if (!r.isDestroyed) continue;
        const c = String(r.deathCause || '');
        if (c === 'building') building++;
        else if (c === 'combat') combat++;
        else if (c === 'ground') ground++;
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
    let combatKills = 0;
    let killsGun = 0;
    let killsMsl = 0;
    let killFields = 0;
    let killedByCombat = 0;

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
        }
        const kb = u && u.killedBy;
        const cause = (roster.find((r) => r.id === id) || {}).deathCause
            || u.deathCause
            || (u.action && u.action.deathCause)
            || null;
        if (kb && kb.attackerId && String(cause) === 'combat') killedByCombat += 1;
        // Dirt/slab tags still come from trails even when counters exist (survival, not weapon).
        if (wc && Number(wc.turns) > 0) {
            const trails = []
                .concat(u.deathTrail || [])
                .concat(u.decisionTrail || []);
            for (const t of trails) {
                if (/dirtBleedRecover|dirtUnderTable|slabDirtArrest/i.test(String(t.reason || ''))) dirtBleed++;
                if (/slabDirtArrest|dirt arrest/i.test(String(t.reason || ''))) slabArrest++;
                if (/mslKnife|mslClose|\bmsl\b/i.test(String(t.reason || ''))) softMsl++;
            }
        }
    }

    const fox1Env = countRe(raw, /envelope:\s*type=fox1/gi);
    const fox2Env = countRe(raw, /envelope:\s*type=fox2/gi);
    const gateOk = j.turn >= 150 && building <= 1;

    return {
        file: path.basename(filePath),
        turn: j.turn,
        arena: j.arenaMode,
        mode: j.matchMode,
        models: [...models],
        building,
        combat,
        ground,
        airspace,
        other,
        gateOk,
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
        killFields,
        killedByCombat,
        // Own combat deaths per missile-queue (legacy; not kill efficiency).
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
            `b${r.building}/g${r.ground}/a${r.airspace || 0}/c${r.combat}`,
            r.gateOk ? 'GATE' : '----',
            r.countersUsed ? `wc${r.countersUsed}` : 'trail',
            `mslQ=${r.mslQ}`,
            `gunQ=${r.gunQ}`,
            `f1/f2=${r.fox1Env}/${r.fox2Env}`,
            `illum=${r.illuminate}`,
            `atk/prep=${r.missileAttackSel}/${r.missilePrepSel}`,
            `chaffEsc=${r.chaffEsc}`,
            `dirt=${r.dirtBleed}`,
            `kills=${r.killFields ? r.combatKills : 'n/a'}`,
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
        `  avgTurn=${avg('turn').toFixed(0)}  building=${sum('building')}  ground=${sum('ground')}  airspace=${sum('airspace')}  combat=${sum('combat')}  gatePass=${rows.filter((r) => r.gateOk).length}/${n}`
    );
    console.log(
        `  mslQ=${sum('mslQ')}  gunQ=${sum('gunQ')}  fox1Env=${sum('fox1Env')}  fox2Env=${sum('fox2Env')}  illuminate=${sum('illuminate')}`
    );
    console.log(
        `  chaffEsc=${sum('chaffEsc')}  flareEsc=${sum('flareEsc')}  dirtBleedTags=${sum('dirtBleed')}  ownCombat/mslQ=${sum('mslQ') ? (sum('combat') / sum('mslQ')).toFixed(3) : 'n/a'}`
    );
    const killRows = rows.filter((r) => r.killFields > 0);
    if (killRows.length) {
        const kSum = (k) => killRows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
        const msl = kSum('mslQ');
        console.log(
            `  combatKills=${kSum('combatKills')}  killsGun=${kSum('killsGun')}  killsMsl=${kSum('killsMsl')}  killedByCombat=${kSum('killedByCombat')}  kills/mslQ=${msl ? (kSum('combatKills') / msl).toFixed(3) : 'n/a'}`
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
    console.log('Knife6 look-for: ground↓, dirtBleed tags with high joyY arrest, no skim at alt<8');
    console.log('Weapon look-for: higher kills/mslQ, fewer illuminate-only stalls, chaffEsc on paint');
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
