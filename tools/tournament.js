'use strict';

/* The tournament, scaffolded after karpathy/autoresearch.

   Its discipline, not its code -- that repo trains GPTs on a GPU. What carries
   over is the shape that makes autonomous iteration trustworthy:

     a harness nobody edits        eval-policy.js and the real client
     one editable file per idea    tools/strategies/<name>.js
     one fixed budget for all      the same seeds, the same match count
     one number                    fitness = kills / (deaths + 1)
     an append-only journal        tools/strategies/results.jsonl

   Every strategy plays the SAME matches, so arms are paired: a seed that is
   simply hard cancels out instead of adding variance. The leaderboard is the
   mean, but the column that decides anything is the paired sign test against
   the shipped policy -- fitness here is driven by deaths, which are 0, 1 or 2
   a match, and a mean over a handful of those moves on noise.

   Each strategy runs in its own process, so one that throws or hangs is
   recorded as a failure rather than taking the tournament down with it.

   Usage:
     node tools/tournament.js [seeds] [--only name,name]
     node tools/tournament.js --worker <file> <seeds-json>     (internal)
*/

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');

const DIR = path.join(__dirname, 'strategies');
const JOURNAL = path.join(DIR, 'results.jsonl');
/* Scaled to the work, not fixed. A match costs ~4.4 CPU-seconds and workers
   contend, so a flat 15 minutes silently failed a 150-seed entry that was
   merely slow -- which is how `cem: exit null` appeared in the first big run
   and cost the tournament an arm. Budget 30s per seed with a 10 minute floor,
   and a strategy that blows THAT is genuinely stuck. */
const MATCH_TIMEOUT_MS = () => Math.max(10 * 60 * 1000, 30 * 1000 * SEEDS.length);

/* ---- worker: one strategy, all seeds ---------------------------------- */
if (process.argv[2] === '--worker') {
  const file = process.argv[3];
  const seeds = JSON.parse(process.argv[4]);
  const { runMatch } = require('./eval-policy.js');
  const strat = require(file);
  if (!strat || typeof strat.policySource !== 'function') {
    console.error(`${path.basename(file)} does not export policySource() — see strategies/README.md`);
    process.exit(2);
  }
  const source = strat.policySource();
  const rows = [];
  for (const seed of seeds) {
    rows.push(runMatch(seed, { policySource: source }));
    if (process.send) process.send({ progress: rows.length });
  }
  process.send({ done: true, name: strat.name, describe: strat.describe || '', rows });
  process.exit(0);
}

/* ---- parent ----------------------------------------------------------- */
const SEEDS_N = Number(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 24);
const onlyArg = process.argv.indexOf('--only');
const ONLY = onlyArg > 0 ? process.argv[onlyArg + 1].split(',') : null;
/* Held out by default, and not seeds 1..N.

   The forensics found the shipped policy dies 0.71 times a match on seeds
   1-24 against 0.92 and 1.08 on two later blocks. Whatever the cause, the
   low seeds are the ones every strategy here was developed against, and a
   tournament run on them scores the baseline on its home ground. Start the
   seed window somewhere nobody has been. */
const fromArg = process.argv.indexOf('--from');
const FIRST = fromArg > 0 ? Number(process.argv[fromArg + 1]) : 1001;
const SEEDS = Array.from({ length: SEEDS_N }, (_, i) => FIRST + i);

/* The shipped policy is always in the field: a strategy that cannot beat what
   is already installed is not a result, whatever its mean says. */
const BASELINE = path.join(DIR, '_baseline.js');
if (!fs.existsSync(BASELINE)) {
  fs.writeFileSync(BASELINE, `'use strict';
/* The policy currently in the userscript. Written once, by the tournament, so
   the field always contains the thing a challenger has to beat. */
const { userscript, policySource } = require('../eval-policy.js');
module.exports = {
  name: 'shipped',
  describe: 'the tuned reactive policy in the userscript',
  policySource: () => policySource(userscript())
};
`);
}

/* A strategy directory collects helpers too -- diagnostics, sweeps, notes.
   Only files that are entries get entered; the rest are not failures. */
const NOT_AN_ENTRY = /\.(analysis|test|util|helper|sweep|arena|train)\.js$/;
const files = fs.readdirSync(DIR)
  .filter(f => f.endsWith('.js') && !NOT_AN_ENTRY.test(f))
  .filter(f => !ONLY || ONLY.some(n => f === n || f === n + '.js' || f === '_' + n + '.js'))
  .map(f => path.join(DIR, f));

if (!files.length) { console.error('no strategies in ' + DIR); process.exit(1); }

console.log(`${files.length} strategies x ${SEEDS.length} seeds ` +
  `(${SEEDS[0]}..${SEEDS[SEEDS.length - 1]}), paired\n`);

const results = [];
let next = 0, running = 0;
const slots = Math.max(1, Math.min(os.cpus().length, 4));

function launch() {
  while (running < slots && next < files.length) {
    const file = files[next++];
    running++;
    const started = Date.now();
    const w = fork(__filename, ['--worker', file, JSON.stringify(SEEDS)],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    w.stderr.on('data', d => { stderr += d.toString(); });
    const lastLines = n => stderr.trim().split('\n').filter(Boolean).slice(-n).join(' | ');
    const kill = setTimeout(() => { w.kill('SIGKILL'); }, MATCH_TIMEOUT_MS());
    let payload = null;
    w.on('message', m => { if (m.done) payload = m; });
    w.on('exit', code => {
      clearTimeout(kill);
      running--;
      if (payload) {
        results.push({ ...payload, file: path.basename(file), ms: Date.now() - started });
        console.log(`  ok    ${payload.name}`);
      } else {
        const why = lastLines(3) || `exit ${code}`;
        results.push({ name: path.basename(file, '.js'), failed: true, error: why.slice(0, 400) });
        console.log(`  FAIL  ${path.basename(file)} — ${why.slice(0, 160)}`);
      }
      if (running === 0 && next >= files.length) finish();
      else launch();
    });
  }
}

/* Exact two-sided sign test on the paired per-seed fitnesses. */
function signTest(base, arm) {
  let better = 0, worse = 0;
  for (let i = 0; i < base.length; i++) {
    if (!base[i] || !arm[i]) continue;
    if (arm[i].streak > base[i].streak) better++;
    else if (arm[i].streak < base[i].streak) worse++;
  }
  const n = better + worse;
  const choose = (N, k) => { let r = 1; for (let i = 0; i < k; i++) r = r * (N - i) / (i + 1); return r; };
  let p = 0;
  for (let i = 0; i <= Math.min(better, worse); i++) p += choose(n, i);
  return { better, worse, ties: base.length - n, p: n ? Math.min(1, 2 * p / Math.pow(2, n)) : 1 };
}

function finish() {
  const ok = results.filter(r => !r.failed);
  const base = ok.find(r => r.name === 'shipped');
  const mean = (rows, f) => rows.reduce((a, r) => a + f(r), 0) / rows.length;

  const table = ok.map(r => ({
    name: r.name,
    describe: r.describe,
    fitness: mean(r.rows, x => x.streak),
    kills: mean(r.rows, x => x.kills),
    deaths: mean(r.rows, x => x.deaths),
    perfect: r.rows.filter(x => x.perfect).length,
    wins: r.rows.filter(x => x.won).length,
    rounds: mean(r.rows, x => x.spent),
    accuracy: mean(r.rows, x => x.accuracy),
    sign: base && r.name !== 'shipped' ? signTest(base.rows, r.rows) : null
  })).sort((a, b) => b.fitness - a.fitness);

  console.log('\n' + '='.repeat(112));
  console.log(`LEADERBOARD  (${SEEDS.length} paired matches, fitness = kills / (deaths + 1), max 25.0)`);
  console.log('='.repeat(112));
  console.log('  strategy      fitness  kills  deaths  perfect  won   rounds  hit   vs shipped');
  for (const t of table) {
    const s = t.sign
      ? `${t.sign.better}b/${t.sign.worse}w/${t.sign.ties}t  p=${t.sign.p.toFixed(3)}` +
        (t.sign.p < 0.05 ? '  *' : '')
      : '(baseline)';
    console.log(
      `  ${t.name.padEnd(13)} ${t.fitness.toFixed(2).padStart(6)}` +
      ` ${t.kills.toFixed(1).padStart(6)} ${t.deaths.toFixed(2).padStart(7)}` +
      ` ${String(t.perfect).padStart(6)}/${SEEDS.length} ${String(t.wins).padStart(4)}` +
      ` ${t.rounds.toFixed(0).padStart(7)} ${(t.accuracy * 100).toFixed(0).padStart(4)}%  ${s}`);
  }
  const failed = results.filter(r => r.failed);
  if (failed.length) {
    console.log('\n  did not finish:');
    for (const f of failed) console.log(`    ${f.name}: ${f.error}`);
  }
  console.log('\n  * significant at p < 0.05 on the paired sign test.' +
    '\n  Deaths are 0, 1 or 2 a match, so read the sign test before the mean.');

  /* Append-only journal, one line per run, so a later run can be compared with
     an earlier one rather than replacing it. */
  const stamp = new Date().toISOString();
  for (const t of table) {
    fs.appendFileSync(JOURNAL, JSON.stringify({
      at: stamp, seeds: SEEDS.length, firstSeed: SEEDS[0], ...t,
      sign: t.sign ? { ...t.sign } : null
    }) + '\n');
  }
  console.log(`\n  journal: ${path.relative(process.cwd(), JOURNAL)}`);
}

launch();
