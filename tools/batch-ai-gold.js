#!/usr/bin/env node
'use strict';
/**
 * Gold A.1 A/B cell: n=3, City Map, dense-urban 2v2, cross + tangent, alt 80 / sep 200.
 *
 *   npm.cmd run batch:ai:gold -- --brains test_01
 *   npm.cmd run batch:ai:gold -- --brains Rei_03
 *   npm.cmd run batch:ai:gold -- --ab
 *
 * Extra args are forwarded; gold spawn/n always win. Ctrl+F5 the game tab first.
 */
const { spawn } = require('child_process');
const path = require('path');

const extra = process.argv.slice(2);
const forced = [
    '--n', '3',
    '--alt', '80',
    '--sep', '200',
    '--spawn-formation', 'cross',
    '--spawn-facing', 'tangent',
    '--no-spawn-mix'
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
