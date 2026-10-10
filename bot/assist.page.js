// Injected into the Ombreval page. Manual-play assist (F6 panel): aimbot, lead, target marker, auto potion,
// and a switch for the necro bot. Wraps __game.controls.build once; never alters play when its options are off.
(() => {
  if (window.__assist) window.__assist.stop();
  const g = window.__game;
  if (!g?.controls) throw new Error('__game not ready');

  const OPT_KEY = 'ombreval-assist';
  const DEF = { aim: true, aimAll: false, lead: true, mark: true, pot: false, potPct: 35, radius: 6, x: null, y: null };
  const opt = (() => { try { return { ...DEF, ...JSON.parse(localStorage.getItem(OPT_KEY)) }; } catch { return { ...DEF }; } })();
  const save = () => { try { localStorage.setItem(OPT_KEY, JSON.stringify(opt)); } catch {} };
  const now = () => performance.now();
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  // Bar slot keys (game defaults, zj in the bundle); slot 0/1 are the mouse buttons.
  const SLOT_KEYS = ['Mouse0', 'Mouse2', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyR', 'Digit5'];
  // TODO(ceiling): rebound slot keys are not read (vM bindings are not exposed): read them if the user rebinds.

  // Cast timing from the bundle. Shaman bar skills: hit at at * dur / aps ($m, eh L29540).
  const SK = { spiritclaws: { dur: 0.72, at: 0.55, range: 12, lead: true }, crows: { dur: 0.7, at: 0.55, range: 12, lead: true } };
  // Non-classic weapon clicks replace slots 0/1 in human form (Fie L57315): lmb lasts 1 / aps, rmb its dur ?? 0.5 (Mie).
  const WPN = {
    antlerstaff: [{ at: 0.5, speed: 26, range: 14, lead: true }, { dur: 0.5, at: 0.5, range: 12, lead: true }],
    hatchet: [{ at: 0.45, range: 2.3, lead: false }, { dur: 0.5, at: 0.5, range: 10, lead: true }],
  };
  // Skill fired by a slot: delay (s) before it lands or leaves, projectile speed (0 = ground effect), range.
  function skillOf(slot) {
    const aps = g.stats?.aps || 1, form = g.sim.form ?? 0;
    if (form >= 1 && form <= 3) return { delay: 0, speed: 0, range: 2.5 + (g.stats?.reach ?? 0), lead: false }; // beast melee
    const w = slot <= 1 && WPN[g.stats?.weapon]?.[slot];
    if (w) return { delay: w.at * (slot ? w.dur ?? 0.5 : 1 / aps), speed: w.speed ?? 0, range: w.range, lead: w.lead };
    const s = SK[g.char.bar[slot]];
    return s ? { delay: s.at * s.dur / aps, speed: 0, range: s.range, lead: s.lead } : { delay: 0, speed: 0, range: 8, lead: false };
  }
  // Predicted hit point: position after delay + flight time, iterated; clamped to the skill range like the sim does.
  function leadPoint(me, p, v, sk) {
    let t = sk.delay, x = p.x, z = p.z;
    for (let i = 0; i < 4; i++) {
      x = p.x + v.x * t; z = p.z + v.z * t;
      t = sk.delay + (sk.speed ? Math.hypot(x - me.x, z - me.z) / sk.speed : 0);
    }
    const d = Math.hypot(x - me.x, z - me.z), lim = Math.max(sk.range, dist(me, p));
    if (d > lim) { x = me.x + (x - me.x) / d * lim; z = me.z + (z - me.z) / d * lim; }
    return { x, z };
  }

  // Velocity per monster from position deltas between ticks (EMA).
  const vel = new Map();
  function trackVel(ms, t) {
    for (const m of ms) {
      const o = vel.get(m.id), x = m.pos.x, z = m.pos.z;
      if (!o) { vel.set(m.id, { x, z, t, vx: 0, vz: 0 }); continue; }
      const dt = (t - o.t) / 1000;
      if (dt < 0.005) continue;
      const k = dt > 0.5 ? 1 : 0.35, vx = (x - o.x) / dt, vz = (z - o.z) / dt;
      if (Math.hypot(vx, vz) > 30) { Object.assign(o, { x, z, t, vx: 0, vz: 0 }); continue; } // teleport or respawn
      Object.assign(o, { x, z, t, vx: o.vx + (vx - o.vx) * k, vz: o.vz + (vz - o.vz) * k });
    }
    for (const [id, o] of vel) if (t - o.t > 2000) vel.delete(id);
  }

  const st = { tgt: null, fallback: false, aim: null, firing: 0, potAt: -1e9, botOn: false, botAt: 0, overPanel: false, err: null };
  const alive = m => m && !m.dead && m.hp > 0;
  // Nearest to the cursor within the radius, else nearest to us within the skill range; sticky while still valid.
  function pickTarget(ms, cur, me, range) {
    const R = opt.radius;
    let best = null, bd = R;
    for (const m of ms) if (alive(m)) { const d = dist(m.pos, cur); if (d < bd) { bd = d; best = m; } }
    let fb = false;
    if (!best) {
      bd = range;
      for (const m of ms) if (alive(m)) { const d = dist(m.pos, me) - (m.radius ?? 0.5); if (d < bd) { bd = d; best = m; } }
      fb = !!best;
    }
    const old = st.tgt && ms.find(m => m.id === st.tgt.id);
    if (alive(old) && (dist(old.pos, cur) <= R * 1.5 || (fb && dist(old.pos, me) - (old.radius ?? 0.5) <= range))) best = old;
    st.fallback = best !== old ? fb : st.fallback;
    return best;
  }

  // Slot the user is firing, or -1. LMB is input.lmb (canvas mousedown, Input class L54234).
  function heldSlot() {
    const i = g.input;
    if (i.lmb) return 0;
    if (!opt.aimAll) return -1;
    if (i.rmb) return 1;
    for (let s = 2; s < SLOT_KEYS.length; s++) if (g.char.bar[s] && i.isDown(SLOT_KEYS[s])) return s;
    return -1;
  }
  // Bot running: it aims and drinks itself. status() is heavy, so read it twice a second.
  const botOn = () => {
    if (!window.__bot) return false;
    if (now() - st.botAt > 500) { st.botAt = now(); try { st.botOn = !!window.__bot.status().on; } catch { st.botOn = false; } }
    return st.botOn;
  };

  function potion() {
    if (!opt.pot || !g.life || g.sim.dead || g.hp <= 0) return;
    if (g.hp / g.life * 100 < opt.potPct && !(g.potionCd > 0) && g.char.potions > 0 && now() - st.potAt > 1500) { st.potAt = now(); g.actions.usePotion(); }
  }

  let alive_ = true;
  const origBuild = g.controls.build.bind(g.controls);
  const wrapper = aimPt => {
    if (!alive_) return origBuild(aimPt);
    try {
      if (botOn()) { st.tgt = null; st.aim = null; return origBuild(aimPt); }
      potion();
      if (!opt.aim || g.ui.typing || g.ui.modalOpen || g.sim.dead) { st.tgt = null; st.aim = null; return origBuild(aimPt); }
      const t = now(), me = g.sim, ms = [...g.entities.visibleMonsters()];
      trackVel(ms, t);
      const slot = heldSlot(), sk = skillOf(slot < 0 ? 0 : slot);
      const tgt = st.tgt = pickTarget(ms, aimPt, me, sk.range);
      st.aim = null;
      if (!tgt || slot < 0 || g.input.overUi || st.overPanel) return origBuild(aimPt);
      const v = vel.get(tgt.id) ?? { vx: 0, vz: 0 };
      const aim = st.aim = opt.lead && sk.lead ? leadPoint(me, tgt.pos, { x: v.vx, z: v.vz }, sk) : { x: tgt.pos.x, z: tgt.pos.z };
      st.firing = t;
      const r = origBuild({ x: aim.x, z: aim.z });
      // Facing too: the built-in assist may snap to another monster, and missiles fly along it.
      const dx = aim.x - me.x, dz = aim.z - me.z, l = Math.hypot(dx, dz);
      return l < 0.1 ? r : { ...r, dx: Math.round(dx / l * 1e3) / 1e3, dz: Math.round(dz / l * 1e3) / 1e3 };
    } catch (e) { st.err = e.message; return origBuild(aimPt); }
  };
  g.controls.build = wrapper;

  // --- marker: screen projection (three.js column-major matrices, as in viz.page.js)
  const cv = document.createElement('canvas');
  cv.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:99989';
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');
  const mat4mul = (a, b) => {
    const c = new Array(16);
    for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
      c[col * 4 + row] = s;
    }
    return c;
  };
  function ringPath(PV, R, x, z, r) {
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i <= 32; i++) {
      const a = i / 32 * 2 * Math.PI, px = x + r * Math.cos(a), pz = z + r * Math.sin(a);
      const cx = PV[0] * px + PV[4] * 0.1 + PV[8] * pz + PV[12], cy = PV[1] * px + PV[5] * 0.1 + PV[9] * pz + PV[13], w = PV[3] * px + PV[7] * 0.1 + PV[11] * pz + PV[15];
      if (w < 1e-3) { pen = false; continue; }
      const sx = R.left + (cx / w + 1) / 2 * R.width, sy = R.top + (1 - cy / w) / 2 * R.height;
      pen ? ctx.lineTo(sx, sy) : ctx.moveTo(sx, sy); pen = true;
    }
    ctx.stroke();
  }
  let raf = 0;
  function frame() {
    raf = requestAnimationFrame(frame);
    const dpr = devicePixelRatio || 1, W = innerWidth, H = innerHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const cam = g.renderer?.camera, m = st.tgt;
    if (!opt.mark || !opt.aim || !alive(m) || !cam?.projectionMatrix || !g.inWorld) return;
    const PV = mat4mul(cam.projectionMatrix.elements, cam.matrixWorldInverse.elements);
    const R = g.input.canvas?.getBoundingClientRect?.() ?? { left: 0, top: 0, width: W, height: H };
    const hot = now() - st.firing < 250, r = (m.radius ?? 0.5) + 0.35;
    ctx.lineWidth = hot ? 3 : 1.5;
    ctx.strokeStyle = hot ? 'rgba(255,90,60,.95)' : 'rgba(217,178,111,.7)';
    ringPath(PV, R, m.pos.x, m.pos.z, r);
    if (hot && st.aim && Math.hypot(st.aim.x - m.pos.x, st.aim.z - m.pos.z) > 0.2) {
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(120,220,255,.9)';
      ringPath(PV, R, st.aim.x, st.aim.z, 0.3);
    }
  }
  raf = requestAnimationFrame(frame);

  // --- panel (F6), styled like the bot HUD, draggable by its title
  const panel = document.createElement('div');
  panel.id = 'assist-panel';
  panel.style.cssText = 'position:fixed;z-index:99999;width:230px;padding:8px 10px;user-select:none;'
    + 'background:rgba(12,14,16,.82);color:#e6e2d6;font:12px/1.6 ui-monospace,Menlo,monospace;'
    + 'border:1px solid rgba(230,226,214,.25);border-radius:6px';
  const place = () => {
    if (opt.x == null) { panel.style.top = '12px'; panel.style.right = '300px'; panel.style.left = 'auto'; return; }
    panel.style.left = Math.max(0, Math.min(innerWidth - 60, opt.x)) + 'px'; panel.style.top = Math.max(0, Math.min(innerHeight - 30, opt.y)) + 'px'; panel.style.right = 'auto';
  };
  const row = (k, label) => `<label style="display:block;cursor:pointer"><input type="checkbox" data-k="${k}"${opt[k] ? ' checked' : ''}> ${label}</label>`;
  const num = (k, label, min, max, step) => `<label style="display:block;padding-left:20px">${label} <input type="number" data-k="${k}" value="${opt[k]}" min="${min}" max="${max}" step="${step}" style="width:48px;background:#1b1e21;color:#e6e2d6;border:1px solid #444;border-radius:3px"></label>`;
  panel.innerHTML = `<div data-drag style="cursor:move;color:#d9b26f;font-weight:bold;margin-bottom:4px">ASSIST <span style="color:#8fb3a8;font-weight:normal">(F6)</span></div>`
    + row('aim', 'Aimbot') + num('radius', 'rayon (m)', 1, 20, 0.5) + row('aimAll', 'Aussi clic droit et sorts')
    + row('lead', 'Anticipation') + row('mark', 'Marqueur')
    + row('pot', 'Potion auto') + num('potPct', 'seuil (%)', 5, 90, 5)
    + `<label style="display:block;cursor:pointer"><input type="checkbox" data-bot> Bot complet (nécro)</label>`
    + `<div data-st style="color:#8fb3a8;margin-top:4px;white-space:pre"></div>`;
  document.body.appendChild(panel);
  place();
  panel.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.bot !== undefined) { try { el.checked ? window.__bot.start() : window.__bot.pause(); } catch {} st.botAt = 0; return; }
    const k = el.dataset.k;
    if (!k) return;
    if (el.type === 'checkbox') opt[k] = el.checked;
    else { const v = parseFloat(el.value); if (Number.isFinite(v)) opt[k] = Math.max(+el.min, Math.min(+el.max, v)); el.value = opt[k]; }
    save();
  });
  // Keys typed in the number inputs must not reach the game.
  panel.addEventListener('keydown', e => e.stopPropagation());
  panel.addEventListener('mouseenter', () => { st.overPanel = true; });
  panel.addEventListener('mouseleave', () => { st.overPanel = false; });
  let drag = null;
  panel.addEventListener('mousedown', e => {
    if (!e.target.closest('[data-drag]')) return;
    const r = panel.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top }; e.preventDefault();
  });
  const onMove = e => { if (!drag) return; opt.x = e.clientX - drag.dx; opt.y = e.clientY - drag.dy; place(); };
  const onUp = () => { if (drag) { drag = null; save(); } };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);

  const botBox = panel.querySelector('[data-bot]'), stEl = panel.querySelector('[data-st]');
  const uiTimer = setInterval(() => {
    if (panel.hidden) return;
    const necro = g.char?.ch?.cls === 'necromancer' && !!window.__bot;
    botBox.disabled = !necro; botBox.parentElement.style.opacity = necro ? 1 : 0.45;
    botBox.checked = necro && botOn();
    const m = st.tgt;
    stEl.textContent = botOn() ? 'bot actif : aimbot en veille'
      : `cible : ${alive(m) ? `${m.def?.kind ?? '?'} ${m.level ?? ''}${st.fallback ? ' (proche)' : ''}` : '-'}${st.err ? `\nerreur : ${st.err}` : ''}`;
  }, 250);

  const onKey = e => {
    if (e.code !== 'F6' || g.ui.typing) return;
    e.preventDefault(); panel.hidden = !panel.hidden;
  };
  window.addEventListener('keydown', onKey, true);
  const onResize = () => place();
  window.addEventListener('resize', onResize);

  // Self-check of the lead math.
  (() => {
    const fail = m => console.warn('assist self-check failed: ' + m);
    const me = { x: 0, z: 0 }, near = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) < 1e-6;
    // Still target: no lead. Ground effect: velocity * delay.
    if (!near(leadPoint(me, { x: 5, z: 0 }, { x: 0, z: 0 }, { delay: 0.4, speed: 0, range: 12 }), { x: 5, z: 0 })) fail('still target');
    if (!near(leadPoint(me, { x: 5, z: 0 }, { x: 0, z: 2 }, { delay: 0.5, speed: 0, range: 12 }), { x: 5, z: 1 })) fail('ground lead');
    // Missile: crossing target at 13 m/s, speed 26, no delay: hit point satisfies t = |p(t)| / 26.
    const p = leadPoint(me, { x: 10, z: 0 }, { x: 0, z: 13 }, { delay: 0, speed: 26, range: 14 }), tt = p.z / 13;
    if (Math.abs(Math.hypot(p.x, p.z) / 26 - tt) > 0.01) fail('missile intercept');
    // Clamp to range.
    if (Math.hypot(...Object.values(leadPoint(me, { x: 11, z: 0 }, { x: 10, z: 0 }, { delay: 1, speed: 0, range: 12 }))) > 12 + 1e-6) fail('range clamp');
  })();

  window.__assist = {
    opt, st, vel, // read-only debug
    stop() {
      alive_ = false;
      if (g.controls.build === wrapper) g.controls.build = origBuild; // else a later wrapper holds ours: it turns into a pass-through
      cancelAnimationFrame(raf); clearInterval(uiTimer);
      window.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', onResize);
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
      cv.remove(); panel.remove();
      delete window.__assist;
    },
  };
  return 'assist loaded (F6)';
})();
