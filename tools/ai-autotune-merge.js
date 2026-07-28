#!/usr/bin/env node
/**
 * ai-autotune-merge.js
 *
 * Merge multiple autotune reports and output:
 * - stable top candidates across runs
 * - consensus params (median from stable candidates)
 */

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
    dir: path.join(__dirname, 'reports'),
    out: path.join(__dirname, 'reports', `merged-${Date.now()}.json`),
    top: 3,
    stableN: 3,
    scenario: 'normal',
    objective: 'balanced',
    inputs: ''
};

function parseArgs(argv) {
    const cfg = { ...DEFAULTS };
    for (let i = 2; i < argv.length; i++) {
        const key = argv[i];
        const val = argv[i + 1];
        if (!key.startsWith('--')) continue;
        const name = key.slice(2);
        if (!(name in cfg)) continue;
        if (val !== undefined && !val.startsWith('--')) {
            cfg[name] = (typeof cfg[name] === 'number') ? Number(val) : val;
            i++;
        }
    }
    return cfg;
}

function ensureDir(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
}

function toKey(params) {
    const normalized = {};
    Object.keys(params || {})
        .filter((k) => !k.startsWith('_'))
        .sort()
        .forEach((k) => {
            const v = params[k];
            normalized[k] = typeof v === 'number' ? Number(v.toFixed(6)) : v;
        });
    return JSON.stringify(normalized);
}

function parseInputList(cfg) {
    if (cfg.inputs && String(cfg.inputs).trim()) {
        return String(cfg.inputs)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
            .map((p) => path.isAbsolute(p) ? p : path.resolve(process.cwd(), p));
    }

    if (!fs.existsSync(cfg.dir)) return [];
    return fs.readdirSync(cfg.dir)
        .filter((name) => /^autotune-.*\.json$/i.test(name))
        .map((name) => path.join(cfg.dir, name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function loadReports(pathsList, top, scenario, objective) {
    const reports = [];
    const entries = [];

    for (const p of pathsList) {
        try {
            const raw = fs.readFileSync(p, 'utf8');
            const report = JSON.parse(raw);
            if (!Array.isArray(report.top) || !report.top.length) continue;
            const reportScenario = (report.config && report.config.scenario) || 'normal';
            const reportObjective = (report.config && report.config.objective) || 'balanced';
            if (scenario && scenario !== 'all' && reportScenario !== scenario) continue;
            if (objective && objective !== 'all' && reportObjective !== objective) continue;
            reports.push({
                path: p,
                generatedAt: report.generatedAt || null,
                scenario: reportScenario,
                objective: reportObjective,
                top: report.top.slice(0, top)
            });
            report.top.slice(0, top).forEach((item, idx) => {
                if (!item || !item.params) return;
                entries.push({
                    source: p,
                    generatedAt: report.generatedAt || null,
                    scenario: reportScenario,
                    objective: reportObjective,
                    rankInReport: idx + 1,
                    params: item.params,
                    hybridScore: Number(item.hybridScore || 0),
                    heuristicScore: Number(item.heuristicScore || 0),
                    deltaScore: Number(item.deltaScore || 0),
                    deltaWinRate: Number(item.deltaWinRate || 0),
                    deltaCrashRate: Number(item.deltaCrashRate || 0),
                    stressScore: typeof item.stressScore === 'number' ? item.stressScore : null,
                    stressCrashRate: typeof item.stressCrashRate === 'number' ? item.stressCrashRate : null
                });
            });
        } catch (err) {
            // Ignore malformed files and continue.
        }
    }
    return { reports, entries };
}

function buildStableCandidates(entries) {
    const bucket = new Map();
    for (const e of entries) {
        const key = toKey(e.params);
        if (!bucket.has(key)) {
            bucket.set(key, {
                key,
                params: e.params,
                count: 0,
                appearances: [],
                hybridScoreSum: 0,
                heuristicScoreSum: 0,
                deltaScoreSum: 0,
                deltaWinRateSum: 0,
                deltaCrashRateSum: 0,
                stressScoreSum: 0,
                stressCrashRateSum: 0,
                stressCount: 0
            });
        }
        const row = bucket.get(key);
        row.count += 1;
        row.appearances.push({ source: e.source, rank: e.rankInReport, scenario: e.scenario, objective: e.objective });
        row.hybridScoreSum += e.hybridScore;
        row.heuristicScoreSum += e.heuristicScore;
        row.deltaScoreSum += e.deltaScore;
        row.deltaWinRateSum += e.deltaWinRate;
        row.deltaCrashRateSum += e.deltaCrashRate;
        if (typeof e.stressScore === 'number') {
            row.stressScoreSum += e.stressScore;
            row.stressCrashRateSum += e.stressCrashRate || 0;
            row.stressCount += 1;
        }
    }

    return [...bucket.values()]
        .map((row) => ({
            params: row.params,
            appearances: row.count,
            avgHybridScore: Number((row.hybridScoreSum / row.count).toFixed(3)),
            avgHeuristicScore: Number((row.heuristicScoreSum / row.count).toFixed(3)),
            avgDeltaScore: Number((row.deltaScoreSum / row.count).toFixed(3)),
            avgDeltaWinRate: Number((row.deltaWinRateSum / row.count).toFixed(4)),
            avgDeltaCrashRate: Number((row.deltaCrashRateSum / row.count).toFixed(4)),
            avgStressScore: row.stressCount ? Number((row.stressScoreSum / row.stressCount).toFixed(3)) : null,
            avgStressCrashRate: row.stressCount ? Number((row.stressCrashRateSum / row.stressCount).toFixed(4)) : null,
            details: row.appearances
        }))
        .sort((a, b) => {
            if (b.appearances !== a.appearances) return b.appearances - a.appearances;
            if (b.avgDeltaScore !== a.avgDeltaScore) return b.avgDeltaScore - a.avgDeltaScore;
            return b.avgHybridScore - a.avgHybridScore;
        });
}

function buildConsensusParams(candidates) {
    if (!candidates.length) return {};
    const keys = Object.keys(candidates[0].params || {}).filter((k) => !k.startsWith('_'));
    const out = {};
    for (const key of keys) {
        const values = candidates
            .map((c) => c.params[key])
            .filter((v) => typeof v === 'number');
        if (!values.length) continue;
        out[key] = Number(median(values).toFixed(6));
    }
    return out;
}

function main() {
    const cfg = parseArgs(process.argv);
    const files = parseInputList(cfg);
    if (!files.length) {
        console.error('No report files found. Run autotune first.');
        process.exit(1);
    }

    const { reports, entries } = loadReports(files, cfg.top, cfg.scenario, cfg.objective);
    if (!entries.length) {
        console.error(`No valid report entries found for scenario=${cfg.scenario}, objective=${cfg.objective}`);
        process.exit(1);
    }

    const stable = buildStableCandidates(entries);
    const topStable = stable.slice(0, Math.max(1, cfg.stableN));
    const consensusParams = buildConsensusParams(topStable);

    const output = {
        generatedAt: new Date().toISOString(),
        scenario: cfg.scenario,
        objective: cfg.objective,
        sourceReports: reports.map((r) => ({ path: r.path, generatedAt: r.generatedAt, scenario: r.scenario, objective: r.objective })),
        settings: {
            topPerReport: cfg.top,
            stableN: cfg.stableN
        },
        stableCandidates: stable,
        selectedStableTop: topStable,
        consensusParams,
        usageHint: 'Apply consensusParams as a candidate, then verify in-game with A/B runs.'
    };

    ensureDir(cfg.out);
    fs.writeFileSync(cfg.out, JSON.stringify(output, null, 2), 'utf8');

    console.log('Autotune merge finished');
    console.log(`Scenario: ${cfg.scenario}`);
    console.log(`Objective: ${cfg.objective}`);
    console.log(`Merged report: ${cfg.out}`);
    console.log(`Reports merged: ${reports.length}`);
    console.log(`Consensus params keys: ${Object.keys(consensusParams).length}`);
}

main();
