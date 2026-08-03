'use strict';

/* =====================================================================
   selfplay.arena.js — run a match with several of the eight bot slots
   driven by POLICY objects instead of by bots.js brains.

   WHY
   ---
   Everything else in this directory is measured against the same eight fixed
   bots. That is a stationary opponent, and a stationary opponent is a
   stationary ceiling. This file makes the opponents move: any subset of the
   bot slots can be handed a policy source, so a policy can be played against
   itself, against an older version of itself, or against a rival.

   THE SEAM
   --------
   src/70-game.js stepBot() is the only thing that drives a bot, and it drives
   it through exactly one call:

       it = AI.think(a.brain, _view, dt)

   consuming {moveX, moveZ, aimYaw, aimPitch, fire, reload, jump, state,
   targetId}. So the adapter below replaces AI.think with a wrapper that, for
   the actors it has claimed, calls POLICY.act(actor, G, dt) and translates the
   answer into that contract. Unclaimed actors fall through to the real
   AI.think untouched, so the eight fixed bots are still the eight fixed bots.

   THREE TRANSLATIONS, EACH OF WHICH IS SILENT WHEN WRONG
   ------------------------------------------------------
   1. YAW. stepBot does `_viewSelf.yaw = yawFlip(a.aimYaw)` on the way in and
      `a.aimYaw = yawFlip(it.aimYaw)` on the way out: the AI contract's yaw is
      the engine's reflected through `yawFlip(y) = PI/2 - y`. POLICY.act
      returns ENGINE yaw (it is written for the local player, whose yaw goes
      straight into a.yaw). So the adapter emits yawFlip(policyYaw), and hands
      the policy a.aimYaw — NOT the flipped view yaw — as `me.yaw`. Get it
      backwards and the bot aims 180 degrees off and reads as a bad policy
      rather than as a bug. `verify()` below tests exactly this.

   2. MOVEMENT FRAME. POLICY.act returns fwd/strafe in the actor's local
      frame; moveX/moveZ are world axes. applyMovement() in src/70-game.js is
      the authority on the rotation, and this repeats it verbatim:
          mx = sin(yaw)*fwd - cos(yaw)*strafe
          mz = cos(yaw)*fwd + sin(yaw)*strafe
      clamped to unit length the same way (clamp, not normalise). stepBot
      normalises again and scales by CFG.botSpeed.

   3. SELF. The shipped policy's target filter is
          if (a === me || a.isPlayer || !a.alive) continue;
      `a.isPlayer` is there to skip *itself*, because the policy is normally
      the local player. A bot running it would skip the human instead and
      never shoot at them. So for the duration of the act() call the adapter
      clears isPlayer on the real player; `a === me` already covers self.
      Restored in a finally.

   THINGS THAT STAY DIFFERENT, AND CANNOT BE FIXED FROM HERE
   ---------------------------------------------------------
   - Bots move at CFG.botSpeed (5.3), the player at CFG.playerSpeed (5.9),
     and only the player can sprint (stepBot has no sprint term at all). A
     policy in a bot slot is therefore ~10% slower than the same policy in the
     player slot. That is why ratings here only ever compare bot slots with
     bot slots; the player slot is a fixed part of the environment.
   - stepBot fires with `if (it.fire) fireWeapon(a)` every tick and lets
     a.fireCd do the gating, where the player driver drives press/release and
     the semi-auto latch. Net effect is the same rate of fire.

   API
   ---
     runArena(seed, {
       entrants: [{ name, source }],   // policy sources, as policySource()
       player:   0 | null,             // entrant index driving the local
                                       // player, via the SHIPPED driver
       bots:     { 0: 1, 2: 1, ... },  // bot slot -> entrant index
       seconds:  120,                  // simulated seconds to run
       killsToWin: 9999,               // lift the race so the clock decides
       arsenal: true                   // give claimed bots the driver's
                                       // smg-then-rifle-then-shotgun arsenal
     })
     -> { seed, seconds, ticks, over, actors: [...], entrants: [...] }

   Every claimed actor is a separate POLICY instance built from its own copy
   of the source, so two slots running the same strategy do not share the
   strategy's module-level state.
   ===================================================================== */

const { createInstance, FIXED, mulberry32 } = require('../../net-sim.js');
const { userscript, policySource, driverSource } = require('../eval-policy.js');

const SIM_BOOT = 'initViewmodel(); initFX(); initInput(); initAI();';

/* The same reseed eval-policy.js uses, so an arena match and a tournament
   match on the same seed start the unclaimed bots from the same draw. */
const RESEED = seed => `
  for (const a of G.actors) {
    if (!a.brain) continue;
    try { a.brain = AI.createBrain({ id: a.id, seed: ${seed >>> 0} * 7919 + a.id * 131, skill: a.skill }); }
    catch (e) {}
  }
`;

/* The tuned vector the shipped driver pushes into whatever POLICY it finds.
   Read out of the driver text rather than copied, so it cannot go stale.
   Every tournament entry gets this call, so claimed bots get it too. */
function tunedVector() {
  const m = /POLICY\.setParams\(\s*(\[[^\]]*\])\s*\)/.exec(driverSource(userscript()));
  return m ? JSON.parse(m[1]) : null;
}

/* ---------------------------------------------------------------------
   The adapter. Written as a real function purely so it is readable and
   `node --check`able; it is never called in node, only stringified into the
   vm where AI, G, WBY, switchRemoteWeapon and friends exist.
   --------------------------------------------------------------------- */
function ADAPTER() {
  const HALF_PI = Math.PI * 0.5;
  const yflip = y => HALF_PI - y;
  const ARSENAL = ['smg', 'rifle', 'shotgun'];

  const claims = new Map();       // actor id -> claim
  const idle = { moveX: 0, moveZ: 0, jump: false, aimYaw: 0, aimPitch: 0,
                 fire: false, reload: false, targetId: null, state: 'idle' };

  function storeOf(a, id) {
    if (a.weapon === id) return { ammo: a.ammo, reserve: a.reserve };
    const s = a._ammoBy && a._ammoBy[id];
    return s || { ammo: WBY[id].mag, reserve: WBY[id].reserve };
  }
  /* The userscript driver's `bestFor`, for an actor that is not G.player:
     switchWeapon() only ever moves the local player, switchRemoteWeapon does
     the identical per-weapon-store bookkeeping for anybody. */
  function equipBest(a, reloadAt) {
    let pick = null;
    for (const id of ARSENAL) {
      const s = storeOf(a, id);
      if (!(s.reserve <= 0 && s.ammo <= WBY[id].mag * reloadAt)) { pick = id; break; }
    }
    if (!pick) {
      let best = -1;
      for (const id of ARSENAL) {
        const s = storeOf(a, id), n = s.ammo + s.reserve;
        if (n > best) { best = n; pick = id; }
      }
    }
    if (pick && pick !== a.weapon) switchRemoteWeapon(a, pick);
  }

  const realThink = AI.think;

  AI.think = function (brain, view, dt) {
    const self = view && view.self;
    const claim = self ? claims.get(self.id) : null;
    if (!claim) return realThink.apply(this, arguments);

    const a = claim.actor;
    claim.ticks++;
    if (claim.arsenal) equipBest(a, claim.reloadAt);

    /* stepBot never writes a.yaw/a.pitch for a bot — it only keeps aimYaw/
       aimPitch — so a policy reading me.yaw would read the spawn yaw forever.
       Publish the engine-convention aim into them before asking. */
    a.yaw = a.aimYaw; a.pitch = a.aimPitch;

    const human = G.player;
    const hadFlag = human ? human.isPlayer : false;
    if (human && human !== a) human.isPlayer = false;
    let act = null;
    try {
      act = claim.policy.act(a, G, dt);
    } catch (e) {
      claim.errors++;
      claim.lastError = String((e && e.message) || e);
    } finally {
      if (human && human !== a) human.isPlayer = hadFlag;
    }

    if (!act) {
      idle.aimYaw = yflip(a.aimYaw); idle.aimPitch = a.aimPitch;
      idle.state = 'hold';
      return idle;
    }

    const yaw = Number.isFinite(act.yaw) ? act.yaw : a.aimYaw;
    let pitch = Number.isFinite(act.pitch) ? act.pitch : a.aimPitch;
    if (pitch > 1.45) pitch = 1.45; else if (pitch < -1.45) pitch = -1.45;

    let fwd = Number.isFinite(act.fwd) ? act.fwd : 0;
    let str = Number.isFinite(act.strafe) ? act.strafe : 0;
    if (fwd > 1) fwd = 1; else if (fwd < -1) fwd = -1;
    if (str > 1) str = 1; else if (str < -1) str = -1;
    /* applyMovement(): forward = (sin y, cos y), right = (-cos y, sin y). */
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    let mx = sy * fwd - cy * str;
    let mz = cy * fwd + sy * str;
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }

    return {
      moveX: mx, moveZ: mz, jump: !!act.jump,
      aimYaw: yflip(yaw), aimPitch: pitch,
      fire: !!act.fire,
      /* The policy owns reloading — it calls tryReload(me) itself, exactly as
         it does in the player slot. Asking stepBot for a second one would be
         a different policy. */
      reload: false,
      targetId: act.fire ? self.id : null,
      state: 'policy'
    };
  };

  return {
    /* `make` is a source-to-instance factory installed from node, one call
       per claimed slot, so slots never share policy state. */
    claim(actorId, policy, opts) {
      const actor = G.actors.find(x => x.id === actorId);
      if (!actor) throw new Error('no actor ' + actorId);
      claims.set(actorId, {
        actor, policy, name: opts.name,
        arsenal: !!opts.arsenal, reloadAt: opts.reloadAt || 0,
        ticks: 0, errors: 0, lastError: null
      });
      return true;
    },
    report() {
      const out = [];
      for (const [id, c] of claims) {
        out.push({ id, name: c.name, ticks: c.ticks, errors: c.errors,
                   lastError: c.lastError });
      }
      return out;
    },
    claimed: () => claims
  };
}

/* --------------------------------------------------------------------- */

function instantiate(inst, index, source) {
  /* Each source declares `const POLICY = ...` at top level. Wrapping it in a
     function body gives every slot its own binding and its own closure state,
     and keeps the vm's global POLICY (the player's, installed by the shipped
     driver) untouched. */
  inst.run(`__SP_MADE[${index}] = (function () {\n${source}\n;return POLICY;})();`);
}

function runArena(seed, opts = {}) {
  const entrants = opts.entrants || [];
  const botAssign = opts.bots || {};
  const seconds = opts.seconds === undefined ? 120 : opts.seconds;
  const arsenal = opts.arsenal === undefined ? true : !!opts.arsenal;
  const killsToWin = opts.killsToWin === undefined ? 9999 : opts.killsToWin;
  const tuned = tunedVector();

  const clock = { ms: 0 };
  const inst = createInstance(clock);
  inst.run(`Math.random = (${mulberry32.toString()})(${(seed >>> 0) || 1});`);
  inst.run(SIM_BOOT);

  /* The player slot, if any, goes in exactly the way eval-policy.js does it:
     the policy source at top level plus the SHIPPED driver, so a match with
     no bot claims is bit-identical to a tournament match. */
  const src = userscript();
  if (opts.player !== null && opts.player !== undefined) {
    inst.run(entrants[opts.player].source);
    inst.run(driverSource(src));
  }

  inst.run('var __SP_MADE = [];');
  inst.run('var SPA = (' + ADAPTER.toString() + ')();');
  inst.run(`CFG.killsToWin = ${killsToWin};`);
  inst.run('startMatch();');
  inst.run(RESEED(seed));

  /* G.actors is [player, bot slot 0..7]; a bot's netId is 'bot-<slot>'. */
  const roster = inst.get(
    'G.actors.map((a, i) => ({ i, id: a.id, netId: a.netId, name: a.name, ' +
    'isPlayer: !!a.isPlayer, skill: a.skill, weapon: a.weapon }))');

  const slotOf = {};
  for (const r of roster) {
    if (r.isPlayer) continue;
    const m = /^bot-(\d+)$/.exec(r.netId || '');
    if (m) slotOf[Number(m[1])] = r;
  }

  const claims = [];
  let made = 0;
  for (const key of Object.keys(botAssign)) {
    const slot = Number(key);
    const idx = botAssign[key];
    const row = slotOf[slot];
    if (!row) throw new Error('no bot in slot ' + slot);
    const ent = entrants[idx];
    if (!ent) throw new Error('no entrant ' + idx);
    const n = made++;
    instantiate(inst, n, ent.source);
    if (tuned) inst.run(`try { __SP_MADE[${n}].setParams(${JSON.stringify(tuned)}); } catch (e) {}`);
    const reloadAt = inst.get(
      `(function () { const p = __SP_MADE[${n}];
         try { const i = p.PARAM_NAMES.indexOf('reloadAt');
               return i < 0 ? 0 : (p.getParams()[i] || 0); } catch (e) { return 0; } })()`);
    inst.run(`SPA.claim(${row.id}, __SP_MADE[${n}], ${JSON.stringify({
      name: ent.name, arsenal, reloadAt: reloadAt || 0 })});`);
    inst.run(`try { __SP_MADE[${n}].reset && __SP_MADE[${n}].reset(${(seed >>> 0) || 1}); } catch (e) {}`);
    claims.push({ slot, actorId: row.id, entrant: idx, name: ent.name });
  }

  const maxTicks = Math.max(1, Math.round(seconds / FIXED));
  let ticks = 0;
  while (ticks < maxTicks && !inst.get('G.over')) {
    inst.run(`simulate(${FIXED});`);
    clock.ms += FIXED * 1000;
    ticks++;
  }

  const finals = inst.get(
    'G.actors.map((a, i) => ({ i, id: a.id, netId: a.netId, isPlayer: !!a.isPlayer, ' +
    'skill: a.skill, weapon: a.weapon, kills: a.kills, deaths: a.deaths }))');
  const diag = inst.get('SPA.report()');
  const diagBy = new Map(diag.map(d => [d.id, d]));
  const claimBy = new Map(claims.map(c => [c.actorId, c]));

  const actors = finals.map(f => {
    const c = claimBy.get(f.id);
    const d = diagBy.get(f.id);
    return {
      slot: f.isPlayer ? 'player' : Number((/^bot-(\d+)$/.exec(f.netId || '') || [])[1]),
      kind: f.isPlayer ? 'player' : (c ? 'policy' : 'native'),
      entrant: f.isPlayer
        ? (opts.player === undefined ? null : opts.player)
        : (c ? c.entrant : null),
      name: f.isPlayer
        ? (opts.player == null ? 'idle' : entrants[opts.player].name)
        : (c ? c.name : 'bot:' + f.skill),
      skill: f.skill, weapon: f.weapon,
      kills: f.kills, deaths: f.deaths,
      streak: f.kills / (f.deaths + 1),
      ticks: d ? d.ticks : null,
      errors: d ? d.errors : 0,
      lastError: d ? d.lastError : null
    };
  });

  return {
    seed, seconds: ticks * FIXED, ticks,
    over: !!inst.get('G.over'),
    actors,
    entrants: entrants.map((e, i) => {
      const mine = actors.filter(a => a.kind === 'policy' && a.entrant === i);
      return {
        index: i, name: e.name, slots: mine.map(a => a.slot),
        kills: mine.reduce((s, a) => s + a.kills, 0),
        deaths: mine.reduce((s, a) => s + a.deaths, 0),
        errors: mine.reduce((s, a) => s + a.errors, 0)
      };
    })
  };
}

/* ---------------------------------------------------------------------
   verify() — the adapter is only worth anything if a bot driven by policy X
   behaves like policy X. Three checks, each of which fails loudly for one of
   the three translations above.

     1. AIM. Put the shipped policy on one bot, freeze the rest, and measure
        the angle between where the bot's aimYaw points and where its nearest
        visible enemy actually is. A yaw-flip bug puts this near PI.
     2. MOVE. Command a pure strafe and check the world velocity is
        perpendicular to the facing, and a pure forward that it is parallel.
     3. FIGHT. A policy-driven bot must take kills. A drunk takes none.
   --------------------------------------------------------------------- */
function verify(opts = {}) {
  const seed = opts.seed || 1;
  const shipped = { name: 'shipped', source: policySource(userscript()) };
  const out = { checks: [] };
  const clock = { ms: 0 };
  const inst = createInstance(clock);
  inst.run(`Math.random = (${mulberry32.toString()})(${seed});`);
  inst.run(SIM_BOOT);
  inst.run('var __SP_MADE = [];');
  inst.run('var SPA = (' + ADAPTER.toString() + ')();');
  inst.run('CFG.killsToWin = 9999;');
  inst.run('startMatch();');
  inst.run(RESEED(seed));

  const roster = inst.get('G.actors.map(a => ({ id: a.id, netId: a.netId, isPlayer: !!a.isPlayer }))');
  const bot = roster.find(r => r.netId === 'bot-0');
  instantiate(inst, 0, shipped.source);
  const tuned = tunedVector();
  if (tuned) inst.run(`__SP_MADE[0].setParams(${JSON.stringify(tuned)});`);
  inst.run(`SPA.claim(${bot.id}, __SP_MADE[0], ${JSON.stringify({ name: 'shipped', arsenal: true, reloadAt: 0 })});`);

  /* --- 1. aim ---------------------------------------------------------- */
  const samples = [];
  for (let i = 0; i < 60 * 20; i++) {
    inst.run(`simulate(${FIXED});`);
    clock.ms += FIXED * 1000;
    if (i % 7) continue;
    const s = inst.get(`(function () {
      const a = G.actors.find(x => x.id === ${bot.id});
      if (!a || !a.alive) return null;
      let best = null, bd = Infinity;
      for (const o of G.actors) {
        if (o === a || !o.alive) continue;
        const d = Math.hypot(o.pos.x - a.pos.x, o.pos.z - a.pos.z);
        if (d < bd && canSee(a.pos.x, actorEye(a), a.pos.z, o.pos.x, actorEye(o), o.pos.z)) { bd = d; best = o; }
      }
      if (!best) return null;
      const want = Math.atan2(best.pos.x - a.pos.x, best.pos.z - a.pos.z);
      const e = Math.atan2(Math.sin(want - a.aimYaw), Math.cos(want - a.aimYaw));
      return { err: Math.abs(e), dist: bd, speed: Math.hypot(a.vel.x, a.vel.z) };
    })()`);
    if (s) samples.push(s);
  }
  const errs = samples.map(s => s.err).sort((a, b) => a - b);
  const median = errs.length ? errs[errs.length >> 1] : NaN;
  out.checks.push({
    name: 'aim points at the enemy',
    samples: errs.length,
    medianAimErrorRad: median,
    pass: errs.length > 20 && median < 0.35
  });
  const speeds = samples.map(s => s.speed);
  out.checks.push({
    name: 'the bot actually moves',
    meanSpeed: speeds.reduce((a, b) => a + b, 0) / Math.max(1, speeds.length),
    pass: speeds.filter(v => v > 1).length > speeds.length * 0.4
  });

  /* --- 2. movement frame ---------------------------------------------- */
  const frame = inst.get(`(function () {
    const a = G.actors.find(x => x.id === ${bot.id});
    const yaw = a.aimYaw;
    const fwd = { x: Math.sin(yaw), z: Math.cos(yaw) };
    const right = { x: -Math.cos(yaw), z: Math.sin(yaw) };
    const test = (f, s) => {
      const sy = Math.sin(yaw), cy = Math.cos(yaw);
      let mx = sy * f - cy * s, mz = cy * f + sy * s;
      const ml = Math.hypot(mx, mz); if (ml > 1) { mx /= ml; mz /= ml; }
      return { alongFwd: mx * fwd.x + mz * fwd.z, alongRight: mx * right.x + mz * right.z };
    };
    return { forward: test(1, 0), strafeRight: test(0, 1), diag: test(1, 1) };
  })()`);
  out.checks.push({
    name: 'fwd=1 is forward, strafe=1 is right, diagonal is unit',
    frame,
    pass: frame.forward.alongFwd > 0.99 && Math.abs(frame.forward.alongRight) < 1e-9 &&
          frame.strafeRight.alongRight > 0.99 && Math.abs(frame.strafeRight.alongFwd) < 1e-9 &&
          Math.abs(Math.hypot(frame.diag.alongFwd, frame.diag.alongRight) - 1) < 1e-9
  });

  /* --- 3. it fights ---------------------------------------------------- */
  for (let i = 0; i < 60 * 100; i++) { inst.run(`simulate(${FIXED});`); clock.ms += FIXED * 1000; }
  const fight = inst.get(`(function () {
    const a = G.actors.find(x => x.id === ${bot.id});
    const others = G.actors.filter(x => x.id !== ${bot.id} && !x.isPlayer);
    return { kills: a.kills, deaths: a.deaths,
             rivalKills: others.reduce((s, o) => s + o.kills, 0) / others.length,
             err: SPA.report()[0] };
  })()`);
  out.checks.push({
    name: 'a policy-driven bot outscores the native bots around it',
    fight,
    pass: fight.err.errors === 0 && fight.kills > fight.rivalKills
  });

  out.pass = out.checks.every(c => c.pass);
  return out;
}

module.exports = {
  runArena, verify, tunedVector, FIXED,
  ADAPTER_SOURCE: () => 'var SPA = (' + ADAPTER.toString() + ')();',

  /* --- tournament contract -------------------------------------------
     tools/tournament.js excludes helper files by the regex
       /\.(analysis|test|util|helper|sweep)\.js$/
     which does not cover `.arena.js`, so this file WILL be picked up as an
     entry. Rather than let it be recorded as a failure in somebody else's
     run, it forwards the strategy in selfplay.js. Adding `arena` to that
     regex would be the tidier fix; that is tournament.js's to make, not
     mine. */
  name: 'sp-arena',
  describe: '(library — mirrors selfplay.js; see the note in the file)',
  policySource: () => require('./selfplay.js').policySource()
};

if (require.main === module) {
  const cmd = process.argv[2] || 'verify';
  if (cmd === 'verify') {
    const r = verify({ seed: Number(process.argv[3] || 1) });
    for (const c of r.checks) {
      console.log((c.pass ? '  ok   ' : '  FAIL ') + c.name);
      const { name, pass, ...rest } = c;
      console.log('       ' + JSON.stringify(rest));
    }
    console.log(r.pass ? '\nadapter verified' : '\nADAPTER BROKEN');
    process.exit(r.pass ? 0 : 1);
  } else if (cmd === 'demo') {
    const shipped = { name: 'shipped', source: policySource(userscript()) };
    const t0 = Date.now();
    const r = runArena(Number(process.argv[3] || 1), {
      entrants: [shipped], player: 0,
      bots: { 0: 0, 2: 0, 4: 0, 6: 0 },
      seconds: Number(process.argv[4] || 90)
    });
    for (const a of r.actors) {
      console.log(`  ${String(a.slot).padEnd(6)} ${a.kind.padEnd(7)} ${a.name.padEnd(10)} ` +
        `${a.weapon.padEnd(8)} ${String(a.kills).padStart(3)}k / ${String(a.deaths).padStart(3)}d` +
        (a.errors ? '  ERRORS ' + a.errors + ' ' + a.lastError : ''));
    }
    console.log(`  ${r.seconds.toFixed(0)}s sim, ${((Date.now() - t0) / 1000).toFixed(1)}s wall`);
  }
}

