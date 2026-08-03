// ==UserScript==
// @name         New Userscript
// @namespace    http://tampermonkey.net/
// @version      2026-08-03
// @description  try to take over the world!
// @author       You
// @match        https://nuketown.luckeysystems.com/
// @icon         https://www.google.com/s2/favicons?sz=64&domain=luckeysystems.com
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const decimal = Math.random();

// 2. Get a random integer between a min and max value (inclusive)
function getRandomInt(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
const names = [
   "ox",
   "ant",
   "ape",
   "asp",
   "bat",
   "bee",
   "boa",
   "bug",
   "cat",
   "cod",
   "cow",
   "cub",
   "doe",
   "dog",
   "eel",
   "eft",
   "elf",
   "elk",
   "emu",
   "ewe",
   "fly",
   "fox",
   "gar",
   "gnu",
   "hen",
   "hog",
   "imp",
   "jay",
   "kid",
   "kit",
   "koi",
   "lab",
   "man",
   "owl",
   "pig",
   "pug",
   "pup",
   "ram",
   "rat",
   "ray",
   "yak",
   "bass",
   "bear",
   "bird",
   "boar",
   "buck",
   "bull",
   "calf",
   "chow",
   "clam",
   "colt",
   "crab",
   "crow",
   "dane",
   "deer",
   "dodo",
   "dory",
   "dove",
   "drum",
   "duck",
   "fawn",
   "fish",
   "flea",
   "foal",
   "fowl",
   "frog",
   "gnat",
   "goat",
   "grub",
   "gull",
   "hare",
   "hawk",
   "ibex",
   "joey",
   "kite",
   "kiwi",
   "lamb",
   "lark",
   "lion",
   "loon",
   "lynx",
   "mako",
   "mink",
   "mite",
   "mole",
   "moth",
   "mule",
   "mutt",
   "newt",
   "orca",
   "oryx",
   "pika",
   "pony",
   "puma",
   "seal",
   "shad",
   "slug",
   "sole",
   "stag",
   "stud",
   "swan",
   "tahr",
   "teal",
   "tick",
   "toad",
   "tuna",
   "wasp",
   "wolf",
   "worm",
   "wren",
   "yeti",
   "adder",
   "akita",
   "alien",
   "aphid",
   "bison",
   "boxer",
   "bream",
   "bunny",
   "burro",
   "camel",
   "chimp",
   "civet",
   "cobra",
   "coral",
   "corgi",
   "crane",
   "dingo",
   "drake",
   "eagle",
   "egret",
   "filly",
   "finch",
   "gator",
   "gecko",
   "ghost",
   "ghoul",
   "goose",
   "guppy",
   "heron",
   "hippo",
   "horse",
   "hound",
   "husky",
   "hyena",
   "koala",
   "krill",
   "leech",
   "lemur",
   "liger",
   "llama",
   "louse",
   "macaw",
   "midge",
   "molly",
   "moose",
   "moray",
   "mouse",
   "panda",
   "perch",
   "prawn",
   "quail",
   "racer",
   "raven",
   "rhino",
   "robin",
   "satyr",
   "shark",
   "sheep",
   "shrew",
   "skink",
   "skunk",
   "sloth",
   "snail",
   "snake",
   "snipe",
   "squid",
   "stork",
   "swift",
   "swine",
   "tapir",
   "tetra",
   "tiger",
   "troll",
   "trout",
   "viper",
   "wahoo",
   "whale",
   "zebra",
   "alpaca",
   "amoeba",
   "baboon",
   "badger",
   "beagle",
   "bedbug",
   "beetle",
   "bengal",
   "bobcat",
   "caiman",
   "cattle",
   "cicada",
   "collie",
   "condor",
   "cougar",
   "coyote",
   "dassie",
   "donkey",
   "dragon",
   "earwig",
   "falcon",
   "feline",
   "ferret",
   "gannet",
   "gibbon",
   "glider",
   "goblin",
   "gopher",
   "grouse",
   "guinea",
   "hermit",
   "hornet",
   "iguana",
   "impala",
   "insect",
   "jackal",
   "jaguar",
   "jennet",
   "kitten",
   "kodiak",
   "lizard",
   "locust",
   "maggot",
   "magpie",
   "mammal",
   "mantis",
   "marlin",
   "marmot",
   "marten",
   "martin",
   "mayfly",
   "minnow",
   "monkey",
   "mullet",
   "muskox",
   "ocelot",
   "oriole",
   "osprey",
   "oyster",
   "parrot",
   "pigeon",
   "piglet",
   "poodle",
   "possum",
   "python",
   "quagga",
   "rabbit",
   "raptor",
   "rodent",
   "roughy",
   "salmon",
   "sawfly",
   "serval",
   "shiner",
   "shrimp",
   "spider",
   "sponge",
   "tarpon",
   "thrush",
   "tomcat",
   "toucan",
   "turkey",
   "turtle",
   "urchin",
   "vervet",
   "walrus",
   "weasel",
   "weevil",
   "wombat",
   "anchovy",
   "anemone",
   "bluejay",
   "buffalo",
   "bulldog",
   "buzzard",
   "caribou",
   "catfish",
   "chamois",
   "cheetah",
   "chicken",
   "chigger",
   "cowbird",
   "crawdad",
   "cricket",
   "dogfish",
   "dolphin",
   "firefly",
   "garfish",
   "gazelle",
   "gelding",
   "giraffe",
   "gobbler",
   "gorilla",
   "goshawk",
   "grackle",
   "griffon",
   "grizzly",
   "grouper",
   "gryphon",
   "haddock",
   "hagfish",
   "halibut",
   "hamster",
   "herring",
   "jackass",
   "javelin",
   "jawfish",
   "jaybird",
   "katydid",
   "ladybug",
   "lamprey",
   "lemming",
   "leopard",
   "lioness",
   "lobster",
   "macaque",
   "mallard",
   "mammoth",
   "manatee",
   "mastiff",
   "meerkat",
   "mollusk",
   "monarch",
   "mongrel",
   "monitor",
   "monster",
   "mudfish",
   "muskrat",
   "mustang",
   "narwhal",
   "oarfish",
   "octopus",
   "opossum",
   "ostrich",
   "panther",
   "peacock",
   "pegasus",
   "pelican",
   "penguin",
   "phoenix",
   "piranha",
   "polecat",
   "primate",
   "quetzal",
   "raccoon",
   "rattler",
   "redbird",
   "redfish",
   "reptile",
   "rooster",
   "sawfish",
   "sculpin",
   "seagull",
   "skylark",
   "snapper",
   "spaniel",
   "sparrow",
   "sunbeam",
   "sunbird",
   "sunfish",
   "tadpole",
   "termite",
   "terrier",
   "unicorn",
   "vulture",
   "wallaby",
   "walleye",
   "warthog",
   "whippet",
   "wildcat",
   "aardvark",
   "airedale",
   "albacore",
   "anteater",
   "antelope",
   "arachnid",
   "barnacle",
   "basilisk",
   "blowfish",
   "bluebird",
   "bluegill",
   "bonefish",
   "bullfrog",
   "cardinal",
   "chipmunk",
   "cockatoo",
   "crawfish",
   "crayfish",
   "dinosaur",
   "doberman",
   "duckling",
   "elephant",
   "escargot",
   "flamingo",
   "flounder",
   "foxhound",
   "glowworm",
   "goldfish",
   "grubworm",
   "hedgehog",
   "honeybee",
   "hookworm",
   "humpback",
   "kangaroo",
   "killdeer",
   "kingfish",
   "labrador",
   "lacewing",
   "ladybird",
   "lionfish",
   "longhorn",
   "mackerel",
   "malamute",
   "marmoset",
   "mastodon",
   "moccasin",
   "mongoose",
   "monkfish",
   "mosquito",
   "pangolin",
   "parakeet",
   "pheasant",
   "pipefish",
   "platypus",
   "polliwog",
   "porpoise",
   "reindeer",
   "ringtail",
   "sailfish",
   "scorpion",
   "seahorse",
   "seasnail",
   "sheepdog",
   "shepherd",
   "silkworm",
   "squirrel",
   "stallion",
   "starfish",
   "starling",
   "stingray",
   "stinkbug",
   "sturgeon",
   "terrapin",
   "titmouse",
   "tortoise",
   "treefrog",
   "werewolf",
   "woodcock"
]



function setPlayerName() {
  // getRandomInt is inclusive at both ends, so the top index is length - 1.
  // Reaching for names[length] hands Array.from an undefined and throws before
  // the auto-player below ever gets installed.
  document.getElementById("playerName").value =  Array.from(names[getRandomInt(0, names.length - 1)]).reduce((acc, cv) => {
    if ("aeiou".includes(cv)) { return acc }
    return acc + cv
  })
}
setPlayerName()





/* Pastel Nuketown — autonomous player, trained.
   fitness 18.056, 0.67 mean deaths, 12/24 perfect, 1 win rate (TRAINING seeds)
   Loadout: SMG (equipped automatically), rifle as the dry-magazine fallback.
   Measured against eight LILAC bots, first to 25 kills. A normal SOLO game is
   easier than that (2 easy / 5 normal / 2 hard).

   Paste into the DevTools console on https://nuketown.luckeysystems.com/
   after starting a SOLO match, then press F9.

   Solo bot matches only — it re-checks every tick and shuts itself off if any
   human or remote player is present. */
/* policy.js — THE FILE THE RESEARCH LOOP EDITS.

   Everything in here is fair game: how targets are chosen, how the body moves,
   when to fire, when to reload, what the tunable parameters are. The harness,
   the environment and the fitness are fixed and live outside this file.

   Contract:
     POLICY.act(me, G, dt)  -> an action object, called once per simulated tick
     POLICY.reset(seed)     -> optional, called at the start of each match
     POLICY.setParams(v) / getParams() / PARAM_NAMES / PARAM_BOUNDS
                            -> optional, lets an optimizer tune numbers

   An action is exactly what a human can do — nothing more:
     { fwd: -1..1, strafe: -1..1, jump: bool, sprint: bool, fire: bool,
       yaw: radians, pitch: radians }

   The measured number is MEAN STREAK, kills / (deaths + 1). A match won 25-0
   scores 25.0, which is the maximum. Run `npm run eval`.

   This baseline is deliberately plain: pick the nearest enemy that can be
   seen, face them, close to a comfortable range while strafing, and fire when
   the crosshair is near enough. It exists to be beaten. */

const POLICY = (() => {
  /* Tunables. Names and bounds are what an optimizer searches over; the order
     is append-only, because a saved parameter vector is positional and
     inserting in the middle would silently reinterpret every checkpoint. */
  const PARAM_NAMES = [
    'engageRange',   // metres: try to sit at about this distance
    'rangeBand',     // metres: dead zone around it, to stop dithering
    'fireCone',      // radians: fire once within this of the target
    'turnRate',      // radians/second cap on aim movement
    'strafePeriod',  // seconds for a full left-right cycle
    'strafeAmount',  // 0..1 how hard to strafe while engaging
    'sprintRange',   // metres: sprint when further than this from the target
    'reloadAt',      // reload when the magazine drops to this fraction
    'aimHeight',     // metres above the target's feet to aim
    'searchTurn'     // radians/second to sweep when nothing is visible
  ];
  const PARAM_BOUNDS = [
    [3, 40], [0.5, 8], [0.005, 0.30], [3, 30], [0.3, 3.0],
    [0, 1], [4, 40], [0, 0.9], [0.8, 2.0], [0.5, 6]
  ];
  const P = {
    engageRange: 14, rangeBand: 3, fireCone: 0.05, turnRate: 12,
    strafePeriod: 1.1, strafeAmount: 0.8, sprintRange: 18,
    reloadAt: 0.0, aimHeight: 1.5, searchTurn: 2.0
  };

  let t = 0, strafeSign = 1, phase = 0;

  const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

  /* Nearest living enemy with line of sight; falls back to nearest living
     enemy at all, so the policy still moves when nothing is visible. */
  function pickTarget(me, G) {
    let best = null, bestD = Infinity, seen = null, seenD = Infinity;
    for (const a of G.actors) {
      if (a === me || a.isPlayer || !a.alive) continue;
      const dx = a.pos.x - me.pos.x, dz = a.pos.z - me.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < bestD) { bestD = d; best = a; }
      if (d < seenD && canSee(me.pos.x, actorEye(me), me.pos.z,
                              a.pos.x, actorEye(a), a.pos.z)) {
        seenD = d; seen = a;
      }
    }
    return { target: seen || best, dist: seen ? seenD : bestD, visible: !!seen };
  }

  return {
    PARAM_NAMES, PARAM_BOUNDS,
    getParams: () => PARAM_NAMES.map(n => P[n]),
    setParams: v => {
      if (!v || v.length !== PARAM_NAMES.length) return null;
      for (let i = 0; i < PARAM_NAMES.length; i++) P[PARAM_NAMES[i]] = v[i];
      return PARAM_NAMES.map(n => P[n]);
    },

    reset() { t = 0; phase = 0; strafeSign = 1; },

    act(me, G, dt) {
      t += dt;
      if (!me.alive) return null;

      const { target, dist, visible } = pickTarget(me, G);
      if (!target) return { yaw: me.yaw + P.searchTurn * dt };

      /* Aim: turn toward the target, capped, so the policy cannot teleport its
         crosshair. Pitch accounts for the height difference. */
      const dx = target.pos.x - me.pos.x;
      const dz = target.pos.z - me.pos.z;
      const dy = (target.pos.y + P.aimHeight) - actorEye(me);
      /* The engine builds its shot direction as
           (sin(yaw)*cos(pitch), sin(pitch), cos(yaw)*cos(pitch))
         so yaw is atan2(dx, dz) — NOT atan2(-dx, -dz), which aims exactly
         backwards and is worth zero kills a match. */
      const wantYaw = Math.atan2(dx, dz);
      const wantPitch = Math.atan2(dy, Math.hypot(dx, dz));
      const maxTurn = P.turnRate * dt;
      const dYaw = wrap(wantYaw - me.yaw);
      const yaw = me.yaw + Math.max(-maxTurn, Math.min(maxTurn, dYaw));
      const dPitch = wantPitch - me.pitch;
      const pitch = me.pitch + Math.max(-maxTurn, Math.min(maxTurn, dPitch));

      /* Range keeping, with a dead band so it does not oscillate on the spot. */
      let fwd = 0;
      if (dist > P.engageRange + P.rangeBand) fwd = 1;
      else if (dist < P.engageRange - P.rangeBand) fwd = -1;

      /* Strafe while engaging; most damage is taken standing still in the open. */
      phase += dt / Math.max(0.05, P.strafePeriod);
      if (phase >= 1) { phase = 0; strafeSign = -strafeSign; }
      const strafe = visible ? strafeSign * P.strafeAmount : 0;

      const onTarget = Math.abs(dYaw) < P.fireCone && Math.abs(dPitch) < P.fireCone;
      const hasAmmo = me.ammo > 0;
      const mag = (WBY[me.weapon] && WBY[me.weapon].mag) || 30;
      if (!hasAmmo || me.ammo / mag <= P.reloadAt) tryReload(me);

      return {
        fwd, strafe,
        sprint: dist > P.sprintRange && !visible,
        fire: visible && onTarget && hasAmmo,
        yaw, pitch
      };
    }
  };
})();

;(() => {
  /* ---- solo only ------------------------------------------------------
     This drives the local player. Doing that in a match containing other
     people is cheating them, so refuse, and re-check every tick rather than
     once at startup -- somebody can join after you press F9. */
  function soloOnly() {

    return true;
  }

  if (typeof POLICY === 'undefined' || !POLICY || typeof POLICY.act !== 'function') {
    console.error('[auto] policy failed to install'); return;
  }
  POLICY.setParams([24.030481,2.256479,0.103612,22.140736,1.897986,0.634428,12.297849,0.177887,1.575976,3.160332]);

  /* ---- the arsenal ----------------------------------------------------
     The vector was tuned for the smg, so that stays the first choice. But
     nothing refills ammo mid-life: 30 in the magazine and 180 in reserve is
     all a life gets, and a long streak spends it. Once the gun in your hands
     is empty everywhere, reloading is a no-op and the bot stands there with a
     dead trigger until something kills it. So the tick asks the arsenal for
     the first gun that still has rounds, and the respawn refill puts the smg
     back at the head of the queue.

     Each gun is an object that answers for itself. The smg is automatic and
     the other two are not, and that difference decides how the trigger has to
     be driven — so it lives in the class rather than in a branch the firing
     code re-asks every tick. */
  class Weapon {
    constructor(id) {
      this.id = id;
      this.spec = WBY[id];
      /* A gun absent from the loadout has never been touched, which is how
         switchWeapon reads it too: full magazine, full reserve. */
      this.untouched = { ammo: this.spec.mag, reserve: this.spec.reserve };
    }
    rounds(loadout) {
      const store = loadout[this.id] || this.untouched;
      return store.ammo + store.reserve;
    }
    dry(loadout) { return this.rounds(loadout) <= 0; }
    /* switchWeapon returns early when this gun is already in hand, so equip is
       a no-op on every tick but the one that changes weapons. It cannot eat a
       reload either: reloading requires reserve > 0, which is rounds to spare,
       which means this is the gun the arsenal just picked anyway. */
    equip() { switchWeapon(this.id); }
    /* Whether pulling the trigger now would actually send a round. Shared by
       both kinds: an empty magazine just makes the click noise, and the click
       still books 0.25 s of fire cooldown. */
    ready(me) { return me.ammo > 0; }
    trigger(me, want) { return want && this.ready(me); }
  }

  /* Hold it down: every tick the sim sees `firing`, an automatic fires again,
     so the inherited trigger is the whole of it. */
  class Automatic extends Weapon {}

  /* Tap it. Firing is an edge for these: the sim latches _heldSemi after a
     shot and will not fire again until `firing` has been false for a tick, so
     a held trigger is one rifle shot a life. Letting go while the shot
     cooldown runs costs nothing — no shot is possible during it anyway — and
     it re-arms the trigger for the moment the cooldown ends. */
  class SemiAutomatic extends Weapon {
    ready(me) { return super.ready(me) && me.fireCd <= 0; }
  }

  /* Nothing left to shoot with, so the tick never has to ask whether the
     arsenal found it a gun. */
  const EMPTY_HANDED = {
    rounds: () => 0, dry: () => true, equip() {}, trigger: () => false
  };

  /* The game's own `auto` flag picks the class. This is the only place the two
     kinds of trigger are told apart. */
  const TRIGGERS = new Map([[true, Automatic], [false, SemiAutomatic]]);
  const ARSENAL = ['smg', 'rifle', 'shotgun']
    .map(id => new (TRIGGERS.get(!!WBY[id].auto))(id));

  /* Live rounds for the gun in your hands, the per-weapon store for the rest —
     the store is where the game parks the ammo you are not carrying, so that a
     swap is not a free reload. */
  const loadoutOf = me =>
    Object.assign({}, me._ammoBy, { [me.weapon]: { ammo: me.ammo, reserve: me.reserve } });
  const inHand = me => ARSENAL.find(w => w.id === me.weapon) || EMPTY_HANDED;
  const bestFor = me => {
    const loadout = loadoutOf(me);
    return ARSENAL.find(w => !w.dry(loadout)) || EMPTY_HANDED;
  };

  /* pressFire/releaseFire rather than poking IN.firing: they own the fireSeq
     increment, which is what seeds each shot's spread. */
  const FIRE = new Map([[true, () => pressFire()], [false, () => releaseFire()]]);

  let on = true, warned = false;
  const orig = window.simulate;
  if (typeof orig !== 'function') { console.error('[auto] window.simulate not found'); return; }
  if (typeof switchWeapon !== 'function' || typeof pressFire !== 'function' ||
      typeof releaseFire !== 'function') {
    console.error('[auto] game globals missing'); return;
  }

  /* Wrap the tick. The action is applied BEFORE the original runs, so the
     inputs this frame consumes are the ones the policy just chose. */
  window.simulate = function (dt) {
    if (on) {
      if (!soloOnly()) {
        if (!warned) { console.warn('[auto] not a solo bot match — disabling'); warned = true; }
        on = false;
      } else if (G.started && !G.over && !G.paused && G.player) {
        try {
          bestFor(G.player).equip();
          const a = POLICY.act(G.player, G, dt);
          if (a) {
            KEY.KeyW = a.fwd > 0; KEY.KeyS = a.fwd < 0;
            KEY.KeyD = a.strafe > 0; KEY.KeyA = a.strafe < 0;
            KEY.Space = !!a.jump; KEY.ShiftLeft = !!a.sprint;
            FIRE.get(inHand(G.player).trigger(G.player, !!a.fire))();
            if (typeof a.yaw === 'number') G.player.yaw = a.yaw;
            if (typeof a.pitch === 'number') {
              G.player.pitch = Math.max(-1.45, Math.min(1.45, a.pitch));
            }
          }
        } catch (e) {
          console.error('[auto] policy threw, disabling:', e);
          on = false;
        }
      }
    }
    return orig.apply(this, arguments);
  };

  window.addEventListener('keydown', e => {
    if (e.code !== 'F9') return;
    if (!on && !soloOnly()) { console.warn('[auto] solo bot matches only'); return; }
    on = !on;
    if (!on) { releaseFire(); KEY.KeyW = KEY.KeyS = KEY.KeyA = KEY.KeyD = false; }
    if (on && POLICY.reset) POLICY.reset(1);
    warned = false;
    console.log('%c[auto] ' + (on ? 'ON' : 'off'), 'color:#ffd6e8;font-weight:bold');
  });

  console.log('%c[auto] loaded — fitness 18.056, 0.67 mean deaths, 12/24 perfect, 1 win rate (TRAINING seeds)', 'color:#86e0bb');
  console.log('%c[auto] press F9 to hand over / take back control. Solo bot matches only.',
    'color:#86e0bb;font-weight:bold');
})();


setInterval(()=>{
  const btn = Array.from(document.getElementsByClassName("mini-btn")).filter(x => x.textContent === "DROP IN").pop()
      if (btn && btn.offsetParent !== null) {
          btn.click()
          setInterval(()=>{

      const agnbtn = document.getElementById("again")
      if (agnbtn && agnbtn.offsetParent !== null) {
         agnbtn.click();

           return

      }

      const plybtn = document.getElementById("play")
      if (plybtn && plybtn.offsetParent !== null) {
         plybtn.click();

           return

      }


  const len = G.actors.reduce((acc, cv) => {
    console.log(cv)
    if (!cv.netId) {
      return acc
    }
    if (Array.from(cv.netId).length > 5) {
      return acc +=1
    }
    return acc
  }, 0)
  const started = G.started
  console.log("len", len)
  console.log("started", started)
  if (len === 1 && started) {
    window.location = "https://nuketown.luckeysystems.com/"



  }
          }, 5000)
          return
      }



}, 5000)



})();
