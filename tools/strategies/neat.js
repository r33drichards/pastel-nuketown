'use strict';

/* =====================================================================
   neat.js — a policy evolved with NEAT (Stanley & Miikkulainen 2002).

   The evolved network is embedded below as DATA. `policySource()` emits
   plain JS that does the forward pass; nothing is trained at load time.

   The three pillars of the paper are implemented in the trainer
   (tools/neat-train.js), not here:
     1. historical markings (innovation numbers) for topological crossover
     2. speciation with explicit fitness sharing, using
        delta = c1*E/N + c2*D/N + c3*Wbar
     3. complexification from a minimal topology — the initial population
        has no hidden nodes and no connections at all

   This file owns the ENCODING, which is the part that matters: what the
   network sees and what it is allowed to do. The trainer imports
   `buildSource` from here so there is exactly one implementation of the
   sensors and the forward pass — the thing that evolved and the thing
   that ships are the same code.
   ===================================================================== */

/* ---- the encoding ---------------------------------------------------
   INPUTS (37), all egocentric and roughly in [-1, 1]:

     per enemy slot k = 0,1,2   (slots ordered: visible enemies first,
                                 then by distance — so slot 0 is the
                                 enemy the shipped policy would engage)
       6k+0  sin(bearing - my yaw)      = sin of the yaw aim error
       6k+1  cos(bearing - my yaw)      = 1 when already facing them
       6k+2  exp(-dist/15)              = 1 when on top of them
       6k+3  line of sight to them, 0/1
       6k+4  how squarely they are facing me, 0..1 (only when visible)
       6k+5  pitch aim error / 0.4, clamped

     18  health / 100
     19  spawn shield remaining, 0..1
     20  magazine fraction
     21  mid-reload, 0/1
     22  cover score of my nav node (AI.buildNav's `cover`, 0..1)
     23  how many enemies can see me, / 3
     24  my pitch / 1.45
     25  vertical velocity / 6
     26  forward speed / 8   (body frame)
     27  lateral speed / 8   (body frame)
     28..33  six wall probes: raycastMap at relative bearings
             0, +52, -52, +115, -115, 180 degrees, as 1 - dist/8
     34  sin(2*pi*t / 1.2)   a clock, so a strafe rhythm is one link away
     35  cos(2*pi*t / 1.2)
     36  bias, constant 1

   OUTPUTS (8), each squashed to (-1, 1):
     0  fwd            -> clamped straight through
     1  strafe         -> clamped straight through
     2  jump           -> pressed when > 0.3
     3  sprint         -> pressed when > 0
     4  fire           -> trigger when > 0
     5  yaw rate       -> * TURN_RATE rad/s, integrated per tick
     6  pitch rate     -> * TURN_RATE rad/s, integrated per tick
     7  reload         -> tryReload when > 0

   Aim is a RATE, capped at TURN_RATE radians/second, exactly like the
   shipped policy's turnRate cap. The network cannot teleport the
   crosshair, so anything that evolves here is shippable.

   The sensors run every SENSE_EVERY ticks, not every tick; the outputs
   are held in between while the aim rates keep integrating. Decimation
   is not free here: a held RATE overshoots, because unlike the shipped
   policy the network cannot clamp its turn to the exact remaining aim
   error. A hand-built seven-link genome scored 37% hit rate at 30 Hz
   against 23% at 15 Hz and 38% at 60 Hz, so 30 Hz buys back nearly all
   of the accuracy for two thirds of the sensor cost. The same sweep put
   the best turn cap at 12-14 rad/s rather than the shipped 22: a coarse
   controller with a high cap just spins past the target.

   One reflex is hard-wired: an empty magazine always calls tryReload.
   An empty gun has exactly one sensible action, the driver only swaps
   weapons once the RESERVE is dry too, and without it a network that
   has not yet discovered output 7 stands there with a dead trigger for
   the whole match — a fitness plateau at zero that hides every other
   thing the search is trying to learn.
   ------------------------------------------------------------------ */

const N_IN = 37;
const N_OUT = 8;
const TURN_RATE = 14.0;    // rad/s, the cap on aim movement
const SENSE_EVERY = 2;     // ticks between forward passes (60 Hz / 2 = 30 Hz)

/* ---- the evolved genome --------------------------------------------
   hidden: node ids of hidden neurons, in creation order.
   conns:  [from, to, weight] for every ENABLED connection.
   Node ids: 0..36 inputs, 37..44 outputs, >=100 hidden.
   Evaluation order is hidden ascending then outputs; a connection that
   points backwards in that order reads last tick's value, which is how
   the topology gets memory for free (MarI/O's single-pass scheme).
   ------------------------------------------------------------------ */
const GENOME = require('./neat.genome.json');

function buildSource(genome, opts) {
  const g = genome || GENOME;
  const o = opts || {};
  const turn = o.turnRate == null ? TURN_RATE : o.turnRate;
  const decim = o.senseEvery == null ? SENSE_EVERY : o.senseEvery;
  return `
const POLICY = (() => {
  const NI = ${N_IN}, NO = ${N_OUT};
  const TURN = ${turn};
  const DECIM = ${decim};
  const HIDDEN = ${JSON.stringify(g.hidden || [])};
  const CONNS = ${JSON.stringify(g.conns || [])};

  /* Compile the gene list into per-node incoming lists once. */
  const ORDER = HIDDEN.slice().sort((a, b) => a - b);
  for (let o = 0; o < NO; o++) ORDER.push(NI + o);
  const SLOT = new Map();
  for (let i = 0; i < NI; i++) SLOT.set(i, i);
  let next = NI;
  for (const id of ORDER) if (!SLOT.has(id)) SLOT.set(id, next++);
  const NV = next;
  const INC = [];
  for (let i = 0; i < NV; i++) INC.push([]);
  for (const c of CONNS) {
    if (!SLOT.has(c[0]) || !SLOT.has(c[1])) continue;
    INC[SLOT.get(c[1])].push([SLOT.get(c[0]), c[2]]);
  }
  const EVAL = ORDER.map(id => SLOT.get(id));

  const V = new Float64Array(NV);
  const OUT = new Float64Array(NO);
  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  /* The NEAT paper's steepened sigmoid, shifted to (-1, 1) so that a
     single link can produce a signed control output. */
  const squash = x => 2 / (1 + Math.exp(-4.9 * x)) - 1;

  let T = 0, tick = 0, navId = -1, navAt = -1;

  const PROBE = [0, 0.91, -0.91, 2.01, -2.01, Math.PI];

  function sense(me, G) {
    for (let i = 0; i < NI; i++) V[i] = 0;
    const eye = actorEye(me);
    const list = [];
    let threats = 0;
    for (const a of G.actors) {
      if (a === me || a.isPlayer || !a.alive) continue;
      const dx = a.pos.x - me.pos.x, dz = a.pos.z - me.pos.z;
      const d = Math.hypot(dx, dz);
      const los = canSee(me.pos.x, eye, me.pos.z, a.pos.x, actorEye(a), a.pos.z);
      if (los) threats++;
      list.push({ a, dx, dz, d, los, dy: (a.pos.y + 1.5) - eye });
    }
    /* Visible first, then nearest. Slot 0 is the engagement target. */
    list.sort((p, q) => (p.los === q.los ? p.d - q.d : (p.los ? -1 : 1)));
    for (let k = 0; k < 3; k++) {
      const e = list[k];
      if (!e) continue;
      const b = k * 6;
      const rel = wrap(Math.atan2(e.dx, e.dz) - me.yaw);
      V[b] = Math.sin(rel);
      V[b + 1] = Math.cos(rel);
      V[b + 2] = Math.exp(-e.d / 15);
      V[b + 3] = e.los ? 1 : 0;
      if (e.los) {
        const back = wrap(Math.atan2(-e.dx, -e.dz) - e.a.yaw);
        V[b + 4] = Math.max(0, Math.cos(back));
      }
      V[b + 5] = clamp((Math.atan2(e.dy, e.d) - me.pitch) / 0.4, -1, 1);
    }

    const mag = (WBY[me.weapon] && WBY[me.weapon].mag) || 30;
    V[18] = clamp(me.health / 100, 0, 1);
    V[19] = clamp(me.shield / (CFG.spawnShield || 1.6), 0, 1);
    V[20] = clamp(me.ammo / mag, 0, 1);
    V[21] = me.reloadT > 0 ? 1 : 0;
    /* Nav lookup is a spiral search; once every 8 sense ticks is plenty,
       a nav cell is 0.85 m across and nobody crosses that in 0.5 s. */
    if (G.nav) {
      if (navAt < 0 || T - navAt > 0.5) {
        navId = G.nav.nearest(me.pos.x, me.pos.y, me.pos.z);
        navAt = T;
      }
      const n = navId >= 0 ? G.nav.nodes[navId] : null;
      V[22] = n ? n.cover : 0;
    }
    V[23] = Math.min(1, threats / 3);
    V[24] = clamp(me.pitch / 1.45, -1, 1);
    V[25] = clamp(me.vel.y / 6, -1, 1);
    const s = Math.sin(me.yaw), c = Math.cos(me.yaw);
    V[26] = clamp((me.vel.x * s + me.vel.z * c) / 8, -1, 1);
    V[27] = clamp((me.vel.x * c - me.vel.z * s) / 8, -1, 1);
    for (let i = 0; i < 6; i++) {
      const ang = me.yaw + PROBE[i];
      const h = raycastMap(me.pos.x, me.pos.y + 0.9, me.pos.z,
                           Math.sin(ang), 0, Math.cos(ang), 8);
      V[28 + i] = h ? 1 - h.dist / 8 : 0;
    }
    const ph = 2 * Math.PI * T / 1.2;
    V[34] = Math.sin(ph);
    V[35] = Math.cos(ph);
    V[36] = 1;
  }

  function forward() {
    for (let i = 0; i < EVAL.length; i++) {
      const n = EVAL[i], inc = INC[n];
      let sum = 0;
      for (let j = 0; j < inc.length; j++) sum += V[inc[j][0]] * inc[j][1];
      V[n] = squash(sum);
    }
    for (let o = 0; o < NO; o++) OUT[o] = V[SLOT.get(NI + o)];
  }

  return {
    /* The shipped driver reads reloadAt through these names and calls
       setParams with the shipped 10-vector; returning null is the
       contract's way of saying "no tunables here". */
    PARAM_NAMES: ['reloadAt'],
    PARAM_BOUNDS: [[0, 0.9]],
    getParams: () => [0.15],
    setParams: () => null,

    reset() {
      T = 0; tick = 0; navId = -1; navAt = -1;
      V.fill(0); OUT.fill(0);
    },

    act(me, G, dt) {
      T += dt;
      if (!me.alive) { V.fill(0); OUT.fill(0); tick = 0; return null; }
      if (tick % DECIM === 0) { sense(me, G); forward(); }
      tick++;

      if (me.ammo === 0) tryReload(me);
      else if (OUT[7] > 0) tryReload(me);

      const yaw = me.yaw + OUT[5] * TURN * dt;
      const pitch = clamp(me.pitch + OUT[6] * TURN * dt, -1.45, 1.45);

      return {
        fwd: clamp(OUT[0], -1, 1),
        strafe: clamp(OUT[1], -1, 1),
        jump: OUT[2] > 0.3,
        sprint: OUT[3] > 0,
        fire: OUT[4] > 0 && me.ammo > 0,
        yaw, pitch
      };
    }
  };
})();
`;
}

module.exports = {
  name: 'neat',
  describe: 'NEAT-evolved network: 37 egocentric inputs, 8 capped-rate outputs',
  policySource: () => buildSource(GENOME),
  buildSource,
  N_IN, N_OUT, TURN_RATE, SENSE_EVERY
};
