'use strict';

/* =====================================================================
   selfplay.js — the policy that came out of the self-play league.

   The league lives in selfplay.sweep.js and the arena it plays in lives in
   selfplay.arena.js; read those two for the method. This file is only the
   answer: the incumbent's parameter vector, wrapped in the shipped POLICY
   block and pinned so the driver's own tuned vector cannot land on top of it.

   VECTOR and the numbers behind it are rewritten by the league; see the
   header block below, which is regenerated with them.
   ===================================================================== */

const { userscript, policySource } = require('../eval-policy.js');

/* --- LEAGUE RESULT (regenerated) ------------------------------------- */
const RESULT = {
  incumbent: 'gen0',
  note: 'placeholder — the league has not run yet; this is the shipped vector'
};

const VECTOR = [24.030481, 2.256479, 0.020000, 22.140736, 1.897986,
  0.634428, 12.297849, 0.177887, 1.575976, 3.160332];

function buildSource(vec) {
  return policySource(userscript()) + `
;(() => {
  /* The tournament installs the shipped driver on top of whatever policy it
     is given, and the driver's first act is POLICY.setParams(<tuned>). A
     strategy that is a different point in the same parameter space has to
     refuse that, or it silently runs as the baseline. setParams returning
     null is the contract's own way of saying "no parameters here"
     (strategies/README.md). */
  POLICY.setParams(${JSON.stringify(vec.map(v => Number(v.toFixed(6))))});
  const frozen = POLICY.getParams();
  POLICY.setParams = () => null;
  POLICY.getParams = () => frozen.slice();
})();
`;
}

module.exports = {
  name: 'selfplay',
  describe: 'league-selected vector, rated head-to-head in self-play',
  policySource: () => buildSource(VECTOR),
  buildSource, VECTOR, RESULT
};
