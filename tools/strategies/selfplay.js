'use strict';

/* =====================================================================
   selfplay.js — the policy the self-play league promoted, and the reason
   you should not trust the league that promoted it.

   The machinery is in two other files:
     selfplay.arena.js   the arena: N of the 8 bot slots driven by POLICY
                         objects instead of by bots.js brains
     selfplay.sweep.js   the league: mirrored head-to-head duels, a pool of
                         past versions, Bradley-Terry ratings, promotion rule

   WHAT THE LEAGUE DID
   -------------------
   Pool started as {gen0} = the shipped tuned vector. Three generations, four
   candidates screened per generation (a 10% jitter off the incumbent), the
   best of each screened batch put through a full gauntlet against every pool
   member at 8 mirrored pairs (16 games) each.

     gen 0   g1c1 gauntlet vs gen0: pair score 0.625 (5w/3l), p=0.727
             -> PROMOTED under the stated rule (score >= 0.58, worst >= 0.40,
                dev fitness within 1.0 of the incumbent)
     gen 1   nothing beat the incumbent in screening; no gauntlet
     gen 2   g2c2 scored 0.563 against gen0 but 0.250 against g1c1 -> rejected
             by the anti-cycling clause. That is the pool of ancestors doing
             exactly the job it is there for: a candidate that beats the
             grandparent and loses to the parent is a rotation, not progress.

   WHY THE PROMOTION IS NOT BELIEVED
   ---------------------------------
   g1c1 was re-played against gen0 on a fresh, disjoint block of seeds at
   three times the power — 24 mirrored pairs, 48 games:

       pair score 0.271 (6w/17l/1t, sign p=0.035)
       mean pair margin -6.23 kills, sd 10.25, se 2.09, t = -2.98

   So the promoted challenger is SIGNIFICANTLY WORSE in self-play than the
   thing it replaced. The 16-game gauntlet was noise: pair margins have a
   standard deviation near 10 kills, so 8 pairs carry a standard error of 3.6
   and a 5-3 result is nothing at all. A gauntlet that decides anything needs
   ~24 mirrored pairs per opponent, which is ~3.5 CPU-minutes per duel.

   AND YET — THE DIVERGENCE, WHICH IS THE ACTUAL RESULT
   ----------------------------------------------------
   On the tournament's own metric, against the eight FIXED bots, on the
   held-out window (seeds 1001..1024, 24 paired matches):

       shipped   fitness 15.02   25.0 kills   0.92 deaths    6/24 perfect
       g1c1      fitness 18.52   25.0 kills   0.71 deaths   13/24 perfect
       paired sign test  10b / 4w / 10t   p = 0.180

   The two numbers point in OPPOSITE directions. The policy self-play rates as
   clearly worse is the policy the fixed-bot tournament rates as better, by
   3.5 fitness and seven extra perfect matches. Measured across all eight
   distinct candidates the league screened (8 dev seeds each, 64 fixed-bot
   matches), the correlation between self-play margin and fixed-bot fitness is

       pearson r = -0.374,  spearman rho = -0.262     (n = 8, not significant)

   which has the same sign. The mechanism is not mysterious: the forensics say
   94% of this policy's deaths are headshots from `hard` bots holding the
   RIFLE, 88% of them a single damage event, median time from first damage to
   death 0.00 s. Self-play opponents are SMG policies at 5.3 m/s that cannot
   one-shot anybody. Getting better at that fight is a different skill.

   SO WHAT IS IN THIS FILE
   -----------------------
   g1c1: the vector the league's stated rule promoted, on self-play evidence
   alone, before any held-out measurement existed. Shipping it keeps the
   selection honest — the held-out numbers above are a REPORT on that choice,
   not the reason for it. The self-play retest and the held-out fitness are
   both stated so the entry can be read either way.

   If you want the league's post-confirmation incumbent instead, it is gen0,
   which is byte-for-byte the shipped vector.
   ===================================================================== */

const { userscript, policySource } = require('../eval-policy.js');

/* --- what the league produced ---------------------------------------- */
const RESULT = {
  promoted: 'g1c1',
  from: 'gen0 (the shipped tuned vector)',
  leagueGauntlet: { pairs: 8, games: 16, score: 0.625, signP: 0.727 },
  confirmation: { pairs: 24, games: 48, score: 0.271, meanPairMargin: -6.23,
                  signP: 0.035, verdict: 'worse in self-play, significantly' },
  heldOutFixedBots: { seeds: '1001..1024', shipped: 15.017, selfplay: 18.524,
                      better: 10, worse: 4, ties: 10, signP: 0.180 },
  divergence: { candidates: 8, pearson: -0.374, spearman: -0.262 },
  matchesRun: { arenaGames: 229, fixedBotMatches: 140, total: 369,
                cpuMinutes: 27, processes: 1 }
};

/* engageRange rangeBand fireCone turnRate strafePeriod
   strafeAmount sprintRange reloadAt aimHeight searchTurn */
const VECTOR = [27.150469, 1.841677, 0.019301, 23.879453, 1.732791,
  0.559684, 10.884784, 0.211233, 1.588818, 3.636002];

const SHIPPED = [24.030481, 2.256479, 0.020000, 22.140736, 1.897986,
  0.634428, 12.297849, 0.177887, 1.575976, 3.160332];

function buildSource(vec) {
  return policySource(userscript()) + `
;(() => {
  /* The tournament installs the shipped driver on top of whatever policy it
     is handed, and the driver's first act is POLICY.setParams(<the shipped
     tuned vector>). A strategy that is a different point in the SAME
     parameter space has to refuse that or it silently runs as the baseline
     and reports the baseline's number as its own. setParams returning null is
     the contract's own way of saying "no parameters here"
     (strategies/README.md), so that is what it returns. */
  POLICY.setParams(${JSON.stringify(vec.map(v => Number(v.toFixed(6))))});
  const frozen = POLICY.getParams();
  POLICY.setParams = () => null;
  POLICY.getParams = () => frozen.slice();
})();
`;
}

module.exports = {
  name: 'selfplay',
  describe: 'league-promoted vector; beaten in self-play, ahead on fixed bots',
  policySource: () => buildSource(VECTOR),
  buildSource, VECTOR, SHIPPED, RESULT
};
