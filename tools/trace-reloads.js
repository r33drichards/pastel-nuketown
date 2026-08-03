'use strict';

/* Why does the bot appear to reload, shoot, reload, shoot?

   A reload is 1.55s on the smg. If one is being started and then thrown away
   before it finishes, the gun never fills, the policy asks again, and the
   result looks exactly like a stutter. Only two things zero a live reloadT:
   switchWeapon (which cancels it outright, src/70-game.js:868) and
   respawnActor. So this hooks tryReload, finishReload and switchWeapon in the
   real client and counts which of them actually happens.

   Usage: node tools/trace-reloads.js [seed] [matches] */

const { createInstance, FIXED, mulberry32 } = require('../net-sim.js');
const { userscript, policySource, driverSource } = require('./eval-policy.js');

const SIM_BOOT = 'initViewmodel(); initFX(); initInput(); initAI();';

const TRACE = `
  var LOG = [];
  const _tryReload = tryReload;
  tryReload = function (a) {
    const was = a.reloadT;
    const out = _tryReload.apply(this, arguments);
    if (a === G.player && was <= 0 && a.reloadT > 0)
      LOG.push({ t: G.time, kind: 'start', w: a.weapon, ammo: a.ammo,
                 reserve: a.reserve, seq: IN.reloadSeq });
    return out;
  };
  const _finishReload = finishReload;
  finishReload = function (a) {
    if (a === G.player) LOG.push({ t: G.time, kind: 'finish', w: a.weapon, ammo: a.ammo });
    return _finishReload.apply(this, arguments);
  };
  const _switchWeapon = switchWeapon;
  switchWeapon = function (id) {
    const p = G.player;
    const cancelling = p && p.weapon !== id && WBY[id] && p.reloadT > 0;
    if (p && p.weapon !== id && WBY[id])
      LOG.push({ t: G.time, kind: cancelling ? 'CANCEL' : 'swap',
                 from: p.weapon, w: id, left: p.reloadT });
    return _switchWeapon.apply(this, arguments);
  };
  const _fireWeapon = fireWeapon;
  fireWeapon = function (a) {
    const before = a.ammo;
    const out = _fireWeapon.apply(this, arguments);
    if (a === G.player && a.ammo < before) {
      const last = LOG[LOG.length - 1];
      if (last && last.kind === 'shots') { last.n++; last.until = G.time; }
      else LOG.push({ t: G.time, kind: 'shots', n: 1, until: G.time, w: a.weapon });
    }
    return out;
  };
`;

function runOne(seed) {
  const src = userscript();
  const clock = { ms: 0 };
  const inst = createInstance(clock);
  inst.run(`Math.random = (${mulberry32.toString()})(${seed >>> 0});`);
  inst.run(SIM_BOOT);
  inst.run(TRACE);
  inst.run(policySource(src));
  inst.run(driverSource(src));
  inst.run('startMatch();');
  inst.run(`for (const a of G.actors) { if (a.brain)
    a.brain = AI.createBrain({ id: a.id, seed: ${seed} * 7919 + a.id * 131, skill: a.skill }); }`);

  let ticks = 0;
  while (ticks < 420 * 60 && !inst.get('G.over')) {
    inst.run(`simulate(${FIXED});`);
    clock.ms += FIXED * 1000;
    ticks++;
  }
  return inst.get('JSON.stringify(LOG)');
}

const seed = Number(process.argv[2] || 1);
const matches = Number(process.argv[3] || 3);
let starts = 0, finishes = 0, cancels = 0, swaps = 0;
const gaps = [];

for (let m = 0; m < matches; m++) {
  const log = JSON.parse(runOne(seed + m));
  let lastStart = null;
  for (const e of log) {
    if (e.kind === 'start') {
      starts++;
      if (lastStart !== null) gaps.push(e.t - lastStart);
      lastStart = e.t;
    } else if (e.kind === 'finish') finishes++;
    else if (e.kind === 'CANCEL') cancels++;
    else if (e.kind === 'swap') swaps++;
  }
  /* The first match prints its story, so the pattern is readable rather than
     only countable. */
  if (m === 0) {
    console.log(`--- seed ${seed + m}, first 30 events ---`);
    for (const e of log.slice(0, 30)) {
      if (e.kind === 'shots') console.log(`  ${e.t.toFixed(2)}s  fired ${e.n} ${e.w}`);
      else if (e.kind === 'start') console.log(`  ${e.t.toFixed(2)}s  reload START  ${e.w} (ammo ${e.ammo}, reserve ${e.reserve})`);
      else if (e.kind === 'finish') console.log(`  ${e.t.toFixed(2)}s  reload done   ${e.w} -> ${e.ammo}`);
      else if (e.kind === 'CANCEL') console.log(`  ${e.t.toFixed(2)}s  *** RELOAD CANCELLED *** ${e.from} -> ${e.w}, ${e.left.toFixed(2)}s left`);
      else console.log(`  ${e.t.toFixed(2)}s  swap ${e.from} -> ${e.w}`);
    }
    console.log('');
  }
}

gaps.sort((a, b) => a - b);
const quick = gaps.filter(g => g < 1.55).length;
console.log(`over ${matches} matches`);
console.log(`  reloads started            ${starts}`);
console.log(`  reloads finished           ${finishes}`);
console.log(`  reloads cancelled by a swap ${cancels}`);
console.log(`  weapon swaps (no reload)   ${swaps}`);
console.log(`  starts closer together than one smg reload (1.55s): ${quick}/${gaps.length}`);
if (gaps.length) {
  console.log(`  gap between reload starts: min ${gaps[0].toFixed(2)}s` +
    `  median ${gaps[Math.floor(gaps.length / 2)].toFixed(2)}s` +
    `  max ${gaps[gaps.length - 1].toFixed(2)}s`);
}
