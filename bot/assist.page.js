// Injected into the Ombreval page. Manual-play assist (F6 panel): aimbot, lead, target marker, auto potion,
// telegraph dodge, auto loot, dashboard, auto cast, and a switch for the full bot (necromancer, shaman).
// Wraps __game.controls.build and onMessage once; never alters play when its options are off.
(() => {
  if (window.__assist) window.__assist.stop();
  const g = window.__game;
  if (!g?.controls) throw new Error('__game not ready');

  const OPT_KEY = 'ombreval-assist';
  const DEF = { aim: true, aimAll: false, lead: true, mark: true, pot: false, potPct: 35, radius: 6,
    dodge: false, loot: false, lootR: 4, lootGear: false, lootWalk: false, dash: true,
    auto: false, autoSlots: [false, false, false, false, false, false, false, false], x: null, y: null };
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

  const st = { tgt: null, fallback: false, aim: null, firing: 0, potAt: -1e9, botOn: false, botAt: 0, overPanel: false, err: null,
    escaping: false, escSince: 0, rollAt: -1e9, dodges: 0, loots: 0, castAt: -1e9, slotAt: [], casts: 0, lastCast: '' };
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

  const aimAt = (me, tgt, sk) => {
    const v = vel.get(tgt.id) ?? { vx: 0, vz: 0 };
    return opt.lead && sk.lead ? leadPoint(me, tgt.pos, { x: v.vx, z: v.vz }, sk) : { x: tgt.pos.x, z: tgt.pos.z };
  };
  const ready = id => !(g.sim.cds?.[id] > 0);

  // --- dodge: telegraphs from server `tele` events (bot.page.js teleScan) plus melee windups in reach.
  const teles = [];
  function addTele(e) {
    const src = e.follow ? g.entities.monsters.get(e.id)?.view : null;
    teles.push({ id: e.id, src, x: e.x, z: e.z, sh: e.sh, r: e.r ?? 0, ha: e.ha ?? 0, yaw: e.yaw ?? 0, len: e.len ?? 0, w: e.w ?? 0, until: now() + (e.dur ?? 1) * 1000 });
  }
  // Escape direction if we stand inside an active telegraph (margin m), else null.
  function teleScan(me, m) {
    for (let i = teles.length - 1; i >= 0; i--) {
      const t = teles[i];
      if (now() > t.until || t.src?.dead) { teles.splice(i, 1); continue; }
      const ox = t.src ? t.src.pos.x : t.x, oz = t.src ? t.src.pos.z : t.z;
      const dx = me.x - ox, dz = me.z - oz, d = Math.hypot(dx, dz);
      const fx = Math.sin(t.yaw), fz = Math.cos(t.yaw);
      // Dead center: flee along our facing.
      const out = d > 0.05 ? [dx / d, dz / d] : [Math.sin(me.yaw ?? 0), Math.cos(me.yaw ?? 0)];
      if (t.sh === 'circle' && d < t.r + m) return out;
      if (t.sh === 'cone' && d < t.r + m && Math.abs(Math.atan2(dx * fz - dz * fx, dx * fx + dz * fz)) < t.ha + 0.15) return out;
      if (t.sh !== 'circle' && t.sh !== 'cone') {
        const along = dx * fx + dz * fz, perp = dx * fz - dz * fx;
        if (along > -m && along < t.len + m && Math.abs(perp) < t.w / 2 + m) { const s = perp >= 0 ? 1 : -1; return [fz * s, -fx * s]; }
      }
    }
    return null;
  }
  // Melee windup facing us within its reach (attack name -> reach beyond the monster radius).
  const REACH = { melee: 1.8, lunge: 3, smash: 2.5, slam: 3 };
  function windupScan(me, ms, m) {
    for (const x of ms) {
      if (!alive(x) || x.state !== 'windup' || !REACH[x.attack]) continue;
      const dx = me.x - x.pos.x, dz = me.z - x.pos.z, d = Math.hypot(dx, dz);
      if (d < (x.radius ?? 0.5) + REACH[x.attack] + m) return { dir: d > 0.05 ? [dx / d, dz / d] : [Math.sin(me.yaw ?? 0), Math.cos(me.yaw ?? 0)], big: x.elite || x.boss };
    }
    return null;
  }
  // { move, roll } while inside a predicted hit area, else null. Margin grows while escaping (no chatter at the edge).
  // Beast forms are melee: they stand in windups on purpose, so only telegraphs count there.
  function dodgeDecide(me, ms) {
    const m = st.escaping ? 1.5 : 0.5, beast = (g.sim.form ?? 0) >= 1 && (g.sim.form ?? 0) <= 3;
    const tele = teleScan(me, m), wu = tele || beast ? null : windupScan(me, ms, m);
    const dir = tele ?? wu?.dir;
    if (!dir) { st.escaping = false; return null; }
    if (!st.escaping) { st.escaping = true; st.escSince = now(); }
    // A zone we cannot leave in 2 s (huge boss circle): hand the stick back.
    if (now() - st.escSince > 2000) return null;
    const roll = (!!tele || !!wu?.big) && ready('roll') && now() - st.rollAt > 1000;
    return { move: dir, roll };
  }

  // --- loot: pickup message (as the bot) for drops within lootR; optional walk-over when idle and safe.
  const AUTO_LOOT = new Set(['gold', 'mat', 'globe', 'potion', 'scroll']);
  const bagFull = () => g.char.bag.filter(Boolean).length >= g.char.bag.length;
  const lootable = d => AUTO_LOOT.has(d.kind) || (d.kind === 'item' && opt.lootGear && !bagFull());
  const lootTry = new Map(); // drop id -> { n, at }
  // Sends pickups (2 tries per drop, 1.5 s apart) and returns the nearest lootable drop in radius, or null.
  function lootTick(me) {
    let best = null, bd = opt.lootR;
    for (const d of g.drops.drops.values()) {
      if (!lootable(d)) continue;
      const dd = dist(d.pos, me);
      if (dd > opt.lootR) continue;
      if (dd < bd) { bd = dd; best = d; }
      const p = lootTry.get(d.id) ?? { n: 0, at: -1e9 };
      if (p.n >= 2 || now() - p.at < 1500) continue;
      lootTry.set(d.id, { n: p.n + 1, at: now() });
      g.send({ t: 'pickup', id: d.id }); st.loots++;
    }
    for (const id of lootTry.keys()) if (!g.drops.drops.has(id)) lootTry.delete(id);
    return best;
  }
  const mobNear = (me, ms, r) => ms.some(m => alive(m) && dist(m.pos, me) < r);

  // --- auto cast: a checked slot fires when the HUD shows it ready (no cooldown, enough resource) and the
  // aimbot target is in range. HUD slot roots carry the game's own state classes (f7.set in the bundle).
  const CAST_RANGE = { spiritclaws: 12, crows: 12, ancestortotem: 12, boarcharge: 16, wolfform: 5, bearform: 4, mammoth: 5 };
  const SHIFT_FORM = { wolfform: 1, bearform: 2, mammoth: 3 }; // toggles: never cast the form we are already in
  const slotEl = i => document.querySelector(`.skill.slot[data-slot="${i}"]`);
  const slotName = i => slotEl(i)?.getAttribute('aria-label') || g.char.bar[i] || '';
  const slotReady = i => {
    const el = slotEl(i), id = g.char.bar[i];
    if (!id) return false;
    if (!el) return ready(id);
    return !['empty', 'cooling', 'nofury', 'active'].some(c => el.classList.contains(c));
  };
  const castRange = i => i <= 1 ? skillOf(i).range : CAST_RANGE[g.char.bar[i]] ?? SK[g.char.bar[i]]?.range ?? 8;
  // { slot, aim } to cast this tick, or null. tgt = aimbot pick.
  function autoDecide(me, tgt) {
    if (!alive(tgt) || now() - st.castAt < 250) return null;
    const d = dist(tgt.pos, me) - (tgt.radius ?? 0.5);
    for (let i = 0; i < SLOT_KEYS.length; i++) {
      const id = g.char.bar[i];
      if (!opt.autoSlots[i] || !id || g.input.isDown(SLOT_KEYS[i])) continue;
      if (SHIFT_FORM[id] && (g.sim.form ?? 0) === SHIFT_FORM[id]) continue;
      if (now() - (st.slotAt[i] ?? -1e9) < 700 || !slotReady(i) || d > castRange(i)) continue;
      return { slot: i, aim: aimAt(me, tgt, skillOf(i)) };
    }
    return null;
  }

  let alive_ = true;
  const origBuild = g.controls.build.bind(g.controls);
  // Build with a slot key held for this one call only (input.down, no `pressed` edge), restored right after.
  const buildWith = (pt, key) => {
    const down = g.input.down;
    if (!key || down.has(key)) return origBuild(pt);
    down.add(key);
    try { return origBuild(pt); } finally { down.delete(key); }
  };
  const wrapper = aimPt => {
    if (!alive_) return origBuild(aimPt);
    try {
      if (botOn()) { st.tgt = null; st.aim = null; return origBuild(aimPt); }
      potion();
      if (g.sim.dead || g.hp <= 0) { st.tgt = null; st.aim = null; st.escaping = false; return origBuild(aimPt); }
      const t = now(), me = g.sim, ms = [...g.entities.visibleMonsters()], busy = g.ui.typing || g.ui.modalOpen;
      trackVel(ms, t);
      const esc = opt.dodge ? dodgeDecide(me, ms) : null;
      const drop = opt.loot ? lootTick(me) : null;
      // Aimbot target (also the auto cast target).
      let aim = null;
      st.aim = null;
      if ((opt.aim || opt.auto) && !busy) {
        const slot = heldSlot(), sk = skillOf(slot < 0 ? 0 : slot);
        let tgt = pickTarget(ms, aimPt, me, sk.range);
        if (!tgt && opt.auto) tgt = pickTarget(ms, aimPt, me, 16); // longest auto cast range
        st.tgt = tgt;
        if (opt.aim && tgt && slot >= 0 && !g.input.overUi && !st.overPanel) { aim = st.aim = aimAt(me, tgt, sk); st.firing = t; }
      } else st.tgt = null;
      const cast = opt.auto && !busy && !esc && !st.overPanel ? autoDecide(me, st.tgt) : null;
      if (cast) {
        aim ??= cast.aim; st.castAt = st.slotAt[cast.slot] = t; st.casts++;
        st.lastCast = slotName(cast.slot);
      }
      let r = buildWith(aim ? { x: aim.x, z: aim.z } : aimPt, cast && SLOT_KEYS[cast.slot]);
      // Facing too: the built-in assist may snap to another monster, and missiles fly along it.
      if (aim) {
        const dx = aim.x - me.x, dz = aim.z - me.z, l = Math.hypot(dx, dz);
        if (l >= 0.1) r = { ...r, dx: Math.round(dx / l * 1e3) / 1e3, dz: Math.round(dz / l * 1e3) / 1e3 };
      }
      const mv = v => ({ mx: Math.round(v[0] * 1e3) / 1e3, mz: Math.round(v[1] * 1e3) / 1e3 });
      if (esc) {
        if (esc.roll) { st.rollAt = t; st.dodges++; }
        return { ...r, ...mv(esc.move), b: esc.roll ? r.b | 64 : r.b };
      }
      // Walk-over detour: only while the user is not steering, nothing hostile within 6 m.
      if (drop && opt.lootWalk && !busy && !r.mx && !r.mz && !mobNear(me, ms, 6)) {
        const dx = drop.pos.x - me.x, dz = drop.pos.z - me.z, l = Math.hypot(dx, dz);
        if (l > 0.4) return { ...r, ...mv([dx / l, dz / l]) };
      }
      return r;
    } catch (e) { st.err = e.message; return origBuild(aimPt); }
  };
  g.controls.build = wrapper;

  // --- dashboard counters, kept on window so a hot re-injection does not reset them.
  const dash = window.__assistDash ??= { t0: now(), xp: [], dmg: [], hit: new Map(), kills: 0, deaths: 0 };
  const resetDash = () => Object.assign(dash, { t0: now(), xp: [], dmg: [], hit: new Map(), kills: 0, deaths: 0 });
  const lvlXp = l => Math.round(110 * l ** 1.85 + 60 * l); // Die in the bundle (L57168), levels <= 30
  // TODO(ceiling): levels > 30 use another curve (rf in the bundle): read it if the character gets there.
  const sumSince = (a, from) => a.reduce((s, e) => e[0] >= from ? s + e[1] : s, 0);
  function dashStats() {
    const t = now(), span = Math.min(300000, Math.max(1000, t - dash.t0));
    while (dash.xp.length && dash.xp[0][0] < t - 300000) dash.xp.shift();
    while (dash.dmg.length && dash.dmg[0][0] < t - 10000) dash.dmg.shift();
    const xph = sumSince(dash.xp, t - 300000) / span * 3.6e6;
    const dps = sumSince(dash.dmg, t - 10000) / Math.min(10, Math.max(1, (t - dash.t0) / 1000));
    const need = Math.max(0, lvlXp(g.char.ch.level ?? g.level) - (g.char.ch.xp ?? 0));
    return { xph, dps, need, toLvl: xph > 0 ? need / xph * 3600 : Infinity, kills: dash.kills, deaths: dash.deaths, dur: (t - dash.t0) / 1000 };
  }
  const origOnMessage = g.onMessage.bind(g);
  const onMsg = msg => {
    if (alive_ && msg?.t === 's' && msg.ev) try {
      const t = now(), ents = g.entities;
      for (const ev of msg.ev) {
        if (ev.e === 'hit') {
          if (ents.monsters.has(ev.id) && (ev.s === g.meId || ents.allies.has(ev.s))) { dash.dmg.push([t, ev.a ?? 0]); dash.hit.set(ev.id, t); }
        } else if (ev.e === 'kill') {
          // Ours only: a monster we hit in the last 15 s (shared world).
          if (t - (dash.hit.get(ev.id) ?? -1e9) < 15000) dash.kills++;
          dash.hit.delete(ev.id);
        } else if (ev.e === 'xp') dash.xp.push([t, ev.a ?? 0]);
        else if (ev.e === 'death') dash.deaths++;
        else if (ev.e === 'tele') addTele(ev);
        else if (ev.e === 'tcancel') for (let i = teles.length - 1; i >= 0; i--) if (teles[i].id === ev.id) teles.splice(i, 1);
      }
      if (dash.hit.size > 500) for (const [id, at] of dash.hit) if (t - at > 15000) dash.hit.delete(id);
    } catch (e) { st.err = e.message; }
    return origOnMessage(msg);
  };
  g.onMessage = onMsg;

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
  panel.style.cssText = 'position:fixed;z-index:99999;width:260px;padding:8px 10px;user-select:none;'
    + 'background:rgba(12,14,16,.82);color:#e6e2d6;font:12px/1.6 ui-monospace,Menlo,monospace;'
    + 'border:1px solid rgba(230,226,214,.25);border-radius:6px';
  const place = () => {
    if (opt.x == null) { panel.style.top = '12px'; panel.style.right = '300px'; panel.style.left = 'auto'; return; }
    panel.style.left = Math.max(0, Math.min(innerWidth - 60, opt.x)) + 'px'; panel.style.top = Math.max(0, Math.min(innerHeight - 30, opt.y)) + 'px'; panel.style.right = 'auto';
  };
  const row = (k, label, sub) => `<label style="display:block;cursor:pointer${sub ? ';padding-left:20px' : ''}"><input type="checkbox" data-k="${k}"${opt[k] ? ' checked' : ''}> ${label}</label>`;
  const num = (k, label, min, max, step) => `<label style="display:block;padding-left:20px">${label} <input type="number" data-k="${k}" value="${opt[k]}" min="${min}" max="${max}" step="${step}" style="width:48px;background:#1b1e21;color:#e6e2d6;border:1px solid #444;border-radius:3px"></label>`;
  panel.innerHTML = `<div data-drag style="cursor:move;color:#d9b26f;font-weight:bold;margin-bottom:4px">ASSIST <span style="color:#8fb3a8;font-weight:normal">(F6)</span></div>`
    + row('aim', 'Aimbot') + num('radius', 'rayon (m)', 1, 20, 0.5) + row('aimAll', 'Aussi clic droit et sorts')
    + row('lead', 'Anticipation') + row('mark', 'Marqueur')
    + row('pot', 'Potion auto') + num('potPct', 'seuil (%)', 5, 90, 5)
    + row('dodge', 'Esquive auto')
    + row('loot', 'Ramassage auto') + num('lootR', 'rayon (m)', 1, 10, 0.5) + row('lootGear', 'Aussi l\'équipement', 1)
    + row('lootWalk', 'Détour si zone sûre (6 m)', 1)
    + row('dash', 'Tableau de bord')
    + row('auto', 'Sorts auto') + `<div data-slots></div>`
    + `<label style="display:block;cursor:pointer"><input type="checkbox" data-bot> Bot complet</label>`
    + `<div data-st style="color:#8fb3a8;margin-top:4px;white-space:pre"></div>`;
  document.body.appendChild(panel);
  place();
  panel.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.bot !== undefined) { try { el.checked ? window.__bot.start() : window.__bot.pause(); } catch {} st.botAt = 0; return; }
    if (el.dataset.slot !== undefined) { opt.autoSlots[+el.dataset.slot] = el.checked; save(); return; }
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

  // Auto cast slot list, rebuilt when the bar (or a form) changes the names.
  const KEY_TXT = ['clic G', 'clic D', '1', '2', '3', '4', 'R', '5'];
  const slotsEl = panel.querySelector('[data-slots]');
  let slotsSig = '';
  function drawSlots() {
    const names = g.char.bar.map((id, i) => id ? slotName(i) : ''), sig = names.join('|');
    if (sig === slotsSig) return;
    slotsSig = sig;
    slotsEl.innerHTML = names.map((n, i) => n ? `<label style="display:block;cursor:pointer;padding-left:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">`
      + `<input type="checkbox" data-slot="${i}"${opt.autoSlots[i] ? ' checked' : ''}> ${KEY_TXT[i]} : ${n.replace(/[<>&]/g, '')}</label>` : '').join('');
  }

  // --- dashboard overlay (Tableau de bord)
  const dashEl = document.createElement('div');
  dashEl.id = 'assist-dash';
  dashEl.style.cssText = 'position:fixed;z-index:99998;top:240px;right:12px;width:190px;padding:6px 9px;user-select:none;'
    + 'background:rgba(12,14,16,.78);color:#e6e2d6;font:12px/1.5 ui-monospace,Menlo,monospace;'
    + 'border:1px solid rgba(230,226,214,.25);border-radius:6px';
  dashEl.innerHTML = `<div style="color:#d9b26f;font-weight:bold">TABLEAU DE BORD <button data-reset style="float:right;font:11px ui-monospace,monospace;`
    + `background:#1b1e21;color:#e6e2d6;border:1px solid #444;border-radius:3px;cursor:pointer" title="Remettre à zéro">RAZ</button></div><div data-v style="white-space:pre"></div>`;
  document.body.appendChild(dashEl);
  const dashV = dashEl.querySelector('[data-v]');
  dashEl.querySelector('[data-reset]').addEventListener('click', () => { resetDash(); drawDash(); });
  const hms = s => !Number.isFinite(s) ? '-' : s >= 3600 ? `${Math.floor(s / 3600)} h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}` : `${Math.floor(s / 60)} min ${String(Math.floor(s) % 60).padStart(2, '0')}`;
  const fmt = n => Math.round(n).toLocaleString('fr-FR');
  function drawDash() {
    dashEl.hidden = !opt.dash;
    if (!opt.dash) return;
    const s = dashStats();
    dashV.textContent = `xp/h (5 min) : ${fmt(s.xph)}\nniveau suivant : ${hms(s.toLvl)}\n  (${fmt(s.need)} xp)\ndps (10 s) : ${fmt(s.dps)}\n`
      + `tués : ${s.kills}   morts : ${s.deaths}\nsession : ${hms(s.dur)}`;
  }

  const botBox = panel.querySelector('[data-bot]'), stEl = panel.querySelector('[data-st]');
  let uiN = 0;
  const uiTimer = setInterval(() => {
    if (uiN++ % 4 === 0) drawDash();
    if (panel.hidden) return;
    drawSlots();
    const ok = ['necromancer', 'shaman'].includes(g.char?.ch?.cls) && !!window.__bot;
    botBox.disabled = !ok; botBox.parentElement.style.opacity = ok ? 1 : 0.45;
    botBox.checked = ok && botOn();
    const m = st.tgt;
    stEl.textContent = botOn() ? 'bot actif : aimbot en veille'
      : `cible : ${alive(m) ? `${m.def?.kind ?? '?'} ${m.level ?? ''}${st.fallback ? ' (proche)' : ''}` : '-'}`
        + (opt.dodge || opt.loot || opt.auto ? `\nesquives ${st.dodges}  ramassés ${st.loots}  sorts ${st.casts}` : '')
        + (st.escaping && opt.dodge ? '\nesquive en cours' : '')
        + (st.err ? `\nerreur : ${st.err}` : '');
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
    // Telegraph geometry: circle in/out, line side step (scratch entries, removed after).
    const n0 = teles.length, T = 1e9 + now();
    teles.push({ x: 0, z: 0, sh: 'circle', r: 3, until: T });
    const c = teleScan({ x: 1, z: 0 }, 0.5);
    if (!c || c[0] !== 1) fail('circle inside');
    teles.length = n0;
    teles.push({ x: 0, z: 0, sh: 'circle', r: 3, until: T });
    if (teleScan({ x: 5, z: 0 }, 0.5)) fail('circle outside');
    teles.length = n0;
    teles.push({ x: 0, z: 0, sh: 'line', yaw: 0, len: 10, w: 2, until: T }); // along +z
    const l = teleScan({ x: 0.5, z: 4 }, 0.5);
    if (!l || Math.abs(l[0]) !== 1 || l[1] !== 0) fail('line side step');
    teles.length = n0;
    if (lootable({ kind: 'carcass' }) || !lootable({ kind: 'gold' })) fail('loot kinds');
  })();

  window.__assist = {
    opt, st, vel, teles, dash, // read-only debug
    dodgeDecide, lootable, lootTick, autoDecide, slotReady, castRange, dashStats, // decision functions, for live checks
    stop() {
      alive_ = false;
      if (g.controls.build === wrapper) g.controls.build = origBuild; // else a later wrapper holds ours: it turns into a pass-through
      cancelAnimationFrame(raf); clearInterval(uiTimer);
      window.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', onResize);
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
      if (g.onMessage === onMsg) g.onMessage = origOnMessage; // else a pass-through (alive_ false)
      cv.remove(); panel.remove(); dashEl.remove();
      delete window.__assist;
    },
  };
  return 'assist loaded (F6)';
})();
