'use strict';

/* =====================================================================
   death-forensics.analysis.js — where do the deaths actually come from?

   Fitness is kills / (deaths + 1). The shipped policy already takes all 25
   kills and wins every match, so the only thing left to buy is the ~0.8
   deaths a match. Before writing a fix it is worth knowing what a death
   looks like, so this runs real matches through the real client and, for
   every death of the local player, records:

     - health over the last 5 seconds (0.5 s samples)
     - who killed it, from what distance, with what gun and what skill
     - whether the killer was the enemy the policy was aiming at
     - when the policy last had line of sight to that killer
     - how many enemies held line of sight at the instant of death
     - whether it was reloading, and whether it had just swapped weapons
     - seconds since its own spawn (CFG.spawnShield is 1.6 s)
     - the `cover` score of the nearest AI.buildNav(MAP) node, plus the best
       cover score within 3 m, i.e. whether cover was even available
     - weapon, magazine, reserve
     - speed, and mean speed over the last second
     - the damage window: first shot that landed in the engagement that
       killed it, total time under fire, how many distinct attackers

   Everything is measured against a BASELINE built from every tick the
   player was alive, so a factor is reported as a relative risk (how much
   more common it is at the moment of death than in ordinary play) rather
   than as a bare percentage. "38% of deaths happen while reloading" means
   nothing until you know the policy spends 30% of its life reloading.

   The instrumentation is read-only: it hooks applyDamage / killActor /
   respawnActor / fireWeapon / switchWeapon with pass-throughs and calls
   only pure helpers (canSee, nav.nearest), so match outcomes are identical
   to tools/eval-policy.js on the same seeds. `--verify` checks that.

   Usage:
     node tools/strategies/death-forensics.analysis.js [--matches 20] [--seed 1]
                                                       [--strategy reactive] [--dump] [--verify]
   ===================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const { createInstance, FIXED, mulberry32 } = require('../../net-sim.js');
const evalPolicy = require('../eval-policy.js');

const SIM_BOOT = 'initViewmodel(); initFX(); initInput(); initAI();';
const MATCH_LIMIT_S = 420;

/* eval-policy.js's own counters, kept so the rows printed here are directly
   comparable with the ones it prints. Both are pass-throughs. */
const INSTRUMENT = `
  var SPENT_ROUNDS = 0, HITS = 0;
  const _fireWeaponCount = fireWeapon;
  fireWeapon = function (a) {
    const before = a.ammo;
    const out = _fireWeaponCount.apply(this, arguments);
    if (a === G.player && a.ammo < before) SPENT_ROUNDS++;
    return out;
  };
  const _applyDamageCount = applyDamage;
  applyDamage = function (target, dmg, from) {
    if (from === G.player) HITS++;
    return _applyDamageCount.apply(this, arguments);
  };
`;

const RESEED = seed => `
  for (const a of G.actors) {
    if (!a.brain) continue;
    try { a.brain = AI.createBrain({ id: a.id, seed: ${seed >>> 0} * 7919 + a.id * 131, skill: a.skill }); }
    catch (e) {}
  }
`;

/* ---------------------------------------------------------------------
   The recorder. Runs inside the vm, after the driver has wrapped
   simulate(), so its per-tick sample is taken with the tick already
   resolved -- the state a death is scored against is the state the engine
   actually left behind.
   --------------------------------------------------------------------- */
const FORENSICS = `
var FDATA = {
  deaths: [], shieldPops: [], ticks: 0, aliveTicks: 0,
  base: {
    reload: 0, los0: 0, los1: 0, los2: 0, los3: 0,
    coverSum: 0, coverOpen: 0, coverGood: 0, availSum: 0,
    hp100: 0, hp70: 0, hp40: 0, hpLow: 0,
    fresh: 0, moving: 0, still: 0, lowAmmo: 0, dry: 0,
    coverHist: [0,0,0,0,0], hpHist: [0,0,0,0,0]
  }
};

(function () {
  const RING_S = 5.0;
  const RING = [];
  const lastSeen = Object.create(null);      // enemy id -> G.time we last had LOS
  const losSince = Object.create(null);      // enemy id -> when the current unbroken LOS began
  const damageLog = [];                      // damage taken by the local player
  let spawnAt = 0, lastSwapAt = -99, poppedShieldAt = -99, lastFireAt = -99;
  let twoLosSince = Infinity;                // when 2+ enemies last STARTED holding LOS

  function nav() { return G.nav; }

  /* cover score of the nav node the player is standing on, and the best
     cover score reachable inside 3 m -- "in the open" only indicts a spot
     if a better one was a step away. */
  function coverHere(p) {
    const n = nav();
    if (!n) return { cover: 0, avail: 0 };
    const id = n.nearest(p.pos.x, p.pos.y, p.pos.z);
    const node = n.nodes[id];
    if (!node) return { cover: 0, avail: 0 };
    let avail = node.cover;
    const span = Math.ceil(3.0 / n.cellSize);
    for (let dz = -span; dz <= span; dz++) {
      for (let dx = -span; dx <= span; dx++) {
        const other = n.nodeAt(node.level, node.gx + dx, node.gz + dz);
        if (other < 0) continue;
        const c = n.nodes[other].cover;
        if (c > avail) avail = c;
      }
    }
    return { cover: node.cover, avail: avail };
  }

  function enemies() {
    const out = [];
    for (const a of G.actors) if (a !== G.player && !a.isPlayer && a.alive) out.push(a);
    return out;
  }

  /* Line of sight eye-to-eye, the same test the policy's pickTarget uses. */
  function sees(p, a) {
    return canSee(p.pos.x, actorEye(p), p.pos.z, a.pos.x, actorEye(a), a.pos.z);
  }

  /* What the shipped policy would be aiming at: nearest enemy with LOS. */
  function currentTarget(p) {
    let seen = null, seenD = Infinity;
    for (const a of enemies()) {
      const d = Math.hypot(a.pos.x - p.pos.x, a.pos.z - p.pos.z);
      if (d < seenD && sees(p, a)) { seenD = d; seen = a; }
    }
    return seen;
  }

  function sampleAt(t) {           // ring lookup: latest sample at or before t
    let out = null;
    for (let i = 0; i < RING.length; i++) if (RING[i].t <= t) out = RING[i]; else break;
    return out;
  }

  function meanOver(secs, key, now) {
    let s = 0, n = 0;
    for (let i = 0; i < RING.length; i++) {
      if (RING[i].t >= now - secs) { s += RING[i][key]; n++; }
    }
    return n ? s / n : 0;
  }

  function fracOver(secs, pred, now) {
    let s = 0, n = 0;
    for (let i = 0; i < RING.length; i++) {
      if (RING[i].t >= now - secs) { s += pred(RING[i]) ? 1 : 0; n++; }
    }
    return n ? s / n : 0;
  }

  /* Seconds the player has been continuously below \`hp\` at the moment of
     death -- how long it had to notice it was losing and leave. */
  function secondsBelow(hp, now) {
    let since = now;
    for (let i = RING.length - 1; i >= 0; i--) {
      if (RING[i].hp < hp) since = RING[i].t; else break;
    }
    return now - since;
  }

  const _respawn = respawnActor;
  respawnActor = function (a) {
    const out = _respawn.apply(this, arguments);
    if (a === G.player) { spawnAt = G.time; RING.length = 0; damageLog.length = 0; }
    /* A bot that respawns is somewhere else entirely, so whatever line of
       sight it held before it died is not the one it holds now. */
    else losSince[a.id] = Infinity;
    return out;
  };

  const _switch = switchWeapon;
  switchWeapon = function (id) {
    const before = G.player ? G.player.weapon : null;
    const out = _switch.apply(this, arguments);
    if (G.player && G.player.weapon !== before) lastSwapAt = G.time;
    return out;
  };

  /* Firing pops your own spawn shield (fireWeapon: a.shield = 0). Worth
     counting: a policy that opens fire inside the 1.6 s bubble throws it
     away, and a policy that never does keeps a free 1.6 s of immunity. */
  const _fire = fireWeapon;
  fireWeapon = function (a) {
    const shielded = a === G.player && a.shield > 0 && a.ammo > 0 && a.fireCd <= 0 && a.reloadT <= 0 && a.alive;
    const before = a.ammo;
    const out = _fire.apply(this, arguments);
    if (a === G.player && a.ammo < before) lastFireAt = G.time;
    if (shielded && a.shield <= 0) {
      poppedShieldAt = G.time;
      FDATA.shieldPops.push({ t: G.time, sinceSpawn: G.time - spawnAt, left: a.shield });
    }
    return out;
  };

  const _damage = applyDamage;
  applyDamage = function (target, dmg, from, head) {
    const p = G.player;
    if (target === p && p.alive) {
      const shielded = p.shield > 0;
      damageLog.push({
        t: G.time, from: from ? from.id : null, dmg: dmg, head: !!head,
        blocked: shielded, hpBefore: p.health,
        dist: from ? Math.hypot(from.pos.x - p.pos.x, from.pos.z - p.pos.z) : 0,
        seen: from ? sees(p, from) : false
      });
      while (damageLog.length > 400) damageLog.shift();
    }
    return _damage.apply(this, arguments);
  };

  const _kill = killActor;
  killActor = function (target, from) {
    if (target === G.player) {
      try { FDATA.deaths.push(snapshot(from)); } catch (e) { FDATA.deaths.push({ error: String(e) }); }
    }
    return _kill.apply(this, arguments);
  };

  function snapshot(killer) {
    const p = G.player, now = G.time;
    const cov = coverHere(p);
    const live = enemies();
    let los = 0, near = 0, losIds = [];
    for (const a of live) {
      const d = Math.hypot(a.pos.x - p.pos.x, a.pos.z - p.pos.z);
      if (d < 20) near++;
      if (sees(p, a)) { los++; losIds.push(a.id); }
    }
    const tgt = currentTarget(p);

    /* The engagement that killed it: damage that landed on this life, walked
       backwards from the killing blow and cut at the first gap of 2 s. */
    const eng = [];
    let cut = now;
    for (let i = damageLog.length - 1; i >= 0; i--) {
      const d = damageLog[i];
      if (d.blocked) continue;
      if (cut - d.t > 2.0) break;
      cut = d.t; eng.unshift(d);
    }
    const attackers = {};
    for (const d of eng) attackers[d.from] = (attackers[d.from] || 0) + d.dmg;
    const byKiller = killer ? (attackers[killer.id] || 0) : 0;
    const total = eng.reduce((s, d) => s + d.dmg, 0);

    /* String(2.0) is "2", so the labels are spelled out rather than derived --
       building them from the number silently collapsed t2_0 into t2 and every
       health-history column read undefined. */
    const hp = {};
    for (const s of [['t0_5', 0.5], ['t1_0', 1.0], ['t1_5', 1.5],
                     ['t2_0', 2.0], ['t3_0', 3.0], ['t4_0', 4.0]]) {
      const r = sampleAt(now - s[1]);
      hp[s[0]] = r ? r.hp : null;
    }

    const killerSeen = killer && lastSeen[killer.id] !== undefined
      ? now - lastSeen[killer.id] : Infinity;
    /* Line of sight is mutual, so how long the killer has held it is how long
       it has had the shot. A killer that acquired LOS a tenth of a second ago
       stepped round a corner; one that has held it for two seconds was
       standing there, in view, while the policy did something else. */
    const killerLosHeld = killer && losSince[killer.id] !== undefined && isFinite(losSince[killer.id])
      ? now - losSince[killer.id] : 0;
    const fatal = eng.length ? eng[eng.length - 1] : null;

    return {
      t: now,
      sinceSpawn: now - spawnAt,
      killer: killer ? killer.id : null,
      killerName: killer ? killer.name : null,
      killerSkill: killer ? killer.skill : null,
      killerWeapon: killer ? killer.weapon : null,
      dist: killer ? Math.hypot(killer.pos.x - p.pos.x, killer.pos.z - p.pos.z) : null,
      dy: killer ? (killer.pos.y - p.pos.y) : null,
      killerWasTarget: !!(killer && tgt && killer.id === tgt.id),
      killerVisibleNow: !!(killer && sees(p, killer)),
      killerUnseenFor: killerSeen,
      killerLosHeld: killerLosHeld,
      twoLosHeld: isFinite(twoLosSince) ? now - twoLosSince : 0,
      sinceOwnShot: now - lastFireAt,
      los: los, losIds: losIds, near20: near,
      los2sMean: meanOver(2.0, 'los', now),
      losMax2s: (function () { let m = 0; for (const r of RING) if (r.t >= now - 2) m = Math.max(m, r.los); return m; })(),
      reloading: p.reloadT > 0,
      reloadFrac2s: fracOver(2.0, r => r.reloadT > 0, now),
      sinceSwap: now - lastSwapAt,
      weapon: p.weapon, ammo: p.ammo, reserve: p.reserve,
      cover: cov.cover, coverAvail: cov.avail,
      cover2sMean: meanOver(2.0, 'cover', now),
      speed: Math.hypot(p.vel.x, p.vel.z),
      speed1sMean: meanOver(1.0, 'spd', now),
      hp: hp,
      lowFor: secondsBelow(50, now),
      veryLowFor: secondsBelow(30, now),
      shieldPopped: poppedShieldAt > spawnAt ? poppedShieldAt - spawnAt : null,
      engFrom: eng.length ? now - eng[0].t : null,
      engDmg: total,
      engHits: eng.length,
      fatalHead: fatal ? fatal.head : false,
      fatalDmg: fatal ? fatal.dmg : 0,
      oneShot: eng.length === 1,
      engAttackers: Object.keys(attackers).length,
      killerShare: total > 0 ? byKiller / total : 0,
      hpAtEngStart: eng.length ? eng[0].hpBefore : p.health,
      unseenDmgFrac: eng.length
        ? eng.filter(d => !d.seen).reduce((s, d) => s + d.dmg, 0) / Math.max(1, total) : 0
    };
  }

  /* ---- the per-tick baseline ---------------------------------------- */
  const prevSim = window.simulate;
  window.simulate = function (dt) {
    const out = prevSim.apply(this, arguments);
    const p = G.player;
    FDATA.ticks++;
    if (p && p.alive && G.started && !G.over) {
      FDATA.aliveTicks++;
      let los = 0;
      const t = G.time;
      const seenNow = Object.create(null);
      for (const a of enemies()) {
        if (sees(p, a)) {
          los++; lastSeen[a.id] = t; seenNow[a.id] = true;
          if (losSince[a.id] === undefined || !isFinite(losSince[a.id])) losSince[a.id] = t;
        } else losSince[a.id] = Infinity;
      }
      if (los >= 2) { if (!isFinite(twoLosSince)) twoLosSince = t; } else twoLosSince = Infinity;
      const cov = coverHere(p);
      const spd = Math.hypot(p.vel.x, p.vel.z);
      const b = FDATA.base;
      if (p.reloadT > 0) b.reload++;
      if (los === 0) b.los0++; else if (los === 1) b.los1++; else if (los === 2) b.los2++; else b.los3++;
      b.coverSum += cov.cover; b.availSum += cov.avail;
      if (cov.cover < 0.15) b.coverOpen++;
      if (cov.cover > 0.45) b.coverGood++;
      b.coverHist[Math.min(4, Math.floor(cov.cover * 5))]++;
      b.hpHist[Math.min(4, Math.floor(Math.max(0, p.health - 0.001) / 20))]++;
      if (p.health >= 99.9) b.hp100++;
      else if (p.health >= 70) b.hp70++;
      else if (p.health >= 40) b.hp40++;
      else b.hpLow++;
      if (t - spawnAt < 1.6) b.fresh++;
      if (spd > 1.6) b.moving++; else b.still++;
      const mag = (WBY[p.weapon] && WBY[p.weapon].mag) || 30;
      if (p.ammo <= mag * 0.2) b.lowAmmo++;
      if (p.ammo === 0) b.dry++;
      RING.push({ t: t, hp: p.health, los: los, spd: spd, reloadT: p.reloadT,
                  ammo: p.ammo, cover: cov.cover, avail: cov.avail });
      while (RING.length && t - RING[0].t > RING_S) RING.shift();
    }
    return out;
  };
})();
`;

function runForensicMatch(seed, opts = {}) {
  const src = evalPolicy.userscript();
  const clock = { ms: 0 };
  const inst = createInstance(clock);

  inst.run(`Math.random = (${mulberry32.toString()})(${(seed >>> 0) || 1});`);
  inst.run(SIM_BOOT);
  inst.run(INSTRUMENT);
  inst.run(opts.policySource || evalPolicy.policySource(src));
  inst.run(evalPolicy.driverSource(src));
  inst.run(FORENSICS);                     // after the driver: last wrapper in, first out
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
  const data = inst.get('JSON.stringify(FDATA)');
  const f = JSON.parse(data);
  return {
    seed, kills, deaths,
    spent: inst.get('SPENT_ROUNDS') || 0,
    hits: inst.get('HITS') || 0,
    won: kills >= target,
    seconds: ticks * FIXED,
    streak: kills / (deaths + 1),
    perfect: deaths === 0 && kills >= target,
    forensics: f
  };
}

/* ---------------------------------------------------------------------
   Reporting
   --------------------------------------------------------------------- */
const pct = x => (100 * x).toFixed(0).padStart(3) + '%';
const num = (x, d = 2) => (x === null || x === undefined || !isFinite(x) ? '  -  ' : x.toFixed(d));

function quantiles(xs) {
  const s = xs.slice().filter(x => isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return { p10: NaN, p50: NaN, p90: NaN, mean: NaN };
  const q = f => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  return { p10: q(0.1), p50: q(0.5), p90: q(0.9), mean: s.reduce((a, b) => a + b, 0) / s.length };
}

function histogram(xs, edges, label) {
  const counts = new Array(edges.length + 1).fill(0);
  for (const x of xs) {
    let i = 0;
    while (i < edges.length && x >= edges[i]) i++;
    counts[i]++;
  }
  const n = xs.length || 1;
  const names = [];
  for (let i = 0; i <= edges.length; i++) {
    const lo = i === 0 ? '' : edges[i - 1];
    const hi = i === edges.length ? '' : edges[i];
    names.push(i === 0 ? `<${hi}` : (i === edges.length ? `${lo}+` : `${lo}-${hi}`));
  }
  const lines = counts.map((c, i) =>
    `      ${String(names[i]).padStart(8)}  ${String(c).padStart(3)}  ${pct(c / n)}  ${'#'.repeat(Math.round(30 * c / n))}`);
  return `    ${label}\n${lines.join('\n')}`;
}

function report(rows, opts) {
  const deaths = [];
  for (const r of rows) for (const d of r.forensics.deaths) { d.seed = r.seed; deaths.push(d); }
  const base = { reload: 0, los0: 0, los1: 0, los2: 0, los3: 0, coverSum: 0, availSum: 0,
    coverOpen: 0, coverGood: 0, hp100: 0, hp70: 0, hp40: 0, hpLow: 0, fresh: 0,
    moving: 0, still: 0, lowAmmo: 0, dry: 0,
    coverHist: [0, 0, 0, 0, 0], hpHist: [0, 0, 0, 0, 0] };
  let aliveTicks = 0, shieldPops = 0, shieldPopEarly = 0;
  for (const r of rows) {
    aliveTicks += r.forensics.aliveTicks;
    for (const k of Object.keys(base)) {
      if (Array.isArray(base[k])) for (let i = 0; i < base[k].length; i++) base[k][i] += r.forensics.base[k][i];
      else base[k] += r.forensics.base[k];
    }
    shieldPops += r.forensics.shieldPops.length;
    shieldPopEarly += r.forensics.shieldPops.filter(s => s.sinceSpawn < 1.6).length;
  }
  const A = aliveTicks || 1;
  const n = deaths.length || 1;

  console.log('');
  console.log('='.repeat(78));
  console.log(`DEATH FORENSICS  —  ${rows.length} matches, ${deaths.length} deaths, ` +
    `${(deaths.length / rows.length).toFixed(2)} per match, ` +
    `${(aliveTicks * FIXED / rows.length).toFixed(0)}s alive per match`);
  console.log('='.repeat(78));

  const kills = rows.reduce((s, r) => s + r.kills, 0) / rows.length;
  const fit = rows.reduce((s, r) => s + r.streak, 0) / rows.length;
  console.log(`  fitness ${fit.toFixed(3)}   kills ${kills.toFixed(2)}   ` +
    `perfect ${rows.filter(r => r.perfect).length}/${rows.length}   ` +
    `matches with 0 deaths ${rows.filter(r => r.deaths === 0).length}`);
  console.log(`  deaths per match: ` +
    [0, 1, 2, 3, 4].map(k => `${k}d:${rows.filter(r => r.deaths === k).length}`).join('  ') +
    `  ${rows.filter(r => r.deaths > 4).length > 0 ? '5+d:' + rows.filter(r => r.deaths > 4).length : ''}`);

  /* ---- relative risk table ---- */
  console.log('');
  console.log('  RELATIVE RISK  (share of deaths vs share of ordinary alive time)');
  console.log('  ' + 'factor'.padEnd(34) + 'at death   baseline   risk x');
  const rr = (label, atDeath, baseline) => {
    const has = isFinite(baseline);
    const x = has && baseline > 0 ? atDeath / baseline : NaN;
    const flag = !isFinite(x) ? '' :
      (x >= 2 && atDeath >= 0.1 ? '   <<<' : (x <= 0.5 && baseline >= 0.05 ? '   (protective)' : ''));
    console.log('  ' + label.padEnd(34) + pct(atDeath).padStart(8) +
      (has ? pct(baseline) : '    -').padStart(11) +
      (isFinite(x) ? x.toFixed(2).padStart(9) : '        -') + flag);
  };
  rr('reloading', deaths.filter(d => d.reloading).length / n, base.reload / A);
  rr('magazine <=20%', deaths.filter(d => d.ammo <= 6).length / n, base.lowAmmo / A);
  rr('dry (ammo 0)', deaths.filter(d => d.ammo === 0).length / n, base.dry / A);
  rr('swapped weapon in last 1s', deaths.filter(d => d.sinceSwap < 1).length / n, NaN);
  rr('had fired within the last 0.5s', deaths.filter(d => d.sinceOwnShot < 0.5).length / n, NaN);
  rr('0 enemies with LOS', deaths.filter(d => d.los === 0).length / n, base.los0 / A);
  rr('exactly 1 enemy with LOS', deaths.filter(d => d.los === 1).length / n, base.los1 / A);
  rr('2+ enemies with LOS', deaths.filter(d => d.los >= 2).length / n, (base.los2 + base.los3) / A);
  rr('3+ enemies with LOS', deaths.filter(d => d.los >= 3).length / n, base.los3 / A);
  rr('in the open (cover < 0.15)', deaths.filter(d => d.cover < 0.15).length / n, base.coverOpen / A);
  rr('in good cover (cover > 0.45)', deaths.filter(d => d.cover > 0.45).length / n, base.coverGood / A);
  rr('within spawn shield (<1.6s)', deaths.filter(d => d.sinceSpawn < 1.6).length / n, base.fresh / A);
  rr('first 3s of a life', deaths.filter(d => d.sinceSpawn < 3).length / n, NaN);
  rr('moving (speed > 1.6)', deaths.filter(d => d.speed > 1.6).length / n, base.moving / A);
  rr('standing still', deaths.filter(d => d.speed <= 1.6).length / n, base.still / A);
  console.log('  (baselines are time-weighted over every alive tick; "-" where no baseline applies)');

  /* ---- the reactive / strategic question ---- */
  console.log('');
  console.log('  HOW MUCH WARNING DID IT HAVE?');
  const ttd = deaths.map(d => d.engFrom).filter(x => x !== null);
  const q = quantiles(ttd);
  console.log(`    seconds under fire before dying:  p10 ${num(q.p10)}  median ${num(q.p50)}  ` +
    `p90 ${num(q.p90)}  mean ${num(q.mean)}`);
  console.log(histogram(ttd, [0.35, 0.7, 1.2, 2.0, 3.5], 'time from first damage to death (s)'));
  const hpq = quantiles(deaths.map(d => d.hpAtEngStart));
  console.log(`    health when the fatal engagement started: median ${num(hpq.p50, 0)}  mean ${num(hpq.mean, 0)}`);
  console.log(`    deaths that began at full health:        ${pct(deaths.filter(d => d.hpAtEngStart >= 99).length / n)}`);
  console.log(`    health 2.0s before death:  median ${num(quantiles(deaths.map(d => d.hp.t2_0).filter(x => x !== null)).p50, 0)}`);
  console.log(`    health 1.0s before death:  median ${num(quantiles(deaths.map(d => d.hp.t1_0).filter(x => x !== null)).p50, 0)}`);
  console.log(`    seconds spent below 50 hp before dying: median ${num(quantiles(deaths.map(d => d.lowFor)).p50)}  ` +
    `mean ${num(quantiles(deaths.map(d => d.lowFor)).mean)}`);
  console.log(`    had >=1.0s below 50 hp (time to disengage): ${pct(deaths.filter(d => d.lowFor >= 1).length / n)}` +
    `   >=2.0s: ${pct(deaths.filter(d => d.lowFor >= 2).length / n)}`);

  console.log('');
  console.log('  WHO KILLED IT');
  const bySkill = {};
  for (const d of deaths) bySkill[d.killerSkill || 'none'] = (bySkill[d.killerSkill || 'none'] || 0) + 1;
  console.log('    killer skill: ' + Object.entries(bySkill).map(([k, v]) => `${k} ${v} (${pct(v / n)})`).join('   '));
  const byGun = {};
  for (const d of deaths) byGun[d.killerWeapon || 'none'] = (byGun[d.killerWeapon || 'none'] || 0) + 1;
  console.log('    killer weapon: ' + Object.entries(byGun).map(([k, v]) => `${k} ${v} (${pct(v / n)})`).join('   '));
  console.log(`    killer was the enemy the policy was aiming at: ${pct(deaths.filter(d => d.killerWasTarget).length / n)}`);
  console.log(`    killer had LOS to the player at death:         ${pct(deaths.filter(d => d.killerVisibleNow).length / n)}`);
  console.log(`    killer NEVER had LOS on this life:             ${pct(deaths.filter(d => !isFinite(d.killerUnseenFor)).length / n)}`);
  const unseen = deaths.map(d => d.killerUnseenFor).filter(isFinite);
  console.log(`    seconds since the killer was last visible: median ${num(quantiles(unseen).p50)}  ` +
    `(only ${unseen.length}/${deaths.length} were ever visible)`);
  console.log(`    share of fatal damage from an enemy with no LOS at the time: ` +
    `median ${pct(quantiles(deaths.map(d => d.unseenDmgFrac)).p50)}`);
  console.log(histogram(deaths.map(d => d.dist).filter(x => x !== null), [6, 10, 14, 20, 28], 'distance to killer (m)'));

  console.log('');
  console.log('  HOW MANY WERE SHOOTING');
  const at = deaths.map(d => d.engAttackers);
  console.log('    distinct attackers in the fatal engagement: ' +
    [1, 2, 3, 4].map(k => `${k}:${at.filter(x => x === k).length}`).join('  ') +
    `   (mean ${num(quantiles(at).mean)})`);
  console.log(`    killer's share of the fatal damage: median ${pct(quantiles(deaths.map(d => d.killerShare)).p50)}`);
  console.log('    enemies with LOS at death: ' +
    [0, 1, 2, 3, 4].map(k => `${k}:${deaths.filter(d => d.los === k).length}`).join('  ') +
    `   (mean ${num(quantiles(deaths.map(d => d.los)).mean)}, baseline mean ` +
    `${num((base.los1 + 2 * base.los2 + 3.5 * base.los3) / A)})`);
  console.log(`    peak enemies with LOS in the 2s before death: mean ${num(quantiles(deaths.map(d => d.losMax2s)).mean)}`);

  console.log('');
  console.log('  POSITION AND STATE');
  console.log(histogram(deaths.map(d => d.cover), [0.05, 0.15, 0.3, 0.5], 'cover score of the nav node under it'));
  console.log(`    baseline cover distribution:  ` +
    base.coverHist.map((c, i) => `${(i / 5).toFixed(1)}-${((i + 1) / 5).toFixed(1)}:${pct(c / A)}`).join('  '));
  console.log(`    mean cover at death ${num(quantiles(deaths.map(d => d.cover)).mean)}  ` +
    `vs baseline ${num(base.coverSum / A)}`);
  console.log(`    best cover within 3m at death ${num(quantiles(deaths.map(d => d.coverAvail)).mean)}  ` +
    `vs baseline ${num(base.availSum / A)}   (was better cover a step away?)`);
  console.log(histogram(deaths.map(d => d.sinceSpawn), [1.6, 3, 6, 12, 25], 'seconds since own spawn'));
  console.log(`    weapon in hand at death: ` +
    Object.entries(deaths.reduce((m, d) => (m[d.weapon] = (m[d.weapon] || 0) + 1, m), {}))
      .map(([k, v]) => `${k} ${v}`).join('  '));
  console.log(`    mean ammo at death ${num(quantiles(deaths.map(d => d.ammo)).mean, 1)}   ` +
    `reload fraction of the 2s before death ${pct(quantiles(deaths.map(d => d.reloadFrac2s)).mean)} ` +
    `(baseline ${pct(base.reload / A)})`);
  console.log(`    mean speed at death ${num(quantiles(deaths.map(d => d.speed)).mean)}  ` +
    `over the last 1s ${num(quantiles(deaths.map(d => d.speed1sMean)).mean)}`);
  console.log(`    spawn shield popped by its own first shot: ${shieldPops} times ` +
    `(${(shieldPops / rows.length).toFixed(1)} per match), of which ` +
    `${shieldPopEarly} inside the 1.6s window`);

  /* ---- classification ---- */
  console.log('');
  console.log('  WHAT THE FATAL BURST LOOKED LIKE');
  console.log(`    killed by a single damage event:   ${pct(deaths.filter(d => d.oneShot).length / n)}` +
    `   by <=2 events: ${pct(deaths.filter(d => d.engHits <= 2).length / n)}`);
  console.log(`    fatal blow was a headshot:         ${pct(deaths.filter(d => d.fatalHead).length / n)}`);
  console.log(`    damage events in the fatal engagement: median ${num(quantiles(deaths.map(d => d.engHits)).p50, 1)}` +
    `   mean ${num(quantiles(deaths.map(d => d.engHits)).mean, 1)}`);
  const held = quantiles(deaths.map(d => d.killerLosHeld));
  console.log(`    seconds the killer had held unbroken LOS when it fired the fatal shot:`);
  console.log(`      p10 ${num(held.p10)}  median ${num(held.p50)}  p90 ${num(held.p90)}  mean ${num(held.mean)}`);
  console.log(histogram(deaths.map(d => d.killerLosHeld), [0.25, 0.6, 1.2, 2.5], 'killer LOS-hold at the moment of death (s)'));
  console.log(`    the player had 2+ enemies in LOS for ${num(quantiles(deaths.map(d => d.twoLosHeld)).p50)}s (median) before dying`);
  console.log(`    the policy had fired within 0.5s of dying: ${pct(deaths.filter(d => d.sinceOwnShot < 0.5).length / n)}`);

  console.log('');
  console.log('  CLASSIFICATION');
  /* Deliberately conservative definitions, both stated in full so the number
     can be argued with rather than taken on trust. */
  const isAmbush = d => (d.engFrom !== null && d.engFrom <= 0.8) &&
                        d.hpAtEngStart >= 90 &&
                        (!isFinite(d.killerUnseenFor) || d.killerUnseenFor > 0.5);
  const isBurst = d => d.engFrom !== null && d.engFrom <= 1.0 && d.hpAtEngStart >= 90;
  const hadWarning = d => d.lowFor >= 1.0;
  const crossfire = d => d.engAttackers >= 2;
  /* The one that decides the project: could a policy watching its own health
     have done anything? It needs the damage to arrive slowly enough to react
     to (>= ~0.5 s, two ticks of decision plus a step) AND a reachable place to
     go. */
  const actionable = d => d.engFrom !== null && d.engFrom >= 0.6 && d.hpAtEngStart >= 40;
  const p = f => pct(deaths.filter(f).length / n);
  console.log(`    REACTIVE-ambush   (<=0.8s under fire, from full health, killer not seen in the last 0.5s): ${p(isAmbush)}`);
  console.log(`    REACTIVE-burst    (<=1.0s under fire, from full health, seen or not):                      ${p(isBurst)}`);
  console.log(`    STRATEGIC-warned  (spent >=1.0s under 50 hp and stayed):                                   ${p(hadWarning)}`);
  console.log(`    crossfire (2+ attackers landed damage):                                                    ${p(crossfire)}`);
  console.log(`    both fast AND from full health AND single attacker:                                        ${p(d => isBurst(d) && d.engAttackers === 1)}`);
  console.log(`    ACTIONABLE (>=0.6s of incoming damage before dying — long enough to disengage):            ${p(actionable)}`);
  console.log(`    killer had held LOS >=1.0s before the fatal shot (it was standing there in view):          ${p(d => d.killerLosHeld >= 1.0)}`);
  console.log(`    killer acquired LOS <0.25s before the fatal shot (it stepped into view):                   ${p(d => d.killerLosHeld < 0.25)}`);

  if (opts.dump) {
    console.log('');
    console.log('  EVERY DEATH');
    console.log('  seed    t  spawn+  hp-2s hp-1s  killer                dist los atk hits  ttd  losHeld  cover/avail rl ammo  spd');
    for (const d of deaths) {
      const hpc = v => String(v === null || v === undefined ? '-' : Math.round(v)).padStart(5);
      console.log(`  ${String(d.seed).padStart(4)} ${num(d.t, 0).padStart(4)} ${num(d.sinceSpawn, 1).padStart(6)}  ` +
        `${hpc(d.hp.t2_0)} ${hpc(d.hp.t1_0)}  ` +
        `${String((d.killerName || '?') + '/' + (d.killerSkill || '?') + '/' + (d.killerWeapon || '?')).padEnd(22)}` +
        `${num(d.dist, 1).padStart(5)} ${String(d.los).padStart(3)} ${String(d.engAttackers).padStart(3)} ` +
        `${String(d.engHits).padStart(4)} ${num(d.engFrom, 2).padStart(5)} ` +
        `${num(d.killerLosHeld, 2).padStart(7)}  ${num(d.cover, 2)}/${num(d.coverAvail, 2)}  ` +
        `${d.reloading ? 'R' : '.'} ${String(d.ammo).padStart(4)} ${num(d.speed, 1).padStart(5)}` +
        `${d.killerWasTarget ? ' TGT' : ''}${d.fatalHead ? ' HEAD' : ''}`);
    }
  }
  return deaths;
}

if (require.main === module) {
  const arg = (k, d) => {
    const i = process.argv.indexOf('--' + k);
    return i >= 0 ? process.argv[i + 1] : d;
  };
  const matches = Number(arg('matches', 20));
  const first = Number(arg('seed', 1));
  const dump = process.argv.includes('--dump');
  const verify = process.argv.includes('--verify');
  const stratName = arg('strategy', null);
  let src = null;
  if (stratName) {
    const strat = require(path.join(__dirname, stratName.replace(/\.js$/, '') + '.js'));
    src = strat.policySource();
    console.log(`policy under test: ${strat.name} — ${strat.describe}`);
  }

  const rows = [];
  for (let i = 0; i < matches; i++) {
    const r = runForensicMatch(first + i, src ? { policySource: src } : {});
    rows.push(r);
    process.stderr.write(`  seed ${String(r.seed).padStart(3)}  ${String(r.kills).padStart(2)}k/${r.deaths}d  ` +
      `${r.seconds.toFixed(0)}s\n`);
    if (verify && !src) {
      const ctrl = evalPolicy.runMatch(r.seed);
      const ok = ctrl.kills === r.kills && ctrl.deaths === r.deaths && ctrl.spent === r.spent;
      process.stderr.write(`      verify vs eval-policy: ${ok ? 'IDENTICAL' : 'DIFFERS ' +
        JSON.stringify({ kills: ctrl.kills, deaths: ctrl.deaths, spent: ctrl.spent })}\n`);
    }
  }
  report(rows, { dump });
}

module.exports = { runForensicMatch, report };
