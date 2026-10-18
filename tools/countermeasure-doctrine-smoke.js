#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'ai', 'pilot-ai.js'), 'utf8');
const start = src.indexOf('// Inbound FOX-2: flare before shallow level-out');
const end = src.indexOf('// Nose-off knife fight', start);

assert(start >= 0 && end > start, 'missing pre-dive FOX-2 defense branch');
const branch = src.slice(start, end);
assert(branch.includes('!inboundFox1 &&'), 'pre-dive flare must reject inbound FOX-1');
assert(branch.includes('!shouldChaffNow &&'), 'pre-dive flare must yield to typed chaff');
assert(branch.includes("queueAction: 'flare'"), 'pre-dive FOX-2 defense must retain flare');

const urbanStart = src.indexOf('const missileDefenseUrgent =');
const urbanEnd = src.indexOf('const earlyUrbanPressure =', urbanStart);
assert(urbanStart >= 0 && urbanEnd > urbanStart, 'missing pre-urban missile defense branch');
const urban = src.slice(urbanStart, urbanEnd);
assert(urban.includes('canUseFlare &&') && urban.includes('flareCooldownReady &&'), 'pre-urban gate must stay unchanged');
assert(!urban.includes('!inboundFox1'), 'pre-urban gate must not skip on FOX-1 (building regression)');
assert(/inboundFox1 && !inboundFox2\s*\?\s*\(canUseChaff && chaffCooldownReady \? 'chaff' : 'none'\)\s*:\s*'flare'/.test(urban),
    'pre-urban expendable must follow seeker type');
assert(urban.includes('queueAction: preUrbanCm'), 'pre-urban branch must queue typed expendable');

console.log('countermeasure-doctrine-smoke: ok');
