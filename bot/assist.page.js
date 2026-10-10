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
    auto: false, autoSlots: [false, false, false, false, false, false, false, false] };
  // Modes: complet (full bot), groupe (full bot following the party, __botOpts.group), metiers (gathering bot), assist, simple (presets on the main switches), perso (the user's own snapshot).
  const MODES = ['complet', 'groupe', 'metiers', 'assist', 'simple', 'perso'];
  const FLAGS = ['aim', 'aimAll', 'lead', 'mark', 'dodge', 'pot', 'loot', 'dash', 'auto'];
  const PRESET = {
    assist: { aim: true, aimAll: true, lead: true, mark: true, dodge: true, pot: true, loot: true, dash: true, auto: false },
    simple: { aim: true, aimAll: false, lead: false, mark: false, dodge: false, pot: false, loot: true, dash: false, auto: false },
  };
  const feats = o => {
    const f = {};
    for (const k in DEF) f[k] = o?.[k] ?? DEF[k];
    f.autoSlots = DEF.autoSlots.map((_, i) => !!o?.autoSlots?.[i]);
    return f;
  };
  const presetOf = f => Object.keys(PRESET).find(m => FLAGS.every(k => !!f[k] === PRESET[m][k])) ?? 'perso';
  // Saved state v2: { v, mode, f (features), custom (Perso snapshot), bot, ui }. v1 was the flat feature object plus x, y.
  function parseState(s) {
    const v1 = s && s.v !== 2, f = feats(v1 ? s : s?.f), ui = v1 ? { x: s.x, y: s.y } : s?.ui ?? {};
    return {
      v: 2, mode: !v1 && MODES.includes(s?.mode) ? s.mode : presetOf(f), f, custom: feats(v1 ? f : s?.custom ?? f),
      bot: { autoTalents: !v1 && s?.bot?.autoTalents === true, vizPath: !v1 && !!s?.bot?.vizPath, vizMap: !v1 && !!s?.bot?.vizMap },
      ui: { x: ui.x ?? null, y: ui.y ?? null, min: !!ui.min, sec: { ...ui.sec } },
    };
  }
  const S = (() => { try { return parseState(JSON.parse(localStorage.getItem(OPT_KEY))); } catch { return parseState(null); } })();
  const opt = S.f; // feature logic reads opt.* only
  const save = () => { try { localStorage.setItem(OPT_KEY, JSON.stringify(S)); } catch {} };
  // Read by bot.page.js before learning talents.
  const pushBotOpts = () => { window.__botOpts = { ...(window.__botOpts || {}), autoTalents: S.bot.autoTalents, group: S.mode === 'groupe' }; };
  pushBotOpts();
  // A* overlay (viz.page.js): bit 1 on-screen path, bit 2 big map; viz reads the bot's nav, so it shows in Complet.
  const pushViz = () => window.__viz?.setMode?.((S.bot.vizPath ? 1 : 0) | (S.bot.vizMap ? 2 : 0));
  pushViz();
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
  // Full bot or gathering bot running: every assist feature steps aside. status() is heavy, so read it twice a second.
  const anyBot = () => {
    if (!window.__bot && !window.__gather) { st.botOn = st.gatherOn = false; return false; }
    if (now() - st.botAt > 500) {
      st.botAt = now();
      try { st.botS = window.__bot?.status() ?? null; } catch { st.botS = null; }
      try { st.gatherS = window.__gather?.status() ?? null; } catch { st.gatherS = null; }
      st.botOn = !!st.botS?.on; st.gatherOn = !!st.gatherS?.on;
    }
    return st.botOn || st.gatherOn;
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
  // A globe only restores hp: worth a pickup (or a detour) only below full life.
  const lootable = d => d.kind === 'globe' ? g.hp < g.life : AUTO_LOOT.has(d.kind) || (d.kind === 'item' && opt.lootGear && !bagFull());
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
      if (anyBot()) { st.tgt = null; st.aim = null; return origBuild(aimPt); }
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

  // --- panel (F6): mode switch, options by category, collapsible to a pill, draggable by its header.
  // Class "menu" makes the game's own overUi test (closest('.panel, .hud-block, .menu')) treat it as UI.
  const css = document.createElement('style');
  css.id = 'assist-style';
  css.textContent = `
#assist-panel{--k-gold:var(--gold,#e2b54a);--k-title:#ffd890;--k-ink:var(--ink,#ece6da);--k-dim:var(--ink-dim,#c0b8a7);--k-faint:var(--ink-faint,#8f8777);
--k-line:rgba(221,213,196,.13);--k-on:var(--good,#8fdc8a);--k-ring:0 0 0 2px #000,0 0 0 4px var(--accent-hi,#f4efe5);
position:fixed;z-index:99999;width:276px;box-sizing:border-box;user-select:none;color:var(--k-ink);
font:13px/1.3 "Alegreya Sans","Segoe UI",system-ui,sans-serif;font-variant-numeric:lining-nums tabular-nums;
background:rgba(22,23,26,.9);border:1px solid rgba(110,103,90,.75);border-radius:8px;
box-shadow:0 0 0 1px #000,0 12px 30px rgba(0,0,0,.6),inset 0 1px 0 rgba(255,255,255,.06);backdrop-filter:blur(3px)}
#assist-panel *{box-sizing:border-box}
#assist-panel[hidden]{display:none}
#assist-panel button{font:inherit;color:inherit;background:none;border:0;padding:0;margin:0;cursor:pointer}
#assist-panel :focus{outline:none}
#assist-panel :focus-visible{box-shadow:var(--k-ring);border-radius:4px}
#assist-panel .hd{display:flex;align-items:center;gap:7px;padding:7px 6px 7px 11px;cursor:move}
#assist-panel .ttl{font:700 13px/1 "Alegreya Sans SC","Alegreya Sans",system-ui,sans-serif;letter-spacing:1.3px;color:var(--k-title)}
#assist-panel .key{font-size:11px;color:var(--k-faint);border:1px solid var(--k-line);border-radius:3px;padding:1px 4px;line-height:1.2}
#assist-panel .pt{display:none;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--k-dim)}
#assist-panel .pt b{color:var(--k-title);font-weight:700}
#assist-panel .dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--k-faint);box-shadow:0 0 0 2px rgba(0,0,0,.5)}
#assist-panel .dot.on{background:var(--k-on);box-shadow:0 0 0 2px rgba(0,0,0,.5),0 0 6px var(--k-on)}
#assist-panel .dot.as{background:var(--k-gold);box-shadow:0 0 0 2px rgba(0,0,0,.5),0 0 6px var(--k-gold)}
#assist-panel .sp{flex:1}
#assist-panel .ic{width:22px;height:22px;display:grid;place-items:center;border-radius:4px;color:var(--k-dim)}
#assist-panel .ic:hover{background:rgba(242,237,226,.08);color:var(--k-ink)}
#assist-panel .ic svg{width:12px;height:12px;transition:transform .15s}
#assist-panel.min{width:max-content;max-width:380px;border-radius:999px}
#assist-panel.min .hd{padding:5px 5px 5px 12px}
#assist-panel.min .ttl,#assist-panel.min .key,#assist-panel.min .bd{display:none}
#assist-panel.min .pt{display:block;flex:0 1 auto}
#assist-panel.min .ic svg{transform:rotate(180deg)}
#assist-panel .bd{padding:0 10px 10px}
#assist-panel .seg{display:flex;padding:2px;gap:2px;background:rgba(0,0,0,.35);border:1px solid var(--k-line);border-radius:6px}
#assist-panel .seg button{flex:1 1 auto;padding:5px 2px;border-radius:4px;font-size:12px;color:var(--k-dim);white-space:nowrap}
#assist-panel .seg button:hover:not(:disabled){color:var(--k-ink);background:rgba(242,237,226,.06)}
#assist-panel .seg button[aria-checked=true]{color:#1a1608;background:linear-gradient(180deg,#f0cd78,#c99a3a);font-weight:700;box-shadow:inset 0 1px 0 rgba(255,255,255,.35)}
#assist-panel .seg button:disabled{opacity:.35;cursor:not-allowed}
#assist-panel .seg .pp{flex:0 0 auto;padding:5px 4px}
#assist-panel .hint{margin:7px 1px 2px;font-size:12px;color:var(--k-faint)}
#assist-panel .act{display:flex;align-items:center;gap:8px;margin-top:8px;padding:7px 9px;border-radius:6px;background:rgba(0,0,0,.25);border:1px solid var(--k-line)}
#assist-panel .act .tx{flex:1;min-width:0;color:var(--k-dim);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#assist-panel .run{flex:none;padding:3px 10px;border-radius:4px;border:1px solid rgba(110,103,90,.9);background:rgba(242,237,226,.06);font-size:12px;font-weight:700;color:var(--k-title)}
#assist-panel .run:hover{background:rgba(242,237,226,.14)}
#assist-panel section{margin-top:8px;border-top:1px solid var(--k-line);padding-top:6px}
#assist-panel .sh{display:flex;align-items:center;gap:6px;width:100%;padding:2px 1px;text-align:left;
font:700 12px/1.2 "Alegreya Sans SC","Alegreya Sans",system-ui,sans-serif;letter-spacing:1.2px;color:var(--k-title)}
#assist-panel .sh svg{width:9px;height:9px;color:var(--k-faint);transition:transform .15s}
#assist-panel .sh[aria-expanded=false] svg{transform:rotate(-90deg)}
#assist-panel .sh .n{margin-left:auto;font:12px "Alegreya Sans",system-ui,sans-serif;letter-spacing:0;color:var(--k-faint)}
#assist-panel .sb{padding-top:2px}
#assist-panel .sh[aria-expanded=false]+.sb{display:none}
#assist-panel .r{display:flex;align-items:center;gap:8px;min-height:25px;padding:0 1px;cursor:pointer}
#assist-panel .r.sub{padding-left:14px;color:var(--k-dim)}
#assist-panel .r.off,#assist-panel [data-slots].off{opacity:.42}
#assist-panel .r[hidden],#assist-panel section[hidden],#assist-panel .act[hidden]{display:none}
#assist-panel .lb{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#assist-panel .lb i{font-style:normal;color:var(--k-faint);margin-right:5px}
#assist-panel input.sw{appearance:none;-webkit-appearance:none;flex:none;width:30px;height:17px;margin:0;border-radius:999px;cursor:pointer;position:relative;
background:rgba(0,0,0,.5);border:1px solid rgba(221,213,196,.25);transition:background .15s,border-color .15s}
#assist-panel input.sw::after{content:"";position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:var(--k-dim);transition:transform .15s,background .15s}
#assist-panel input.sw:checked{background:rgba(226,181,74,.3);border-color:var(--k-gold)}
#assist-panel input.sw:checked::after{transform:translateX(13px);background:var(--k-title)}
#assist-panel input.sw:focus-visible{box-shadow:var(--k-ring)}
#assist-panel input[type=range]{flex:0 0 96px;width:96px;margin:0;accent-color:var(--k-gold);cursor:pointer;height:14px}
#assist-panel output{flex:0 0 38px;text-align:right;font-size:12px;color:var(--k-title)}
#assist-panel .st{margin-top:8px;padding-top:6px;border-top:1px solid var(--k-line);font-size:12px;color:var(--k-faint);white-space:pre-line}
`;
  document.head.appendChild(css);

  const MODE_TXT = { complet: 'Jouer complet', groupe: 'Groupe', metiers: 'Métiers', assist: 'Assistant', simple: 'Simple', perso: 'Perso' };
  const MODE_SEG = { complet: 'Complet', groupe: 'Groupe', metiers: 'Métiers', assist: 'Assistant', simple: 'Simple', perso: 'Perso' };
  const HINT = {
    complet: 'Le bot joue seul, les aides sont en veille.', groupe: 'Le bot suit le membre du groupe de niveau le plus proche et l\'aide.', metiers: 'Le bot récolte seul, les aides sont en veille.',
    assist: 'Aides au jeu manuel. Changer une option passe en Perso.', simple: 'Aimbot et ramassage seulement.', perso: 'Toutes les options, à la carte.',
  };
  const MC = { complet: 'c', groupe: 'g', metiers: 'm', assist: 'a', simple: 's', perso: 'p' }; // row visibility letters
  // Sections: [id, title, rows]. Row: [key, label, modes, parent key, range [min, max, step, unit]].
  const SECS = [
    ['visee', 'Visée', [['aim', 'Aimbot', 'asp'], ['radius', 'Rayon', 'asp', 'aim', [1, 20, 0.5, ' m']],
      ['aimAll', 'Aussi clic droit et sorts', 'ap', 'aim'], ['lead', 'Anticipation', 'ap'], ['mark', 'Marqueur', 'ap', 'aim']]],
    ['survie', 'Survie', [['dodge', 'Esquive auto', 'ap'], ['pot', 'Potion auto', 'ap'], ['potPct', 'Seuil', 'ap', 'pot', [5, 90, 5, ' %']]]],
    ['butin', 'Butin', [['loot', 'Ramassage auto', 'asp'], ['lootR', 'Rayon', 'asp', 'loot', [1, 10, 0.5, ' m']],
      ['lootGear', 'Aussi l\'équipement', 'ap', 'loot'], ['lootWalk', 'Détour si zone sûre (6 m)', 'ap', 'loot']]],
    ['combat', 'Combat', [['auto', 'Sorts auto', 'p']]],
    ['infos', 'Infos', [['dash', 'Tableau de bord', 'ap'], ['vizPath', 'Chemin A* à l\'écran', 'cgmasp'], ['vizMap', 'Grande carte (A*)', 'cgmasp']]],
    ['bots', 'Bots', [['autoTalents', 'Talents auto', 'cgp']]],
  ];
  const CHEV = '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const fmtV = (v, u) => `${+v}${u}`;
  const rowHtml = ([k, label, m, par, rg]) => {
    const a = `class="r${par ? ' sub' : ''}" data-row="${k}" data-m="${m}"${par ? ` data-par="${par}"` : ''}`;
    return rg ? `<label ${a}><span class="lb">${label}</span><input type="range" data-k="${k}" min="${rg[0]}" max="${rg[1]}" step="${rg[2]}" aria-label="${label}"><output data-u="${rg[3]}"></output></label>`
      : `<label ${a}><span class="lb">${label}</span><input type="checkbox" class="sw" role="switch" data-k="${k}"></label>`;
  };

  const panel = document.createElement('div');
  panel.id = 'assist-panel';
  panel.className = 'menu';
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Assistance');
  panel.innerHTML = `<div class="hd" data-drag><span class="dot" data-dot></span><span class="ttl">Assist</span><span class="key">F6</span>`
    + `<span class="pt" data-pt></span><span class="sp"></span><button class="ic" data-min>${CHEV.replace('M2 3.5l3 3 3-3', 'M2 6.5l3-3 3 3')}</button></div>`
    + `<div class="bd"><div class="seg" role="radiogroup" aria-label="Mode">`
    + MODES.map(m => `<button role="radio" data-mode="${m}"${m === 'perso' ? ' class="pp"' : ''} title="${MODE_TXT[m]}">${MODE_SEG[m]}</button>`).join('')
    + `</div><div class="hint" data-hint></div>`
    + `<div class="act" data-act><span class="dot" data-adot></span><span class="tx" data-atx></span><button class="run" data-run></button></div>`
    + SECS.map(([id, title, rows]) => `<section data-sec="${id}"><button class="sh" data-sh aria-expanded="true">${CHEV}${title}<span class="n" data-n></span></button>`
      + `<div class="sb">${rows.map(rowHtml).join('')}${id === 'combat' ? '<div data-slots></div>' : ''}</div></section>`).join('')
    + `<div class="st" data-st></div></div>`;
  document.body.appendChild(panel);
  const $ = s => panel.querySelector(s), $$ = s => [...panel.querySelectorAll(s)];
  const stEl = $('[data-st]'), slotsEl = $('[data-slots]');
  const esc = s => String(s).replace(/[<>&"]/g, c => `&#${c.charCodeAt(0)};`);

  const place = () => {
    const w = panel.offsetWidth || 276, h = panel.offsetHeight || 40;
    if (S.ui.x == null) { panel.style.left = Math.max(0, innerWidth - 300 - w) + 'px'; panel.style.top = '12px'; return; }
    panel.style.left = Math.max(0, Math.min(innerWidth - w, S.ui.x)) + 'px'; panel.style.top = Math.max(0, Math.min(innerHeight - Math.min(h, 40), S.ui.y)) + 'px';
  };

  // --- state actions
  const botOk = () => ['necromancer', 'shaman'].includes(g.char?.ch?.cls) && !!window.__bot;
  const refresh = () => { st.botAt = 0; anyBot(); };
  const pauseBots = () => {
    refresh();
    try { if (st.botOn) window.__bot.pause(); } catch {}
    try { if (st.gatherOn) window.__gather.pause(); } catch {}
    refresh();
  };
  // Start one bot, pause the other (__gather.start already pauses __bot itself).
  const runBot = which => {
    refresh();
    try {
      if (which !== 'metiers') { if (st.gatherOn) window.__gather.pause(); window.__bot.start(); }
      else window.__gather.start();
    } catch (e) { st.err = e.message; }
    refresh();
  };
  function setMode(m) {
    if (m === S.mode && m !== 'perso') return;
    S.mode = m; pushBotOpts(); // the bot reads group on its next tick
    if (m === 'complet' || m === 'groupe' || m === 'metiers') { runBot(m); S.ui.min = true; }
    else {
      pauseBots();
      Object.assign(opt, m === 'perso' ? feats(S.custom) : PRESET[m]);
    }
    save(); draw(); place();
  }
  const botMode = () => S.mode === 'complet' || S.mode === 'groupe' || S.mode === 'metiers';
  // Any individual feature change turns the mode into Perso and becomes its snapshot.
  const touched = () => {
    if (botMode()) pauseBots();
    S.mode = 'perso'; pushBotOpts(); S.custom = feats(opt); save();
  };

  // --- rendering
  function draw() {
    const mc = MC[S.mode];
    panel.classList.toggle('min', !!S.ui.min);
    const minBtn = $('[data-min]');
    minBtn.title = S.ui.min ? 'Agrandir' : 'Réduire'; minBtn.setAttribute('aria-label', minBtn.title); minBtn.setAttribute('aria-expanded', String(!S.ui.min));
    for (const b of $$('[data-mode]')) {
      const m = b.dataset.mode;
      b.setAttribute('aria-checked', String(m === S.mode)); b.tabIndex = m === S.mode ? 0 : -1;
      b.disabled = m === 'complet' || m === 'groupe' ? !botOk() : m === 'metiers' ? !window.__gather : false;
      b.title = (m === 'complet' || m === 'groupe') && !botOk() ? `${MODE_TXT[m]} : nécromancien ou chaman, bot chargé`
        : m === 'metiers' && !window.__gather ? 'Métiers : bot métiers non chargé' : MODE_TXT[m];
    }
    $('[data-hint]').textContent = HINT[S.mode];
    for (const r of $$('[data-row]')) {
      const k = r.dataset.row, el = r.querySelector('input');
      r.hidden = !r.dataset.m.includes(mc);
      r.classList.toggle('off', !!r.dataset.par && !opt[r.dataset.par]);
      if (k === 'autoTalents' || k === 'vizPath' || k === 'vizMap') el.checked = S.bot[k];
      else if (el.type === 'checkbox') el.checked = !!opt[k];
      else { el.value = opt[k]; r.querySelector('output').textContent = fmtV(opt[k], r.querySelector('output').dataset.u); }
    }
    slotsEl.hidden = mc !== 'p';
    for (const el of slotsEl.querySelectorAll('[data-slot]')) el.checked = !!opt.autoSlots[+el.dataset.slot];
    slotsEl.classList.toggle('off', !opt.auto);
    for (const s of $$('section')) {
      const rows = [...s.querySelectorAll('[data-row]')], vis = rows.filter(r => !r.hidden);
      s.hidden = !vis.length;
      const sw = vis.filter(r => !r.dataset.par && r.querySelector('.sw'));
      s.querySelector('[data-n]').textContent = sw.length > 1 ? `${sw.filter(r => r.querySelector('input').checked).length}/${sw.length}` : '';
      const sh = s.querySelector('[data-sh]');
      sh.setAttribute('aria-expanded', String(!S.ui.sec[s.dataset.sec]));
    }
    drawLive();
  }
  // Bot line, pill text and status dot: refreshed by the timer.
  const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
  const short = (v, n = 32) => { const s = typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v); return s.length > n ? s.slice(0, n - 1) + '.' : s; };
  function gatherTxt() {
    const s = st.gatherS;
    if (!s) return 'bot métiers non chargé';
    const top = Object.entries(s.stats ?? {}).sort((a, b) => b[1].n - a[1].n)[0];
    const rate = top ? `${top[0]} ${String(s.rate?.[top[0]] ?? '').split(',')[0]}` : '';
    return [s.node?.node ?? short(s.doing, 24), rate].filter(Boolean).join(', ') || 'en route';
  }
  function botTxt() {
    const s = st.botS;
    if (!s) return 'bot non chargé';
    return `${short(s.doing, 28) || 'prêt'}, niv ${s.lvl}, ${plural(s.deaths ?? 0, 'mort')}`;
  }
  // Leader exposed by the bot as status().group = { name, lvl } (null without a party).
  const groupTxt = () => { const l = st.botS?.group; return l ? `suit ${l.name} niv ${l.lvl}` : 'pas de groupe'; };
  function drawLive() {
    const bm = botMode(), on = S.mode === 'metiers' ? st.gatherOn : st.botOn;
    let pill, dot;
    if (st.gatherOn) { pill = `<b>Métiers</b> : ${esc(gatherTxt())}`; dot = 'on'; }
    else if (st.botOn && S.mode === 'groupe') { pill = `<b>Groupe</b> : ${esc(groupTxt())}`; dot = 'on'; }
    else if (st.botOn) { pill = `<b>Complet</b> : ${esc(botTxt())}`; dot = 'on'; }
    else if (bm) { pill = `<b>${MODE_TXT[S.mode]}</b> : en pause`; dot = ''; }
    else { pill = `<b>${MODE_TXT[S.mode]}</b> actif`; dot = 'as'; }
    const pt = $('[data-pt]');
    if (pt.innerHTML !== pill) { pt.innerHTML = pill; pt.title = pt.textContent; }
    $('[data-dot]').className = 'dot ' + dot;
    const act = $('[data-act]');
    act.hidden = !bm;
    if (bm) {
      $('[data-adot]').className = 'dot ' + (on ? 'on' : '');
      $('[data-atx]').textContent = on ? (S.mode === 'metiers' ? gatherTxt() : S.mode === 'groupe' ? `${groupTxt()}, ${botTxt()}` : botTxt()) : 'en pause';
      $('[data-atx]').title = $('[data-atx]').textContent;
      $('[data-run]').textContent = on ? 'Pause' : 'Reprendre';
    }
  }
  // --- events
  panel.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.mode) setMode(b.dataset.mode);
    else if (b.dataset.min !== undefined) { S.ui.min = !S.ui.min; save(); draw(); place(); }
    else if (b.dataset.sh !== undefined) { const id = b.closest('section').dataset.sec; S.ui.sec[id] = !S.ui.sec[id]; save(); draw(); }
    else if (b.dataset.run !== undefined) { (S.mode === 'metiers' ? st.gatherOn : st.botOn) ? pauseBots() : runBot(S.mode); drawLive(); }
  });
  // Arrow keys move between mode segments (radio group pattern).
  $('.seg').addEventListener('keydown', e => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const bs = $$('[data-mode]').filter(b => !b.disabled), i = bs.indexOf(document.activeElement);
    if (i < 0) return;
    const n = bs[(i + (e.key === 'ArrowRight' ? 1 : bs.length - 1)) % bs.length];
    n.focus(); n.click(); e.preventDefault();
  });
  const onInput = e => {
    const el = e.target;
    if (el.dataset.slot !== undefined) { opt.autoSlots[+el.dataset.slot] = el.checked; touched(); draw(); return; }
    const k = el.dataset.k;
    if (!k) return;
    if (k === 'autoTalents') { S.bot.autoTalents = el.checked; pushBotOpts(); save(); return; }
    if (k === 'vizPath' || k === 'vizMap') { S.bot[k] = el.checked; pushViz(); save(); return; }
    if (el.type === 'checkbox') opt[k] = el.checked;
    else { const v = parseFloat(el.value); if (!Number.isFinite(v)) return; opt[k] = Math.max(+el.min, Math.min(+el.max, v)); }
    touched(); draw();
  };
  panel.addEventListener('change', onInput);
  panel.addEventListener('input', e => { if (e.target.type === 'range') onInput(e); });
  // Keys and clicks on the panel never reach the game.
  for (const t of ['keydown', 'keyup', 'mousedown', 'pointerdown', 'wheel', 'contextmenu', 'dblclick']) panel.addEventListener(t, e => e.stopPropagation());
  // Mouse users get focus back to the game (WASD would stop at a focused switch); keyboard focus stays.
  panel.addEventListener('pointerup', () => setTimeout(() => { if (panel.contains(document.activeElement)) document.activeElement.blur(); }));
  panel.addEventListener('mouseenter', () => { st.overPanel = true; });
  panel.addEventListener('mouseleave', () => { st.overPanel = false; });
  let drag = null;
  panel.addEventListener('mousedown', e => {
    if (e.button !== 0 || !e.target.closest('[data-drag]') || e.target.closest('button')) return;
    const r = panel.getBoundingClientRect(); drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x0: e.clientX, y0: e.clientY, moved: false }; e.preventDefault();
  });
  const onMove = e => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
    drag.moved = true; S.ui.x = e.clientX - drag.dx; S.ui.y = e.clientY - drag.dy; place();
  };
  // A click (no drag) on the pill expands it.
  const onUp = () => {
    if (!drag) return;
    const moved = drag.moved; drag = null;
    if (!moved && S.ui.min) { S.ui.min = false; draw(); place(); }
    save();
  };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);

  // Auto cast slot list, rebuilt when the bar (or a form) changes the names.
  const KEY_TXT = ['clic G', 'clic D', '1', '2', '3', '4', 'R', '5'];
  let slotsSig = '';
  function drawSlots() {
    const names = g.char.bar.map((id, i) => id ? slotName(i) : ''), sig = names.join('|');
    if (sig === slotsSig) return;
    slotsSig = sig;
    slotsEl.innerHTML = names.map((n, i) => n ? `<label class="r sub" title="${esc(n)}"><span class="lb"><i>${KEY_TXT[i]}</i>${esc(n)}</span>`
      + `<input type="checkbox" class="sw" role="switch" data-slot="${i}"${opt.autoSlots[i] ? ' checked' : ''}></label>` : '').join('');
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

  let uiN = 0;
  const uiTimer = setInterval(() => {
    if (uiN++ % 4 === 0) drawDash();
    if (panel.hidden) return;
    anyBot();
    drawSlots(); drawLive();
    const sig = `${botOk()}|${!!window.__gather}`;
    if (sig !== st.uiSig) { st.uiSig = sig; draw(); } // a bot loaded or unloaded: segment availability
    const m = st.tgt;
    stEl.textContent = st.botOn || st.gatherOn ? `${st.botOn ? (S.mode === 'groupe' ? 'groupe' : 'jouer complet') : 'bot métiers'} actif : aides en veille`
      : `cible : ${alive(m) ? `${m.def?.kind ?? '?'} ${m.level ?? ''}${st.fallback ? ' (proche)' : ''}` : '-'}`
        + (opt.dodge || opt.loot || opt.auto ? `\nesquives ${st.dodges}, ramassés ${st.loots}, sorts ${st.casts}` : '')
        + (st.escaping && opt.dodge ? '\nesquive en cours' : '')
        + (st.err ? `\nerreur : ${st.err}` : '');
  }, 250);

  const onKey = e => {
    if (e.code !== 'F6' || g.ui.typing) return;
    e.preventDefault(); panel.hidden = !panel.hidden;
    if (!panel.hidden) place();
  };
  window.addEventListener('keydown', onKey, true);
  const onResize = () => place();
  window.addEventListener('resize', onResize);
  draw(); place();

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
    if (lootable({ kind: 'carcass' }) || !lootable({ kind: 'gold' }) || lootable({ kind: 'globe' }) !== g.hp < g.life) fail('loot kinds');
    // v1 flat settings: values and position kept, mode guessed from the switches.
    const m1 = parseState({ aim: true, aimAll: true, lead: true, mark: true, dodge: true, loot: true, lootR: 7, x: 40, y: 50, autoSlots: [true] });
    if (m1.mode !== 'perso' || m1.f.lootR !== 7 || !m1.f.autoSlots[0] || m1.ui.x !== 40 || 'x' in m1.f || m1.bot.autoTalents) fail('migrate v1');
    if (parseState({ ...PRESET.simple }).mode !== 'simple' || parseState(null).mode !== 'perso') fail('migrate mode');
  })();

  window.__assist = {
    opt, S, st, vel, teles, dash, draw, // read-only debug (S: saved state, draw: panel redraw)
    dodgeDecide, lootable, lootTick, autoDecide, slotReady, castRange, dashStats, // decision functions, for live checks
    stop() {
      alive_ = false;
      if (g.controls.build === wrapper) g.controls.build = origBuild; // else a later wrapper holds ours: it turns into a pass-through
      cancelAnimationFrame(raf); clearInterval(uiTimer);
      window.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', onResize);
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
      if (g.onMessage === onMsg) g.onMessage = origOnMessage; // else a pass-through (alive_ false)
      cv.remove(); panel.remove(); css.remove(); dashEl.remove();
      delete window.__assist;
    },
  };
  return 'assist loaded (F6)';
})();
