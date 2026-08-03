'use strict';

/* =====================================================================
   Fitness for the autoplay policy.

   The measured number is the streak: kills per life, kills / (deaths + 1).
   A match won 25-0 scores 25.0, which is the maximum.

   This runs THE REAL CLIENT, through net-sim.js's vm harness -- the same
   trick its netcode measurements use. Movement, hitscan, spread, damage,
   reloads, respawns and the bot brains are the shipped code from src/*.js,
   not a copy of it here. A copy would move when you fixed the copy and stay
   put in the game.

   What is under test is also the shipped text: both the POLICY block and the
   driver that wraps simulate() are sliced straight out of the userscript, so
   there is no second implementation to drift.

   A match is a solo game -- the policy against CFG.bots bots on the real map,
   first to CFG.killsToWin. Seeds vary the match by re-seeding the bot brains,
   which is the only entropy that reaches their behaviour: bots.js contains no
   Math.random at all, and every brain is built with a fixed seed, so without
   this every match plays out identically.

   Usage:
     node tools/eval-policy.js [--matches 12] [--seed 1] [--idle]
   ===================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const { createInstance, FIXED, mulberry32 } = require('../net-sim.js');

const ROOT = path.join(__dirname, '..');
const SIM_BOOT = 'initViewmodel(); initFX(); initInput(); initAI();';
const MATCH_LIMIT_S = 420;        // a match unresolved by then is scored as it stands

function userscript() {
  return fs.readFileSync(path.join(ROOT, 'tools/nuketown-autoplay.user.js'), 'utf8');
}

/* The two halves of the userscript that play the game, taken verbatim. The
   rest of the file is the Tampermonkey header, the name randomiser and the
   menu auto-clicker, none of which has anything to do with fitness. */
function slice(src, startMark, from) {
  const a = src.indexOf(startMark, from || 0);
  if (a < 0) throw new Error('cannot find ' + startMark);
  const b = src.indexOf('\n})();', a);
  if (b < 0) throw new Error('unterminated block at ' + startMark);
  return { text: src.slice(a, b + 6), end: b + 6 };
}
function policySource(src) { return slice(src, 'const POLICY = (() => {').text; }
function driverSource(src) {
  const policy = slice(src, 'const POLICY = (() => {');
  return slice(src, ';(() => {', policy.end).text;
}

/* Counted at the one place the engine books a round and the one place it
   books damage, rather than by watching the ammo counter -- a reload or a
   weapon swap moves that too. */
const INSTRUMENT = `
  var SPENT_ROUNDS = 0, HITS = 0;
  const _fireWeapon = fireWeapon;
  fireWeapon = function (a) {
    const before = a.ammo;
    const out = _fireWeapon.apply(this, arguments);
    if (a === G.player && a.ammo < before) SPENT_ROUNDS++;
    return out;
  };
  const _applyDamage = applyDamage;
  applyDamage = function (target, dmg, from) {
    if (from === G.player) HITS++;
    return _applyDamage.apply(this, arguments);
  };
`;

/* Same eight bots, same skills and guns, a different behavioural draw. */
const RESEED = seed => `
  for (const a of G.actors) {
    if (!a.brain) continue;
    try { a.brain = AI.createBrain({ id: a.id, seed: ${seed >>> 0} * 7919 + a.id * 131, skill: a.skill }); }
    catch (e) {}
  }
`;

/* One match. `opts.src` is the userscript text under test; `opts.idle` leaves
   the driver out, which is the control showing the harness does not hand out
   kills by itself. */
function runMatch(seed, opts = {}) {
  const src = opts.src || userscript();
  const clock = { ms: 0 };
  const inst = createInstance(clock);

  inst.run(`Math.random = (${mulberry32.toString()})(${(seed >>> 0) || 1});`);
  inst.run(SIM_BOOT);
  inst.run(INSTRUMENT);
  inst.run(policySource(src));
  if (!opts.idle) inst.run(driverSource(src));     // wraps window.simulate
  if (opts.params) inst.run(`POLICY.setParams(${JSON.stringify(opts.params)});`);
  inst.run('startMatch();');
  inst.run(RESEED(seed));

  const target = inst.get('matchTarget()');
  let ticks = 0;
  const maxTicks = Math.round(MATCH_LIMIT_S / FIXED);
  while (ticks < maxTicks && !inst.get('G.over')) {
    inst.run(`simulate(${FIXED});`);
    clock.ms += FIXED * 1000;
    ticks++;
  }

  const kills = inst.get('G.player.kills') || 0;
  const deaths = inst.get('G.player.deaths') || 0;
  const spent = inst.get('SPENT_ROUNDS') || 0;
  const hits = inst.get('HITS') || 0;
  return {
    seed, kills, deaths, spent, hits,
    won: kills >= target,
    seconds: ticks * FIXED,
    streak: kills / (deaths + 1),
    accuracy: spent > 0 ? hits / spent : 0,
    perfect: deaths === 0 && kills >= target
  };
}

function summarise(name, rows) {
  const n = rows.length;
  const mean = f => rows.reduce((s, r) => s + f(r), 0) / n;
  const kills = mean(r => r.kills);
  const rounds = mean(r => r.spent);
  return {
    name, matches: n, rows,
    fitness: mean(r => r.streak),
    kills, deaths: mean(r => r.deaths),
    wins: rows.filter(r => r.won).length,
    perfect: rows.filter(r => r.perfect).length,
    rounds,
    perKill: kills > 0 ? rounds / kills : Infinity,
    accuracy: mean(r => r.accuracy),
    seconds: mean(r => r.seconds)
  };
}

function report(s) {
  console.log(
    `${s.name.padEnd(9)} fitness ${s.fitness.toFixed(3).padStart(7)}` +
    `   kills ${s.kills.toFixed(2).padStart(6)}` +
    `   deaths ${s.deaths.toFixed(2).padStart(5)}` +
    `   won ${String(s.wins).padStart(2)}/${s.matches}` +
    `   perfect ${String(s.perfect).padStart(2)}` +
    `   rounds/kill ${s.perKill === Infinity ? '  inf' : s.perKill.toFixed(1).padStart(5)}` +
    `   hit ${(s.accuracy * 100).toFixed(0).padStart(3)}%` +
    `   ${s.seconds.toFixed(0)}s`);
}

module.exports = {
  runMatch, summarise, report, userscript, policySource, driverSource, FIXED
};

if (require.main === module) {
  const arg = (k, d) => {
    const i = process.argv.indexOf('--' + k);
    return i >= 0 ? process.argv[i + 1] : d;
  };
  const matches = Number(arg('matches', 12));
  const first = Number(arg('seed', 1));
  const idle = process.argv.includes('--idle');
  const rows = [];
  for (let i = 0; i < matches; i++) {
    const r = runMatch(first + i, { idle });
    rows.push(r);
    console.log(`  seed ${String(r.seed).padStart(3)}  ${String(r.kills).padStart(2)}k/${r.deaths}d` +
      `  streak ${r.streak.toFixed(2).padStart(6)}  ${String(r.spent).padStart(4)} rounds` +
      `  ${(r.accuracy * 100).toFixed(0).padStart(3)}% hit  ${r.seconds.toFixed(0)}s` +
      (r.won ? '  WIN' : ''));
  }
  console.log('');
  report(summarise(idle ? 'idle' : 'current', rows));
}
