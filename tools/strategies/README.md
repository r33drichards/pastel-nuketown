# Strategy contract

Every strategy is one file in this directory exporting:

```js
module.exports = {
  name: 'mcgs',                 // short, unique, used in the tournament table
  describe: 'one line',         // what the idea is
  policySource: () => '...'     // JS source text, evaluated in the game's vm
};
```

`policySource()` returns **source text**, not a function — it is evaluated
inside the vm that has the real client loaded, so it can close over the game's
globals (`G`, `WBY`, `HIT`, `canSee`, `actorEye`, `tryReload`, `AI`, `MAP`,
`CFG`, ...). It must define a global `POLICY` with:

- `act(me, G, dt)` → `{fwd, strafe, jump, sprint, fire, yaw, pitch}` or `null`
- `reset(seed)` → optional
- `setParams(v)` → **must exist**, may return `null`. The shipped driver calls
  it with the tuned vector on install; a strategy that ignores parameters
  should return `null` rather than throw, or the driver fails to install.

Evaluate with:

```js
const { runMatch, summarise, report } = require('../eval-policy.js');
const rows = [1,2,3].map(seed => runMatch(seed, { policySource: strat.policySource() }));
report(summarise(strat.name, rows));
```

Fitness is the streak, `kills / (deaths + 1)`, maximum 25.0 for a 25-0 match.
`runMatch` returns `{kills, deaths, streak, spent, hits, accuracy, won,
perfect, seconds}`.

Seeds re-seed the bot brains, which is the only entropy that reaches their
behaviour — `bots.js` contains no `Math.random` and every brain is built with
a fixed seed, so without this every match is identical. Arms compared on the
same seeds are paired: the same match, played differently.

## House rules

- Do not modify anything outside your own file(s): not `eval-policy.js`, not
  `sweep.js`, not `nuketown-autoplay.user.js`, and nothing in `src/`.
- Do not run git. Version control is handled centrally.
- The box has 4 cores and several strategies are being developed at once. Use
  ONE node process at a time and keep development runs to ~10 seeds.
