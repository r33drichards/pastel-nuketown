/* =====================================================================
   PASTEL NUKETOWN — spectator freecam  (console tool, not shipped)
   =====================================================================
   Paste the whole file into the browser console during a match. Paste it
   again — or press V — to drop back into your body.

     WASD          fly (where you are looking)
     SPACE / CTRL  up / down
     SHIFT / ALT   3.5x / 0.25x
     WHEEL         cruise speed
     V             toggle
     click         grab the mouse back after using the console

   While it is on, your body stands still, takes no damage, stops no
   bullets and is invisible to the bots, so the match you are watching is
   the match that would have happened without you in it. Everything is a
   wrapper around a live function: nothing is monkey-patched permanently,
   and turning it off puts the game back exactly as it was.

     freecam.top()        jump to the overhead view
     freecam.goto(x,y,z)  put the camera somewhere
     freecam.off()

   Console helpers, in case you want them: NUKETOWN_DEBUG.state() dumps
   every actor, NUKETOWN_DEBUG.step(n) runs n sim ticks with no render.
   ===================================================================== */
(() => {
  if (window.freecam) { window.freecam.toggle(); return window.freecam; }

  const S = { on: false, x: 0, y: 30, z: 40, yaw: Math.PI, pitch: -0.6, speed: 18 };

  const tag = document.createElement('div');
  tag.style.cssText = 'position:fixed;left:50%;bottom:14px;transform:translateX(-50%);' +
    'z-index:99;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;color:#4a3f5c;' +
    'background:rgba(255,248,240,.92);border:2px solid #4a3f5c;border-radius:12px;' +
    'padding:6px 14px;pointer-events:none;white-space:nowrap;display:none';
  document.body.appendChild(tag);

  /* Hidden while flying: the gun belongs to a body you have stepped out of,
     and the crosshair is aiming nothing. #dead goes too, so toggling on
     mid-respawn is not a card over the view. */
  const CHROME = ['cross', 'hitmark', 'vitals', 'ammo', 'dead'];

  const key = c => KEY[c] ? 1 : 0;

  function fly(dt) {
    const f = key('KeyW') - key('KeyS');
    const s = key('KeyD') - key('KeyA');
    const u = key('Space') - Math.min(1, key('ControlLeft') + key('ControlRight') + key('KeyC'));
    const v = S.speed * (KEY.ShiftLeft || KEY.ShiftRight ? 3.5 : 1) *
                        (KEY.AltLeft || KEY.AltRight ? 0.25 : 1) * dt;
    /* The engine's basis: forward = (sin yaw, cos yaw), right = (-cos, sin),
       with pitch folded into forward so W flies where you are looking. */
    const sy = Math.sin(S.yaw), cy = Math.cos(S.yaw);
    const sp = Math.sin(S.pitch), cp = Math.cos(S.pitch);
    S.x += (sy * cp * f - cy * s) * v;
    S.y += (sp * f + u) * v;
    S.z += (cy * cp * f + sy * s) * v;
    S.y = Math.max(-4, Math.min(140, S.y));
  }

  /* ---- the wrappers. Each one is "if the freecam is off, behave exactly as
     before", so a single flag turns the whole thing on and off. ---- */

  const origCamera = updateCamera;
  updateCamera = function (dt) {
    if (!S.on) return origCamera(dt);
    fly(dt);
    camera.position.set(S.x, S.y, S.z);
    /* +PI for the same reason the first-person camera needs it: three.js
       looks down -Z, engine yaw 0 means +Z. */
    camera.rotation.set(S.pitch, S.yaw + Math.PI, 0);
    tag.textContent = 'FREECAM  ' + S.x.toFixed(1) + ' ' + S.y.toFixed(1) + ' ' +
      S.z.toFixed(1) + '  ·  ' + Math.round(S.speed) + ' m/s  ·  ' +
      'WASD fly · SPACE/CTRL up-down · SHIFT fast · WHEEL speed · V exit';
  };

  const origLook = applyLook;
  applyLook = function (dx, dy, sens) {
    if (!S.on) return origLook(dx, dy, sens);
    dy *= invertY;
    S.yaw -= dx * sens;
    S.pitch = Math.max(-1.5, Math.min(1.5, S.pitch - dy * sens));
  };

  /* The one place player intent is read, so zeroing it here is the whole of
     "the body stops playing" — it still falls and lands, it just has nothing
     to say. */
  const origInput = readLocalInput;
  readLocalInput = function (accepts) {
    if (!S.on) return origInput(accepts);
    return { fwd: 0, strafe: 0, jump: false, sprint: false, fire: false };
  };

  const origDamage = applyDamage;
  applyDamage = function (target) {
    if (S.on && target === G.player) return;
    return origDamage.apply(null, arguments);
  };

  /* Invulnerable is not enough: an unhittable body still stops the bullet.
     Take it out of the actor list the shot tests against. */
  const origHitscan = hitscan;
  hitscan = function (ox, oy, oz, dx, dy, dz, maxT, actors, ignoreId) {
    if (S.on && G.player && actors) actors = actors.filter(a => a !== G.player);
    return origHitscan(ox, oy, oz, dx, dy, dz, maxT, actors, ignoreId);
  };

  /* And a bot builds its view from G.actors directly, so hide the body for
     the duration of the call — that covers targeting, pathing and, when the
     bot respawns inside it, spawn picking. */
  const origStepBot = stepBot;
  stepBot = function (a, dt) {
    const i = S.on && G.player ? G.actors.indexOf(G.player) : -1;
    if (i < 0) return origStepBot(a, dt);
    G.actors.splice(i, 1);
    try { return origStepBot(a, dt); } finally { G.actors.splice(i, 0, G.player); }
  };

  function chrome(on) {
    G.frozenNoVM = on;                    // renderAll's own flag for "no viewmodel"
    for (const id of CHROME) {
      const el = document.getElementById(id);
      if (el) el.style.display = on ? 'none' : '';
    }
    tag.style.display = on ? 'block' : 'none';
  }

  const api = {
    state: S,
    on() {
      if (S.on) return S;
      /* Start from wherever the camera already is, so it feels like stepping
         out of your head rather than being teleported. rotation is set as
         (pitch, yaw+PI, 0) everywhere, so this inverts it exactly. */
      S.x = camera.position.x; S.y = camera.position.y; S.z = camera.position.z;
      S.yaw = camera.rotation.y - Math.PI;
      S.pitch = camera.rotation.x;
      S.on = true;
      chrome(true);
      return S;
    },
    off() {
      if (!S.on) return S;
      S.on = false;
      chrome(false);
      return S;
    },
    toggle() { return S.on ? api.off() : api.on(); },
    /* Down the short axis from above: both houses, the street between them
       and the whole fence in frame. */
    top() { api.on(); S.x = 0; S.y = 31; S.z = 37; S.yaw = Math.PI; S.pitch = -0.64; return S; },
    goto(x, y, z) { api.on(); S.x = x; S.y = y; S.z = z; return S; },
    speed(v) { S.speed = Math.max(2, Math.min(120, v)); return S.speed; }
  };

  addEventListener('keydown', e => {
    if (e.code !== 'KeyV' || e.repeat) return;
    const el = document.activeElement;
    if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName || '')) return;   // callsign box
    api.toggle();
  });
  addEventListener('wheel', e => {
    if (S.on) api.speed(S.speed * (e.deltaY > 0 ? 1 / 1.2 : 1.2));
  }, { passive: true });
  /* Using the console drops pointer lock, which the game reads as a pause.
     Clicking the world takes both back. */
  canvas.addEventListener('mousedown', () => { if (S.on && !IN.locked) requestLock(); });

  window.freecam = api;
  api.on();
  return api;
})();
