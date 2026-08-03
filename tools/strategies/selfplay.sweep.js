'use strict';

/* =====================================================================
   selfplay.sweep.js — the league that drives tools/strategies/selfplay.js.

   (Named `.sweep.js` on purpose: tournament.js excludes
    /\.(analysis|test|util|helper|sweep)\.js$/ from the field, and this is a
    search driver, not an entry.)

   THE METRIC PROBLEM
   ------------------
   Fitness in this project is kills/(deaths+1) against eight fixed bots. Under
   self-play that number says almost nothing: if every actor runs the same
   policy the kills and the deaths are the same population, so the mean streak
   is pinned near 1 whatever the policy is. Making the policy twice as good
   makes the opposition twice as good and the number does not move.

   So the league scores RELATIVELY. One game is:

     - the 8 bot slots split 4/4 between two policies A and B;
     - the local player driven by the SHIPPED policy through the shipped
       driver, identical in every game, so the human slot is part of the
       environment rather than part of the contest (it is also the only slot
       that can sprint and runs at 5.9 rather than 5.3 — see the arena's
       header — which is exactly why it is never one of the contestants);
     - the kill race lifted (killsToWin 9999) and the match cut at a fixed
       90 simulated seconds, so both sides get the same amount of game rather
       than the game ending when one of them gets lucky first.

   The result of a game is the sign of

       margin = (killsA - deathsA) - (killsB - deathsB)

   which is zero in expectation when A and B are the same policy, because
   every kill in the match is somebody's death.

   Slots are not interchangeable — pickSpawn keys off actor id — so every
   game is played TWICE on the same seed with the sides swapped (A on the even
   slots then A on the odd ones). That is the chess colour-swap: it cancels
   slot bias, and the pair is the unit the league counts.

   RATING is Bradley-Terry fitted by MM over every game any two pool members
   have ever played, reported on the Elo scale (400/ln10). Sequential Elo would
   depend on the order games happened to be played in; BT does not, which
   matters when the pool keeps gaining members.

   THE POOL holds the incumbent AND ITS ANCESTORS. Latest-versus-latest self-
   play cycles: A beats B, C beats A, and B beats C, and the loop improves
   nothing while every step looks like progress. A challenger here has to beat
   the whole pool, and specifically must not LOSE badly to any one member.

   A GENERATION is two stages, because a full gauntlet costs |pool| duels and
   most candidates are not worth one:
     SCREEN    lambda candidates jittered off the incumbent, 5 mirrored pairs
               each against the incumbent alone. Best mean pair margin wins.
     GAUNTLET  that one candidate against EVERY pool member, 8 mirrored pairs
               (16 games) each, on a disjoint block of seeds.

   PROMOTION RULE, stated before the run:
     a challenger replaces the incumbent iff
       (1) its aggregate pair score across the whole gauntlet is >= 0.58 over
           at least 16 games, AND
       (2) its pair score against no single pool member is below 0.40 — the
           anti-cycling clause; a policy that trades wins with an ancestor is
           a rotation, not an improvement, AND
       (3) its fixed-bot fitness on the DEV seeds (1..8, disjoint from the
           tournament's held-out 1001+) is not more than 1.0 below the
           incumbent's.
     (3) is the guard the brief asks for. It is a LOOSE guard on purpose: it
     lets self-play move the policy, and lets the divergence show up in the
     numbers rather than being defined away.

   WHAT THE FIRST RUN OF THIS FILE FOUND (3 generations, 176 arena games)
   ----------------------------------------------------------------------
   The promotion rule above is TOO LOOSE and the run proved it. g1c1 was
   promoted on a 16-game gauntlet at pair score 0.625 (5w/3l, sign p=0.727),
   then re-played against the same opponent on a disjoint block of 24 mirrored
   pairs: score 0.271, mean pair margin -6.23, sd 10.25, sign p=0.035. The
   promoted challenger is significantly WORSE.

   The pair margin has sd ~10 kills, so the standard error of a duel is
   10/sqrt(pairs): 3.6 at 8 pairs, 2.0 at 24. Detecting the size of effect a
   10% parameter jitter produces (a few kills) needs 24+ mirrored pairs per
   opponent — ~3.5 CPU-minutes a duel, ~|pool| x that a gauntlet. Any future
   run of this file should use GAUNTLET_PAIRS >= 24 and read the t on the mean
   pair margin, not the win count: the sign of the pair margin throws away the
   magnitude, and magnitude is where the information is.

   And the divergence the brief warned about is real and points the other way
   from the naive fear: across the 8 candidates screened here, self-play
   margin against fixed-bot fitness came out at pearson r = -0.374, spearman
   rho = -0.262, and the one candidate measured on the tournament's held-out
   window was worse in self-play (p=0.035) and better on fixed bots (18.52 vs
   15.02, 10b/4w/10t, p=0.180). Self-play here is not a proxy for the
   tournament. Report both, always.

   Usage:
     node tools/strategies/selfplay.sweep.js null   [pairs]
     node tools/strategies/selfplay.sweep.js league [gens] [lambda]
     node tools/strategies/selfplay.sweep.js head   <a.json> <b.json> [pairs]
     node tools/strategies/selfplay.sweep.js holdout [matches] [firstSeed]
     node tools/strategies/selfplay.sweep.js divergence [devSeeds]
   ===================================================================== */

const fs = require('node:fs');
const path = require('node:path');
const { runArena, tunedVector } = require('./selfplay.arena.js');
const { userscript, policySource, runMatch } = require('../eval-policy.js');

const SHIPPED_SRC = policySource(userscript());
const TUNED = tunedVector();

/* Copied from the POLICY block in the userscript, which is the authority.
   Asserted against the live policy at startup so a rename cannot go unnoticed. */
const NAMES = ['engageRange', 'rangeBand', 'fireCone', 'turnRate', 'strafePeriod',
  'strafeAmount', 'sprintRange', 'reloadAt', 'aimHeight', 'searchTurn'];
const BOUNDS = [[3, 40], [0.5, 8], [0.005, 0.30], [3, 30], [0.3, 3.0],
  [0, 1], [4, 40], [0, 0.9], [0.8, 2.0], [0.5, 6]];

for (const n of NAMES) {
  if (!new RegExp(`'${n}'`).test(SHIPPED_SRC)) {
    throw new Error(`parameter ${n} is no longer in the shipped policy — retune this file`);
  }
}

const STATE = path.join(__dirname, 'selfplay.league.json');
const EVEN = [0, 2, 4, 6];
const ODD = [1, 3, 5, 7];
const SECONDS = 90;

/* A candidate is a parameter vector. Its source is the shipped block plus a
   tail that pins the vector and then REFUSES later setParams calls — the
   shipped driver pushes its own tuned 10-vector into whatever POLICY it
   finds, and the arena mirrors that, so a candidate that did not defend its
   numbers would quietly run as the baseline. Returning null is the contract's
   own way of saying "no parameters here" (strategies/README.md). */
function sourceOf(vec) {
  const v = vec.map(x => Number(x.toFixed(6)));
  return SHIPPED_SRC + `
;(() => {
  POLICY.setParams(${JSON.stringify(v)});
  const frozen = POLICY.getParams();
  POLICY.setParams = () => null;      // the driver's vector must not land here
  POLICY.getParams = () => frozen.slice();
})();
`;
}
const entrantOf = (name, vec) => ({ name, source: sourceOf(vec), vec });

/* ---- one mirrored pair ------------------------------------------------ */
function side(res, entIdx) {
  const mine = res.actors.filter(a => a.kind === 'policy' && a.entrant === entIdx);
  return {
    kills: mine.reduce((s, a) => s + a.kills, 0),
    deaths: mine.reduce((s, a) => s + a.deaths, 0),
    errors: mine.reduce((s, a) => s + a.errors, 0)
  };
}

function game(seed, A, B, aSlots) {
  const bSlots = aSlots === EVEN ? ODD : EVEN;
  const bots = {};
  for (const s of aSlots) bots[s] = 0;
  for (const s of bSlots) bots[s] = 1;
  const res = runArena(seed, {
    entrants: [A, B, { name: 'shipped', source: SHIPPED_SRC }],
    player: 2, bots, seconds: SECONDS
  });
  const a = side(res, 0), b = side(res, 1);
  if (a.errors || b.errors) {
    const bad = res.actors.find(x => x.errors);
    throw new Error(`policy threw in the arena: ${bad && bad.lastError}`);
  }
  return {
    seed, aEven: aSlots === EVEN,
    a, b,
    margin: (a.kills - a.deaths) - (b.kills - b.deaths)
  };
}

/* Each seed is played both ways round and the PAIR is the unit.

   The mirror is antithetic and the engine is deterministic, so when A and B
   are the same policy the second game is literally the first game with the
   labels swapped: its margin is the exact negative of the first, and the pair
   margin is exactly 0. That is a perfectly calibrated null — a non-zero pair
   margin cannot be slot luck, spawn luck or seed luck, only a difference
   between the two policies. It also means the per-game sign is worthless
   (it is always one win and one loss), so the pair margin is what is scored. */
function pair(seed, A, B) {
  const g1 = game(seed, A, B, EVEN);
  const g2 = game(seed, A, B, ODD);
  const margin = (g1.margin + g2.margin) / 2;
  return { seed, games: [g1, g2], margin,
           score: margin > 0 ? 1 : (margin < 0 ? 0 : 0.5) };
}

function duel(A, B, seeds, log) {
  const pairs = seeds.map(s => {
    const p = pair(s, A, B);
    if (log) log(p);
    return p;
  });
  const n = pairs.length;
  const score = pairs.reduce((s, p) => s + p.score, 0) / n;
  const margin = pairs.reduce((s, p) => s + p.margin, 0) / n;
  const wins = pairs.reduce((s, p) => s + (p.score > 0.5 ? 1 : 0), 0);
  const losses = pairs.reduce((s, p) => s + (p.score < 0.5 ? 1 : 0), 0);
  return { pairs: n, games: n * 2, score, margin, wins, losses,
           ties: n - wins - losses, p: signTest(wins, losses) };
}

/* Exact two-sided sign test, the same one tournament.js uses. */
function signTest(better, worse) {
  const n = better + worse;
  if (!n) return 1;
  const choose = (N, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (N - i) / (i + 1); return r; };
  let p = 0;
  for (let i = 0; i <= Math.min(better, worse); i++) p += choose(n, i);
  return Math.min(1, 2 * p / Math.pow(2, n));
}

/* ---- Bradley-Terry over the recorded games ---------------------------- */
function ratings(members, records) {
  /* records: [{a, b, scoreA, games}] with names. A quarter-game prior against
     a phantom average opponent keeps an undefeated member finite. */
  const idx = new Map(members.map((m, i) => [m, i]));
  const w = members.map(() => 0.5);      // prior wins
  const n = members.map(() => 1.0);      // prior games
  const pairsW = members.map(() => members.map(() => 0));
  const pairsN = members.map(() => members.map(() => 0));
  for (const r of records) {
    if (!idx.has(r.a) || !idx.has(r.b)) continue;
    const i = idx.get(r.a), j = idx.get(r.b);
    w[i] += r.scoreA * r.games; w[j] += (1 - r.scoreA) * r.games;
    n[i] += r.games; n[j] += r.games;
    pairsW[i][j] += r.scoreA * r.games; pairsW[j][i] += (1 - r.scoreA) * r.games;
    pairsN[i][j] += r.games; pairsN[j][i] += r.games;
  }
  let g = members.map(() => 1);
  for (let it = 0; it < 500; it++) {
    const next = g.slice();
    for (let i = 0; i < members.length; i++) {
      let denom = 1 / (g[i] + 1);          // the prior game vs strength 1
      for (let j = 0; j < members.length; j++) {
        if (i === j || !pairsN[i][j]) continue;
        denom += pairsN[i][j] / (g[i] + g[j]);
      }
      next[i] = denom > 0 ? w[i] / denom : g[i];
    }
    const mean = Math.exp(next.reduce((s, v) => s + Math.log(Math.max(1e-9, v)), 0) / members.length);
    g = next.map(v => v / mean);
  }
  const K = 400 / Math.LN10;
  return members.map((m, i) => ({ name: m, elo: K * Math.log(g[i]), games: n[i] - 1 }));
}

/* ---- fixed-bot fitness, the sanity number ----------------------------- */
function fixedFitness(source, seeds) {
  const rows = seeds.map(s => runMatch(s, { policySource: source }));
  return {
    rows,
    fitness: rows.reduce((s, r) => s + r.streak, 0) / rows.length,
    kills: rows.reduce((s, r) => s + r.kills, 0) / rows.length,
    deaths: rows.reduce((s, r) => s + r.deaths, 0) / rows.length
  };
}

/* ---- candidate generation --------------------------------------------- */
function jitter(vec, rng, scale) {
  return vec.map((v, i) => {
    const [lo, hi] = BOUNDS[i];
    const x = v + (rng() * 2 - 1) * scale * (hi - lo);
    return Math.max(lo, Math.min(hi, x));
  });
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------------- */
function loadState() {
  if (fs.existsSync(STATE)) return JSON.parse(fs.readFileSync(STATE, 'utf8'));
  return {
    matches: 0,
    pool: [{ name: 'gen0', vec: TUNED, born: 0 }],
    incumbent: 'gen0',
    records: [],
    log: []
  };
}
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }

const fmt = n => (n >= 0 ? '+' : '') + n.toFixed(2);

function cmdNull(pairsN) {
  const A = entrantOf('shippedA', TUNED);
  const B = entrantOf('shippedB', TUNED);
  const seeds = Array.from({ length: pairsN }, (_, i) => 2001 + i);
  console.log(`null model: shipped vs shipped, ${pairsN} mirrored pairs ` +
    `(${pairsN * 2} games, ${SECONDS}s each)\n`);
  const margins = [];
  const d = duel(A, B, seeds, p => {
    for (const g of p.games) margins.push(g.margin);
    console.log(`  seed ${p.seed}  ${p.games.map(g =>
      `${g.a.kills}-${g.a.deaths} vs ${g.b.kills}-${g.b.deaths} (${fmt(g.margin)})`).join('   ')}` +
      `   pair score ${p.score.toFixed(2)}`);
  });
  const mean = margins.reduce((a, b) => a + b, 0) / margins.length;
  const sd = Math.sqrt(margins.reduce((a, b) => a + (b - mean) ** 2, 0) / (margins.length - 1));
  console.log(`\n  per-game margin  mean ${fmt(mean)}  sd ${sd.toFixed(2)}  n ${margins.length}`);
  console.log(`  pair score ${d.score.toFixed(3)}  (${d.wins}w/${d.losses}l/${d.ties}t, p=${d.p.toFixed(3)})`);
  console.log(`  se of a ${pairsN}-pair score under the null ~ ${(0.5 / Math.sqrt(pairsN)).toFixed(3)}`);
}

function cmdLeague(gens, lambda) {
  const st = loadState();
  const rng = mulberry32(20260803 + st.matches * 7919);
  const devSeeds = Array.from({ length: 8 }, (_, i) => 1 + i);
  const vecOf = name => st.pool.find(m => m.name === name).vec;
  const SCREEN_PAIRS = 5, GAUNTLET_PAIRS = 8;   // see the header: 8 is too few
  const t0 = Date.now();
  const spent = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`;

  const incFit = fixedFitness(sourceOf(vecOf(st.incumbent)), devSeeds);
  st.matches += devSeeds.length;
  console.log(`incumbent ${st.incumbent}   dev fixed-bot fitness ${incFit.fitness.toFixed(2)} ` +
    `(${incFit.kills.toFixed(1)}k / ${incFit.deaths.toFixed(2)}d)`);
  console.log(`pool: ${st.pool.map(m => m.name).join(', ')}`);
  console.log(`plan: ${gens} generations x (${lambda} screened @ ${SCREEN_PAIRS} pairs ` +
    `+ 1 gauntlet @ ${GAUNTLET_PAIRS} pairs vs each pool member)\n`);

  for (let gen = 0; gen < gens; gen++) {
    const incVec = vecOf(st.incumbent);
    const inc = entrantOf(st.incumbent, incVec);
    const screenSeeds = Array.from({ length: SCREEN_PAIRS },
      (_, i) => 30000 + st.log.length * 137 + i * 11);

    /* ---- screen ---- */
    const cands = [];
    for (let k = 0; k < lambda; k++) {
      st.nextId = (st.nextId || 0) + 1;
      const name = `c${st.nextId}`;      // unique: a generation that promotes
                                         // nobody must not reuse names
      const vec = jitter(incVec, rng, 0.10);
      const cand = entrantOf(name, vec);
      const d = duel(cand, inc, screenSeeds);
      st.matches += d.games;
      cands.push({ name, vec, cand, screen: d });
      console.log(`  screen ${name.padEnd(7)} vs ${st.incumbent.padEnd(7)} ` +
        `margin ${fmt(d.margin)}  score ${d.score.toFixed(2)}   [${spent()}]`);
    }
    cands.sort((a, b) => b.screen.margin - a.screen.margin);
    const best = cands[0];
    for (const c of cands) {
      st.log.push({ stage: 'screen', name: c.name, vec: c.vec,
        margin: c.screen.margin, score: c.screen.score, gen });
    }
    if (best.screen.margin <= 0) {
      console.log(`  gen ${gen}: nothing beat the incumbent in screening; no gauntlet\n`);
      saveState(st);
      continue;
    }

    /* ---- gauntlet ---- */
    let worst = 1, agg = 0, aggN = 0;
    const fresh = [];
    for (const m of st.pool) {
      const seeds = Array.from({ length: GAUNTLET_PAIRS },
        (_, i) => 50000 + st.pool.length * 977 + i * 13);
      const d = duel(best.cand, entrantOf(m.name, m.vec), seeds);
      st.matches += d.games;
      fresh.push({ a: best.name, b: m.name, scoreA: d.score, games: d.games });
      agg += d.score * d.games; aggN += d.games;
      worst = Math.min(worst, d.score);
      console.log(`  gauntlet ${best.name} vs ${m.name.padEnd(7)} score ${d.score.toFixed(3)}  ` +
        `margin ${fmt(d.margin)}  ${d.wins}w/${d.losses}l/${d.ties}t  p=${d.p.toFixed(3)}   [${spent()}]`);
    }
    const score = agg / aggN;
    const fit = fixedFitness(best.cand.source, devSeeds);
    st.matches += devSeeds.length;
    const promote = score >= 0.58 && worst >= 0.40 && aggN >= 16 &&
      fit.fitness >= incFit.fitness - 1.0;
    console.log(`  ${best.name}: pool score ${score.toFixed(3)} (worst ${worst.toFixed(3)}, ` +
      `${aggN} games)  dev fitness ${fit.fitness.toFixed(2)} vs ${incFit.fitness.toFixed(2)}` +
      `  ->  ${promote ? 'PROMOTED' : 'rejected'}\n`);

    st.records.push(...fresh);
    st.log.push({ stage: 'gauntlet', name: best.name, vec: best.vec, score, worst,
      games: aggN, devFitness: fit.fitness, devKills: fit.kills, devDeaths: fit.deaths,
      promote, gen });
    if (promote) {
      st.pool.push({ name: best.name, vec: best.vec, born: st.pool.length,
        devFitness: fit.fitness });
      st.incumbent = best.name;
    }
    saveState(st);
  }

  const members = st.pool.map(m => m.name);
  const table = ratings(members, st.records).sort((a, b) => b.elo - a.elo);
  console.log('  league rating (Bradley-Terry, Elo scale)');
  for (const r of table) {
    const m = st.pool.find(x => x.name === r.name);
    console.log(`    ${r.name.padEnd(8)} ${r.elo.toFixed(0).padStart(6)}  ${r.games} games` +
      (m && m.devFitness !== undefined ? `   dev fitness ${m.devFitness.toFixed(2)}` : ''));
  }

  /* The headline the brief asks for: do the two numbers agree? */
  const g = st.log.filter(x => x.stage === 'gauntlet');
  if (g.length >= 3) {
    const r = pearson(g.map(x => x.score), g.map(x => x.devFitness));
    console.log(`\n  gauntlet pool score vs dev fixed-bot fitness: r = ${r.toFixed(3)} over ${g.length} candidates`);
  }
  console.log(`\n  incumbent: ${st.incumbent}   matches booked to this state: ${st.matches}   wall ${spent()}`);
  saveState(st);
}

function pearson(a, b) {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2;
  }
  return sa && sb ? sab / Math.sqrt(sa * sb) : 0;
}

/* ---------------------------------------------------------------------
   holdout — the paired number the brief asks for. Both arms play the SAME
   fixed-bot matches on the tournament's held-out seed window (1001+), in ONE
   process, and the decision column is the same exact sign test tournament.js
   uses. This is the sanity metric, not the league metric: it is measured
   against the eight fixed bots, whose threat model (a `hard` rifle bot
   landing a one-shot headshot) is nothing like a lobby full of SMG policies.
   --------------------------------------------------------------------- */
function cmdHoldout(n, first, who) {
  const seeds = Array.from({ length: n }, (_, i) => first + i);
  let arm;
  if (!who || who === 'selfplay') {
    arm = { name: 'selfplay', source: require('./selfplay.js').policySource() };
  } else {
    const st = loadState();
    const m = st.pool.find(x => x.name === who) ||
      st.log.find(x => x.name === who);
    if (!m) throw new Error('no such candidate: ' + who);
    arm = { name: who, source: sourceOf(m.vec) };
  }
  const arms = [{ name: 'shipped', source: SHIPPED_SRC }, arm];
  const out = arms.map(a => ({ name: a.name, rows: seeds.map(s => {
    const r = runMatch(s, { policySource: a.source });
    process.stdout.write('.');
    return r;
  }) }));
  process.stdout.write('\n\n');
  const mean = (rows, f) => rows.reduce((x, r) => x + f(r), 0) / rows.length;
  for (const a of out) {
    console.log(`  ${a.name.padEnd(9)} fitness ${mean(a.rows, r => r.streak).toFixed(3).padStart(7)}` +
      `  kills ${mean(a.rows, r => r.kills).toFixed(2).padStart(6)}` +
      `  deaths ${mean(a.rows, r => r.deaths).toFixed(2).padStart(5)}` +
      `  perfect ${a.rows.filter(r => r.perfect).length}/${n}` +
      `  won ${a.rows.filter(r => r.won).length}/${n}`);
  }
  let better = 0, worse = 0;
  const per = [];
  for (let i = 0; i < n; i++) {
    const b = out[0].rows[i].streak, x = out[1].rows[i].streak;
    per.push({ seed: seeds[i], shipped: b, arm: x });
    if (x > b) better++; else if (x < b) worse++;
  }
  console.log(`\n  ${arm.name} vs shipped, paired on seeds ${first}..${first + n - 1}: ` +
    `${better}b/${worse}w/${n - better - worse}t   p=${signTest(better, worse).toFixed(3)}`);
  for (const r of per) {
    console.log(`    seed ${r.seed}  shipped ${r.shipped.toFixed(2).padStart(6)}  ` +
      `${arm.name} ${r.arm.toFixed(2).padStart(6)}  ${r.arm > r.shipped ? '+' : (r.arm < r.shipped ? '-' : '=')}`);
  }
}

/* ---------------------------------------------------------------------
   divergence — the question the brief says matters more than a rating gain.
   Every candidate the league ever screened has a self-play strength (its mean
   pair margin against the incumbent it was screened against) and a fixed-bot
   fitness. If those two are uncorrelated, or anti-correlated, then self-play
   is optimising a different game and the rating is not evidence about the
   tournament.
   --------------------------------------------------------------------- */
function cmdDivergence(devN) {
  const st = loadState();
  const devSeeds = Array.from({ length: devN }, (_, i) => 1 + i);
  const rows = [];
  const seen = new Set();
  for (const e of st.log) {
    if (e.stage !== 'screen' || seen.has(e.name)) continue;
    seen.add(e.name);
    const f = fixedFitness(sourceOf(e.vec), devSeeds);
    rows.push({ name: e.name, margin: e.margin, fitness: f.fitness,
      kills: f.kills, deaths: f.deaths });
    console.log(`  ${e.name.padEnd(8)} selfplay margin ${fmt(e.margin).padStart(7)}   ` +
      `fixed-bot fitness ${f.fitness.toFixed(2).padStart(6)}  (${f.kills.toFixed(1)}k / ${f.deaths.toFixed(2)}d)`);
  }
  for (const m of st.pool) {
    if (seen.has(m.name)) continue;
    const f = fixedFitness(sourceOf(m.vec), devSeeds);
    console.log(`  ${m.name.padEnd(8)} (pool member)             ` +
      `fixed-bot fitness ${f.fitness.toFixed(2).padStart(6)}  (${f.kills.toFixed(1)}k / ${f.deaths.toFixed(2)}d)`);
  }
  if (rows.length >= 3) {
    const r = pearson(rows.map(x => x.margin), rows.map(x => x.fitness));
    const rs = spearman(rows.map(x => x.margin), rows.map(x => x.fitness));
    console.log(`\n  ${rows.length} candidates, ${devN} dev seeds each ` +
      `(${rows.length * devN} fixed-bot matches)`);
    console.log(`  self-play margin vs fixed-bot fitness:  pearson r = ${r.toFixed(3)}   spearman rho = ${rs.toFixed(3)}`);
  }
  fs.writeFileSync(path.join(__dirname, 'selfplay.divergence.json'), JSON.stringify(rows, null, 2));
}

function spearman(a, b) {
  const rank = v => {
    const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(v.length);
    idx.forEach(([, i], k) => { r[i] = k + 1; });
    return r;
  };
  return pearson(rank(a), rank(b));
}

/* ---------------------------------------------------------------------
   confirm — one duel at whatever power you ask for, between two members of
   the league state (or 'shipped'). The gauntlet runs 8 pairs per opponent
   because a gauntlet is |pool| duels wide; a single decisive comparison can
   afford far more, and the pair margin has a standard deviation around 8-10
   kills, so 8 pairs cannot separate anything smaller than a large effect.
   --------------------------------------------------------------------- */
function cmdConfirm(aName, bName, pairsN) {
  const st = loadState();
  const vecOf = n => n === 'shipped' ? TUNED : st.pool.find(m => m.name === n).vec;
  const A = entrantOf(aName, vecOf(aName)), B = entrantOf(bName, vecOf(bName));
  const seeds = Array.from({ length: pairsN }, (_, i) => 70000 + i * 17);
  console.log(`${aName} vs ${bName}: ${pairsN} mirrored pairs (${pairsN * 2} games)\n`);
  const ms = [];
  const d = duel(A, B, seeds, p => {
    ms.push(p.margin);
    process.stdout.write(`${fmt(p.margin)} `);
  });
  const n = ms.length;
  const mean = ms.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(ms.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  console.log(`\n\n  pair score ${d.score.toFixed(3)}  (${d.wins}w/${d.losses}l/${d.ties}t, sign p=${d.p.toFixed(3)})`);
  console.log(`  mean pair margin ${fmt(mean)}  sd ${sd.toFixed(2)}  se ${(sd / Math.sqrt(n)).toFixed(2)}` +
    `  t=${(mean / (sd / Math.sqrt(n))).toFixed(2)}`);
}

function cmdHead(aFile, bFile, pairsN) {
  const load = f => f === 'shipped' ? TUNED : JSON.parse(fs.readFileSync(f, 'utf8')).vec;
  const A = entrantOf('A', load(aFile)), B = entrantOf('B', load(bFile));
  const seeds = Array.from({ length: pairsN }, (_, i) => 4001 + i);
  const d = duel(A, B, seeds, p => console.log(`  seed ${p.seed} score ${p.score.toFixed(2)} margin ${fmt(p.margin)}`));
  console.log(`\n  A score ${d.score.toFixed(3)}  margin ${fmt(d.margin)}  p=${d.p.toFixed(3)}`);
}

module.exports = { duel, pair, game, sourceOf, entrantOf, ratings, fixedFitness,
  NAMES, BOUNDS, TUNED, EVEN, ODD, SECONDS };

if (require.main === module) {
  const cmd = process.argv[2] || 'null';
  if (cmd === 'null') cmdNull(Number(process.argv[3] || 6));
  else if (cmd === 'league') cmdLeague(Number(process.argv[3] || 3), Number(process.argv[4] || 4));
  else if (cmd === 'head') cmdHead(process.argv[3], process.argv[4], Number(process.argv[5] || 8));
  else if (cmd === 'confirm') cmdConfirm(process.argv[3], process.argv[4], Number(process.argv[5] || 24));
  else if (cmd === 'holdout') cmdHoldout(Number(process.argv[3] || 24), Number(process.argv[4] || 1001), process.argv[5]);
  else if (cmd === 'divergence') cmdDivergence(Number(process.argv[3] || 8));
  else { console.error('unknown command ' + cmd); process.exit(2); }
}
