#!/usr/bin/env node
/**
 * Open-sky facade pull-over: a taller building ahead with nothing overhead in plan
 * view gets a sim-scored jy 0.62 candidate in the scored escape, and the exit keeps
 * it past the slab headroom cap while the geometry still holds.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'js', 'ai', 'pilot-ai.js'), 'utf8');

function assert(cond, msg) {
    if (!cond) throw new Error(msg);
}

assert(src.includes('    isOverheadFootprintOpen(pos, margin = 2) {'), 'missing plan-view overhead check');
assert(src.includes('    isOpenFacadePullOver(pos, opts = {}) {'), 'missing pull-over gate');
assert(src.includes('if (!(Number.isFinite(roof) && roof < 0 && roof >= -22)) return false;'), 'pull-over only below a taller roof within 22 m');
assert(src.includes('if (!pos || !(pos.y >= 30)) return false;'), 'pull-over needs altitude');
assert(src.includes("mode: 'scorePullOver',"), 'scored escape must offer the pull-over candidate');
assert(src.includes("proto.branch !== 'pullOver') score -= 45;"), 'pull-over is not a climb-into-slab');
assert(src.includes('pullOver: scoredEsc.pullOver || undefined,'), 'escape output must carry the pull-over tag');
assert(src.includes('if (safeAction.pullOver && this.isOpenFacadePullOver(selfPos, {'), 'exit must recheck geometry before holding the pull');
assert(src.includes("if (!opts.carry && (kind === 'tableUndercroft' || kind === 'tightUndercroft')) return false;"),
    'only a carried pull-over may pass an undercroft choke label');
assert(/if \(!opts\.carry[^\n]*\n\s*return this\.isOverheadFootprintOpen\(pos, 2\);/.test(src), 'carry still needs an open footprint');
assert(src.includes('return !!(mem && Number.isFinite(t) && mem[teamId] === t - 1);'), 'carry lasts one beat after a flown pull-over');
assert(src.includes('if (pullOverCarry && pullOverOk)'), 'carried pull-over must skip re-score against skim');
assert(src.includes("reason: 'Scored escape: open-sky facade pull-over carry=1'"), 'forced carry stick must tag carry=1');
assert(src.includes('carry: pullOverCarry'), 'scored escape must honour the carry');
assert(src.includes('(this._pullOverTurn || (this._pullOverTurn = {}))[teamId] = pickTurn;'), 'pick arms carry with opts.turnNo');
assert(src.includes("out = (out && (out.pullOver || out.branch === 'pullOver'))"), 'table owner must not steal a pull-over');

const slab = src.indexOf('    isSlabClimbBlocked(opts = {}) {');
const slabEnd = src.indexOf('    isOverheadFootprintOpen(', slab);
assert(slab > 0 && slabEnd > slab, 'slab rules must stay ahead of the footprint helper');
assert(!/pullOver|Footprint/.test(src.slice(slab, slabEnd)), 'slab doctrine itself is unchanged');

console.log('pull-over-smoke: ok');
