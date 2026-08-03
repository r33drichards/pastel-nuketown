'use strict';

/* =====================================================================
   reactive.js — the shipped policy, plus the fixes the forensics justify.

   What the forensics said (24 matches, 17 deaths, see
   death-forensics.analysis.js):

     - 94% of deaths ended on a HEADSHOT and 88% arrived as a SINGLE damage
       event. The median time between the first damage of the fatal
       engagement and death is 0.00 s. 82% of killers carried the rifle
       (52 dmg, 2.2x head = 114, a one-shot kill from full health) and 76%
       were `hard` bots.
     - So there is no health curve to react to: 59% of deaths started from
       full health. "Disengage when hurt" cannot address the majority of
       them, because the majority arrive with zero warning.
     - Reloading is NOT a factor: 24% of deaths vs 26% of ordinary alive
       time (risk 0.92).
     - Neither is being in the open: mean cover 0.58 at death vs 0.46
       baseline. Deaths happen in ABOVE-average cover, because cover score
       measures nearness to a solid and a rifle bot 22 m away does not care.
     - What IS elevated: 2+ enemies holding line of sight, 82% of deaths vs
       40% of alive time (risk 2.05); 3+, 59% vs 20% (risk 2.88).
     - And the biggest single lever: 29% of deaths happen inside the 1.6 s
       spawn shield (vs 6% of alive time, risk 4.67) — a window in which the
       player is INVULNERABLE until it fires, because fireWeapon sets
       a.shield = 0. The shipped policy pops that shield with its first shot
       on every single life: 41 pops in 41 lives, all inside the window.

   So this file adds three rules, each switchable on its own so that each
   could be measured on its own:

     1. SHIELD DISCIPLINE (`shieldHold`). While me.shield > 0, do not pull
        the trigger. Damage is blocked outright during it, so this is not a
        gamble about who wins a duel.
     2. FLEE (`shieldFlee`) / EVADE (`evadeLos`) / LOW HEALTH (`lowHealth`).
        Run to the nearest nav node no living enemy can see — during the
        shield, when `evadeLos` enemies hold line of sight, or below
        `lowHealth`. Aimed at the 2.05x / 2.88x risk multipliers above.

   Everything else — engageRange, rangeBand, fireCone, turnRate,
   strafePeriod, strafeAmount, sprintRange, reloadAt, aimHeight, searchTurn —
   is the shipped tuned vector, unchanged, and the first ten parameters keep
   their published order so the driver's positional setParams still lands.

   WHAT HAPPENED (all paired, same seeds, tools/eval-policy.js).

   The ablations, seeds 1-10, deaths a match:

       shipped 1.00   hold 0.60   flee 0.50   evade3 1.40   low40 0.80

   Everything that runs away lost, so `shieldFlee`, `evadeLos` and
   `lowHealth` are off and `shieldHold` — hold your fire, keep your feet —
   is the shipped configuration. `hold` against `shipped`, three blocks of
   24 paired seeds:

     seeds   1-24   deaths 0.71 -> 0.67   fitness 17.88 -> 17.80   perfect 12 -> 11    7b/8w/9t  p=1.000
     seeds 101-124  deaths 0.92 -> 0.54   fitness 15.63 -> 19.27   perfect  8 -> 14   12b/6w/6t  p=0.238
     seeds 201-224  deaths 1.08 -> 0.63   fitness 15.57 -> 18.58   perfect  9 -> 13   10b/6w/8t  p=0.454
     pooled (72)    deaths 0.90 -> 0.61   fitness 16.36 -> 18.55   perfect 29 -> 38  29b/20w/23t p=0.253

   Directionally a third fewer deaths, mechanically explained — re-running
   the forensics against it shows spawn-shield pops 41 -> 0 and deaths inside
   the 1.6 s shield 29% -> 0% — and NOT SIGNIFICANT. It is also not a free
   win: the same forensics shows the deaths partly reappearing in the 1.6-3 s
   window straight after the shield (0% -> 28%), because the underlying
   problem is spawning inside a hard rifle bot's sightline and holding fire
   only postpones that meeting.

   Two things to hold on to before believing the pooled number:

     - the one block where it does nothing is seeds 1-24, which is the block
       the shipped parameter vector was tuned on. The shipped policy dies
       0.71 times a match there and 1.00 times a match on the held-out
       blocks; this policy dies 0.67 and 0.58. Some of the pooled gap is the
       baseline being overfit rather than this rule being good.
     - the paired death difference is -0.29 a match with sd 1.18, so ~130
       paired matches are needed to call it at 80% power and ~510 to resolve
       an effect half this size. 24 seeds cannot settle anything here.
   ===================================================================== */

const SOURCE = String.raw`
const POLICY = (() => {
  /* Append-only. The first ten are the shipped names in the shipped order,
     so the driver's ten-long vector still sets what it always set; the
     defaults below ARE that tuned vector, so the policy behaves correctly
     even when nobody calls setParams at all. */
  const PARAM_NAMES = [
    'engageRange', 'rangeBand', 'fireCone', 'turnRate', 'strafePeriod',
    'strafeAmount', 'sprintRange', 'reloadAt', 'aimHeight', 'searchTurn',
    'shieldHold',     // 1 = never fire while the spawn shield is up
    'shieldFlee',     // 1 = spend the shield running somewhere unseen
    'evadeLos',       // break line of sight when this many enemies hold it (0 = off)
    'lowHealth',      // below this health, one watcher is enough to trigger it (0 = off)
    'evadeSecs',      // seconds before an evade is abandoned and the fight resumed
    'evadeCool',      // seconds of forced fighting after an evade ends
    'refugeRange'     // metres of nav nodes considered when looking for cover
  ];
  const PARAM_BOUNDS = [
    [3, 40], [0.5, 8], [0.005, 0.30], [3, 30], [0.3, 3.0],
    [0, 1], [4, 40], [0, 0.9], [0.8, 2.0], [0.5, 6],
    [0, 1], [0, 1], [0, 5], [0, 100], [0.3, 4], [0, 4], [3, 20]
  ];
  const P = {
    engageRange: 24.030481, rangeBand: 2.256479, fireCone: 0.020000,
    turnRate: 22.140736, strafePeriod: 1.897986, strafeAmount: 0.634428,
    sprintRange: 12.297849, reloadAt: 0.177887, aimHeight: 1.575976,
    searchTurn: 3.160332,
    /* shieldFlee, evadeLos and lowHealth all ship OFF, because all three were
       measured and all three lost. Paired on seeds 1-10: evading at three
       watchers took deaths from 1.00 to 1.40 a match and perfect matches from
       4 to 1; the low-health rule took deaths from 0.50 back to 0.80. Paired
       on seeds 1-24, fleeing during the shield scored 0.75 deaths against
       0.67 for holding fire and standing your ground. Three independent
       measurements of the same thing: in this game, turning your back is how
       you die. The code stays so the result can be re-run; the defaults say
       what the data said. */
    shieldHold: 1, shieldFlee: 0, evadeLos: 0, lowHealth: 0,
    evadeSecs: 1.2, evadeCool: 1.5, refugeRange: 9
  };

  let t = 0, strafeSign = 1, phase = 0;
  let dest = null, destUntil = 0, evadeUntil = 0, coolUntil = 0, lastHealth = 100;

  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

  /* One pass over the actors gives the target, the distance and the whole
     threat set: the shipped pickTarget already ran canSee on every enemy, so
     counting how many can see us costs nothing extra. */
  function survey(me) {
    let best = null, bestD = Infinity, seen = null, seenD = Infinity;
    const threats = [];
    for (const a of G.actors) {
      if (a === me || a.isPlayer || !a.alive) continue;
      const dx = a.pos.x - me.pos.x, dz = a.pos.z - me.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < bestD) { bestD = d; best = a; }
      if (canSee(me.pos.x, actorEye(me), me.pos.z, a.pos.x, actorEye(a), a.pos.z)) {
        threats.push(a);
        if (d < seenD) { seenD = d; seen = a; }
      }
    }
    return { target: seen || best, dist: seen ? seenD : bestD, visible: !!seen, threats };
  }

  /* The nearest nav node none of the watchers can see. Line of sight is
     mutual, so a node they cannot see is a node they cannot shoot into.
     Candidates are taken on the player's own level, on a stride-2 lattice
     (nav cells are 0.85 m, so that is a sample every 1.7 m) and rejected
     unless the straight line to them is walkable — a refuge behind a wall
     is no use if getting there means walking through the wall. */
  function refuge(me, threats) {
    const nav = G.nav;
    if (!nav || !nav.nodes || !nav.nodes.length) return null;
    const hereId = nav.nearest(me.pos.x, me.pos.y, me.pos.z);
    const here = nav.nodes[hereId];
    if (!here) return null;
    const eye = nav.actor.eye;

    const exposure = n => {
      let e = 0;
      for (let i = 0; i < threats.length; i++) {
        const a = threats[i];
        if (canSee(n.x, n.y + eye, n.z, a.pos.x, actorEye(a), a.pos.z)) e++;
      }
      return e;
    };

    const hereExp = exposure(here);
    let best = null, bestScore = -Infinity;
    const span = Math.ceil(P.refugeRange / nav.cellSize);
    for (let dz = -span; dz <= span; dz += 2) {
      for (let dx = -span; dx <= span; dx += 2) {
        if (dx === 0 && dz === 0) continue;
        const id = nav.nodeAt(here.level, here.gx + dx, here.gz + dz);
        if (id < 0) continue;
        const n = nav.nodes[id];
        if (!nav.lineWalkable(here, n)) continue;
        const d = Math.hypot(n.x - me.pos.x, n.z - me.pos.z);
        /* Unseen first, then close, then behind something. The cover term is
           a tie-break only: the forensics found cover score uncorrelated with
           dying, so it is not allowed to outvote line of sight. */
        const score = -12 * exposure(n) - 0.5 * d + 1.0 * n.cover;
        if (score > bestScore) { bestScore = score; best = n; }
      }
    }
    if (!best) return null;
    /* Only move if it is actually an improvement in what can shoot us. */
    if (exposure(best) >= hereExp && hereExp > 0) return null;
    return best;
  }

  /* Movement is eight-way: the driver turns fwd/strafe into WASD, so only the
     signs survive. Project the wanted world direction onto the movement basis
     the engine uses — forward (sin yaw, cos yaw), right (-cos yaw, sin yaw) —
     and take its signs, which lands on the nearest of the eight. */
  function steer(me, yaw, tx, tz) {
    const dx = tx - me.pos.x, dz = tz - me.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 1e-3) return { fwd: 0, strafe: 0 };
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const f = (dx * sy + dz * cy) / d;
    const s = (-dx * cy + dz * sy) / d;
    return {
      fwd: f > 0.35 ? 1 : (f < -0.35 ? -1 : 0),
      strafe: s > 0.35 ? 1 : (s < -0.35 ? -1 : 0)
    };
  }

  return {
    PARAM_NAMES, PARAM_BOUNDS,
    getParams: () => PARAM_NAMES.map(n => P[n]),
    /* Tolerant of the shipped ten-long vector: the driver hands over the
       vector it has always handed over, and the rules added here keep their
       defaults. A strict length check would silently leave the whole tuned
       loadout on the floor. */
    setParams: v => {
      if (!v || !v.length || v.length > PARAM_NAMES.length) return null;
      for (let i = 0; i < v.length; i++) P[PARAM_NAMES[i]] = v[i];
      return PARAM_NAMES.map(n => P[n]);
    },

    reset() {
      t = 0; phase = 0; strafeSign = 1;
      dest = null; destUntil = 0; evadeUntil = 0; coolUntil = 0; lastHealth = 100;
    },

    act(me, G, dt) {
      t += dt;
      if (!me.alive) { dest = null; evadeUntil = 0; return null; }
      if (me.health > lastHealth) { dest = null; evadeUntil = 0; coolUntil = 0; }  // respawned
      lastHealth = me.health;

      const { target, dist, visible, threats } = survey(me);
      if (!target) return { yaw: me.yaw + P.searchTurn * dt };

      /* ---- aim (unchanged from the shipped policy) ---- */
      const dx = target.pos.x - me.pos.x;
      const dz = target.pos.z - me.pos.z;
      const dy = (target.pos.y + P.aimHeight) - actorEye(me);
      const wantYaw = Math.atan2(dx, dz);
      const wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
      const maxTurn = P.turnRate * dt;
      const dYaw = wrap(wantYaw - me.yaw);
      const dPitch = wantPitch - me.pitch;

      /* ---- which rule is in charge -------------------------------------
         The shield window is invulnerability the engine hands out and the
         trigger throws away, so it outranks everything. Below it, evade;
         below that, fight exactly as the shipped policy fights. */
      const shielded = P.shieldHold > 0.5 && me.shield > 0;
      const hurt = P.lowHealth > 0 && me.health <= P.lowHealth;
      const watchers = threats.length;
      const wantEvade = !shielded && t > coolUntil &&
        ((P.evadeLos > 0 && watchers >= P.evadeLos) || (hurt && watchers >= 1));

      if (evadeUntil > t && watchers === 0) { evadeUntil = 0; coolUntil = t + P.evadeCool; dest = null; }
      if (wantEvade && evadeUntil <= t) evadeUntil = t + P.evadeSecs;
      if (evadeUntil <= t && !shielded && dest && !wantEvade) dest = null;

      const fleeing = shielded ? P.shieldFlee > 0.5 : evadeUntil > t;

      /* ---- flee: run somewhere they cannot shoot into ---- */
      if (fleeing) {
        const reached = dest && Math.hypot(dest.x - me.pos.x, dest.z - me.pos.z) < 0.9;
        if (!dest || reached || t > destUntil) {
          const r = refuge(me, threats.length ? threats : [target]);
          dest = r ? { x: r.x, z: r.z } : null;
          destUntil = t + 0.6;
        }
        if (dest) {
          /* Face the way we are running. Sprint needs fwd > 0 and the trigger
             released (applyMovement), and at turnRate 22 rad/s the aim comes
             back in under a tenth of a second when the window ends. */
          const runYaw = Math.atan2(dest.x - me.pos.x, dest.z - me.pos.z);
          const dRun = wrap(runYaw - me.yaw);
          const yaw = me.yaw + Math.max(-maxTurn, Math.min(maxTurn, dRun));
          const mv = steer(me, yaw, dest.x, dest.z);
          const mag = (WBY[me.weapon] && WBY[me.weapon].mag) || 30;
          if (me.ammo / mag <= P.reloadAt) tryReload(me);   // reloading does not pop the shield
          return {
            fwd: mv.fwd, strafe: mv.strafe,
            sprint: mv.fwd > 0,
            fire: false,
            yaw,
            pitch: me.pitch + Math.max(-maxTurn, Math.min(maxTurn, -me.pitch))
          };
        }
        /* Nowhere better to be. Fall through and fight — but if the shield is
           still up, still do not spend it on a shot. */
      }

      /* ---- the shipped fight ---- */
      const yaw = me.yaw + Math.max(-maxTurn, Math.min(maxTurn, dYaw));
      const pitch = me.pitch + Math.max(-maxTurn, Math.min(maxTurn, dPitch));

      let fwd = 0;
      if (dist > P.engageRange + P.rangeBand) fwd = 1;
      else if (dist < P.engageRange - P.rangeBand) fwd = -1;

      phase += dt / Math.max(0.05, P.strafePeriod);
      if (phase >= 1) { phase = 0; strafeSign = -strafeSign; }
      const strafe = visible ? strafeSign * P.strafeAmount : 0;

      const onTarget = Math.abs(dYaw) < P.fireCone && Math.abs(dPitch) < P.fireCone;
      const hasAmmo = me.ammo > 0;
      const mag = (WBY[me.weapon] && WBY[me.weapon].mag) || 30;
      if (!hasAmmo || me.ammo / mag <= P.reloadAt) tryReload(me);

      return {
        fwd, strafe,
        sprint: dist > P.sprintRange && !visible,
        fire: visible && onTarget && hasAmmo && !shielded,
        yaw, pitch
      };
    }
  };
})();
`;

module.exports = {
  name: 'reactive',
  describe: 'shipped policy + spawn-shield discipline (evasion and low-health rules measured, both lost, both off)',
  policySource: () => SOURCE
};

/* ---------------------------------------------------------------------
   Ablation runner. Every rule can be switched off by a parameter, so each
   one is measured on its own, on the same seeds, against the policy that
   is actually shipped.

     node tools/strategies/reactive.js [--matches 10] [--seed 1] [--arms a,b]
   --------------------------------------------------------------------- */
const ARMS = {
  /* the control: the text sliced out of the userscript */
  shipped:  null,
  /* the same rules the shipped policy has, expressed in this file — if this
     does not tie shipped exactly, the port is wrong and nothing else here
     means anything */
  port:     { shieldHold: 0, shieldFlee: 0, evadeLos: 0, lowHealth: 0 },
  hold:     { shieldHold: 1, shieldFlee: 0, evadeLos: 0, lowHealth: 0 },
  flee:     { shieldHold: 1, shieldFlee: 1, evadeLos: 0, lowHealth: 0 },
  evade3:   { shieldHold: 1, shieldFlee: 1, evadeLos: 3, lowHealth: 0 },
  evade2:   { shieldHold: 1, shieldFlee: 1, evadeLos: 2, lowHealth: 0 },
  low40:    { shieldHold: 1, shieldFlee: 1, evadeLos: 0, lowHealth: 40 },
  evadeOnly:{ shieldHold: 0, shieldFlee: 0, evadeLos: 3, lowHealth: 0 },
  full:     { shieldHold: 1, shieldFlee: 1, evadeLos: 3, lowHealth: 40 }
};

if (require.main === module) {
  const evalPolicy = require('../eval-policy.js');
  const arg = (k, d) => {
    const i = process.argv.indexOf('--' + k);
    return i >= 0 ? process.argv[i + 1] : d;
  };
  const matches = Number(arg('matches', 10));
  const first = Number(arg('seed', 1));
  const names = String(arg('arms', 'shipped,port,hold,flee,evade3,full')).split(',');
  const seeds = Array.from({ length: matches }, (_, i) => first + i);

  const shippedSource = evalPolicy.policySource(evalPolicy.userscript());
  const out = {};
  for (const name of names) {
    if (!(name in ARMS)) { console.error('no such arm: ' + name); process.exit(2); }
    const opts = ARMS[name] === null
      ? { policySource: shippedSource }
      : { policySource: SOURCE, overrides: ARMS[name] };
    const rows = seeds.map(s => evalPolicy.runMatch(s, opts));
    out[name] = rows;
    const s = evalPolicy.summarise(name, rows);
    evalPolicy.report(s);
    process.stderr.write(`    ${name}: ` + rows.map(r => `${r.kills}/${r.deaths}`).join(' ') + '\n');
  }

  /* Exact two-sided sign test on the paired per-seed fitness, the same test
     tournament.js ranks on. */
  const sign = (base, arm) => {
    let b = 0, w = 0;
    for (let i = 0; i < base.length; i++) {
      if (arm[i].streak > base[i].streak) b++;
      else if (arm[i].streak < base[i].streak) w++;
    }
    const n = b + w;
    const choose = (N, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (N - i) / (i + 1); return r; };
    let p = 0;
    for (let i = 0; i <= Math.min(b, w); i++) p += choose(n, i);
    return { b, w, t: base.length - n, p: n ? Math.min(1, 2 * p / Math.pow(2, n)) : 1 };
  };
  const base = out.shipped;
  if (base) {
    console.log('\n  paired against shipped on the same seeds:');
    for (const name of names) {
      if (name === 'shipped') continue;
      const st = sign(base, out[name]);
      const dd = out[name].reduce((a, r) => a + r.deaths, 0) - base.reduce((a, r) => a + r.deaths, 0);
      console.log(`    ${name.padEnd(10)} ${st.b}b/${st.w}w/${st.t}t  p=${st.p.toFixed(3)}` +
        `   deaths ${dd >= 0 ? '+' : ''}${dd}   ` +
        `perfect ${out[name].filter(r => r.perfect).length} vs ${base.filter(r => r.perfect).length}`);
    }
  }
}
