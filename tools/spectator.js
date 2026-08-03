/* =====================================================================
   PASTEL NUKETOWN — SPECTATOR CAMERA
   =====================================================================
   A paste-into-the-console camera. Open the game, press F12, paste this
   whole file into the console, press ENTER, then press V.

   V            spectator on / off
   W A S D      fly (in TOP view: pan across the map)
   SPACE / C    up / down
   SHIFT        3x speed        ALT   quarter speed
   WHEEL        speed (free / top view) or follow distance (follow)
   T            snap to a top-down view of the whole arena
   R            back to free flight from top-down or follow
   F            follow a player   [ ]   previous / next player
   H            hide the HUD and this help card

   WHAT IT DOES AND DOES NOT DO
     This moves the camera and nothing else. The match keeps running, and
     while you are spectating your keys and mouse never reach the game, so
     your own player stands still — visible, shootable, and quite likely to
     be shot. Nobody else's client is touched: this is a local view, not a
     spectator slot on the relay.

     Two things follow from the game being first-person. Your own player has
     no body model — only bots and other people do — so where you are standing
     there is a shadow and a name-less gap. And ESC still releases the mouse,
     which the game reads as "stopped playing" and pauses on; press PLAY (or
     click the canvas) to get the look back.

   HOW IT WORKS
     `frame()` in src/90-main.js calls `updateCamera(dt)` once a frame, and
     that function is a plain global. So spectating is: take that name over,
     place the camera ourselves, and put the original back on the way out.
     Everything else — input, viewmodel, HUD — is restored the same way, so
     turning spectator off leaves the page exactly as it was found.

     Input is swallowed in the CAPTURE phase on `window`. The game listens
     in the bubble phase, so a capture listener is guaranteed to see the
     event first and can stop it there; that is what keeps WASD from walking
     the player around while you fly.

   Re-pasting the file replaces the old copy cleanly. Call
   `NUKETOWN_SPECTATOR.destroy()` to remove it entirely.
   ===================================================================== */
(function () {
  'use strict';

  const DBG = window.NUKETOWN_DEBUG;
  if (!DBG || !DBG.THREE) {
    console.error('[spectator] Pastel Nuketown is not loaded on this page.');
    return;
  }
  if (typeof window.updateCamera !== 'function') {
    console.error('[spectator] no updateCamera() to take over — wrong build?');
    return;
  }
  // A second paste should replace the first, not stack another set of
  // listeners on top of it.
  if (window.NUKETOWN_SPECTATOR) window.NUKETOWN_SPECTATOR.destroy();

  const TOGGLE = 'KeyV';
  const EYE = 1.5;                       // head height to frame in follow mode
  const G = DBG.game;
  const cam = () => DBG.camera;
  const canvas = document.querySelector('canvas');

  const S = {
    on: false,
    mode: 'free',                        // 'free' | 'top' | 'follow'
    yaw: 0, pitch: 0,                    // radians, camera-space (YXZ)
    speed: 16,                           // metres/second
    dist: 6,                             // follow distance
    target: null,                        // followed actor
    held: Object.create(null),
    saved: null                          // what we have to put back
  };

  /* ---- geometry ---------------------------------------------------- */
  /* A three.js camera looks down -Z, and the rig is already rotation.order
     'YXZ', so yaw and pitch go straight in and the basis is closed form —
     no matrix round trip, and no dependency on when matrixWorld was last
     updated. */
  function forward(pitch) {
    const cp = Math.cos(pitch);
    return { x: -Math.sin(S.yaw) * cp, y: Math.sin(pitch), z: -Math.cos(S.yaw) * cp };
  }
  function right() {
    return { x: Math.cos(S.yaw), y: 0, z: -Math.sin(S.yaw) };
  }

  const down = code => !!S.held[code];

  /* ---- the frame --------------------------------------------------- */
  function fly(dt) {
    const k = down('ShiftLeft') || down('ShiftRight') ? 3
            : down('AltLeft') || down('AltRight') ? 0.25 : 1;
    const step = S.speed * k * dt;

    /* Looking straight down, the view forward IS down, so W would fly you
       into the tarmac. Top-down therefore walks the ground plane instead:
       W is "up the screen", which is what a map view has to mean. */
    const f = S.mode === 'top' ? { x: -Math.sin(S.yaw), y: 0, z: -Math.cos(S.yaw) } : forward(S.pitch);
    const r = right();
    const fwd = (down('KeyW') ? 1 : 0) - (down('KeyS') ? 1 : 0);
    const str = (down('KeyD') ? 1 : 0) - (down('KeyA') ? 1 : 0);
    const ver = (down('Space') ? 1 : 0)
              - (down('KeyC') || down('ControlLeft') || down('ControlRight') ? 1 : 0);

    const c = cam();
    c.position.x += (f.x * fwd + r.x * str) * step;
    c.position.y += (f.y * fwd + ver) * step;
    c.position.z += (f.z * fwd + r.z * str) * step;
    c.rotation.set(S.pitch, S.yaw, 0);
  }

  function chase() {
    const a = S.target;
    // Whoever you were following can leave the match, or be a bot the host
    // recycled into a seat. Drop back to flying rather than follow a ghost.
    if (!a || G.actors.indexOf(a) < 0) { S.mode = 'free'; S.target = null; return; }

    const f = forward(S.pitch);
    const hx = a.pos.x, hy = a.pos.y + EYE, hz = a.pos.z;
    /* Pull the boom in when there is something behind them — the same thing
       the death cam does, and for the same reason: a chase camera that goes
       through walls spends half the match inside the bus, looking at the far
       side of a panel. raycastMap also stops on the ground plane, so looking
       up at somebody does not bury the camera in the road. */
    let d = S.dist;
    if (typeof raycastMap === 'function') {
      const h = raycastMap(hx, hy, hz, -f.x, -f.y, -f.z, S.dist + 0.4);
      if (h) d = Math.max(0.5, h.dist - 0.35);
    }
    const c = cam();
    c.position.set(hx - f.x * d, hy - f.y * d, hz - f.z * d);
    c.rotation.set(S.pitch, S.yaw, 0);
  }

  function update(dt) {
    if (S.mode === 'follow') chase(); else fly(dt);
    hudText();
  }

  /* ---- modes ------------------------------------------------------- */
  /* Map is x in [-30,30], z in [-20,20] (mapspec.js). At the 74deg vertical
     FOV this camera runs, 40m up frames the whole arena with room to spare.
     Pitch stops just short of -90deg: exactly -90 is the gimbal pole, where
     yaw and roll fold together and a mouse flick spins the world. */
  function topDown() {
    S.mode = 'top';
    S.yaw = 0;
    S.pitch = -Math.PI / 2 + 0.001;
    const c = cam();
    c.position.set(0, 40, 0);
    c.rotation.set(S.pitch, S.yaw, 0);
  }

  function freeFly() {
    if (S.mode === 'top') S.pitch = -0.6;      // level out, or you fly at the road
    S.mode = 'free';
    S.target = null;
  }

  function follow(dir) {
    const list = G.actors.slice();
    if (!list.length) return;
    let i = list.indexOf(S.target);
    i = i < 0 ? 0 : (i + dir + list.length) % list.length;
    S.target = list[i];
    S.mode = 'follow';
    /* Start behind their shoulder looking where they look. Engine yaw 0 is
       +Z and a three.js camera looks -Z, hence the half turn — the same +PI
       the first-person camera in 90-main.js applies. */
    S.yaw = (S.target.aimYaw || 0) + Math.PI;
    S.pitch = -0.15;
  }

  /* ---- input ------------------------------------------------------- */
  function onKeyDown(e) {
    if (e.code === TOGGLE && !e.repeat) {
      e.stopImmediatePropagation();
      toggle();
      return;
    }
    if (!S.on) return;
    e.stopImmediatePropagation();          // the game never sees these
    S.held[e.code] = true;
    if (e.repeat) return;
    if (e.code === 'KeyT') topDown();
    else if (e.code === 'KeyR') freeFly();
    else if (e.code === 'KeyF') S.mode === 'follow' ? freeFly() : follow(0);
    else if (e.code === 'BracketRight') follow(1);
    else if (e.code === 'BracketLeft') follow(-1);
    else if (e.code === 'KeyH') showChrome(card.style.display === 'none');
  }

  function onKeyUp(e) {
    if (!S.on) return;
    e.stopImmediatePropagation();
    S.held[e.code] = false;
  }

  function onMouseMove(e) {
    if (!S.on) return;
    e.stopImmediatePropagation();
    if (!document.pointerLockElement) return;
    S.yaw -= (e.movementX || 0) * 0.0021;
    S.pitch -= (e.movementY || 0) * 0.0021;
    S.pitch = Math.max(-1.5533, Math.min(1.5533, S.pitch));
    // Any look at all means you are steering, so leave the locked map view.
    if (S.mode === 'top' && Math.abs(S.pitch + Math.PI / 2) > 0.02) S.mode = 'free';
  }

  function onWheel(e) {
    if (!S.on) return;
    e.stopImmediatePropagation();
    const f = e.deltaY > 0 ? 1 / 1.15 : 1.15;
    if (S.mode === 'follow') S.dist = Math.max(1.2, Math.min(40, S.dist / f));
    else S.speed = Math.max(1, Math.min(160, S.speed * f));
  }

  // Firing and the weapon wheel are mouse events too; stop them all.
  function onMouseButton(e) { if (S.on) e.stopImmediatePropagation(); }

  const CAP = { capture: true };
  const LISTENERS = [
    ['keydown', onKeyDown], ['keyup', onKeyUp],
    ['mousemove', onMouseMove], ['mousedown', onMouseButton],
    ['mouseup', onMouseButton], ['wheel', onWheel]
  ];

  /* ---- help card --------------------------------------------------- */
  const card = document.createElement('div');
  card.style.cssText = [
    'position:fixed', 'left:14px', 'bottom:14px', 'z-index:99999',
    'font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace',
    'color:#3a2f4a', 'background:rgba(255,255,255,.82)',
    'border:1px solid rgba(120,100,150,.35)', 'border-radius:10px',
    'padding:9px 12px', 'pointer-events:none', 'white-space:pre',
    'box-shadow:0 6px 18px rgba(80,60,120,.18)', 'display:none'
  ].join(';');
  document.body.appendChild(card);

  const HELP = 'WASD fly   SPACE/C up-down   SHIFT fast   WHEEL speed\n'
             + 'T top-down   R free   F follow   [ ] player   H hide   V exit';
  let lastText = 0;
  function hudText() {
    const now = performance.now();
    if (now - lastText < 120) return;      // 8Hz is plenty for a readout
    lastText = now;
    const p = cam().position;
    const who = S.mode === 'follow' && S.target ? '  ' + S.target.name : '';
    card.textContent = 'SPECTATOR  ' + S.mode.toUpperCase() + who + '\n'
      + 'x ' + p.x.toFixed(1) + '   y ' + p.y.toFixed(1) + '   z ' + p.z.toFixed(1)
      + (S.mode === 'follow' ? '   dist ' + S.dist.toFixed(1) : '   speed ' + S.speed.toFixed(0))
      + '\n' + HELP;
  }

  /* Inline visibility, remembered so the page is handed back exactly as it
     was found — these elements are shown and hidden by class elsewhere, and
     an inline style outranks all of it. */
  const hidden = new Map();
  function hide(id) {
    const el = document.getElementById(id);
    if (!el || hidden.has(id)) return;
    hidden.set(id, el.style.visibility);
    el.style.visibility = 'hidden';
  }
  function unhide(id) {
    const el = document.getElementById(id);
    if (el && hidden.has(id)) el.style.visibility = hidden.get(id);
    hidden.delete(id);
  }

  /* H only ever touches the game HUD and this card. The crosshair and the
     death card stay hidden for as long as spectator is on. */
  function showChrome(on) {
    card.style.display = on ? 'block' : 'none';
    if (on) unhide('hud'); else hide('hud');
  }

  /* ---- on / off ---------------------------------------------------- */
  function enable() {
    if (S.on) return;
    S.on = true;
    S.saved = {
      updateCamera: window.updateCamera,
      noVM: G.frozenNoVM,
      pos: cam().position.clone(),
      rot: cam().rotation.clone()
    };

    /* Take the camera. The original is called for nothing while we hold it:
       it is the whole of the first-person, killcam and title-orbit rig. */
    window.updateCamera = function (dt) { update(dt || 1 / 60); };

    G.frozenNoVM = true;                   // a spectator holds no gun
    hide('cross');
    /* Standing still in a firefight means dying, and the death card is a
       full-screen backdrop blur — spectate through it and the whole arena
       goes soft and white every few seconds. The match still runs and you
       still respawn; you just are not shown the card. */
    hide('dead');

    // Whatever was held when you pressed V would otherwise stay held forever:
    // the game's keyup for it is about to be swallowed by us.
    try { for (const k in KEY) KEY[k] = false; } catch (e) {}
    try { IN.firing = false; } catch (e) {}

    /* Start from wherever you were already looking, so pressing V lifts off
       from the current view instead of teleporting. */
    S.mode = 'free';
    S.target = null;
    S.yaw = cam().rotation.y;
    S.pitch = Math.max(-1.5533, Math.min(1.5533, cam().rotation.x));
    card.style.display = 'block';

    /* A keypress is a user gesture, so this is the one moment the lock can
       be asked for. Without it there is no mouse-look, only the keys. */
    if (canvas && !document.pointerLockElement && canvas.requestPointerLock) {
      try {
        const r = canvas.requestPointerLock();
        if (r && r.catch) r.catch(() => {});
      } catch (e) {}
    }
    console.log('[spectator] on — T top-down, F follow, V to leave');
  }

  function disable() {
    if (!S.on) return;
    S.on = false;
    window.updateCamera = S.saved.updateCamera;
    G.frozenNoVM = S.saved.noVM;
    cam().position.copy(S.saved.pos);
    cam().rotation.copy(S.saved.rot);
    S.held = Object.create(null);
    S.target = null;
    for (const id of Array.from(hidden.keys())) unhide(id);
    card.style.display = 'none';
    console.log('[spectator] off');
  }

  function toggle() { S.on ? disable() : enable(); }

  for (const [type, fn] of LISTENERS) window.addEventListener(type, fn, CAP);

  window.NUKETOWN_SPECTATOR = {
    on: enable,
    off: disable,
    toggle: toggle,
    topDown: () => { enable(); topDown(); },
    follow: n => { enable(); follow(n || 0); },
    state: S,
    destroy() {
      disable();
      for (const [type, fn] of LISTENERS) window.removeEventListener(type, fn, CAP);
      card.remove();
      delete window.NUKETOWN_SPECTATOR;
    }
  };

  console.log('[spectator] loaded — press V (or call NUKETOWN_SPECTATOR.on())');
})();
