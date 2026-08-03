'use strict';

/* Paired A/B for the fire gate, plus a sweep of the knob it introduces.

   Both arms play identical matches: same seeds, same bot brains, same map.
   The baseline arm is the previous committed userscript, read out of git, so
   it is the text that actually shipped rather than a reconstruction of it.

   Usage: node tools/ab-firecone.js [matches] [gitref] */

const { execFileSync } = require('node:child_process');
const { runMatch, summarise, report, userscript } = require('./eval-policy.js');

const MATCHES = Number(process.argv[2] || 12);
const REF = process.argv[3] || 'HEAD';

const before = execFileSync('git', ['show', `${REF}:tools/nuketown-autoplay.user.js`],
  { cwd: __dirname + '/..', encoding: 'utf8' });
const after = userscript();

const seeds = Array.from({ length: MATCHES }, (_, i) => i + 1);
const arm = (name, opts) => {
  const rows = seeds.map(s => runMatch(s, opts));
  const sum = summarise(name, rows);
  report(sum);
  return sum;
};

console.log(`paired over ${MATCHES} matches, seeds ${seeds[0]}..${seeds[seeds.length - 1]}\n`);
const base = arm(`${REF}`, { src: before });
const cone = arm('firecone', { src: after });

/* The knob the change adds: how many multiples of the target's own angular
   width still counts as on it. Swept on the same matches. */
const TUNED = [24.030481, 2.256479, 0.103612, 22.140736, 1.897986,
               0.634428, 12.297849, 0.177887, 1.575976, 3.160332];
console.log('');
const sweep = [0.6, 1.0, 1.6, 2.4, 3.5].map(slack =>
  arm(`slack ${slack}`, { src: after, params: TUNED.concat([slack]) }));

console.log('');
const winner = sweep.concat([cone]).reduce((a, b) => b.fitness > a.fitness ? b : a);
console.log(`baseline ${base.fitness.toFixed(3)}  ->  best ${winner.name} ${winner.fitness.toFixed(3)}` +
  `   (${((winner.fitness / base.fitness - 1) * 100).toFixed(0)}% on fitness,` +
  ` ${((1 - winner.rounds / base.rounds) * 100).toFixed(0)}% fewer rounds)`);

/* Paired per-seed comparison: a mean over 12 noisy matches can move on one
   lucky seed, so show how many seeds actually improved. */
const better = seeds.filter((s, i) => winner.rows[i].streak > base.rows[i].streak).length;
const worse = seeds.filter((s, i) => winner.rows[i].streak < base.rows[i].streak).length;
console.log(`per-seed: ${better} better, ${worse} worse, ${MATCHES - better - worse} unchanged`);
