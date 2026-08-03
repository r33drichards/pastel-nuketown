'use strict';

/* cem.js — the shipped reactive policy, re-tuned by the cross-entropy method,
   with five appended parameters that let it disengage.

   Why re-tune something that was already tuned: the vector in the userscript
   was fitted when fitness still looked like a kill-rate problem. It is not.
   The policy takes all 25 kills and wins every match; the only thing left in
   `kills / (deaths + 1)` is the denominator. And the ten shipped parameters
   cannot express "back off" at all — there is no health input, no notion of
   how many guns are pointed at you, and nothing that turns the body away from
   a fight. A parameter that cannot say it cannot be tuned into it.

   So this file is the shipped POLICY text VERBATIM plus an extension block
   that appends to PARAM_NAMES / PARAM_BOUNDS (append-only: saved vectors are
   positional) and wraps act():

     hurtHealth   below this health, count as hurt (0 = never)
     losThreat    this many enemies holding line of sight counts as swarmed
     breakRange   only disengage while the nearest visible enemy is nearer
                  than this; past it, fight normally
     retreatTurn  fraction of pi to swing the view away from the target while
                  disengaging. 0 backpedals with the gun still on them; 1 turns
                  the back and runs, which is the only way to reach sprint
                  speed — applyMovement() gates sprint on fwd > 0 && !fire.
     retreatFire  > 0.5 keeps the trigger going while disengaging

   Movement while disengaging is resolved in world space (away from the
   target) and then projected onto whatever heading the view ended up at, so
   retreatTurn moves the eyes without changing where the body goes.

   The vector below is the CEM result. Both halves of it are searched — the
   ten shipped numbers as well as the five new ones. */

const { userscript, policySource } = require('../eval-policy.js');

/* Appended to the shipped ten, in this order. */
const EXTRA_NAMES = ['hurtHealth', 'losThreat', 'breakRange', 'retreatTurn', 'retreatFire'];
const EXTRA_BOUNDS = [[0, 100], [1, 6], [4, 45], [0, 1], [0, 1]];

/* The shipped vector, for reference and for paired comparisons. */
const SHIPPED = [24.030481, 2.256479, 0.020000, 22.140736, 1.897986,
                 0.634428, 12.297849, 0.177887, 1.575976, 3.160332];

/* CEM result: 15 numbers, mean of the final elite set, clipped to bounds.
   pop 20, elite 6, 9 iterations, 12 common seeds. */
const VECTOR = [
  22.520564, 2.986243, 0.020000, 25.297199, 1.470325,
  0.752716, 10.401306, 0.264006, 1.529020, 3.516408,
  62.371450, 2.131763, 26.246842, 0.907997, 0.000000
];

/* The extension. Text, because it is evaluated inside the game's vm on top of
   the shipped POLICY block. */
function extensionSource(vec) {
  return `
;(() => {
  const EXTRA = ${JSON.stringify(EXTRA_NAMES)};
  const BOUNDS = ${JSON.stringify(EXTRA_BOUNDS)};
  for (let i = 0; i < EXTRA.length; i++) {
    POLICY.PARAM_NAMES.push(EXTRA[i]);
    POLICY.PARAM_BOUNDS.push(BOUNDS[i]);
  }

  /* Every parameter by name, refreshed whenever the vector moves. The shipped
     block keeps them in a closed-over object; this is the published way in. */
  const X = {};
  const baseSet = POLICY.setParams;
  const sync = vals => {
    const names = POLICY.PARAM_NAMES;
    for (let i = 0; i < names.length; i++) X[names[i]] = vals[i];
  };
  POLICY.setParams = v => {
    const out = baseSet(v);
    if (out) sync(out);
    return out;
  };

  const baseAct = POLICY.act;
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);

  POLICY.act = function (me, G, dt) {
    const out = baseAct.call(POLICY, me, G, dt);
    if (!out || !me.alive) return out;

    /* One pass for both questions: who is the nearest enemy that can see me,
       and how many of them there are. Line of sight is symmetric here --
       canSee is a ray against the map -- so the same test answers both.
       Only inside breakRange: a rifle across the whole map is not what makes
       this policy die, and the ray is the expensive part of the tick. */
    let tgt = null, td = Infinity, los = 0;
    const ex = me.pos.x, ey = actorEye(me), ez = me.pos.z;
    for (const a of G.actors) {
      if (a === me || a.isPlayer || !a.alive) continue;
      const d = Math.hypot(a.pos.x - ex, a.pos.z - ez);
      if (d > X.breakRange) continue;
      if (!canSee(ex, ey, ez, a.pos.x, actorEye(a), a.pos.z)) continue;
      los++;
      if (d < td) { td = d; tgt = a; }
    }
    if (!tgt) return out;

    const hurt = X.hurtHealth > 0 && me.health < X.hurtHealth;
    const swarmed = los >= X.losThreat;
    if (!(hurt || swarmed)) return out;

    /* Where the body goes: straight away from the nearest gun. */
    let ax = ex - tgt.pos.x, az = ez - tgt.pos.z;
    const al = Math.hypot(ax, az) || 1;
    ax /= al; az /= al;

    /* Where the eyes go: the target, swung away by retreatTurn * pi. Capped by
       the same turn rate the rest of the policy obeys, so disengaging cannot
       teleport the crosshair either. */
    const toT = Math.atan2(tgt.pos.x - ex, tgt.pos.z - ez);
    const maxTurn = X.turnRate * dt;
    const yaw = me.yaw + clamp(wrap(toT + X.retreatTurn * Math.PI - me.yaw), -maxTurn, maxTurn);

    /* forward = (sin yaw, cos yaw), right = (-cos yaw, sin yaw) -- the same
       basis applyMovement uses, so this is the input that produces the world
       direction we actually want. */
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    const fwd = clamp(ax * sy + az * cy, -1, 1);
    const strafe = clamp(ax * -cy + az * sy, -1, 1);

    const onTarget = Math.abs(wrap(toT - yaw)) < X.fireCone;
    const fire = X.retreatFire > 0.5 && onTarget && me.ammo > 0;

    return {
      fwd, strafe,
      sprint: fwd > 0.2 && !fire,
      fire,
      yaw,
      pitch: out.pitch
    };
  };

  POLICY.setParams(${JSON.stringify(vec.map(v => Number(v.toFixed(6))))});
})();
`;
}

function buildSource(vec) {
  return policySource(userscript()) + '\n' + extensionSource(vec || VECTOR);
}

module.exports = {
  name: 'cem',
  describe: 'shipped policy re-tuned by CEM, plus five disengage parameters',
  policySource: () => buildSource(VECTOR),

  /* For the tuner. */
  buildSource,
  EXTRA_NAMES, EXTRA_BOUNDS, SHIPPED, VECTOR
};
