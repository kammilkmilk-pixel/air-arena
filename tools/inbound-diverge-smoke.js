#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'ai', 'pilot-ai.js'), 'utf8');
const start = src.indexOf('const hardInboundBreak =');
const end = src.indexOf('const stealthAdvanceWindow =', start);
assert(start >= 0 && end > start, 'missing inbound hard-break branch');
const branch = src.slice(start, end);

assert(branch.includes('inboundDiverge = this.buildCloseMidairBreakAction({'),
    'inbound hard-break must take joyX from the merge builder');
assert(branch.includes('evadeJoyX = inboundDiverge.joyX'),
    'inbound hard-break must not keep the per-beat panicSide stick');
assert(branch.includes("? (steepClimb || selfForward.y > 0.35"),
    'inbound hard-break must keep its own joyY');
assert(branch.includes("'Inbound missile too close: hard break (no maskedHold)'"),
    'inbound reason needle must stay');
assert(branch.includes('divergeHold=${inboundDiverge.divergeHold ? 1 : 0}'),
    'inbound trail must write divergeHold=');
assert(!branch.includes('queueAction: inboundDiverge'),
    'inbound must not take builder queueAction');

console.log('inbound-diverge-smoke: ok');
