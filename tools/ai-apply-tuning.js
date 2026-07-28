#!/usr/bin/env node
/**
 * ai-apply-tuning.js
 *
 * Apply params from autotune report to js/ai/pilot-tuning.local.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sharedDefaults = require(path.join(ROOT, 'js', 'ai', 'pilot-tuning-defaults.js'));
const ALLOWED_KEYS = sharedDefaults.PARAM_KEYS;

const DEFAULTS = {
    report: '',
    source: 'consensus',
    target: path.join(ROOT, 'js', 'ai', 'pilot-tuning.local.js')
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
            cfg[name] = val;
            i++;
        }
    }
    return cfg;
}

function newestReportFile(dir) {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir)
        .filter((name) => /^(autotune|merged)-.*\.json$/i.test(name))
        .map((name) => path.join(dir, name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files[0] || null;
}

function resolveReportPath(cfg) {
    if (cfg.report) return path.isAbsolute(cfg.report) ? cfg.report : path.resolve(process.cwd(), cfg.report);
    const reportsDir = path.join(__dirname, 'reports');
    return newestReportFile(reportsDir);
}

function cleanParams(params) {
    const out = {};
    for (const key of ALLOWED_KEYS) {
        if (typeof params[key] === 'number' && Number.isFinite(params[key])) {
            out[key] = Number(params[key].toFixed(6));
        }
    }
    return out;
}

function pickParams(report, source) {
    const mode = String(source || 'consensus').toLowerCase();
    if (mode === 'best' && report.best && report.best.params) return cleanParams(report.best.params);
    if (report.consensusParams && Object.keys(report.consensusParams).length) return cleanParams(report.consensusParams);
    if (report.best && report.best.params) return cleanParams(report.best.params);
    throw new Error('No usable params found in report.');
}

function buildFileContent(params, meta = {}) {
    const generatedAt = new Date().toISOString();
    return `// ============================================================================
// pilot-tuning.local.js - Runtime AI tuning overrides (auto-generated)
// Source: ${meta.source || 'unknown'}
// Generated: ${generatedAt}
// ============================================================================
(function initAirArenaAITuning() {
    window.AIR_ARENA_AI_TUNING_META = {
        source: ${JSON.stringify(meta.source || 'unknown')},
        generatedAt: ${JSON.stringify(generatedAt)}
    };
    window.AIR_ARENA_AI_TUNING = {
${Object.keys(params).map((k) => `        ${k}: ${params[k]}`).join(',\n')}
    };
})();
`;
}

function main() {
    const cfg = parseArgs(process.argv);
    const reportPath = resolveReportPath(cfg);
    if (!reportPath || !fs.existsSync(reportPath)) {
        console.error('Report not found. Provide --report or run autotune first.');
        process.exit(1);
    }
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const params = pickParams(report, cfg.source);
    if (!Object.keys(params).length) {
        console.error('No valid tuning params extracted.');
        process.exit(1);
    }

    const targetPath = path.isAbsolute(cfg.target) ? cfg.target : path.resolve(process.cwd(), cfg.target);
    const metaSource = path.relative(ROOT, reportPath).split(path.sep).join('/');
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, buildFileContent(params, { source: metaSource }), 'utf8');

    console.log('AI tuning applied');
    console.log(`Report: ${metaSource}`);
    console.log(`Target: ${path.relative(ROOT, targetPath).split(path.sep).join('/')}`);
    console.log(`Keys: ${Object.keys(params).length}`);
}

main();
