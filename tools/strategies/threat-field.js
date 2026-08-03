'use strict';

/* threat-field.js — tactical positioning by a potential field over the nav graph.

   The shipped policy already takes all 25 kills. It loses fitness only to
   deaths, and it has no notion of exposure at all: it closes to a fixed
   engagement range and strafes in the open, fighting one-versus-three exactly
   as it fights one-versus-one. This strategy keeps every tuned aim/fire number
   and replaces only where the body goes.

   No search, no learning, no per-tick planning. Every RECOMPUTE_TICKS ticks it
   runs one bounded Dijkstra over the nav graph from the node under its feet,
   scores a subsample of the reachable nodes with a weighted sum of five terms,
   and walks the graph path to the winner. The reactive layer above it —
   pickTarget, capped turn, fire cone, strafe — is the shipped code verbatim.

   The five terms (see FIELD WEIGHTS below):

     THREAT       for each living enemy with line of sight to the node,
                  a range-decayed danger weight; summed, then raised to
                  threatExp so three watchers cost far more than three
                  times one watcher.
     COVER        the `cover` score buildNav already computed for all 3156
                  nodes and nobody was using.
     OPPORTUNITY  a node you can shoot from is the point. Full credit inside
                  the tuned engageRange (clamped to the weapon's range),
                  falling off beyond it, and divided by how many enemies can
                  see the node — so a 1v1 angle is worth much more than the
                  same angle in a 1v3.
     TRAVEL       Dijkstra cost to get there. Keeps the goal local and stops
                  the bot crossing the map for a marginally better corner.
     PRESSURE     the attractive half: cost per metre the node sits beyond
                  the engagement radius of the current target. Without it
                  the field is all repulsion, the bot settles in an empty
                  covered pocket and the match takes half as long again for
                  the same 25 kills — which is a straight fitness loss.

   Dithering is handled in three explicit places, not by luck:
     1. the field is recomputed at RECOMPUTE_TICKS, not every tick;
     2. a chosen goal is held for commitTime seconds regardless;
     3. after that a rival must beat the *current goal's current score* by
        switchMargin to replace it.
   Only a panicMargin-sized collapse in the held goal's score (three people
   just walked into view of it) breaks the commitment early. */

const SOURCE = String.raw`
const POLICY = (() => {
  /* ------------------------------------------------------------------ *
   * Parameters. The first ten are the shipped names in the shipped
   * order — the driver installs the tuned vector positionally, so that
   * prefix must not move. The field weights are appended after.
   * ------------------------------------------------------------------ */
  const PARAM_NAMES = [
    'engageRange',   // metres: try to sit at about this distance
    'rangeBand',     // metres: dead zone around it
    'fireCone',      // radians: fire once within this of the target
    'turnRate',      // radians/second cap on aim movement
    'strafePeriod',  // seconds for a full left-right cycle
    'strafeAmount',  // 0..1 how hard to strafe while holding a node
    'sprintRange',   // metres: sprint when further than this from the target
    'reloadAt',      // reload when the magazine drops to this fraction
    'aimHeight',     // metres above the target's feet to aim
    'searchTurn',    // radians/second to sweep when nothing is visible
    /* ---- field weights (append-only) ---- */
    'wThreat',       // cost per unit of (summed line-of-sight danger)
    'threatExp',     // >1 makes the threat term superlinear in the watcher count
    'wCover',        // reward per unit of buildNav's precomputed cover score
    'wOpp',          // reward for a node that can shoot, at a good range
    'wTravel',       // cost per metre of Dijkstra path to the node
    'threatDecay',   // metres: e-folding distance of an enemy's danger
    'oppBand',       // metres: width of the "good shooting range" window
    'wPress',        // cost per metre the node is too far from the target
    'switchMargin',  // a rival must beat the held goal by this to take over
    'commitTime',    // seconds a goal is held no matter what
    'hurtBoost',     // extra threat weight at zero health (0 = ignore health)
    'shieldHold'     // seconds of the spawn bubble to spend moving, not shooting
  ];
  const PARAM_BOUNDS = [
    [3, 40], [0.5, 8], [0.005, 0.30], [3, 30], [0.3, 3.0],
    [0, 1], [4, 40], [0, 0.9], [0.8, 2.0], [0.5, 6],
    [0, 40], [1, 3], [0, 20], [0, 30], [0, 3],
    [5, 60], [2, 30], [0, 3], [0, 8], [0, 3], [0, 4], [0, 1.6]
  ];
  const P = {
    /* the shipped tuned vector, so the policy is correct even if nobody
       calls setParams */
    engageRange: 24.030481, rangeBand: 2.256479, fireCone: 0.020000,
    turnRate: 22.140736, strafePeriod: 1.897986, strafeAmount: 0.634428,
    sprintRange: 12.297849, reloadAt: 0.177887, aimHeight: 1.575976,
    searchTurn: 3.160332,
    /* ---- FIELD WEIGHTS ---- */
    wThreat: 9.0, threatExp: 1.75, wCover: 3.0, wOpp: 7.0, wTravel: 0.45,
    threatDecay: 22.0, oppBand: 9.0, wPress: 0.60, switchMargin: 1.5,
    commitTime: 0.55, hurtBoost: 1.0, shieldHold: 0
  };

  /* ---- structural constants: shape of the search, not tuning knobs ---- */
  const RECOMPUTE_TICKS = 5;    // field cadence, ~12 Hz at a 60 Hz tick
  const NODE_BUDGET     = 300;  // Dijkstra expansions per recompute
  const MAX_TRAVEL      = 16;   // metres: hard cap on how far a goal may be
  const SUBSAMPLE       = 2;    // score every SUBSAMPLE'th grid cell per axis
  const ENEMY_CAP       = 6;    // nearest N living enemies enter the field
  const ARRIVE_R        = 1.15; // metres: "standing on the goal"
  const WAYPOINT_R      = 1.00; // metres: steer at the first node further than this
  const PANIC_MARGIN    = 9.0;  // score collapse that breaks commitment early
  const EYE             = 1.62; // ACT.eye — a candidate node's eye height

  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  const clampv = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);

  let t = 0, strafeSign = 1, phase = 0, tick = 0;

  /* ---- nav state, built lazily: G.nav does not exist until startMatch ---- */
  let nav = null, dist = null, parent = null, stamp = null, closed = null, epoch = 0;
  let navTries = 0;
  let heapId = null, heapF = null, heapN = 0;

  /* Line of sight, allocation-free.

     The engine's canSee() is correct and is what the aim/fire path uses, but
     it goes through raycastMap -> rayBox, which builds two three-element
     arrays per box. The field asks for a few hundred of these every recompute
     and 110 solids each, so that is ~100k short-lived arrays a recompute and
     the garbage collector eats the tick. The same slab test over flat typed
     arrays is the single biggest cost saving in this file: ~5x.

     Only the static solids are tested, exactly like canSee. The ground plane
     canSee also checks cannot block an eye-to-eye segment, since both ends are
     above y = 0. */
  let SX0 = null, SY0 = null, SZ0 = null, SX1 = null, SY1 = null, SZ1 = null, NSOL = 0;
  function initSolids() {
    const src = (typeof SOLIDS !== 'undefined' && SOLIDS) ||
                (typeof MAP !== 'undefined' && MAP.solids) || null;
    if (!src || !src.length) return false;
    NSOL = src.length;
    SX0 = new Float64Array(NSOL); SY0 = new Float64Array(NSOL); SZ0 = new Float64Array(NSOL);
    SX1 = new Float64Array(NSOL); SY1 = new Float64Array(NSOL); SZ1 = new Float64Array(NSOL);
    for (let i = 0; i < NSOL; i++) {
      const s = src[i];
      SX0[i] = s.min[0]; SY0[i] = s.min[1]; SZ0[i] = s.min[2];
      SX1[i] = s.max[0]; SY1[i] = s.max[1]; SZ1[i] = s.max[2];
    }
    return true;
  }
  function losClear(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-4) return true;
    /* canSee stops 5 cm short of the target, so a wall the target is flush
       against does not count as blocking. Matched here in segment units. */
    const tEnd = (len - 0.05) / len;
    if (tEnd <= 0) return true;
    const ix = dx !== 0 ? 1 / dx : 0, iy = dy !== 0 ? 1 / dy : 0, iz = dz !== 0 ? 1 / dz : 0;
    for (let k = 0; k < NSOL; k++) {
      let t0 = 0, t1 = tEnd, a, b, tmp;
      if (dx === 0) { if (ax < SX0[k] || ax > SX1[k]) continue; }
      else {
        a = (SX0[k] - ax) * ix; b = (SX1[k] - ax) * ix;
        if (a > b) { tmp = a; a = b; b = tmp; }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        if (t0 > t1) continue;
      }
      if (dy === 0) { if (ay < SY0[k] || ay > SY1[k]) continue; }
      else {
        a = (SY0[k] - ay) * iy; b = (SY1[k] - ay) * iy;
        if (a > b) { tmp = a; a = b; b = tmp; }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        if (t0 > t1) continue;
      }
      if (dz === 0) { if (az < SZ0[k] || az > SZ1[k]) continue; }
      else {
        a = (SZ0[k] - az) * iz; b = (SZ1[k] - az) * iz;
        if (a > b) { tmp = a; a = b; b = tmp; }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        if (t0 > t1) continue;
      }
      return false;
    }
    return true;
  }

  function initNav(G) {
    const n = (G && G.nav) || (typeof AI !== 'undefined' && typeof MAP !== 'undefined'
      ? AI.buildNav(MAP) : null);
    if (!n || !n.nodes || !n.nodes.length) return false;
    if (!initSolids()) return false;
    nav = n;
    const c = nav.nodes.length;
    dist = new Float64Array(c);
    parent = new Int32Array(c);
    stamp = new Int32Array(c);
    closed = new Int32Array(c);
    heapId = new Int32Array(8 * c + 16);
    heapF = new Float64Array(8 * c + 16);
    return true;
  }

  /* ---- binary heap over (nodeId, f) ---- */
  function hPush(id, f) {
    let i = heapN++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapF[p] <= f) break;
      heapId[i] = heapId[p]; heapF[i] = heapF[p]; i = p;
    }
    heapId[i] = id; heapF[i] = f;
  }
  function hPop() {
    const top = heapId[0];
    heapN--;
    if (heapN > 0) {
      const lid = heapId[heapN], lf = heapF[heapN];
      let i = 0;
      for (;;) {
        let c = i * 2 + 1;
        if (c >= heapN) break;
        if (c + 1 < heapN && heapF[c + 1] < heapF[c]) c++;
        if (heapF[c] >= lf) break;
        heapId[i] = heapId[c]; heapF[i] = heapF[c]; i = c;
      }
      heapId[i] = lid; heapF[i] = lf;
    }
    return top;
  }

  /* Bounded Dijkstra from startId. Fills dist/parent for everything it
     reaches and returns the reached ids. The graph is an 8-connected grid of
     walkable cells with explicit drop edges, so a parent chain is a path the
     body can actually walk — no line-of-walk test needed, which is what makes
     this cheap enough to run twelve times a second. */
  const reached = [];
  function explore(startId) {
    epoch++;
    reached.length = 0;
    heapN = 0;
    dist[startId] = 0; parent[startId] = -1; stamp[startId] = epoch;
    hPush(startId, 0);
    let expansions = 0;
    const nodes = nav.nodes;
    while (heapN > 0 && expansions < NODE_BUDGET) {
      /* A node can sit in the heap several times; the stale copies pop after
         the settled one and must not be re-expanded. */
      const cur = hPop();
      if (closed[cur] === epoch) continue;
      closed[cur] = epoch;
      const g = dist[cur];
      if (g > MAX_TRAVEL) continue;
      expansions++;
      reached.push(cur);
      const edges = nodes[cur].edges;
      for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const nd = g + e.cost;
        if (nd > MAX_TRAVEL) continue;
        if (stamp[e.to] === epoch && dist[e.to] <= nd + 1e-9) continue;
        stamp[e.to] = epoch; dist[e.to] = nd; parent[e.to] = cur;
        hPush(e.to, nd);
      }
    }
    return reached;
  }

  /* ------------------------------------------------------------------ *
   * The field itself.
   * ------------------------------------------------------------------ */
  const foes = [];
  function gatherFoes(me, G) {
    foes.length = 0;
    const ranked = [];
    for (const a of G.actors) {
      if (a === me || a.isPlayer || !a.alive) continue;
      const dx = a.pos.x - me.pos.x, dz = a.pos.z - me.pos.z;
      ranked.push([dx * dx + dz * dz, a]);
    }
    ranked.sort((p, q) => p[0] - q[0]);
    for (let i = 0; i < ranked.length && i < ENEMY_CAP; i++) foes.push(ranked[i][1]);
    return foes;
  }

  /* Lower is better. Threat and travel are costs, cover and opportunity are
     rewards; the sum is what the goal choice minimises. */
  let pressX = 0, pressZ = 0, pressOn = false;
  function scoreNode(n, g, idealRange, wRange, threatW) {
    const ey = n.y + EYE;
    let exposure = 0, watchers = 0, opp = 0;
    for (let i = 0; i < foes.length; i++) {
      const e = foes[i];
      if (!losClear(n.x, ey, n.z, e.pos.x, e.pos.y + 1.60, e.pos.z)) continue;
      watchers++;
      const d = Math.hypot(e.pos.x - n.x, e.pos.z - n.z);
      /* THREAT: an enemy that can see you but is 40 m away is not the same
         problem as one at 6 m. */
      exposure += Math.exp(-d / P.threatDecay);
      /* OPPORTUNITY: the best angle available from this node. One-sided on
         purpose. A symmetric bell around engageRange scored a point-blank
         angle at ~0.04 and the field answered by parking in empty cover:
         ticks with nobody in sight went from 36% to 55% and the match got
         half as long again for the same 25 kills. Anything inside the
         effective range is a shot; only being too far to hit costs. Being
         too close is already priced by the threat term, which rises as the
         enemy gets nearer. */
      if (d <= wRange) {
        let v = 1;
        if (d > idealRange) {
          const q = (d - idealRange) / P.oppBand;
          v = Math.exp(-q * q);
        }
        if (v > opp) opp = v;
      }
    }
    let cost = threatW * Math.pow(exposure, P.threatExp)
             - P.wCover * n.cover
             + P.wTravel * g;
    if (watchers > 0) cost -= P.wOpp * opp / watchers;
    /* PRESSURE: the attractive half of the potential. Without it the field is
       purely repulsive and, once out of everyone's sight, every nearby node
       looks alike — so the bot settles into a covered pocket and the match
       drags. Paying per metre beyond the engagement radius gives a gradient
       that flows toward the enemy *through* whatever cover is on the way,
       which is the whole point of doing this on the nav graph. Nothing is
       charged once inside the ring; where to stand in it is the other terms'
       business. */
    if (pressOn) {
      const pd = Math.hypot(pressX - n.x, pressZ - n.z);
      if (pd > idealRange) cost += P.wPress * (pd - idealRange);
    }
    return cost;
  }

  /* ---- commitment state ---- */
  let goalId = -1, goalSince = -1e9, steer = null, holding = false;

  function replan(me, G, target) {
    const startId = nav.nearest(me.pos.x, me.pos.y, me.pos.z);
    if (startId < 0) { goalId = -1; steer = null; return; }
    const list = explore(startId);
    if (!list.length) { goalId = -1; steer = null; return; }

    gatherFoes(me, G);
    const w = WBY[me.weapon] || WBY.smg;
    const wRange = (w && w.range) || 90;
    const idealRange = Math.min(P.engageRange, wRange * 0.9);
    const hp = clampv((me.health || 0) / (me.maxHealth || 100), 0, 1);
    const threatW = P.wThreat * (1 + P.hurtBoost * (1 - hp));
    pressOn = !!target;
    if (target) { pressX = target.pos.x; pressZ = target.pos.z; }

    const nodes = nav.nodes;
    let bestId = -1, bestScore = Infinity;
    for (let i = 0; i < list.length; i++) {
      const id = list[i], n = nodes[id];
      /* Score a quarter of the reachable set. The field is smooth at the
         0.85 m cell size, so a stride of two loses nothing and buys back
         four times the line-of-sight budget. */
      if (id !== startId && id !== goalId &&
          ((n.gx % SUBSAMPLE) || (n.gz % SUBSAMPLE))) continue;
      const s = scoreNode(n, dist[id], idealRange, wRange, threatW);
      if (s < bestScore) { bestScore = s; bestId = id; }
    }
    if (bestId < 0) return;

    /* COMMITMENT. The held goal is re-scored under the enemies' *current*
       positions, so "still good" is a live judgement, not a memory. */
    let held = Infinity;
    if (goalId >= 0 && stamp[goalId] === epoch) {
      held = scoreNode(nodes[goalId], dist[goalId], idealRange, wRange, threatW);
    }
    const committed = (t - goalSince) < P.commitTime;
    const collapsed = held - bestScore > PANIC_MARGIN;
    if (goalId < 0 || held === Infinity || collapsed ||
        (!committed && bestScore < held - P.switchMargin)) {
      if (bestId !== goalId) { goalId = bestId; goalSince = t; }
    }
    if (goalId < 0 || stamp[goalId] !== epoch) { steer = null; return; }

    /* Walk the parent chain back from the goal and steer at the first node
       further than WAYPOINT_R away. */
    let cursor = goalId, prev = goalId, guard = NODE_BUDGET + 4;
    const gn = nodes[goalId];
    const goalD = Math.hypot(gn.x - me.pos.x, gn.z - me.pos.z);
    holding = goalD <= ARRIVE_R;
    while (cursor >= 0 && guard-- > 0) {
      const n = nodes[cursor];
      if (Math.hypot(n.x - me.pos.x, n.z - me.pos.z) < WAYPOINT_R) break;
      prev = cursor;
      cursor = parent[cursor];
    }
    steer = nodes[prev];
  }

  /* Nearest living enemy with line of sight; falls back to nearest living
     enemy at all. Shipped verbatim — target choice is not what this changes. */
  function pickTarget(me, G) {
    let best = null, bestD = Infinity, seen = null, seenD = Infinity;
    for (const a of G.actors) {
      if (a === me || a.isPlayer || !a.alive) continue;
      const dx = a.pos.x - me.pos.x, dz = a.pos.z - me.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < bestD) { bestD = d; best = a; }
      if (d < seenD && canSee(me.pos.x, actorEye(me), me.pos.z,
                              a.pos.x, actorEye(a), a.pos.z)) {
        seenD = d; seen = a;
      }
    }
    return { target: seen || best, dist: seen ? seenD : bestD, visible: !!seen };
  }

  return {
    PARAM_NAMES, PARAM_BOUNDS,
    getParams: () => PARAM_NAMES.map(n => P[n]),
    /* Accepts a prefix. The shipped driver installs a ten-long vector and must
       not be made to fail just because this policy grew ten more knobs; a
       sweep passes the full vector and gets everything. */
    setParams: v => {
      if (!v || !v.length) return null;
      const k = Math.min(v.length, PARAM_NAMES.length);
      for (let i = 0; i < k; i++) P[PARAM_NAMES[i]] = v[i];
      return PARAM_NAMES.map(n => P[n]);
    },

    reset() {
      t = 0; phase = 0; strafeSign = 1; tick = 0;
      goalId = -1; goalSince = -1e9; steer = null; holding = false;
      navTries = 0;
    },

    act(me, G, dt) {
      t += dt;
      if (!me.alive) { goalId = -1; steer = null; return null; }
      /* G.nav does not exist until startMatch, so the graph is picked up on
         the first tick. Bounded retries: if it is never going to arrive, do
         not pay AI.buildNav sixty times a second forever — fall through to
         the shipped body instead. */
      if (!nav && navTries < 8) { navTries++; initNav(G); }

      const { target, dist: tdist, visible } = pickTarget(me, G);
      if (!target) return { yaw: me.yaw + P.searchTurn * dt };

      /* ---- AIM: shipped, untouched. The engine builds its shot direction as
         (sin(yaw)cos(pitch), sin(pitch), cos(yaw)cos(pitch)), so yaw is
         atan2(dx, dz). ---- */
      const dx = target.pos.x - me.pos.x;
      const dz = target.pos.z - me.pos.z;
      const dy = (target.pos.y + P.aimHeight) - actorEye(me);
      const wantYaw = Math.atan2(dx, dz);
      const wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
      const maxTurn = P.turnRate * dt;
      const dYaw = wrap(wantYaw - me.yaw);
      const yaw = me.yaw + clampv(dYaw, -maxTurn, maxTurn);
      const dPitch = wantPitch - me.pitch;
      const pitch = me.pitch + clampv(dPitch, -maxTurn, maxTurn);

      /* ---- THE FIELD decides where the body goes ---- */
      if (nav && (tick++ % RECOMPUTE_TICKS) === 0) {
        try { replan(me, G, target); } catch (e) { steer = null; }
      }

      phase += dt / Math.max(0.05, P.strafePeriod);
      if (phase >= 1) { phase = 0; strafeSign = -strafeSign; }

      let fwd = 0, strafe = 0;
      if (nav && steer && !holding) {
        /* Decompose the world-space step into the yaw frame the engine
           moves in: forward = (sin y, cos y), right = (-cos y, sin y). The
           driver reduces fwd/strafe to key presses, so this quantises to the
           nearest of the eight directions a keyboard can express. */
        const sx = steer.x - me.pos.x, sz = steer.z - me.pos.z;
        const len = Math.hypot(sx, sz) || 1;
        const ux = sx / len, uz = sz / len;
        const sy = Math.sin(me.yaw), cy = Math.cos(me.yaw);
        const f = ux * sy + uz * cy;
        const r = -ux * cy + uz * sy;
        if (f > 0.383) fwd = 1; else if (f < -0.383) fwd = -1;
        if (r > 0.383) strafe = 1; else if (r < -0.383) strafe = -1;
        if (!fwd && !strafe) fwd = f >= 0 ? 1 : -1;
      } else if (nav) {
        /* Standing on the chosen node: strafe rather than stand still, and
           let the next recompute pull the drift back. Most damage is taken
           by a stationary silhouette. */
        strafe = visible ? strafeSign * P.strafeAmount : 0;
      } else {
        /* No nav graph — fall back to the shipped range-keeping body. */
        if (tdist > P.engageRange + P.rangeBand) fwd = 1;
        else if (tdist < P.engageRange - P.rangeBand) fwd = -1;
        strafe = visible ? strafeSign * P.strafeAmount : 0;
      }

      const onTarget = Math.abs(dYaw) < P.fireCone && Math.abs(dPitch) < P.fireCone;
      const hasAmmo = me.ammo > 0;
      /* The spawn bubble is 1.6 s of total immunity that pops the instant you
         pull the trigger. Three of the shipped policy's ten deaths over seeds
         1-10 land inside 0.7 s of a respawn, at full health, from 12 m — it
         spawns, sees somebody, shoots, drops its own bubble and gets
         head-shot. shieldHold spends the first shieldHold seconds of the
         bubble walking the field instead of shooting. Default 0 keeps the
         shipped behaviour; the value is swept, not assumed. */
      const bubble = (typeof CFG !== 'undefined' && CFG.spawnShield) || 1.6;
      const shielded = P.shieldHold > 0 && (me.shield || 0) > bubble - P.shieldHold;
      const mag = (WBY[me.weapon] && WBY[me.weapon].mag) || 30;
      if (!hasAmmo || me.ammo / mag <= P.reloadAt) tryReload(me);

      return {
        fwd, strafe,
        sprint: tdist > P.sprintRange && !visible && fwd > 0,
        fire: visible && onTarget && hasAmmo && !shielded,
        yaw, pitch
      };
    }
  };
})();
`;

module.exports = {
  name: 'threatfld',
  describe: 'nav-graph potential field: threat, cover, opportunity, pressure, travel',
  policySource: () => SOURCE
};
