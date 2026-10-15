#!/usr/bin/env node
'use strict';
/**
 * Lab weapon booth (not gold, not live play):
 * 1v1, blank, chase, alt 80 / sep 140, maxTurns 60, n=3.
 *
 *   npm.cmd run batch:ai:weapon -- --brains test_01
 *
 * Booth closed 2026-09-05 (shot/prep). Urban hang is A.2b. Chase is lab-only.
 */
const { spawn } = require('child_process');
const path = require('path');

const extra = process.argv.slice(2);
const forced = [
    '--n', '3',
    '--mode', '1v1',
    '--arena', 'blank',
    '--alt', '80',
    '--sep', '140',
    '--spawn-formation', 'pair',
    '--spawn-facing', 'chase',
    '--no-spawn-mix',
    '--max-turns', '60'
];
const child = spawn(
    process.execPath,
    [path.join(__dirname, 'batch-ai-matches.js')].concat(extra, forced),
    { cwd: path.join(__dirname, '..'), stdio: 'inherit' }
);
child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code == null ? 1 : code);
});
