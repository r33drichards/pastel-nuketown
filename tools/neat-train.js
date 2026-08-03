'use strict';

/* =====================================================================
   neat-train.js — NEAT (Stanley & Miikkulainen 2002) for the autoplay
   policy. Produces tools/strategies/neat.genome.json, which
   tools/strategies/neat.js embeds and plays back with plain JS
   inference. Nothing here runs at policy load time.

   The three pillars:

     HISTORICAL MARKINGS. Every distinct (from, to) pair ever proposed
     gets a global innovation number, so crossover aligns genes by
     number rather than by analysing topology. Adding a node disables
     the split connection and adds two new ones (in->new weight 1,
     new->out the old weight), each with its own innovation number.

     SPECIATION. delta = c1*E/N + c2*D/N + c3*Wbar with E excess, D
     disjoint, Wbar the mean absolute weight difference over matching
     genes, N the gene count of the larger genome (1 when both are
     under 20 genes). Explicit fitness sharing divides each genome's
     fitness by its species size; species get offspring in proportion
     to their summed shared fitness.

     COMPLEXIFICATION. The initial population is the paper's minimal
     topology: NO HIDDEN NODES, every input wired straight to every
     output, random weights. Hidden structure only ever arrives by node
     mutation, and speciation is what gives a fresh structure time to be
     optimised before it has to compete with the whole population.

     (MarI/O's variant -- start from the EMPTY genome and let link
     mutation wire it up -- was tried first and does not bootstrap here.
     Five generations of pop 16 stayed at fitness 0.00: with 37 inputs a
     single random link is almost always silent, and a network with no
     link into the fire output never pulls the trigger at all, so there
     is nothing for selection to grade. The paper's fully-connected
     minimal start has an opinion about every output on generation one.)

   Usage:
     node tools/neat-train.js [--gens 25] [--pop 64] [--ticks 1200]
     node tools/neat-train.js --resume <checkpoint.json> --gens 40

   ONE process. Every match is a fresh vm instance run inline.
   ===================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const { createInstance, FIXED, mulberry32 } = require(path.join(ROOT, 'net-sim.js'));
const EP = require(path.join(__dirname, 'eval-policy.js'));
const NEATPOL = require(path.join(__dirname, 'strategies', 'neat.js'));

/* The shipped driver announces itself on every instance boot, which at a
   few hundred instances a generation buries the only output that matters.
   The vm shares this console, so silencing it here silences that. */
const say = (...a) => process.stdout.write(a.join(' ') + '\n');
console.log = () => {};

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i >= 0 ? process.argv[i + 1] : d;
};

/* ---- the environment --------------------------------------------------
   A clone of eval-policy.js's runMatch with one difference: a tick cap,
   so an early genome that will never reach 25 kills costs 20 seconds of
   simulated time instead of 420. Everything else -- the boot sequence,
   the instrumentation, the reseed, the driver -- is lifted verbatim so a
   capped match is a genuine prefix of the harness's match.
   --------------------------------------------------------------------- */
const SIM_BOOT = 'initViewmodel(); initFX(); initInput(); initAI();';
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
const RESEED = seed => `
  for (const a of G.actors) {
    if (!a.brain) continue;
    try { a.brain = AI.createBrain({ id: a.id, seed: ${seed >>> 0} * 7919 + a.id * 131, skill: a.skill }); }
    catch (e) {}
  }
`;
const DRIVER = EP.driverSource(EP.userscript());

/* A dense signal for the aiming sub-problem, wrapped around the driver's
   own wrapper so it sees the state the policy just produced. Every fourth
   tick, if any enemy is visible, score how close the crosshair is to the
   closest-to-aim one: exp(-angular error / 0.15), which is 1 on target and
   about 0.1 fifteen degrees off. Kills and even hits are far too sparse to
   grade a first generation -- ninety random networks across nine different
   initialisations landed ZERO hits between them in a 15 second match --
   but aim quality is non-zero for everybody and points the right way. */
const AIM_PROBE = `
  var AIMSUM = 0, AIMN = 0, AIMTICK = 0;
  {
    const _sim = window.simulate;
    window.simulate = function (dt) {
      const out = _sim.apply(this, arguments);
      if ((AIMTICK++ & 3) === 0) {
        const me = G.player;
        if (me && me.alive && G.started && !G.over) {
          const eye = actorEye(me);
          let best = -1;
          for (const a of G.actors) {
            if (a === me || a.isPlayer || !a.alive) continue;
            if (!canSee(me.pos.x, eye, me.pos.z, a.pos.x, actorEye(a), a.pos.z)) continue;
            const dx = a.pos.x - me.pos.x, dz = a.pos.z - me.pos.z;
            const d = Math.hypot(dx, dz);
            const wy = Math.atan2(dx, dz), wp = Math.atan2((a.pos.y + 1.5) - eye, d);
            const ey = Math.atan2(Math.sin(wy - me.yaw), Math.cos(wy - me.yaw));
            const q = Math.exp(-Math.hypot(ey, wp - me.pitch) / 0.15);
            if (q > best) best = q;
          }
          if (best >= 0) { AIMSUM += best; AIMN++; }
        }
      }
      return out;
    };
  }
`;

function rollout(seed, policySource, maxTicks) {
  const clock = { ms: 0 };
  const inst = createInstance(clock);
  inst.run(`Math.random = (${mulberry32.toString()})(${(seed >>> 0) || 1});`);
  inst.run(SIM_BOOT);
  inst.run(INSTRUMENT);
  inst.run(policySource);
  inst.run(DRIVER);
  inst.run(AIM_PROBE);
  inst.run('startMatch();');
  inst.run(RESEED(seed));
  let ticks = 0;
  while (ticks < maxTicks && !inst.get('G.over')) {
    inst.run(`simulate(${FIXED});`);
    clock.ms += FIXED * 1000;
    ticks++;
  }
  const kills = inst.get('G.player.kills') || 0;
  const deaths = inst.get('G.player.deaths') || 0;
  const aimN = inst.get('AIMN') || 0;
  return {
    seed, kills, deaths, ticks,
    hits: inst.get('HITS') || 0,
    spent: inst.get('SPENT_ROUNDS') || 0,
    aim: aimN ? (inst.get('AIMSUM') || 0) / aimN : 0,
    streak: kills / (deaths + 1)
  };
}

/* Training fitness is SHAPED, and the shaping is ANNEALED AWAY. The
   reported number is always the real streak, kills/(deaths+1) -- but on a
   15 second slice of a match a first-generation network gets zero kills
   AND zero hits, so the whole population sits at zero and selection is a
   coin toss. Two extra terms carry the early search:

     hits, worth a fortieth of a kill each -- evidence the network points
     at somebody and pulls the trigger;
     aim quality, the dense crosshair-proximity score above.

   Both fade linearly to nothing by generation ANNEAL, after which the
   objective IS the fitness the tournament measures. Finalists are then
   re-scored uncapped and unshaped through eval-policy.js itself.

   The shaping is ADDED to the real fitness, not folded inside its
   divisor. Folding it inside was tried and it breeds cowards: with zero
   kills the score is shapeW*aim/(deaths+1), and cutting deaths from two
   to zero triples that while tripling aim quality is hard, so five
   generations went into learning to hide rather than to shoot. Added
   outside, hiding earns nothing -- the aim term only accumulates on
   ticks when an enemy is actually visible, so a genome that never looks
   at anybody scores zero on it. */
const HIT_CREDIT = 0.05;
const AIM_CREDIT = 8.0;
const ANNEAL = 20;
let shapeW = 1;
const shaped = r =>
  r.kills / (r.deaths + 1) + shapeW * (HIT_CREDIT * r.hits + AIM_CREDIT * r.aim);
const realStreakOf = g => g.rows.reduce((a, r) => a + r.streak, 0) / g.rows.length;

/* ---- genome ----------------------------------------------------------- */
const N_IN = NEATPOL.N_IN, N_OUT = NEATPOL.N_OUT;
const IN_BIAS = N_IN - 1;                 // the constant-1 input
const OUT0 = N_IN;                        // output ids OUT0 .. OUT0+N_OUT-1
const HID0 = 100;                         // hidden ids start here

/* Rates. MarI/O's numbers where they transfer, the paper's where they do
   not. `connections` is the paper's 80% ("in each generation, 80% of
   offspring had their connection weights mutated") rather than MarI/O's
   0.25 -- with the population cut from 300 to 48 the search cannot
   afford to leave three quarters of its children weight-identical to a
   parent. `link` is down from 2.0 because the starting topology is
   already fully connected, so most proposals are duplicates and get
   rejected; what is left is the genuinely new hidden-node wiring. */
const RATES = {
  connections: 0.80,   // chance a child perturbs its weights at all
  link: 1.00,          // expected new links per child
  bias: 0.20,          // expected new links FROM the bias input
  node: 0.35,          // chance of splitting a connection
  enable: 0.20,
  disable: 0.40,
  step: 0.12
};
/* Initial and re-randomised weights. MarI/O draws U(-2, 2); with the
   paper's steepened sigmoid (4.9) and inputs already normalised to
   [-1, 1] that saturates every output into bang-bang control, and a
   crosshair slewing at the full turn cap never settles on anybody. A
   hand-built probe genome hit 37% of its shots with a 0.6 weight on the
   aim-error input and 10% with 1.0, so the draw is U(-0.6, 0.6). */
const WEIGHT_INIT = 0.6;
const PERTURB_CHANCE = 0.90;
const CROSSOVER_CHANCE = 0.75;
const STALE_SPECIES = 8;    // MarI/O uses 15; this run is far shorter than
                            // 15 generations of headroom, see the report
const C1 = 1.0, C2 = 1.0, C3 = 0.4;   // Stanley & Miikkulainen eq. 1
const TARGET_SPECIES = 6;

let RNG = mulberry32(12345);
const rnd = () => RNG();
const pick = arr => arr[Math.floor(rnd() * arr.length)];

/* Historical markings. One counter, one memo per structural change, so
   the same mutation appearing twice in a generation gets the same
   number and the two children stay compatible. */
let innovCounter = 0;
const innovOf = new Map();      // "from>to" -> innovation number
const splitOf = new Map();      // innovation of the split gene -> new node id
let nodeCounter = HID0;

function innovation(from, to) {
  const k = from + '>' + to;
  let v = innovOf.get(k);
  if (v === undefined) { v = ++innovCounter; innovOf.set(k, v); }
  return v;
}

const emptyGenome = () => ({ genes: [], hidden: [], fitness: 0, shared: 0, rates: { ...RATES } });
/* The paper's minimal structure: no hidden nodes, all inputs connected
   directly to all outputs. */
function newGenome() {
  const g = emptyGenome();
  for (let i = 0; i < N_IN; i++) {
    for (let o = 0; o < N_OUT; o++) {
      g.genes.push({ from: i, to: OUT0 + o, w: (rnd() * 2 - 1) * WEIGHT_INIT,
                     enabled: true, innov: innovation(i, OUT0 + o) });
    }
  }
  return g;
}
const copyGenome = g => ({
  genes: g.genes.map(x => ({ ...x })),
  hidden: g.hidden.slice(),
  fitness: 0, shared: 0,
  rates: { ...g.rates }
});

const isInput = id => id < OUT0;
const isOutput = id => id >= OUT0 && id < OUT0 + N_OUT;
const sources = g => {                    // legal `from` ends
  const a = [];
  for (let i = 0; i < N_IN; i++) a.push(i);
  for (const h of g.hidden) a.push(h);
  return a;
};
const sinks = g => {                      // legal `to` ends
  const a = [];
  for (let o = 0; o < N_OUT; o++) a.push(OUT0 + o);
  for (const h of g.hidden) a.push(h);
  return a;
};

function hasLink(g, from, to) {
  for (const x of g.genes) if (x.from === from && x.to === to) return true;
  return false;
}

function linkMutate(g, fromBias) {
  const from = fromBias ? IN_BIAS : pick(sources(g));
  const to = pick(sinks(g));
  if (from === to || isOutput(from) || isInput(to)) return;
  if (hasLink(g, from, to)) return;
  g.genes.push({ from, to, w: (rnd() * 2 - 1) * WEIGHT_INIT, enabled: true, innov: innovation(from, to) });
}

function nodeMutate(g) {
  const live = g.genes.filter(x => x.enabled);
  if (!live.length) return;
  const gene = pick(live);
  gene.enabled = false;
  let id = splitOf.get(gene.innov);
  if (id === undefined) { id = ++nodeCounter; splitOf.set(gene.innov, id); }
  if (!g.hidden.includes(id)) g.hidden.push(id);
  g.genes.push({ from: gene.from, to: id, w: 1, enabled: true, innov: innovation(gene.from, id) });
  g.genes.push({ from: id, to: gene.to, w: gene.w, enabled: true, innov: innovation(id, gene.to) });
}

function pointMutate(g) {
  const step = g.rates.step;
  for (const gene of g.genes) {
    if (rnd() < PERTURB_CHANCE) gene.w += rnd() * step * 2 - step;
    else gene.w = (rnd() * 2 - 1) * WEIGHT_INIT * 2;
  }
}

function toggleMutate(g, enable) {
  const cands = g.genes.filter(x => x.enabled !== enable);
  if (!cands.length) return;
  pick(cands).enabled = enable;
}

/* MarI/O's self-adapting rates: each rate drifts up or down by 5% per
   generation, so the population tunes its own operator mix. */
function mutate(g) {
  for (const k of Object.keys(g.rates)) g.rates[k] *= (rnd() < 0.5 ? 0.95 : 1.05263);
  if (rnd() < g.rates.connections) pointMutate(g);
  for (const [key, fn] of [['link', () => linkMutate(g, false)],
                           ['bias', () => linkMutate(g, true)],
                           ['node', () => nodeMutate(g)],
                           ['enable', () => toggleMutate(g, true)],
                           ['disable', () => toggleMutate(g, false)]]) {
    let p = g.rates[key];
    while (p > 0) { if (rnd() < p) fn(); p -= 1; }
  }
  return g;
}

/* Crossover by historical marking: matching genes come at random from
   either parent, everything else from the fitter one. */
function crossover(a, b) {
  if (b.fitness > a.fitness) { const t = a; a = b; b = t; }
  const child = emptyGenome();
  child.rates = { ...a.rates };
  const byInnov = new Map();
  for (const x of b.genes) byInnov.set(x.innov, x);
  for (const x of a.genes) {
    const m = byInnov.get(x.innov);
    child.genes.push({ ...((m && m.enabled && rnd() < 0.5) ? m : x) });
  }
  const nodes = new Set();
  for (const x of child.genes) { nodes.add(x.from); nodes.add(x.to); }
  child.hidden = [...nodes].filter(id => id >= HID0).sort((p, q) => p - q);
  return child;
}

/* Compatibility distance, Stanley & Miikkulainen equation 1. */
function distance(a, b) {
  const A = new Map(), B = new Map();
  for (const x of a.genes) A.set(x.innov, x);
  for (const x of b.genes) B.set(x.innov, x);
  const maxA = a.genes.length ? Math.max(...A.keys()) : 0;
  const maxB = b.genes.length ? Math.max(...B.keys()) : 0;
  const cut = Math.min(maxA, maxB);
  let excess = 0, disjoint = 0, matching = 0, wsum = 0;
  for (const [k, x] of A) {
    if (B.has(k)) { matching++; wsum += Math.abs(x.w - B.get(k).w); }
    else if (k > cut) excess++;
    else disjoint++;
  }
  for (const [k] of B) {
    if (A.has(k)) continue;
    if (k > cut) excess++; else disjoint++;
  }
  const n1 = a.genes.length, n2 = b.genes.length;
  const N = (n1 < 20 && n2 < 20) ? 1 : Math.max(1, n1, n2);
  const wbar = matching ? wsum / matching : 0;
  return C1 * excess / N + C2 * disjoint / N + C3 * wbar;
}

/* ---- evolution -------------------------------------------------------- */
const GENS = Number(arg('gens', 25));
const POP = Number(arg('pop', 64));
const TICKS = Number(arg('ticks', 1200));
const TRAIN_SEEDS = (arg('seeds', '101,102,103')).split(',').map(Number);
const OUTDIR = arg('out', '/tmp/claude-0/-home-user-pastel-nuketown/112b2fd7-e695-5c34-a25d-1c178917b043/scratchpad/neat');
fs.mkdirSync(OUTDIR, { recursive: true });

const evalCache = new Map();
function key(g) {
  return g.genes.filter(x => x.enabled)
    .map(x => x.from + ':' + x.to + ':' + x.w.toFixed(4)).sort().join('|');
}

let evals = 0;
function evaluate(g) {
  const k = key(g);
  if (evalCache.has(k)) { const c = evalCache.get(k); g.fitness = c.f; g.rows = c.rows; return; }
  const src = NEATPOL.buildSource({
    hidden: g.hidden.slice().sort((a, b) => a - b),
    conns: g.genes.filter(x => x.enabled).map(x => [x.from, x.to, x.w])
  });
  const rows = TRAIN_SEEDS.map(s => rollout(s, src, TICKS));
  /* Each match builds a whole vm instance; without a nudge the resident
     set walks past a gigabyte inside ten generations. */
  if (global.gc && (evals % 24) === 0) global.gc();
  evals += rows.length;
  const f = rows.reduce((s, r) => s + shaped(r), 0) / rows.length;
  g.fitness = f; g.rows = rows;
  evalCache.set(k, { f, rows });
}

function speciate(pop, threshold) {
  const species = [];
  for (const g of pop) {
    let placed = false;
    for (const s of species) {
      if (distance(g, s.rep) < threshold) { s.members.push(g); placed = true; break; }
    }
    if (!placed) species.push({ rep: g, members: [g], top: -Infinity, staleness: 0 });
  }
  return species;
}

function genomeJSON(g) {
  return {
    hidden: g.hidden.slice().sort((a, b) => a - b),
    conns: g.genes.filter(x => x.enabled).map(x => [x.from, x.to, Number(x.w.toFixed(6))])
  };
}

/* Staleness bookkeeping lives outside the generation loop: species are
   rebuilt from scratch every generation, so "the same species" is
   recognised by its representative still being compatible. */
const staleBook = [];

let population = [];
let species = [];
/* The paper's delta_t = 3.0 assumes N normalises by genome size. With the
   N = 1 rule in force (both genomes under 20 genes, which is the whole of
   the early run) delta is just the RAW count of differing genes, and two
   siblings that each took ~2.5 link mutations already differ by 5. A fixed
   3.0 therefore puts almost every genome in its own species. In the other
   direction, with the fully-connected start every genome carries 296
   genes, N = 296, and delta collapses to 0.4 * mean|dw| ~ 0.16 -- one
   species for everybody. Either way a fixed threshold is wrong, so it is
   adapted multiplicatively to hold the species count near TARGET_SPECIES,
   over a range reaching far below the paper's 3.0: once the population
   shares an ancestor the disjoint terms nearly vanish and delta is
   essentially 0.4 * mean|dw|, which between a parent and its mutated child
   is about 0.02. A floor anywhere near 1.0 leaves everybody in one species
   and switches pillar two off -- which is exactly what the first attempt
   at this run did for two generations before it was noticed.
   That is standard NEAT practice and it is the only deviation from the
   paper's equation 1 here: E, D, Wbar and the N = 1 rule are all exact. */
let threshold = 0.30;
let gen0 = 0;
let best = null;

const resume = arg('resume', null);
if (resume) {
  const st = JSON.parse(fs.readFileSync(resume, 'utf8'));
  population = st.population;
  gen0 = st.gen;
  threshold = st.threshold;
  innovCounter = st.innovCounter;
  nodeCounter = st.nodeCounter;
  for (const [k, v] of st.innovOf) innovOf.set(k, v);
  for (const [k, v] of st.splitOf) splitOf.set(Number(k), v);
  RNG = mulberry32(st.rngSeed);
  say(`resumed from ${resume} at generation ${gen0}`);
} else {
  /* Minimal start: no hidden nodes, inputs wired straight to outputs. */
  for (let i = 0; i < POP; i++) population.push(mutate(newGenome()));
}

say(`NEAT: pop ${POP}, ${TRAIN_SEEDS.length} seeds ${TRAIN_SEEDS}, ` +
  `${TICKS} ticks (${(TICKS * FIXED).toFixed(0)}s) per match, ${GENS} generations`);
say('gen shapeW   best   mean  spec   thr  links nodes  streak  kills deaths   aim   evals  mins  rssMB');

const t0 = Date.now();
const history = [];

for (let gen = gen0; gen < gen0 + GENS; gen++) {
  shapeW = Math.max(0, 1 - gen / ANNEAL);
  evalCache.clear();          // the objective moved; old scores are stale
  for (const g of population) evaluate(g);

  /* Speciate, then share fitness explicitly inside each species. */
  species = speciate(population, threshold);
  if (species.length > TARGET_SPECIES + 1) threshold = Math.min(60, threshold * 1.2);
  else if (species.length < TARGET_SPECIES - 1) threshold = Math.max(0.005, threshold / 1.2);

  for (const s of species) {
    s.members.sort((a, b) => b.fitness - a.fitness);
    s.top = s.members[0].fitness;
    for (const g of s.members) g.shared = g.fitness / s.members.length;
    s.sum = s.members.reduce((a, g) => a + g.shared, 0);
  }
  species.sort((a, b) => b.top - a.top);

  const champ = species[0].members[0];
  /* `best` tracks the real streak, not the shaped score: the shaped score
     is not comparable across generations once the annealing starts. */
  if (!best || realStreakOf(champ) > best.real) best = copyBest(champ);
  const meanFit = population.reduce((a, g) => a + g.fitness, 0) / population.length;
  const realStreak = champ.rows.reduce((a, r) => a + r.streak, 0) / champ.rows.length;
  const kills = champ.rows.reduce((a, r) => a + r.kills, 0) / champ.rows.length;
  const deaths = champ.rows.reduce((a, r) => a + r.deaths, 0) / champ.rows.length;
  const aim = champ.rows.reduce((a, r) => a + r.aim, 0) / champ.rows.length;
  const links = champ.genes.filter(x => x.enabled).length;

  history.push({ gen, shapeW, best: champ.fitness, mean: meanFit, species: species.length,
    realStreak, kills, deaths, aim, links, hidden: champ.hidden.length });
  say(
    `${String(gen).padStart(3)} ${shapeW.toFixed(2).padStart(6)} ${champ.fitness.toFixed(2).padStart(6)} ` +
    `${meanFit.toFixed(2).padStart(6)} ${String(species.length).padStart(5)} ` +
    `${threshold.toFixed(1).padStart(5)} ${String(links).padStart(6)} ` +
    `${String(champ.hidden.length).padStart(5)}   ${realStreak.toFixed(2).padStart(10)} ` +
    `${kills.toFixed(1).padStart(6)} ${deaths.toFixed(2).padStart(6)} ` +
    `${aim.toFixed(2).padStart(5)} ` +
    `${String(evals).padStart(7)} ${((Date.now() - t0) / 60000).toFixed(1).padStart(5)} ` +
    `${(process.memoryUsage().rss / 1e6).toFixed(0).padStart(6)}`);

  fs.writeFileSync(path.join(OUTDIR, 'best.json'), JSON.stringify(genomeJSON(best), null, 1));
  fs.writeFileSync(path.join(OUTDIR, 'history.json'), JSON.stringify(history, null, 1));
  fs.writeFileSync(path.join(OUTDIR, 'checkpoint.json'), JSON.stringify({
    gen: gen + 1, threshold, innovCounter, nodeCounter,
    innovOf: [...innovOf], splitOf: [...splitOf], rngSeed: Math.floor(rnd() * 2 ** 31),
    population: population.map(g => ({ genes: g.genes, hidden: g.hidden, rates: g.rates, fitness: 0, shared: 0 }))
  }));

  if (global.gc) global.gc();
  if (gen === gen0 + GENS - 1) break;

  /* ---- staleness: a species that has not improved in STALE_SPECIES
     generations is removed, unless it is the best one. --------------- */
  stale(species, gen);

  /* ---- offspring in proportion to summed SHARED fitness ------------- */
  const totalShared = species.reduce((a, s) => a + s.sum, 0) || 1;
  const next = [];
  /* The paper copies the champion of a species with more than five
     members through unchanged. At population 32 spread over eight
     species almost nothing clears that bar, so the best genome in the
     run could be -- and was -- mutated away every generation. Species of
     three or more keep their champion, and the overall best is always
     carried, which is elitism the paper leaves implicit in its much
     larger populations. */
  for (const s of species) {
    if (s.members.length >= 3) next.push(copyGenome(s.members[0]));
  }
  if (!next.length) next.push(copyGenome(species[0].members[0]));
  if (best) next.push(copyGenome(best));

  for (const s of species) {
    const quota = Math.floor(POP * s.sum / totalShared);
    /* breed from the top half of the species only */
    const pool = s.members.slice(0, Math.max(1, Math.ceil(s.members.length / 2)));
    for (let i = 0; i < quota && next.length < POP; i++) next.push(breed(pool));
  }
  while (next.length < POP) next.push(breed(species[0].members.slice(0, Math.max(1, Math.ceil(species[0].members.length / 2)))));
  population = next.slice(0, POP);
}

function breed(pool) {
  let child;
  if (rnd() < CROSSOVER_CHANCE && pool.length > 1) child = crossover(pick(pool), pick(pool));
  else child = copyGenome(pick(pool));
  return mutate(child);
}

function copyBest(g) {
  const c = copyGenome(g);
  c.fitness = g.fitness; c.rows = g.rows; c.real = realStreakOf(g);
  return c;
}

function stale(list, gen) {
  for (const s of list) {
    let rec = staleBook.find(r => distance(r.rep, s.rep) < threshold);
    if (!rec) { rec = { rep: s.rep, top: -Infinity, since: gen }; staleBook.push(rec); }
    if (s.top > rec.top + 1e-9) { rec.top = s.top; rec.since = gen; rec.rep = s.rep; }
    s.staleness = gen - rec.since;
  }
  const bestTop = Math.max(...list.map(s => s.top));
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].staleness > STALE_SPECIES && list[i].top < bestTop && list.length > 1) {
      list.splice(i, 1);
    }
  }
}

say(`\ndone: ${evals} matches in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
say(`best genome -> ${path.join(OUTDIR, 'best.json')}`);
