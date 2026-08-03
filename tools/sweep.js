'use strict';

/* Paired multi-arm evaluation, run across cores.

   Every arm plays the SAME matches -- same seeds, same bot brains -- so arms
   can be compared seed by seed rather than only in the mean. That matters
   here: every arm wins 25-0-ish, so fitness is driven entirely by deaths,
   which are 0, 1 or 2 per match. A mean over a dozen coarse integers moves
   on noise, and the first sweep showed it: two opposite ends of the coneSlack
   range tied for first with the middle below both.

   So the headline is not the mean. It is the paired sign test against the
   baseline arm: of the seeds where the two arms differ, how many favour the
   candidate, and how likely is that split by chance alone.

   Usage: node tools/sweep.js [seeds] [--matches-per-worker]
          node tools/sweep.js --worker '<json>'      (internal)
*/

const os = require('node:os');
const path = require('node:path');
const { execFileSync, fork } = require('node:child_process');
const { runMatch, userscript } = require('./eval-policy.js');


/* ---- worker ---------------------------------------------------------- */
if (process.argv[2] === '--worker') {
  const job = JSON.parse(process.argv[3]);
  const sources = job.sources;
  process.on('message', msg => {
    if (!msg || msg.done) { process.exit(0); }
    const r = runMatch(msg.seed, {
      src: sources[msg.arm.src],
      overrides: msg.arm.overrides || undefined
    });
    process.send({ arm: msg.arm.name, seed: msg.seed, row: r });
  });
  process.send({ ready: true });
  return;
}

/* ---- parent ---------------------------------------------------------- */
const SEEDS = Number(process.argv[2] || 40);
const ROOT = path.join(__dirname, '..');
/* Pinned, not HEAD~1: the baseline is the last commit whose fire gate was the
   constant angle, and it stops being the previous commit the moment anything
   else lands. A relative ref here would quietly start comparing the change
   against itself. */
const BASE_REF = process.argv[3] || '423a4a2';
/* name=value,value,... e.g. coneSlack=0.6,3.5 */
const KNOB = (process.argv[4] || 'coneSlack=0.6,3.5');
const [KNOB_NAME, KNOB_VALUES] = KNOB.split('=');
const VALUES = KNOB_VALUES.split(',').map(Number);
/* `now` as the ref compares the working tree against itself with one knob
   moved, which is what isolates a single parameter. A committed ref compares
   against a different file, which measures the whole diff -- right for "did
   this change help", wrong for "what should this knob be set to". */
const sources = {
  head: BASE_REF === 'now' ? userscript()
    : execFileSync('git', ['show', `${BASE_REF}:tools/nuketown-autoplay.user.js`],
      { cwd: ROOT, encoding: 'utf8' }),
  now: userscript()
};

const ARMS = [{ name: 'baseline', src: 'head' }].concat(
  VALUES.map(v => ({
    name: `${KNOB_NAME} ${v}`, src: 'now', overrides: { [KNOB_NAME]: v }
  })));

const jobs = [];
for (const arm of ARMS) for (let s = 1; s <= SEEDS; s++) jobs.push({ arm, seed: s });
const results = new Map(ARMS.map(a => [a.name, new Map()]));

let next = 0, outstanding = 0;
const workers = [];
const nWorkers = Math.max(1, Math.min(os.cpus().length, 4));
console.log(`${ARMS.length} arms x ${SEEDS} seeds = ${jobs.length} matches on ${nWorkers} workers\n`);

function pump(w) {
  if (next >= jobs.length) { w.send({ done: true }); return; }
  const job = jobs[next++];
  outstanding++;
  w.send(job);
}

for (let i = 0; i < nWorkers; i++) {
  const w = fork(__filename, ['--worker', JSON.stringify({ sources })], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  workers.push(w);
  w.on('message', msg => {
    if (msg.ready) { pump(w); return; }
    results.get(msg.arm).set(msg.seed, msg.row);
    outstanding--;
    const done = jobs.length - (jobs.length - next) - outstanding;
    if (done % 20 === 0) process.stdout.write(`  ${done}/${jobs.length}\r`);
    pump(w);
  });
  w.on('exit', () => { if (workers.every(x => x.exitCode !== null)) finish(); });
}

/* Two-sided sign test on the paired per-seed streaks. Exact binomial, which
   is the right test for "of the seeds that differ, how many went our way". */
function signTest(base, arm, seeds) {
  let better = 0, worse = 0;
  for (const s of seeds) {
    const a = base.get(s), b = arm.get(s);
    if (!a || !b) continue;
    if (b.streak > a.streak) better++;
    else if (b.streak < a.streak) worse++;
  }
  const n = better + worse;
  const choose = (n, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (n - i) / (i + 1); return r; };
  let p = 0;
  const k = Math.min(better, worse);
  for (let i = 0; i <= k; i++) p += choose(n, i);
  p = n ? Math.min(1, 2 * p / Math.pow(2, n)) : 1;
  return { better, worse, ties: seeds.length - n, p };
}

function finish() {
  const seeds = Array.from({ length: SEEDS }, (_, i) => i + 1);
  const base = results.get('baseline');
  const stat = rows => {
    const list = seeds.map(s => rows.get(s)).filter(Boolean);
    const mean = f => list.reduce((a, r) => a + f(r), 0) / list.length;
    return {
      n: list.length,
      fitness: mean(r => r.streak),
      deaths: mean(r => r.deaths),
      kills: mean(r => r.kills),
      perfect: list.filter(r => r.perfect).length,
      wins: list.filter(r => r.won).length,
      rounds: mean(r => r.spent),
      accuracy: mean(r => r.accuracy)
    };
  };
  console.log(' '.repeat(30) + '\r');
  for (const arm of ARMS) {
    const s = stat(results.get(arm.name));
    const t = arm.name === 'baseline' ? null : signTest(base, results.get(arm.name), seeds);
    console.log(
      `${arm.name.padEnd(10)} fitness ${s.fitness.toFixed(2).padStart(6)}` +
      `  deaths ${s.deaths.toFixed(2)}` +
      `  perfect ${String(s.perfect).padStart(2)}/${s.n}` +
      `  won ${s.wins}/${s.n}` +
      `  rounds ${s.rounds.toFixed(0).padStart(3)}` +
      `  hit ${(s.accuracy * 100).toFixed(0)}%` +
      (t ? `   vs baseline: ${t.better} better / ${t.worse} worse / ${t.ties} tied,  p=${t.p.toFixed(3)}` : ''));
  }
}
