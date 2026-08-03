'use strict';

/* =====================================================================
   mcgs.js — Monte-Carlo GRAPH search as a macro-level planner.

   Faithful to KataGo's docs/GraphSearch.md in the three things that
   document is actually about:

     1. a hash table from state to node, so transposing paths share a node
        and share their statistics;
     2. edge visits N(n,a) stored on the EDGE and decoupled from the child
        node's own visit count N(child) -- PUCT selects on edge visits;
     3. the backup

              N(n) = 1 + sum_a N(n,a)
              Q(n) = ( U(n) + sum_a A(n,a) * N(n,a) ) / N(n)

        where A(n,a) is this edge's action value. KataGo has no per-edge
        reward so its A(n,a) is just child.Q; here every macro-action takes
        real time and books real damage, so
              A(n,a) = r(n,a) + gamma^dt(n,a) * child.Q
        which is the same formula with the rewards written in.

   WHAT IS NOT KataGo: there is no policy network and no value network.
   P(n,a) is a softmax over the heuristic one-step reward and U(n) is a
   hand-written state evaluation. That is where KataGo's strength lives, so
   this is a search with the strong part removed -- see the report.

   ---------------------------------------------------------------------
   THE ABSTRACTION

   A literal port over raw game state cannot work: positions are continuous
   floats so the transposition table never hits twice, and there is no way
   to clone the world for a rollout. So the search runs over an abstract
   state:

        (region, living-enemy bitmask, health bucket, ammo bucket)

   `region` is a connected component of the 3156-node nav graph inside a 7m
   coarse cell -- about 90 of them, mean degree ~4.3. Discrete, hashable,
   and genuinely transposition-rich: "north window, four enemies left, half
   health" is reached by many different routes and every one of them wants
   the same answer.

   ---------------------------------------------------------------------
   CYCLES

   A nav graph is nothing but cycles, and GraphSearch.md says explicitly
   that cycle handling is game-specific. Two mechanisms, both needed:

     * TIME DISCOUNTING. Every edge carries a duration dt (travel time from
       nav edge costs plus a dwell) and multiplies the child value by
       exp(-dt/tau). That makes this a discounted MDP, whose value function
       is uniquely defined on a cyclic graph -- so sharing a node between
       paths of different depth is sound, which a plain undiscounted
       finite-horizon value would not be.
     * CUT, DO NOT BAN. The search keeps the set of abstract keys on the
       current descent path. An edge back into that set is still SELECTABLE
       -- it is scored r + gamma^dt * Q(child) using the shared node's
       current value -- but the descent stops there instead of recursing.
       Banning such edges was tried first and is simply wrong: "stand where
       you are and fight" maps the abstract state to itself, so it is a
       self-loop, and banning self-loops bans the most important action in
       the game. (That bug showed up as the planner refusing to hold ground:
       an ablation that should have reproduced the shipped policy exactly
       diverged after seven seconds.)

     A depth cap (maxDepth) is kept as well, purely as a budget guard.

   ---------------------------------------------------------------------
   ARCHITECTURE

   Hierarchical. The planner runs at ~7 Hz and returns a GOAL: a nav node
   plus a stance in {engage, reposition, break}. The controller underneath
   is the shipped reactive policy with its tuned vector -- same target
   pick, same capped turn, same fire cone, same strafe, same reload -- and
   only its MOVEMENT direction is taken from the goal. When the planner says
   "engage" the controller is bit-for-bit the shipped policy.
   ===================================================================== */

function POLICY_BODY() {
  /* ---- parameters ---------------------------------------------------
     The first ten are the shipped policy's, same names, same order, so the
     driver's tuned vector installs and the tuned aim is preserved. The
     planner's knobs are appended; setParams accepts a short vector and
     assigns positionally, so the shipped 10-vector still lands. */
  const PARAM_NAMES = [
    'engageRange', 'rangeBand', 'fireCone', 'turnRate', 'strafePeriod',
    'strafeAmount', 'sprintRange', 'reloadAt', 'aimHeight', 'searchTurn',
    /* planner */
    'sims',        // simulations per replan
    'maxDepth',    // macro-actions deep
    'cPuct',       // PUCT exploration constant
    'tau',         // seconds; discount is exp(-dt/tau)
    'dwell',       // seconds a macro-action spends in its target region
    'killW',       // reward for a kill
    'dmgW',        // reward per 100 damage taken
    'deathW',      // reward for dying
    'riskW',       // leaf value: weight on incoming dps
    'oppW',        // leaf value: weight on having someone to shoot
    'hpW',         // leaf value: weight on remaining health
    'priorBeta',   // softmax temperature on the one-step reward prior
    'planHz',      // replans per second
    'commitS',     // seconds a goal is held before it may change
    'fleeHp',      // below this health a move is a break, not a reposition
    'coverMul',    // exposure multiplier for the cover stance
    'botDpsK',     // scales the modelled bot damage output
    'ourDpsK',     // scales the modelled player damage output
    'stayBias',    // reward added to "stand and fight"; large = never replan
    'breakLook',   // 1 = turn and run when breaking, 0 = keep facing the enemy
    'moveStrafe'   // strafe oscillation kept on top of a repositioning walk
  ];
  const PARAM_BOUNDS = [
    [3, 40], [0.5, 8], [0.005, 0.30], [3, 30], [0.3, 3.0],
    [0, 1], [4, 40], [0, 0.9], [0.8, 2.0], [0.5, 6],
    [16, 512], [2, 8], [0.5, 4], [1, 10], [0.3, 2.5],
    [0.2, 3], [0.2, 4], [1, 20], [0, 2], [0, 1.5], [0, 1.5],
    [0.2, 6], [3, 20], [0.2, 3], [0, 90], [0.1, 1],
    [0.3, 2.5], [0.3, 2.5], [0, 4], [0, 1], [0, 1]
  ];
  const P = {
    engageRange: 14, rangeBand: 3, fireCone: 0.05, turnRate: 12,
    strafePeriod: 1.1, strafeAmount: 0.8, sprintRange: 18,
    reloadAt: 0.0, aimHeight: 1.5, searchTurn: 2.0,
    sims: 128, maxDepth: 5, cPuct: 1.4, tau: 3.5, dwell: 1.4,
    killW: 1.0, dmgW: 1.0, deathW: 6.0, riskW: 0.5, oppW: 0.25, hpW: 0.4,
    priorBeta: 1.6, planHz: 7, commitS: 0.7, fleeHp: 45, coverMul: 0.35,
    botDpsK: 1.0, ourDpsK: 1.0, stayBias: 0.5, breakLook: 0, moveStrafe: 0.7
  };

  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
  const clamp = (v, lo, hi) => v < lo ? lo : (v > hi ? hi : v);

  /* =================================================================
     THE ABSTRACTION: nav regions
     ================================================================= */
  const CELL = 7.0;          // metres, coarse cell before connectivity split
  const MIN_REGION = 6;      // nodes; smaller components get merged away
  const MAXE = 8;            // enemies tracked in the bitmask

  let NAVREF = null, RG = null;

  function buildRegions(nav) {
    const nodes = nav.nodes, N = nodes.length;
    const bx = nav.bounds.minX, bz = nav.bounds.minZ;
    const cellOf = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      const n = nodes[i];
      cellOf[i] = n.level * 1000000 +
        (((n.x - bx) / CELL) | 0) * 1000 + (((n.z - bz) / CELL) | 0);
    }
    const reg = new Int32Array(N).fill(-1);
    let R = 0;
    const members = [];
    const stack = [];
    for (let i = 0; i < N; i++) {
      if (reg[i] >= 0) continue;
      const c = cellOf[i], r = R++;
      const mem = [];
      reg[i] = r; stack.length = 0; stack.push(i);
      while (stack.length) {
        const u = stack.pop();
        mem.push(u);
        const ed = nodes[u].edges;
        for (let k = 0; k < ed.length; k++) {
          const v = ed[k].to;
          if (reg[v] >= 0 || cellOf[v] !== c) continue;
          reg[v] = r; stack.push(v);
        }
      }
      members.push(mem);
    }

    /* A three-node sliver is not a place; fold it into whichever neighbour
       it is most strongly attached to, smallest first. */
    const order = [];
    for (let r = 0; r < R; r++) order.push(r);
    order.sort((a, b) => members[a].length - members[b].length);
    for (const r of order) {
      if (members[r].length === 0 || members[r].length >= MIN_REGION) continue;
      const cnt = new Map();
      for (const u of members[r]) {
        const ed = nodes[u].edges;
        for (let k = 0; k < ed.length; k++) {
          const v = reg[ed[k].to];
          if (v !== r) cnt.set(v, (cnt.get(v) || 0) + 1);
        }
      }
      let best = -1, bc = 0;
      cnt.forEach((c, v) => { if (c > bc) { bc = c; best = v; } });
      if (best < 0) continue;
      for (const u of members[r]) { reg[u] = best; members[best].push(u); }
      members[r] = [];
    }

    /* compact */
    const remap = new Int32Array(R).fill(-1);
    const keep = [];
    for (let r = 0; r < R; r++) if (members[r].length) { remap[r] = keep.length; keep.push(members[r]); }
    for (let i = 0; i < N; i++) reg[i] = remap[reg[i]];
    const RC = keep.length;

    const repNode = new Int32Array(RC);
    const rx = new Float64Array(RC), ry = new Float64Array(RC), rz = new Float64Array(RC);
    const rcover = new Float32Array(RC), rlevel = new Int32Array(RC);
    for (let r = 0; r < RC; r++) {
      const mem = keep[r];
      let cx = 0, cz = 0;
      for (const u of mem) { cx += nodes[u].x; cz += nodes[u].z; }
      cx /= mem.length; cz /= mem.length;
      /* the region's "best spot": most cover, ties broken toward the middle */
      let best = mem[0], bs = -1e9;
      for (const u of mem) {
        const n = nodes[u];
        const s = n.cover * 10 - Math.hypot(n.x - cx, n.z - cz) * 0.05;
        if (s > bs) { bs = s; best = u; }
      }
      repNode[r] = best;
      rx[r] = nodes[best].x; ry[r] = nodes[best].y; rz[r] = nodes[best].z;
      rcover[r] = nodes[best].cover; rlevel[r] = nodes[best].level;
    }

    /* adjacency, flattened */
    const sets = [];
    for (let r = 0; r < RC; r++) sets.push(new Set());
    for (let i = 0; i < N; i++) {
      const a = reg[i], ed = nodes[i].edges;
      for (let k = 0; k < ed.length; k++) {
        const b = reg[ed[k].to];
        if (b !== a) sets[a].add(b);
      }
    }
    const start = new Int32Array(RC + 1);
    let tot = 0;
    for (let r = 0; r < RC; r++) { start[r] = tot; tot += sets[r].size; }
    start[RC] = tot;
    const to = new Int32Array(tot), cost = new Float32Array(tot);
    let w = 0;
    for (let r = 0; r < RC; r++) {
      for (const b of sets[r]) {
        to[w] = b;
        /* straight line between the two best spots, plus a detour factor,
           plus a fixed toll for changing floors (stairs are not free). */
        cost[w] = Math.hypot(rx[r] - rx[b], rz[r] - rz[b]) * 1.2 +
          (rlevel[r] !== rlevel[b] ? 3.0 : 0);
        w++;
      }
    }
    return {
      R: RC, reg, repNode, rx, ry, rz, rcover, rlevel,
      adjStart: start, adjTo: to, adjCost: cost, members: keep
    };
  }

  /* ---- region-to-region visibility ----------------------------------
     canSee() is a ray against every solid on the map and costs ~42 us --
     forty times a nav.nearest. Asking it per (region, enemy) inside the
     search cost 4-5 ms a replan, which is not a browser budget.

     But visibility between two REGIONS does not change: the map is static.
     So it is a matrix, computed once. It is built a row at a time, on the
     first search that touches a region, so the cost arrives as ~90 rays
     (~3.8 ms) spread over the first minute of a match instead of a 170 ms
     stall at startup. After that the whole forward model is arithmetic:
     zero raycasts per replan. */
  let VIS = null, VISROW = null, VISRAYS = 0;

  function visOf(a, b) {
    if (!VISROW[a]) {
      const R = RG.R, ax = RG.rx[a], ay = RG.ry[a] + 1.6, az = RG.rz[a];
      for (let c = 0; c < R; c++) {
        const v = (a === c) ? 1
          : (canSee(ax, ay, az, RG.rx[c], RG.ry[c] + 1.6, RG.rz[c]) ? 1 : 0);
        VIS[a * R + c] = v; VIS[c * R + a] = v;      // symmetric
        VISRAYS++;
      }
      VISROW[a] = 1;
    }
    return VIS[a * RG.R + b];
  }

  function ensureNav(G) {
    const nav = G.nav || (typeof AI !== 'undefined' && typeof MAP !== 'undefined'
      ? AI.buildNav(MAP) : null);
    if (!nav) return null;
    if (NAVREF !== nav) {
      NAVREF = nav;
      RG = buildRegions(nav);
      VIS = new Uint8Array(RG.R * RG.R);
      VISROW = new Uint8Array(RG.R);
    }
    return nav;
  }

  /* =================================================================
     THE FORWARD MODEL
     Cheap, and honest about being cheap: enemies are frozen where they
     stand at replan time, and everything below is arithmetic over
     precomputed per-region tables.
     ================================================================= */

  /* per-replan situation */
  const S = {
    n: 0, ax: [], az: [], ay: [], dps: [], react: [], hp: [],
    stamp: 0, seen: null, losMask: null, dist: null, hpNow: 100, aliveMask: 0
  };

  function weaponDps(id) {
    const w = (typeof WBY !== 'undefined' && WBY[id]) || null;
    if (!w) return 100;
    return w.dmg * (w.pellets || 1) * (w.rpm / 60);
  }

  const SKILL = {
    easy:   { react: 0.62, err: 0.145, duty: 0.29 / (0.29 + 0.51) },
    normal: { react: 0.34, err: 0.080, duty: 0.51 / (0.51 + 0.30) },
    hard:   { react: 0.15, err: 0.038, duty: 0.77 / (0.77 + 0.16) }
  };

  function snapshot(me, G) {
    S.n = 0; S.aliveMask = 0;
    const list = [];
    for (const a of G.actors) {
      if (a === me || a.isPlayer || !a.alive) continue;
      list.push(a);
    }
    /* eight bits is the budget; if a mode ever fields more, keep the near ones */
    if (list.length > MAXE) {
      list.sort((p, q) => (Math.hypot(p.pos.x - me.pos.x, p.pos.z - me.pos.z) -
                           Math.hypot(q.pos.x - me.pos.x, q.pos.z - me.pos.z)));
      list.length = MAXE;
    }
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const sk = SKILL[a.skill] || SKILL.normal;
      S.ax[i] = a.pos.x; S.ay[i] = a.pos.y; S.az[i] = a.pos.z;
      S.dps[i] = weaponDps(a.weapon) * sk.duty * P.botDpsK;
      S.react[i] = sk.react;
      S.hp[i] = Math.max(1, a.health || 100);
      S.errK[i] = sk.err;
      /* an enemy is placed in the abstraction the same way we are: by the
         region it stands in. Eight nav.nearest calls a replan, ~3.5 us each. */
      const nid = NAVREF.nearest(a.pos.x, a.pos.y, a.pos.z);
      S.ereg[i] = nid >= 0 ? RG.reg[nid] : 0;
      S.aliveMask |= (1 << i);
    }
    S.n = list.length;
    S.hpNow = Math.max(0, me.health || 0);
    /* lazily-filled per-region line-of-sight tables */
    S.stamp++;
    if (!S.seen || S.seen.length !== RG.R) {
      S.seen = new Int32Array(RG.R);
      S.losMask = new Int32Array(RG.R);
      S.dpsTab = new Float32Array(RG.R * MAXE);
      S.dstTab = new Float32Array(RG.R * MAXE);
    }
  }
  S.errK = []; S.ereg = [];
  S.dpsTab = null; S.dstTab = null;

  /* Does enemy i hold a sightline onto region r, and if so how hard does it
     hurt? A matrix lookup plus a distance, memoised per region for the life
     of the replan. */
  function losOf(r) {
    if (S.seen[r] === S.stamp) return S.losMask[r];
    S.seen[r] = S.stamp;
    let mask = 0;
    const ex = RG.rx[r], ez = RG.rz[r];
    const base = r * MAXE;
    for (let i = 0; i < S.n; i++) {
      const d = Math.hypot(S.ax[i] - ex, S.az[i] - ez);
      S.dstTab[base + i] = d;
      let dps = 0;
      if (d < 60 && visOf(r, S.ereg[i])) {
        mask |= (1 << i);
        /* aim error opens a cone that grows with range; a 0.45m target in it */
        dps = S.dps[i] * clamp(0.45 / (0.45 + S.errK[i] * d), 0.05, 0.9);
      }
      S.dpsTab[base + i] = dps;
    }
    S.losMask[r] = mask;
    return mask;
  }

  /* incoming damage per second at region r against the living set `mask` */
  function threatAt(r, mask) {
    const los = losOf(r) & mask;
    if (!los) return 0;
    const base = r * MAXE;
    let s = 0;
    for (let i = 0; i < S.n; i++) if (los & (1 << i)) s += S.dpsTab[base + i];
    return s;
  }
  /* damage over an exposure window; `fresh` means the sightline is new, so
     the bots have to re-acquire first -- reaction time is the single
     biggest reason a short exposure is nearly free and a long one kills */
  function damageOver(r, mask, T, fresh) {
    const los = losOf(r) & mask;
    if (!los || T <= 0) return 0;
    const base = r * MAXE;
    let s = 0;
    for (let i = 0; i < S.n; i++) {
      if (!(los & (1 << i))) continue;
      const t = fresh ? T - S.react[i] : T;
      if (t > 0) s += S.dpsTab[base + i] * t;
    }
    return s;
  }
  /* the enemy we would shoot from region r, and how fast */
  const OUR = { idx: -1, dps: 0 };
  function ourShot(r, mask) {
    const los = losOf(r) & mask;
    OUR.idx = -1; OUR.dps = 0;
    if (!los) return false;
    const base = r * MAXE;
    let bd = Infinity, bi = -1;
    for (let i = 0; i < S.n; i++) {
      if (!(los & (1 << i))) continue;
      const d = S.dstTab[base + i];
      if (d < bd) { bd = d; bi = i; }
    }
    if (bi < 0) return false;
    OUR.idx = bi;
    OUR.dps = OUR_RAW * clamp(0.95 - bd / 70, 0.25, 0.85) * P.ourDpsK;
    return true;
  }
  let OUR_RAW = 180;

  /* =================================================================
     THE GRAPH
     ================================================================= */
  const HPB = 6, AMMOB = 3;
  const table = new Map();

  function keyOf(r, mask, hp, ammo) {
    const h = clamp((hp / 100 * HPB) | 0, 0, HPB - 1);
    return ((r * 256 + mask) * HPB + h) * AMMOB + ammo;
  }

  /* U(n): the leaf value. No network -- this is the substitute, and it is
     the weakest part of the whole thing. */
  function evalState(r, mask, hp, ammo) {
    if (hp <= 0) return -P.deathW;
    const t = threatAt(r, mask);
    const opp = (losOf(r) & mask) ? 1 : 0;
    return -P.riskW * (t / 100) * (2 - hp / 100)
      + P.hpW * (hp / 100)
      + P.oppW * opp
      - (ammo === 0 ? 0.2 : 0);
  }

  function getNode(key, r, mask, hp, ammo) {
    let n = table.get(key);
    if (n) return n;
    n = {
      key, r, mask, hp, ammo,
      U: evalState(r, mask, hp, ammo),
      Q: 0, N: 0, acts: null, edgeN: 0
    };
    n.Q = n.U;
    table.set(key, n);
    return n;
  }

  /* One macro-action: walk to region `toR` (possibly the one we are in) and
     spend `dwell` seconds there, either fighting or sitting in the cover. */
  function makeAct(node, toR, cover) {
    const r = node.r;
    const move = toR !== r;
    let tMove = 0;
    if (move) {
      const s = RG.adjStart[r], e = RG.adjStart[r + 1];
      let c = Math.hypot(RG.rx[r] - RG.rx[toR], RG.rz[r] - RG.rz[toR]) * 1.2;
      for (let k = s; k < e; k++) if (RG.adjTo[k] === toR) { c = RG.adjCost[k]; break; }
      tMove = c / 5.9;
    }
    const tDwell = P.dwell;
    const T = tMove + tDwell;

    /* damage taken: half the transit under the old sightlines, half under
       the new, then the dwell. Moving buys the enemies' reaction time back;
       standing still does not. */
    let dmg = 0;
    if (move) {
      dmg += damageOver(r, node.mask, tMove * 0.5, false);
      dmg += damageOver(toR, node.mask, tMove * 0.5, true);
      dmg += damageOver(toR, node.mask, tDwell, true) * (cover ? P.coverMul : 1);
    } else {
      dmg += damageOver(r, node.mask, T, false) * (cover ? P.coverMul : 1);
    }

    /* damage dealt */
    let kills = 0, progress = 0, mask = node.mask;
    let ammo = node.ammo;
    if (!cover && ourShot(toR, node.mask)) {
      const need = S.hp[OUR.idx];
      const dealt = OUR.dps * Math.max(0, tDwell - 0.15);
      progress = clamp(dealt / need, 0, 1);
      if (progress >= 1) { kills = 1; mask = node.mask & ~(1 << OUR.idx); }
      /* rounds are not the binding constraint here, but the abstraction
         carries ammo, so spend it and pay for the reload when it runs out */
      ammo = ammo - (dealt > 0 ? 1 : 0);
      if (ammo < 0) { ammo = AMMOB - 1; dmg += damageOver(toR, mask, 1.55, false); }
    }

    const hp = node.hp - dmg;
    const dead = hp <= 0;
    const reward = P.killW * (kills ? 1 : progress * 0.35)
      - P.dmgW * (dmg / 100)
      - (dead ? P.deathW : 0);

    return {
      toR, cover, T, dead,
      r: reward,
      disc: Math.exp(-T / P.tau),
      sKey: dead ? -1 : keyOf(toR, mask, hp, ammo),
      sMask: mask, sHp: hp, sAmmo: ammo,
      P: 0, n: 0, A: 0, child: null
    };
  }

  function expand(node) {
    const acts = [];
    const stand = makeAct(node, node.r, false);   // stand and fight
    stand.r += P.stayBias;                        // ablation / commitment knob
    acts.push(stand);
    acts.push(makeAct(node, node.r, true));    // sit in the cover, hold fire
    const s = RG.adjStart[node.r], e = RG.adjStart[node.r + 1];
    for (let k = s; k < e; k++) acts.push(makeAct(node, RG.adjTo[k], false));

    /* P(n,a): no policy network, so a softmax over the one-step reward.
       It is a greedy prior -- it knows nothing the search does not
       immediately rediscover, which is exactly what a real prior would
       add and this one cannot. */
    let m = -Infinity;
    for (const a of acts) { a.A = a.r; if (a.r > m) m = a.r; }
    let z = 0;
    for (const a of acts) { a.P = Math.exp(P.priorBeta * (a.r - m)); z += a.P; }
    for (const a of acts) a.P /= z;
    node.acts = acts;
  }

  function backup(node) {
    let sum = 0, en = 0;
    const acts = node.acts;
    for (let i = 0; i < acts.length; i++) {
      if (acts[i].n > 0) { sum += acts[i].A * acts[i].n; en += acts[i].n; }
    }
    node.edgeN = en;
    node.N = 1 + en;
    node.Q = (node.U + sum) / node.N;
  }

  /* PUCT on EDGE visits, exactly the formula in GraphSearch.md. The child
     node may carry far more visits than this edge does -- that is the whole
     point of the graph -- and the exploration term must not see them. */
  function select(node) {
    const acts = node.acts;
    const sq = Math.sqrt(node.edgeN + 1e-9);
    const fpu = node.Q - 0.25;
    let best = null, bs = -Infinity;
    for (let i = 0; i < acts.length; i++) {
      const a = acts[i];
      const q = a.n > 0 ? a.A : (a.r + a.disc * fpu);
      const u = P.cPuct * a.P * sq / (1 + a.n);
      const s = q + u;
      if (s > bs) { bs = s; best = a; }
    }
    return best;
  }

  function simulate(node, depth, path) {
    if (depth >= P.maxDepth) return node.Q;
    if (!node.acts) { expand(node); backup(node); return node.Q; }
    const a = select(node);
    if (!a) return node.Q;
    if (a.dead) {                       // terminal: the reward is the whole value
      a.n++; a.A = a.r;
      backup(node);
      return node.Q;
    }
    let child = a.child;
    if (!child) child = a.child = getNode(a.sKey, a.toR, a.sMask, a.sHp, a.sAmmo);
    /* CYCLE. The successor is already on this descent path -- most often it
       IS this node, because "stand where you are and fight" maps the abstract
       state to itself. Banning the edge was the first thing tried and it is
       wrong: it bans the single most important action in the game. Instead
       take the edge but do not descend, and value it with the shared node's
       current Q. That terminates, it keeps every action available, and under
       the time discount r + gamma*Q(n) is exactly the one-step backup of the
       fixed point that repeating the action converges to. */
    if (path.has(a.sKey)) {
      a.n++;
      a.A = a.r + a.disc * child.Q;
      backup(node);
      return node.Q;
    }
    path.add(a.sKey);
    simulate(child, depth + 1, path);
    path.delete(a.sKey);
    a.n++;
    a.A = a.r + a.disc * child.Q;      // child.Q is the graph's shared value
    backup(node);
    return node.Q;
  }

  /* =================================================================
     THE PLANNER
     ================================================================= */
  const GOAL = { node: -1, region: -1, stance: 'engage', at: -1 };
  const PATHSET = new Set();
  let STATS = { plans: 0, nodes: 0, sims: 0, engage: 0, reposition: 0, brk: 0, paths: 0, rays: 0 };

  function runPlan(me, G) {
    const nav = ensureNav(G);
    if (!nav || !RG || RG.R === 0) return null;
    snapshot(me, G);
    if (S.n === 0) return null;

    const curNode = nav.nearest(me.pos.x, me.pos.y, me.pos.z);
    const r0 = curNode >= 0 ? RG.reg[curNode] : 0;
    if (r0 < 0) return null;

    const mag = (typeof WBY !== 'undefined' && WBY[me.weapon] && WBY[me.weapon].mag) || 30;
    OUR_RAW = weaponDps(me.weapon);
    const ammo0 = clamp(((me.ammo / mag) * AMMOB) | 0, 0, AMMOB - 1);

    table.clear();
    const root = getNode(keyOf(r0, S.aliveMask, S.hpNow, ammo0),
      r0, S.aliveMask, S.hpNow, ammo0);

    const sims = P.sims | 0;
    for (let i = 0; i < sims; i++) {
      PATHSET.clear();
      PATHSET.add(root.key);
      simulate(root, 0, PATHSET);
    }
    STATS.plans++; STATS.sims += sims; STATS.nodes += table.size; STATS.rays = VISRAYS;

    /* the move is the most-visited EDGE out of the root */
    let best = null;
    for (const a of root.acts) {
      if (!best || a.n > best.n || (a.n === best.n && a.A > best.A)) best = a;
    }
    if (!best) return null;

    let stance;
    if (best.toR === r0 && !best.cover) stance = 'engage';
    else if (best.cover || S.hpNow < P.fleeHp) stance = 'break';
    else stance = 'reposition';
    STATS[stance === 'engage' ? 'engage' : (stance === 'break' ? 'brk' : 'reposition')]++;

    return { region: best.toR, node: RG.repNode[best.toR], stance };
  }

  /* =================================================================
     THE CONTROLLER -- the shipped reactive policy, movement excepted
     ================================================================= */
  let t = 0, strafeSign = 1, phase = 0, planT = 0, commitT = 0;
  let path = null, pathI = 0, pathGoal = -1, pathT = 0;

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

  /* world direction -> (fwd, strafe) in the body frame. The engine builds
     movement as  mx = sin(y)*fwd - cos(y)*str,  mz = cos(y)*fwd + sin(y)*str,
     an orthonormal frame, so the inverse is its transpose. */
  function bodyFrame(yaw, dx, dz) {
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    return { fwd: sy * dx + cy * dz, strafe: -cy * dx + sy * dz };
  }

  function steer(me, G, goal) {
    const nav = G.nav;
    if (!nav || goal.node < 0) return null;
    if (goal.node !== pathGoal || !path || pathI >= path.length) {
      path = nav.findPath(me.pos, goal.node, 420);
      STATS.paths++;
      pathI = path.length > 1 ? 1 : 0;
      pathGoal = goal.node;
    }
    while (pathI < path.length - 1) {
      const w = path[pathI];
      if (Math.hypot(w.x - me.pos.x, w.z - me.pos.z) < 1.4) pathI++;
      else break;
    }
    const w = path[Math.min(pathI, path.length - 1)];
    if (!w) return null;
    let dx = w.x - me.pos.x, dz = w.z - me.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.35) return null;          // standing on it
    return { dx: dx / d, dz: dz / d, dist: d };
  }

  return {
    PARAM_NAMES, PARAM_BOUNDS,
    getParams: () => PARAM_NAMES.map(n => P[n]),
    setParams: v => {
      if (!v || !v.length || v.length > PARAM_NAMES.length) return null;
      for (let i = 0; i < v.length; i++) P[PARAM_NAMES[i]] = v[i];
      return PARAM_NAMES.map(n => P[n]);
    },

    reset() {
      t = 0; phase = 0; strafeSign = 1; planT = 0; commitT = 0;
      path = null; pathI = 0; pathGoal = -1;
      GOAL.node = -1; GOAL.region = -1; GOAL.stance = 'engage';
      table.clear();
      STATS = { plans: 0, nodes: 0, sims: 0, engage: 0, reposition: 0, brk: 0, paths: 0, rays: 0 };
    },
    stats: () => STATS,
    /* for the offline timer: run the search n times, nothing else */
    __bench(n, G) {
      const g = G || (typeof globalThis !== 'undefined' && globalThis.G);
      for (let i = 0; i < n; i++) runPlan(g.player, g);
      return table.size;
    },

    act(me, G, dt) {
      t += dt;
      if (!me.alive) {
        GOAL.node = -1; path = null; pathGoal = -1; commitT = 0; planT = 0;
        return null;
      }

      const { target, dist, visible } = pickTarget(me, G);
      if (!target) return { yaw: me.yaw + P.searchTurn * dt };

      /* ---- the plan (macro) ---- */
      planT -= dt; commitT -= dt;
      if (planT <= 0) {
        planT = 1 / Math.max(1, P.planHz);
        if (commitT <= 0 || GOAL.node < 0) {
          let g = null;
          try { g = runPlan(me, G); } catch (e) { g = null; }
          if (g) {
            if (g.node !== GOAL.node) { path = null; pathGoal = -1; }
            GOAL.node = g.node; GOAL.region = g.region; GOAL.stance = g.stance;
            commitT = g.stance === 'engage' ? 0 : P.commitS;
          }
        }
      }
      const stance = GOAL.node >= 0 ? GOAL.stance : 'engage';

      /* ---- aim (the shipped policy, untouched) ---- */
      const dx = target.pos.x - me.pos.x;
      const dz = target.pos.z - me.pos.z;
      const dy = (target.pos.y + P.aimHeight) - actorEye(me);
      let wantYaw = Math.atan2(dx, dz);
      const wantPitch = Math.atan2(dy, Math.hypot(dx, dz));

      /* ---- movement ---- */
      let fwd = 0, strafe = 0, sprint = false;
      let mv = null;
      if (stance !== 'engage') mv = steer(me, G, GOAL);

      if (!mv) {
        /* the shipped range-keeping controller, verbatim */
        if (dist > P.engageRange + P.rangeBand) fwd = 1;
        else if (dist < P.engageRange - P.rangeBand) fwd = -1;
        phase += dt / Math.max(0.05, P.strafePeriod);
        if (phase >= 1) { phase = 0; strafeSign = -strafeSign; }
        strafe = visible ? strafeSign * P.strafeAmount : 0;
        sprint = dist > P.sprintRange && !visible;
      } else {
        /* Breaking contact means turning and running: sprint needs fwd > 0
           and a released trigger, and neither is possible while facing down
           a sightline you are trying to leave. */
        if (stance === 'break' && P.breakLook > 0.5) wantYaw = Math.atan2(mv.dx, mv.dz);
        const b = bodyFrame(wantYaw, mv.dx, mv.dz);
        fwd = clamp(b.fwd, -1, 1);
        /* Keep the tuned strafe oscillation riding on top of the walk. Most
           damage is taken moving in a straight line, and a path is nothing
           but straight lines. */
        phase += dt / Math.max(0.05, P.strafePeriod);
        if (phase >= 1) { phase = 0; strafeSign = -strafeSign; }
        strafe = clamp(b.strafe + (visible ? strafeSign * P.moveStrafe : 0), -1, 1);
        sprint = stance === 'break' && fwd > 0.55;
      }

      const maxTurn = P.turnRate * dt;
      const dYaw = wrap(wantYaw - me.yaw);
      const yaw = me.yaw + clamp(dYaw, -maxTurn, maxTurn);
      const dPitch = wantPitch - me.pitch;
      const pitch = me.pitch + clamp(dPitch, -maxTurn, maxTurn);

      const onTarget = Math.abs(dYaw) < P.fireCone && Math.abs(dPitch) < P.fireCone;
      const hasAmmo = me.ammo > 0;
      const mag = (WBY[me.weapon] && WBY[me.weapon].mag) || 30;
      if (!hasAmmo || me.ammo / mag <= P.reloadAt) tryReload(me);

      /* Hold fire only while actually breaking contact. Once the goal is
         underfoot there is nothing left to break, and a bot standing in its
         cover with the trigger off is just a slower bot. */
      const holdFire = stance === 'break' && !!mv;

      return {
        fwd, strafe, sprint,
        fire: visible && onTarget && hasAmmo && !holdFire,
        yaw, pitch
      };
    }
  };
}

module.exports = {
  name: 'mcgs',
  describe: 'Monte-Carlo graph search over (region, enemy set, hp, ammo); goals feed the tuned reactive controller',
  policySource: () => 'const POLICY = (' + POLICY_BODY.toString() + ')();'
};
