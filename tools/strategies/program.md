# program.md — the standing brief

Modelled on karpathy/autoresearch's `program.md`: humans set strategy here,
agents edit only their own strategy file, and the harness and the metric never
move underneath a result.

## The goal

Fitness is `kills / (deaths + 1)`, measured over paired matches against the
game's own bots. A 25-0 match scores 25.0, the maximum. **Perfect fitness means
never dying**, which is the actual target — the shipped policy already takes all
25 kills and wins every match; it loses fitness to roughly 0.8 deaths a match.

So: kills are solved. Deaths are the entire remaining problem. A strategy that
kills faster and dies the same amount scores the same. A strategy that kills
slower and never dies wins outright.

## The rules that do not move

1. **The harness is fixed.** `tools/eval-policy.js` runs the real client from
   `src/*.js` inside net-sim.js's vm. Nobody edits it. If it seems wrong, say
   so — do not work around it.
2. **One file per idea**, in `tools/strategies/`, exporting the contract in
   `README.md`.
3. **One budget for everyone.** The tournament gives every strategy the same
   seeds and the same match count. No strategy gets to pick its own.
4. **One number.** Fitness. Report others for insight, rank on that.
5. **The sign test decides, not the mean.** Deaths are 0, 1 or 2 a match, so a
   mean over a handful of matches moves on noise. `tools/tournament.js` reports
   the paired sign test against the shipped policy; that is the column that
   settles whether something works.

## What is already known

- The shipped policy is reactive and stateless beyond a strafe phase. It never
  reads `me.health` or `me.shield`, never uses the `cover` score that
  `AI.buildNav(MAP)` computes for all 3156 nav nodes, and fights one-versus-
  three exactly as it fights one-versus-one.
- Tightening the fire gate did nothing offline (360 matches, p=0.81) but was
  worth ~12 points of hit registration and ~10% more kills online, where
  prediction and authority can disagree. Offline and online are different
  problems; this tournament measures offline.
- A burst-fire cadence cut rounds spent by 8% (p=0.006) and changed kills and
  deaths not at all (p=0.51). Ammo is not the binding constraint.
- Bots carry fixed seeds and `bots.js` has no `Math.random`, so match variety
  comes only from re-seeding the brains, which the harness does per seed.

## Reporting

Say what you tried, what the numbers were, and what you would do next. A
negative result stated clearly is worth more than a positive one that does not
replicate — several confident-looking wins in this project have already
evaporated when the seed count went up.
