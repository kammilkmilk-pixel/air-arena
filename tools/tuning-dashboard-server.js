#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.TUNING_DASHBOARD_PORT || 8765);
const DASHBOARD_HTML = path.join(__dirname, 'dashboard', 'index.html');
const TUNING_FILE = path.join(ROOT, 'js', 'ai', 'pilot-tuning.local.js');
const CURRICULUM_FILE = path.join(ROOT, 'tools', 'curriculum', 'ai-curriculum.json');
const REPORTS_DIR = path.join(ROOT, 'tools', 'reports');
const SCENARIOS = new Set(['normal', 'low-altitude', 'low-energy', 'high-threat', 'mixed-stress']);
const OBJECTIVES = new Set(['safety-first', 'balanced', 'aggressive']);

const TUNING_KEYS = [
    'energyCriticalAp',
    'lowAp',
    'stallPitchThreshold',
    'minRecoverAlt',
    'stallRecoverBonus',
    'climbPenalty',
    'gunRange',
    'gunAngle',
    'missileMinRange',
    'missileMaxRange',
    'missileAngle',
    'interceptTurnGain',
    'recoverPitchBias',
    'hybridAggression'
];

/** @type {Map<string, {id: string, status: string, startedAt: string, endedAt: string|null, exitCode: number|null, command: string, logs: string}>} */
const jobs = new Map();
let activeJobId = null;

function sendJson(res, code, payload) {
    const body = JSON.stringify(payload, null, 2);
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
}

function sendText(res, code, text, contentType = 'text/plain; charset=utf-8') {
    res.writeHead(code, {
        'Content-Type': contentType,
        'Content-Length': Buffer.byteLength(text)
    });
    res.end(text);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk.toString('utf8');
            if (data.length > 2 * 1024 * 1024) {
                reject(new Error('Request body too large'));
            }
        });
        req.on('end', () => resolve(data));
        req.on('error', reject);
    });
}

function pickLatestByPrefix(prefix) {
    if (!fs.existsSync(REPORTS_DIR)) return null;
    const files = fs.readdirSync(REPORTS_DIR)
        .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
        .map((name) => path.join(REPORTS_DIR, name))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files[0] || null;
}

function parseTuningFile() {
    const fallback = {
        params: {},
        meta: {
            source: 'unknown',
            generatedAt: null
        }
    };
    if (!fs.existsSync(TUNING_FILE)) return fallback;
    const raw = fs.readFileSync(TUNING_FILE, 'utf8');

    const sourceMatch = raw.match(/source:\s*["']([^"']+)["']/);
    const generatedMatch = raw.match(/generatedAt:\s*["']([^"']+)["']/);
    const meta = {
        source: sourceMatch ? sourceMatch[1] : 'unknown',
        generatedAt: generatedMatch ? generatedMatch[1] : null
    };

    const params = {};
    for (const key of TUNING_KEYS) {
        const m = raw.match(new RegExp(`${key}:\\s*([-+]?\\d*\\.?\\d+)`));
        if (m) params[key] = Number(m[1]);
    }
    return { params, meta };
}

function writeTuningFile(params, source = 'dashboard-manual') {
    const lines = TUNING_KEYS
        .filter((key) => typeof params[key] === 'number' && Number.isFinite(params[key]))
        .map((key) => `        ${key}: ${Number(params[key].toFixed(6))}`);
    const generatedAt = new Date().toISOString();
    const content = `// ============================================================================
// pilot-tuning.local.js - Runtime AI tuning overrides (auto-generated)
// Source: ${source}
// Generated: ${generatedAt}
// ============================================================================
(function initAirArenaAITuning() {
    window.AIR_ARENA_AI_TUNING_META = {
        source: ${JSON.stringify(source)},
        generatedAt: ${JSON.stringify(generatedAt)}
    };
    window.AIR_ARENA_AI_TUNING = {
${lines.join(',\n')}
    };
})();
`;
    fs.writeFileSync(TUNING_FILE, content, 'utf8');
}

function pickLatestReport(prefix, scenario, objective) {
    if (!fs.existsSync(REPORTS_DIR)) return null;
    const files = fs.readdirSync(REPORTS_DIR)
        .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
        .map((name) => path.join(REPORTS_DIR, name))
        .filter((file) => {
            if (!scenario || scenario === 'all') return true;
            try {
                const report = JSON.parse(fs.readFileSync(file, 'utf8'));
                const reportScenario = (report.config && report.config.scenario) || report.scenario || 'normal';
                const reportObjective = (report.config && report.config.objective) || report.objective || 'balanced';
                if (reportScenario !== scenario) return false;
                if (objective && objective !== 'all' && reportObjective !== objective) return false;
                return true;
            } catch (_) {
                return false;
            }
        })
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return files[0] || null;
}

function sanitizeScenario(scenario) {
    const value = String(scenario || 'normal');
    return SCENARIOS.has(value) ? value : 'normal';
}

function sanitizeObjective(objective) {
    const value = String(objective || 'balanced');
    return OBJECTIVES.has(value) ? value : 'balanced';
}

function startPipelineJob(options = {}) {
    if (activeJobId) {
        return { error: 'A pipeline job is already running.', jobId: activeJobId, code: 409 };
    }
    const scenario = sanitizeScenario(options.scenario);
    const objective = sanitizeObjective(options.objective);
    const id = `job-${Date.now()}`;
    const outSuffix = `${scenario}-${objective}-${Date.now()}`;
    const autotuneOut = path.join(REPORTS_DIR, `autotune-${outSuffix}.json`);
    const mergedOut = path.join(REPORTS_DIR, `merged-${outSuffix}.json`);
    const commandLabel = `autotune:pipeline --scenario ${scenario} --objective ${objective}`;
    const job = {
        id,
        status: 'running',
        startedAt: new Date().toISOString(),
        endedAt: null,
        exitCode: null,
        command: commandLabel,
        scenario,
        objective,
        logs: ''
    };
    jobs.set(id, job);
    activeJobId = id;

    let child;
    try {
        const env = { ...process.env };
        delete env.npm_config_devdir;
        delete env.NPM_CONFIG_DEVDIR;
        const pipelineCommand = [
            `node tools/ai-autotune.js --iterations 120 --episodes 60 --turns 80 --scenario ${scenario} --objective ${objective} --out ${autotuneOut}`,
            `node tools/ai-autotune-merge.js --top 3 --stableN 3 --scenario ${scenario} --objective ${objective} --out ${mergedOut}`,
            'node tools/ai-apply-tuning.js --source consensus'
        ].join(' && ');
        if (process.platform === 'win32') {
            child = spawn('cmd.exe', ['/d', '/s', '/c', pipelineCommand], {
                cwd: ROOT,
                env,
                windowsHide: true
            });
        } else {
            child = spawn('sh', ['-c', pipelineCommand], {
                cwd: ROOT,
                env
            });
        }
    } catch (err) {
        jobs.delete(id);
        activeJobId = null;
        return { error: `spawn failed: ${err.message}`, code: 500 };
    }
    const append = (text) => {
        job.logs += text;
        if (job.logs.length > 300000) {
            job.logs = job.logs.slice(job.logs.length - 300000);
        }
    };
    child.stdout.on('data', (buf) => append(buf.toString('utf8')));
    child.stderr.on('data', (buf) => append(buf.toString('utf8')));
    child.on('error', (err) => {
        append(`\n[dashboard] process error: ${err.message}\n`);
        job.status = 'failed';
        job.exitCode = -1;
        job.endedAt = new Date().toISOString();
        activeJobId = null;
    });
    child.on('close', (code) => {
        job.status = code === 0 ? 'succeeded' : 'failed';
        job.exitCode = code;
        job.endedAt = new Date().toISOString();
        activeJobId = null;
    });
    return { jobId: id, code: 202 };
}

function loadCurriculum() {
    if (!fs.existsSync(CURRICULUM_FILE)) return null;
    return JSON.parse(fs.readFileSync(CURRICULUM_FILE, 'utf8'));
}

function getLatestReports(scenario = 'normal', objective = 'balanced') {
    const selectedScenario = sanitizeScenario(scenario);
    const selectedObjective = sanitizeObjective(objective);
    const latestAutotune = pickLatestReport('autotune-', selectedScenario, selectedObjective);
    const latestMerged = pickLatestReport('merged-', selectedScenario, selectedObjective);
    const readSafe = (p) => {
        if (!p) return null;
        try {
            return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch (_) {
            return null;
        }
    };
    return {
        latestAutotunePath: latestAutotune ? path.relative(ROOT, latestAutotune) : null,
        latestMergedPath: latestMerged ? path.relative(ROOT, latestMerged) : null,
        scenario: selectedScenario,
        objective: selectedObjective,
        latestAutotune: readSafe(latestAutotune),
        latestMerged: readSafe(latestMerged)
    };
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const method = req.method || 'GET';

        if (method === 'GET' && url.pathname === '/favicon.ico') {
            return sendText(res, 204, '');
        }
        if (method === 'GET' && url.pathname === '/') {
            const html = fs.readFileSync(DASHBOARD_HTML, 'utf8');
            return sendText(res, 200, html, 'text/html; charset=utf-8');
        }
        if (method === 'GET' && url.pathname === '/api/tuning') {
            return sendJson(res, 200, parseTuningFile());
        }
        if (method === 'POST' && url.pathname === '/api/tuning') {
            const raw = await readBody(req);
            const payload = JSON.parse(raw || '{}');
            const params = payload.params || {};
            writeTuningFile(params, 'dashboard-manual');
            return sendJson(res, 200, { ok: true, tuning: parseTuningFile() });
        }
        if (method === 'GET' && url.pathname === '/api/curriculum') {
            return sendJson(res, 200, { curriculum: loadCurriculum() });
        }
        if (method === 'GET' && url.pathname === '/api/reports/latest') {
            return sendJson(res, 200, getLatestReports(
                url.searchParams.get('scenario') || 'normal',
                url.searchParams.get('objective') || 'balanced'
            ));
        }
        if (method === 'POST' && url.pathname === '/api/jobs/pipeline') {
            const raw = await readBody(req);
            const payload = raw ? JSON.parse(raw) : {};
            const started = startPipelineJob({ scenario: payload.scenario, objective: payload.objective });
            if (started.error) return sendJson(res, started.code || 500, started);
            return sendJson(res, started.code || 202, started);
        }
        if (method === 'GET' && url.pathname === '/api/jobs/active') {
            if (!activeJobId) return sendJson(res, 200, { activeJobId: null, job: null });
            return sendJson(res, 200, { activeJobId, job: jobs.get(activeJobId) || null });
        }
        if (method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
            const id = url.pathname.split('/').pop();
            const job = id ? jobs.get(id) : null;
            if (!job) return sendJson(res, 404, { error: 'Job not found' });
            return sendJson(res, 200, job);
        }

        return sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
        return sendJson(res, 500, { error: err.message || String(err) });
    }
});

server.listen(PORT, () => {
    console.log(`Tuning dashboard server running at http://localhost:${PORT}`);
});
