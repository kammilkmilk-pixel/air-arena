#!/usr/bin/env node
/**
 * decide-gate-smoke.js — H3: named decide pipeline order must match source.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const pipeline = require(path.join(ROOT, 'js', 'ai', 'decide-pipeline.js'));
const pilotSrc = fs.readFileSync(path.join(ROOT, 'js', 'ai', 'pilot-ai.js'), 'utf8');

const fails = [];

const uniq = pipeline.assertUniqueOrder(pipeline.DECIDE_GATE_ORDER);
if (!uniq.ok) fails.push(`duplicate gates: ${uniq.dup.join(',')}`);

if (!pilotSrc.includes('runDecidePipeline')) {
    fails.push('pilot-ai.js missing runDecidePipeline');
}
if (!pilotSrc.includes('tryDecideGate')) {
    fails.push('pilot-ai.js missing tryDecideGate');
}
if (!pilotSrc.includes('finishDecideGate')) {
    fails.push('pilot-ai.js missing finishDecideGate');
}

// Prefix gates via tryDecideGate
for (const id of pipeline.PREFIX_GATE_ORDER) {
    if (!pilotSrc.includes(`tryDecideGate('${id}'`) && !pilotSrc.includes(`tryDecideGate("${id}"`)) {
        fails.push(`prefix gate not invoked: ${id}`);
    }
}

// Main gates via runDecidePipeline entries
for (const id of pipeline.MAIN_GATE_ORDER) {
    const hit = new RegExp(`\\[\\s*['"]${id}['"]\\s*,`).test(pilotSrc);
    if (!hit) fails.push(`main gate not in pipeline array: ${id}`);
}

const orderCheck = pipeline.assertSourceMatchesOrder(pilotSrc, pipeline.DECIDE_GATE_ORDER);
if (!orderCheck.ok) {
    fails.push(
        `source gate order mismatch\n  expected: ${orderCheck.expected.join(' → ')}\n  found:    ${orderCheck.firstHits.join(' → ')}\n  missing:  ${orderCheck.missing.join(',') || '(none)'}`
    );
}

// Required doctrine docs present
for (const id of ['fox2Opening', 'obstacleEmergency', 'alignFirst']) {
    if (!pipeline.GATE_DOCS[id]) fails.push(`missing GATE_DOCS for ${id}`);
}

if (fails.length) {
    console.error('Decide-gate smoke FAIL:');
    for (const f of fails) console.error(' -', f);
    process.exit(1);
}

console.log('Decide-gate smoke PASS');
console.log('Order:', pipeline.DECIDE_GATE_ORDER.join(' → '));
