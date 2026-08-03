'use strict';

/* Does the bot's shot selection cost it hit registration online?

   A hitmarker is the guest's own prediction: its local hitscan connected, so
   it draws the marker at once. The damage is decided on the host, which
   re-runs the shot against a rewound world -- and the rewind is clamped to
   what the connection has actually been running at, not granted as asked. A
   shot that only clipped the hitbox on the guest's screen is the one a small
   rewind discrepancy flips to a miss, and the marker stands with nothing
   behind it.

   The claim under test: the policy fires the instant its crosshair crosses a
   target, so a much larger share of its shots are marginal than a human's
   would be, and it should therefore lose more of its markers. If that is
   right, tightening fireCone -- firing only when properly centred -- should
   raise the fraction of markers the host backs with damage.

   Both sides are the real client, joined through net-sim.js's modelled relay
   at a real latency. Counted:
     markers  -- showHitmarker on the guest, the marker actually drawn
     landed   -- applyDamage on the HOST attributed to the guest's actor
   and the ratio between them is the answer.

   Usage: node tools/guest-hitreg.js [seconds] [latencyMs]
*/

const { createMatch, GUEST_ID, FIXED } = require('../net-sim.js');
const { userscript, policySource, driverSource } = require('./eval-policy.js');

/* HOST_SHOTS is the instrument's own check. If the host does not fire roughly
   the same number of rounds the guest thinks it fired, the shortfall is an
   input-path fault and every ratio below is measuring that instead. */
const HOST_COUNT = `
  var LANDED = 0, HOST_SHOTS = 0;
  const _applyDamage = applyDamage;
  applyDamage = function (target, dmg, from) {
    if (from && from.netId === ${JSON.stringify(GUEST_ID)}) LANDED++;
    return _applyDamage.apply(this, arguments);
  };
  const _hostFire = fireWeapon;
  fireWeapon = function (a) {
    const before = a.ammo;
    const out = _hostFire.apply(this, arguments);
    if (a && a.netId === ${JSON.stringify(GUEST_ID)} && a.ammo < before) HOST_SHOTS++;
    return out;
  };
`;

/* showHitmarker fires only when a marker is actually drawn, which is what the
   player sees; netPredictHit has its own early exits (a shielded target, a
   ledger refusal) that never reach the screen. */
const GUEST_COUNT = `
  var MARKERS = 0, SHOTS = 0;
  const _showHitmarker = showHitmarker;
  showHitmarker = function (head) { MARKERS++; return _showHitmarker.apply(this, arguments); };
  const _fireWeapon = fireWeapon;
  fireWeapon = function (a) {
    const before = a.ammo;
    const out = _fireWeapon.apply(this, arguments);
    if (a === G.player && a.ammo < before) SHOTS++;
    return out;
  };
`;

function overrideParams(inst, overrides) {
  if (!overrides) return;
  inst.run(`{
    const v = POLICY.getParams(), names = POLICY.PARAM_NAMES;
    const o = ${JSON.stringify(overrides)};
    for (const k of Object.keys(o)) {
      const i = names.indexOf(k);
      if (i < 0) throw new Error('no such parameter: ' + k);
      v[i] = o[k];
    }
    if (!POLICY.setParams(v)) throw new Error('setParams rejected');
  }`);
}

function run(opts) {
  const src = userscript();
  const match = createMatch({
    latencyMs: opts.latencyMs, jitterMs: opts.jitterMs || 0,
    seed: opts.seed || 1, combatants: 9
  });

  match.host.run(HOST_COUNT);
  match.guest.run(GUEST_COUNT);
  /* The policy drives the GUEST -- the side that has to predict. */
  match.guest.run(policySource(src));
  match.guest.run(driverSource(src));
  overrideParams(match.guest, opts.overrides);
  /* Same bots on the authority for every arm, so the arms face one match. */
  match.host.run(`for (const a of G.actors) { if (a.brain)
    a.brain = AI.createBrain({ id: a.id, seed: ${opts.seed || 1} * 7919 + a.id * 131, skill: a.skill }); }`);

  const ticks = Math.round(opts.seconds / FIXED);
  for (let i = 0; i < ticks; i++) match.tick();

  const markers = match.guest.get('MARKERS') || 0;
  const shots = match.guest.get('SHOTS') || 0;
  const hostShots = match.host.get('HOST_SHOTS') || 0;
  const landed = match.host.get('LANDED') || 0;
  return {
    shots, hostShots, markers, landed,
    backed: markers > 0 ? landed / markers : 0,
    kills: match.host.get(`(G.actors.find(a => a.netId === ${JSON.stringify(GUEST_ID)}) || {}).kills`) || 0
  };
}

const seconds = Number(process.argv[2] || 60);
const SEEDS = [1, 2, 3, 4];
const LATENCIES = (process.argv[3] || '20,96,200').split(',').map(Number);

/* Explicit values rather than "whatever the file ships": the shipped default
   is the thing under test, so an arm defined as its absence moves with it.
   0.015 rad is a body's own angular half-width at the 24m this policy
   engages at, so the sweep brackets it. */
const ARMS = (process.argv[4] || '0.103612,0.05,0.02,0.01').split(',').map(v => ({
  name: 'cone ' + v, overrides: { fireCone: Number(v) }
}));

console.log(`${seconds}s per match, ${SEEDS.length} seeds, guest driven by the policy\n`);
console.log('latency  arm          guest shots  host shots  markers  landed  backed   kills');
for (const ms of LATENCIES) {
  for (const arm of ARMS) {
    const rows = SEEDS.map(seed => run({ ...arm, seconds, latencyMs: ms, seed }));
    const sum = k => rows.reduce((a, r) => a + r[k], 0);
    const markers = sum('markers'), landed = sum('landed');
    console.log(
      `${(ms + 'ms').padEnd(8)} ${arm.name.padEnd(12)} ` +
      `${String(sum('shots')).padStart(11)} ${String(sum('hostShots')).padStart(11)}` +
      ` ${String(markers).padStart(8)} ${String(landed).padStart(7)}` +
      ` ${(markers ? (100 * landed / markers).toFixed(1) + '%' : '  -').padStart(7)}` +
      ` ${String(sum('kills')).padStart(7)}`);
  }
}
