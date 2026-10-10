// Injected into the Ombreval page. Profession gathering bot (window.__gather), any class.
// Same mechanics as bot.page.js: wraps __game.controls.build and __game.onMessage; never runs together with __bot.
// Helpers marked "copy" come from bot.page.js (kept standalone on purpose, no import).
(() => {
  if (window.__gather) window.__gather.stop();
  const g = window.__game;
  if (!g?.controls || !g.nodes?.list) throw new Error('__game not ready');

  // Learned memory (this browser only): gather duration, respawn, xp per node type, strike timing, danger spots.
  const AD_KEY = 'ombreval-gather';
  const ad = (() => { try { return JSON.parse(localStorage.getItem(AD_KEY)) ?? {}; } catch { return {}; } })();
  // v2 migration: drop the doubling avoid timers and hour-long danger spots (risk is now a decaying cost).
  if ((ad.v ?? 1) < 2) { delete ad.spots; delete ad.avoid; delete ad.risk; ad.v = 2; }
  ad.dur ??= {}; ad.gdur ??= {}; ad.back ??= {}; ad.xp ??= {}; ad.leash ??= {};
  ad.area ??= {}; ad.aggro ??= {}; ad.mspd ??= {}; ad.mdps ??= {}; ad.chaseS ??= 15;
  ad.strike ??= [0, 0.5, 1].map(k => ({ k, ok: 0, n: 0 })); ad.rtt ??= 150; ad.bf ??= 0; ad.bfN ??= 0; ad.detour ??= 1.25; ad.wayCost ??= 25;
  ad.tot ??= {};
  const saveAd = () => { try { localStorage.setItem(AD_KEY, JSON.stringify(ad)); } catch {} };

  const now = () => performance.now();
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const ema = (old, x, n) => old == null ? x : old + (x - old) * Math.max(0.1, 1 / (n + 2));
  const solid = (x, z) => { // copy
    const c = g.dungeon?.collision ?? g.world?.collision;
    try { return !!c?.solidAt(x, z, 0.6); } catch { return false; }
  };
  const PLAYER_SPEED = 5.28;
  // Dodge useless for travel (knight: raised guard slows down).
  const NO_ROLL = new Set(['knight']);
  const CLS = g.char.ch.cls;

  // --- Professions and node values (bundle: X$ L86524, b_ tiers, M_ xp base, D_ grey-out).
  const PROF = { ore: 'miner', herb: 'herbalist' };
  const PROF_FR = { miner: 'Mineur', herbalist: 'Herboriste', skinner: 'Dépeceur', alchemist: 'Alchimiste', cook: 'Cuisinier', jeweler: 'Joaillier', armorer: 'Armurier' };
  const MAT_FR = { iron: 'fer', steel: 'acier', emberite: 'braisite', umbral: 'ombracier' };
  const XP_BASE = { 1: 18, 2: 30, 3: 44, 4: 60 };
  const xpFactor = d => d < 5 ? 1 : d < 10 ? 0.7 : d < 18 ? 0.35 : 0.05;
  const lvlNeed = L => Math.round(30 + 8 * L + 0.9 * L * L);
  const profOf = n => g.char.prof?.list?.find(p => p.id === PROF[n.kind]);
  const canWork = n => { const p = profOf(n); return !!p && p.lvl >= n.req; };
  const key = n => n.kind + n.tier;
  const nodeName = n => `${n.kind === 'ore' ? 'Filon de ' : ''}${MAT_FR[n.mat] ?? n.mat} #${n.id}`;
  // Expected xp per gather: learned value (normalized to factor 1) or the recipe base as a prior.
  const xpOf = n => { const p = profOf(n); return (ad.xp[key(n)]?.v ?? XP_BASE[n.tier]) * xpFactor((p?.lvl ?? 1) - n.req); };
  const durOf = n => ad.gdur[key(n)]?.v ?? ad.dur[key(n)] ?? 5;
  // Rich node (bundle vT/yT L44144): 12 % of nodes per character per 20 min window, server clock.
  function hash3(e, t, n) {
    let r = Math.imul(e ^ 2654435769, 2246822507) ^ Math.imul(t + 1663821211, 3266489909) ^ Math.imul(n + 668265263, 374761393);
    r = Math.imul(r ^ (r >>> 15), 739982445); r = Math.imul(r ^ (r >>> 12), 695872825);
    return ((r ^ (r >>> 15)) >>> 0) / 4294967296;
  }
  const serverNow = () => Date.now() + ad.bf;
  const rich = (id, t = serverNow()) => hash3(id, g.char.id, Math.floor(t / 1200000)) < 0.12;
  const backLocal = id => { const b = g.nodesBack.get(id); return b == null ? 0 : b - ad.bf; };

  // Open-world zones (bundle Xu L27440): center, radius, monster levels.
  const ZONES = [
    { id: 'wolves', name: 'Bois des Hurlements', x: -52, z: 8, r: 30, lvl: [1, 3] },
    { id: 'goblins', name: 'Camp des Gobelins', x: -82, z: -48, r: 27, lvl: [3, 5] },
    { id: 'graveyard', name: 'Cimetière Oublié', x: 62, z: 12, r: 28, lvl: [5, 7] },
    { id: 'spiders', name: 'Sombrebois', x: 58, z: -62, r: 30, lvl: [7, 9] },
    { id: 'lair', name: 'Antre de Grukk', x: 0, z: -100, r: 26, lvl: [10, 12] },
    { id: 'swamp', name: 'Brumelande', x: -160, z: 70, r: 42, lvl: [12, 16] },
    { id: 'ashlands', name: 'Terres de Cendre', x: 160, z: -30, r: 44, lvl: [17, 22] },
    { id: 'necropolis', name: 'Nécropole', x: 5, z: -170, r: 40, lvl: [23, 30] },
    { id: 'quarry', name: 'Rochenoire', x: -112, z: -104, r: 30, lvl: [13, 16] },
    { id: 'mycelium', name: 'Moisivert', x: -130, z: 150, r: 38, lvl: [9, 13] },
    { id: 'frost', name: 'Givrecroc', x: 20, z: 178, r: 42, lvl: [17, 22] },
    { id: 'rift', name: 'La Faille', x: 160, z: 150, r: 38, lvl: [27, 30] },
  ];
  const zoneOf = p => ZONES.reduce((b, z) => !b || dist(z, p) - z.r < dist(b, p) - b.r ? z : b, null);

  const st = { on: false, phase: 'idle', node: null, last: '', pressed: new Set(), black: new Map(), stats: {}, onMs: 0, flip: new Map() };

  // --- Danger: no level caps. Every node pays an expected cost in seconds:
  // risk = P(attacked on the trip) x [P(death | attacked) x death cost + (1 - P(death | attacked)) x cost of the attack].
  const ATTACK_STATES = ['chase', 'windup', 'strike'];
  const CHASE_STATES = ['chase', 'windup', 'strike', 'recover', 'leap'];
  const CHASE_PRIOR = 14, AGGRO_PRIOR = 10, HALF_LIFE = 600000, RESPAWN_S = 10, BASE_ATTACK = 0.15, MARGIN = 0.1;
  const chaseRange = kind => ad.leash[kind]?.d ?? CHASE_PRIOR;
  const aggroR = kind => Math.min(20, ad.aggro[kind]?.d ?? AGGRO_PRIOR);
  const mSpeed = m => ad.mspd[m.def?.kind]?.v ?? m.def?.speed ?? PLAYER_SPEED;
  const converging = (m, d) => ATTACK_STATES.includes(m.state) && d < chaseRange(m.def?.kind) + mSpeed(m);
  const retreatOver = (state, d, range, speed) => !CHASE_STATES.includes(state) || (range != null && d > range + speed);
  const live = () => [...g.entities.visibleMonsters()].filter(m => !m.dead && m.hp > 0);
  const lvlScale = l => 1 + 0.1 * Math.max(0, (l ?? 1) - 1);
  // Monster dps per kind (normalized to level 1): damage / exposure in reach, prior worth 5 s of a guessed dps. TODO(ceiling): prior is a guess.
  const mDps = m => {
    const e = ad.mdps[m.def?.kind], p = (m.def?.dmg ?? 1) * 4;
    return ((e?.d ?? 0) + 5 * p) / ((e?.e ?? 0) + 5) * lvlScale(m.level) * (m.elite ? 2 : 1) * (m.boss ? 4 : 1);
  };
  const myDps = () => (g.stats?.dps ?? 5) * 0.8; // basic clicks only
  const reachOf = m => (m.def?.radius ?? 0.6) + 1.5;
  // Fight check: kill the quickest first; damage taken = each monster's dps over its lifetime.
  function fightCost(o, dps, hp, life) {
    const s = o.map(m => ({ hp: m.hp, dps: m.dps })).sort((a, b) => a.hp / a.dps - b.hp / b.dps);
    let t = 0, taken = 0;
    for (const m of s) { t += m.hp / dps; taken += m.dps * t; }
    return { ttk: t, taken, win: taken < hp - MARGIN * life };
  }
  const fight = (ms, hp = g.hp) => fightCost(ms.map(m => ({ hp: m.hp, dps: mDps(m) })), myDps(), hp, g.life);
  const riskSec = (pa, pd, deathS, hitS) => pa * (pd * deathS + (1 - pd) * hitS);
  const regen = () => ad.regen ?? 1; // hp/s while resting, learned
  // Area memory: trips n, attacked a, deaths d, all decaying with a 10 min half-life (never a ban).
  function area(id) {
    const a = ad.area[id] ??= { n: 0, a: 0, d: 0, t: Date.now() }, k = 0.5 ** ((Date.now() - a.t) / HALF_LIFE);
    a.n *= k; a.a *= k; a.d *= k; a.t = Date.now();
    return a;
  }
  // Trip = one node visit; ends on gather end, retreat or death.
  const tripHit = () => { const t = st.trip; if (t && !t.hit) { t.hit = true; area(t.z).a++; } };
  // A death after the trip ended (retreat) still counts against the area we died in.
  const tripEnd = death => {
    const t = st.trip;
    if (!t) { if (death) { area(zoneOf(g.sim).id).d++; saveAd(); } return; }
    const a = area(t.z); a.n++; if (death) { if (!t.hit) a.a++; a.d++; } st.trip = null; saveAd();
  };
  // Death cost: respawn, walk back from the bound stone, xp lost at the character's farming rate.
  const CHAR_XPS = () => ad.charXps ?? 0.5 + 0.3 * g.level; // learned while __bot levels us, prior guessed
  function deathSec(n) {
    const rsp = ad.respawn ?? WAYS[0], walk = trip(rsp, n).len / speed();
    return RESPAWN_S + walk + (ad.lossK ?? 0.1) * (g.char.ch.xp ?? 0) / CHAR_XPS();
  }
  const segDist = (p, a, b) => {
    const dx = b.x - a.x, dz = b.z - a.z, L = dx * dx + dz * dz, t = L ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / L)) : 0;
    return Math.hypot(p.x - a.x - t * dx, p.z - a.z - t * dz);
  };
  function nodeRisk(n, me, ms, hp = g.hp) {
    const z = zoneOf(n), A = area(z.id), near = [];
    // Prior: live monsters by their aggro radius around the node and the leg to it, plus a base rate for roamers.
    let q = 1 - BASE_ATTACK;
    for (const m of ms) {
      const dn = dist(m.pos, n), d = Math.min(dn, segDist(m.pos, me, n)), r = aggroR(m.def?.kind);
      const e = d < r ? 0.7 : d < r + 8 ? 0.7 * (r + 8 - d) / 8 : 0;
      if (e) q *= 1 - e;
      if (dn < r + 8) near.push(m);
    }
    const pa = (A.a + 2 * (1 - q)) / (A.n + 2);
    const f = near.length ? fight(near, hp) : null;
    const pd0 = f ? (f.win ? 0.05 : near.every(m => mSpeed(m) < speed()) ? 0.2 : 0.6) : Math.min(1, g.life / Math.max(1, hp) / (1 + Math.exp(3 - (z.lvl[1] - g.level))));
    const pd = (A.d + 2 * pd0) / (A.a + 2);
    // Attack cost: a won fight costs its duration plus the hp to regenerate; else the learned cost of a chase.
    return riskSec(pa, pd, deathSec(n), f?.win ? f.ttk + f.taken / regen() : ad.chaseS);
  }

  // Threat: chasing or recently hitting us. Damage predicted over horizon H (what is left to do here):
  // faster monsters reach us at once, slower ones only once we stand still at the node (after tLeft).
  const threats = me => live().filter(m => { const d = dist(m.pos, me); return converging(m, d) || (d < 6 && now() - (hitAt.get(m.id) ?? -1e9) < 3000); });
  function dmgOver(ms, me, H, tLeft) {
    let s = 0;
    for (const m of ms) {
      const v = mSpeed(m), gap = Math.max(0, dist(m.pos, me) - reachOf(m)), ta = v >= speed() || !tLeft ? gap / v : Math.max(tLeft, gap / v);
      s += mDps(m) * Math.max(0, H - ta);
    }
    return s;
  }
  const hpLog = [];
  function hpTrend() { // observed incoming dps over the last 3 s
    const t = now(); hpLog.push([t, g.hp]);
    while (hpLog.length > 2 && t - hpLog[0][0] > 3000) hpLog.shift();
    const [t0, h0] = hpLog[0];
    return t - t0 > 500 ? Math.max(0, (h0 - g.hp) / ((t - t0) / 1000)) : 0;
  }
  // Learning per tick: aggro radius (idle -> chase distance), chase speed, monster dps (hits / exposure in reach).
  const mPrev = new Map(), dmgWin = { dmg: {}, exp: {}, at: now() };
  function monTick(me, dt) {
    for (const m of live()) {
      const k = m.def?.kind, d = dist(m.pos, me), was = mPrev.get(m.id);
      if (was && !CHASE_STATES.includes(was) && m.state === 'chase' && d < 25) { const e = ad.aggro[k] ??= { d: AGGRO_PRIOR, n: 0 }; e.d = ema(e.d, d, e.n++); }
      if (m.state === 'chase' && d < 30 && m.speedNow > 0.6 * (m.def?.speed ?? PLAYER_SPEED)) { const e = ad.mspd[k] ??= { v: m.speedNow, n: 0 }; e.v = ema(e.v, m.speedNow, e.n++); }
      if (ATTACK_STATES.includes(m.state) && d < reachOf(m) + 0.5) dmgWin.exp[k] = (dmgWin.exp[k] ?? 0) + dt / 1000;
      mPrev.set(m.id, m.state);
    }
    if (mPrev.size > 300) mPrev.clear();
    if (now() - dmgWin.at < 4000) return;
    for (const k in dmgWin.exp) {
      const e = ad.mdps[k] = ad.mdps[k]?.e != null ? ad.mdps[k] : { d: 0, e: 0 }, f = e.e > 300 ? 0.5 : 1; // keep ~5 min of exposure
      e.d = e.d * f + (dmgWin.dmg[k] ?? 0); e.e = e.e * f + dmgWin.exp[k];
    }
    dmgWin.dmg = {}; dmgWin.exp = {}; dmgWin.at = now();
  }

  function pickRetreat(me, chasers, cands, cur, vRatio) { // copy
    const clear = c => Math.min(...chasers.map(p => dist(p, c))) - dist(me, c) * vRatio;
    if (cur && dist(me, cur) > 2 && clear(cur) > 0) return cur;
    let best = null, bv = 0;
    for (const c of cands) { const v = clear(c); if (dist(me, c) > 2 && v > bv) { bv = v; best = { x: c.x, z: c.z }; } }
    return best;
  }
  function retreatCands(me) {
    const out = [], idle = live().filter(m => !CHASE_STATES.includes(m.state));
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6, c = Math.cos(a), s = Math.sin(a);
      out.push({ x: me.x + c * 20, z: me.z + s * 20 }, { x: me.x + c * 40, z: me.z + s * 40 });
    }
    for (const w of awake()) out.push(w);
    return out.filter(p => !solid(p.x, p.z) && !idle.some(m => dist(m.pos, p) < aggroR(m.def?.kind)));
  }
  function startRetreat(ms, why) {
    if (!st.retreat) { st.retreats = (st.retreats ?? 0) + 1; st.retreat = { ids: new Map(), t0: now(), trip0: st.trip?.t0 ?? now(), hp0: g.hp, target: null, why }; tripHit(); tripEnd(false); }
    const r = st.retreat;
    for (const m of ms) if (!r.ids.has(m.id)) r.ids.set(m.id, m.state);
  }
  // Retreat (copy of retreatTick): lasts until every chaser gave up; a faster chaser we can beat gets fought.
  function retreatTick(me) {
    if (g.dungeon) { st.retreat = null; return null; }
    const r = st.retreat;
    if (!r) return null;
    const chasers = [], ms = [];
    let vMax = 0;
    for (const [id, last] of r.ids) {
      const m = g.entities.monsters.get(id)?.view;
      if (!m || m.dead || m.hp <= 0) { r.ids.delete(id); continue; }
      const d = dist(m.pos, me), kind = m.def?.kind;
      if (last === 'chase' && !CHASE_STATES.includes(m.state)) { const e = ad.leash[kind] ??= { d, n: 0 }; e.d = ema(e.d, d, e.n++); }
      r.ids.set(id, m.state);
      if (retreatOver(m.state, d, ad.leash[kind]?.d, mSpeed(m))) { r.ids.delete(id); continue; }
      chasers.push(m.pos); ms.push(m); vMax = Math.max(vMax, mSpeed(m));
    }
    // Chase cost: the whole wasted trip plus the hp lost, at the regen rate.
    if (!chasers.length) { ad.chaseS = ema(ad.chaseS, (now() - r.trip0) / 1000 + Math.max(0, r.hp0 - g.hp) / regen(), 4); st.retreat = null; st.node = null; return null; }
    if (vMax >= speed() && fight(ms).win) { st.retreat = null; return null; } // can't outrun, can win: the fight branch takes over
    r.target = pickRetreat(me, chasers, retreatCands(me), r.target, vMax / speed());
    st.last = `repli (${r.why})`;
    if (r.target) return travelPath(r.target, 'retreat');
    const cx = chasers.reduce((a, p) => a + p.x, 0) / chasers.length, cz = chasers.reduce((a, p) => a + p.z, 0) / chasers.length;
    return steer(me.x - cx, me.z - cz);
  }

  // Telegraphed attacks (copy): dodge out of the marked area.
  const teles = [];
  function addTele(e) {
    const src = e.follow ? g.entities.monsters.get(e.id)?.view : null;
    teles.push({ src, x: e.x, z: e.z, sh: e.sh, r: e.r ?? 0, ha: e.ha ?? 0, yaw: e.yaw ?? 0, len: e.len ?? 0, w: e.w ?? 0, until: now() + (e.dur ?? 1) * 1000 });
  }
  function teleEscape(me) { const out = teleScan(me, st.escaping ? 1.7 : 0.7); st.escaping = !!out; return out; }
  function teleScan(me, m) {
    for (let i = teles.length - 1; i >= 0; i--) {
      const t = teles[i];
      if (now() > t.until || t.src?.dead) { teles.splice(i, 1); continue; }
      const ox = t.src ? t.src.pos.x : t.x, oz = t.src ? t.src.pos.z : t.z;
      const dx = me.x - ox, dz = me.z - oz, d = Math.hypot(dx, dz);
      const fx = Math.sin(t.yaw), fz = Math.cos(t.yaw);
      if (t.sh === 'circle' && d < t.r + m) return [dx / (d || 1), dz / (d || 1)];
      if (t.sh === 'cone' && d < t.r + m) {
        const ang = Math.abs(Math.atan2(dx * fz - dz * fx, dx * fx + dz * fz));
        if (ang < t.ha + 0.15) return [dx / (d || 1), dz / (d || 1)];
      }
      if (t.sh !== 'circle' && t.sh !== 'cone') {
        const along = dx * fx + dz * fz, perp = dx * fz - dz * fx;
        if (along > -m && along < t.len + m && Math.abs(perp) < t.w / 2 + m) { const side = perp >= 0 ? 1 : -1; return [fz * side, -fx * side]; }
      }
    }
    return null;
  }

  // --- Navigation (copy): steer, A* on solidAt (binary heap here: candidate scoring runs a few A* per pick).
  function steer(dx, dz) {
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return [0, 0];
    dx /= len; dz /= len;
    const { x, z } = g.sim;
    for (const off of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6, 2.2, -2.2, Math.PI]) {
      const c = Math.cos(off), s = Math.sin(off), rx = dx * c - dz * s, rz = dx * s + dz * c;
      if (!solid(x + rx * 1.5, z + rz * 1.5) && !solid(x + rx * 3, z + rz * 3)) return [rx, rz];
    }
    return [dx, dz];
  }
  const MAX_NODES = 60000;
  function findPath(from, to) {
    const sx = Math.round(from.x), sz = Math.round(from.z), tx = Math.round(to.x), tz = Math.round(to.z);
    const K = (x, z) => x * 100003 + z, h = (x, z) => Math.hypot(x - tx, z - tz);
    // Path around idle monsters: +4 per step inside their aggro radius (soft, never a wall).
    const idle = live().filter(m => !CHASE_STATES.includes(m.state)).map(m => ({ x: m.pos.x, z: m.pos.z, r: aggroR(m.def?.kind) }));
    const heap = [[h(sx, sz), 0, sx, sz]], came = new Map([[K(sx, sz), null]]), cost = new Map([[K(sx, sz), 0]]);
    const push = e => { heap.push(e); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= e[0]) break; heap[i] = heap[p]; i = p; } heap[i] = e; };
    const pop = () => {
      const top = heap[0], e = heap.pop();
      if (heap.length) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= heap.length) break; if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++; if (heap[c][0] >= e[0]) break; heap[i] = heap[c]; i = c; } heap[i] = e; }
      return top;
    };
    let n = 0;
    while (heap.length && n++ < MAX_NODES) {
      const [, c, x, z] = pop();
      if (c > cost.get(K(x, z))) continue;
      if (Math.abs(x - tx) <= 1 && Math.abs(z - tz) <= 1) {
        const pts = []; let k = K(x, z), p = [x, z];
        while (p) { pts.push({ x: p[0], z: p[1] }); p = came.get(k); k = p && K(p[0], p[1]); }
        pts.reverse();
        const out = pts.filter((_, i) => i % 3 === 0 || i === pts.length - 1);
        out.len = c;
        return out;
      }
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = x + dx, nz = z + dz, nk = K(nx, nz);
        if (solid(nx, nz)) continue;
        if (dx && dz && (solid(x + dx, z) || solid(x, z + dz))) continue;
        const nc = c + (dx && dz ? 1.414 : 1) + (idle.some(s => Math.hypot(nx - s.x, nz - s.z) < s.r) ? 4 : 0);
        if (nc < (cost.get(nk) ?? Infinity)) { cost.set(nk, nc); came.set(nk, [x, z]); push([nc + h(nx, nz), nc, nx, nz]); }
      }
    }
    return null;
  }
  const lineFree = (a, b) => { const d = dist(a, b); for (let s = 0.5; s < d; s += 0.5) if (solid(a.x + (b.x - a.x) * s / d, a.z + (b.z - a.z) * s / d)) return false; return true; };

  // Waystones (copy, client table Qu L27721, 17 stones incl. puits and coeur).
  const WAYS = [
    { id: 'valbrune', x: 11, z: 55 }, { id: 'hurlements', x: -36, z: 15 }, { id: 'gobelins', x: -64, z: -24 },
    { id: 'cimetiere', x: 38, z: 19 }, { id: 'sombrebois', x: 47, z: -30 }, { id: 'grukk', x: 8, z: -70 },
    { id: 'brumelande', x: -124, z: 44 }, { id: 'cendre', x: 128, z: -9 }, { id: 'necropole', x: 30, z: -133 },
    { id: 'rochenoire', x: -94, z: -88 }, { id: 'forteresse', x: 157, z: -62 }, { id: 'citadelle', x: -27, z: -178 },
    { id: 'moisivert', x: -104, z: 128 }, { id: 'givrecroc', x: 6, z: 142 }, { id: 'faille', x: 132, z: 126 },
    { id: 'puits', x: 40, z: 196 }, { id: 'coeur', x: 170, z: 192 },
  ];
  const awake = () => WAYS.filter(w => g.char.ways?.includes(w.id));
  const wayCost = () => ad.wayCost;
  function wayRoute(me, goal, list) { // copy
    let best = null, bestCost = dist(me, goal);
    for (const src of list) for (const dst of list) {
      if (src === dst) continue;
      const c = dist(me, src) + wayCost() + dist(dst, goal);
      if (c < bestCost) { bestCost = c; best = { src, dst }; }
    }
    return best;
  }
  // Stones only when they save >= 30 % (same hysteresis as wayShortcut).
  const stoneRoute = (me, goal) => { const r = wayRoute(me, goal, awake()); return r && dist(me, r.src) + wayCost() + dist(r.dst, goal) < 0.7 * dist(me, goal) ? r : null; };
  function wayShortcut(goal, k) { // copy, simplified calm test
    if (g.dungeon || st.retreat) return null;
    const me = g.sim, plans = st.wayPlans ??= {};
    const calm = (g.sim.outOfCombat ?? 0) >= 3 && !live().some(m => converging(m, dist(m.pos, me)));
    let plan = plans[k];
    if (plan && (dist(plan.goal, goal) > 2 || (!plan.route && now() - plan.at > 60000))) plan = plans[k] = null;
    if (!plan) { if (!calm) return null; plan = plans[k] = { goal: { x: goal.x, z: goal.z }, route: stoneRoute(me, goal), at: now() }; }
    if (!plan.route) return null;
    const { src, dst } = plan.route;
    if (dist(me, src) > 2.5) return travelPath({ x: src.x, z: src.z }, 'way:' + k);
    if (!calm) { st.last = 'attend le calme à la pierre'; plan.interrupted = true; return [0, 0]; }
    if (now() - (st.wayAt ?? 0) > 5000) {
      st.wayAt = now(); st.navs = {}; st.wayPlans = {}; st.wayTrips = (st.wayTrips ?? 0) + 1;
      ad.wayCost = plan.interrupted ? Math.min(150, wayCost() + 10) : Math.max(15, wayCost() * 0.95); saveAd();
      g.send({ t: 'travel', w: dst.id });
    }
    st.last = `pierre de passage : ${src.id} -> ${dst.id}`;
    return [0, 0];
  }
  const travel = (goal, k) => wayShortcut(goal, k) ?? travelPath(goal, k);
  // Path follow (copy) plus a line-of-sight lookahead: steer at the farthest visible waypoint within 9 m (st.ahead).
  function travelPath(goal, k = 'goal') {
    const me = g.sim, navs = st.navs ??= {};
    const nav = navs[k];
    if (!nav || dist(nav.goal, goal) > 2 || now() - nav.progressAt > 2000) {
      const pts = findPath(me, goal);
      navs[k] = { goal, pts: pts ?? [goal], i: 0, progressAt: now(), best: Infinity, failed: !pts };
    }
    const p = navs[k];
    while (p.i < p.pts.length - 1 && dist(me, p.pts[p.i]) < 1.5) p.i++;
    const wp = p.pts[p.i], d = dist(me, wp);
    if (d < p.best - 0.3 || p.i > (p.lastI ?? -1)) { p.best = d; p.lastI = p.i; p.progressAt = now(); }
    if (p.failed) { st.ahead = null; return steer(wp.x - me.x, wp.z - me.z); }
    let a = wp;
    for (let j = p.i + 1; j < p.pts.length && dist(me, p.pts[j]) <= 9; j++) if (lineFree(me, p.pts[j])) a = p.pts[j];
    st.ahead = a; st.remain = dist(me, a) + p.pts.slice(p.pts.indexOf(a)).reduce((s, q, i, arr) => s + (i ? dist(arr[i - 1], q) : 0), 0);
    const da = dist(me, a);
    return [(a.x - me.x) / (da || 1), (a.z - me.z) / (da || 1)];
  }
  // Stuck detection (copy).
  function unstick(move) {
    const t = now(), me = g.sim, moving = Math.hypot(move[0], move[1]) > 0.1;
    if (!st.stuckRef || !moving || dist(me, st.stuckRef) > 1.5) st.stuckRef = { x: me.x, z: me.z, at: t };
    else if (t - st.stuckRef.at > 3000) {
      const side = Math.random() < 0.5 ? 1 : -1;
      st.sidestep = { until: t + 700, dir: [-move[1] * side, move[0] * side] };
      st.navs = {}; st.wayPlans = {}; st.stuckRef = { x: me.x, z: me.z, at: t }; st.unsticks = (st.unsticks ?? 0) + 1;
    }
    return st.sidestep && t < st.sidestep.until ? st.sidestep.dir : move;
  }

  // --- Node choice: argmax xp / (travel + wait + gather + area risk), straight-line estimate first, A* on the best few.
  const speed = () => ad.speed ?? PLAYER_SPEED * (g.stats?.moveSpd ?? 1) * (NO_ROLL.has(CLS) ? 1 : 1.15);
  function trip(me, goal, walkLen) {
    const walk = walkLen ?? dist(me, goal) * ad.detour, r = stoneRoute(me, goal);
    const viaStone = r ? (dist(me, r.src) + dist(r.dst, goal)) * ad.detour + wayCost() : Infinity;
    return viaStone < walk ? { len: viaStone, stone: r } : { len: walk, stone: null };
  }
  // Approach cell: free ground 1.4 m from the node (its collision circle is 0.7 x scale), nearest to us first.
  function approach(n, from = g.sim) {
    const cands = [];
    for (let i = 0; i < 16; i++) { const a = i * Math.PI / 8; cands.push({ x: n.x + Math.cos(a) * 1.4, z: n.z + Math.sin(a) * 1.4 }); }
    cands.sort((a, b) => dist(a, from) - dist(b, from));
    return cands.find(c => !solid(c.x, c.z)) ?? { x: n.x, z: n.z };
  }
  function candidates() {
    const me = g.sim, t = Date.now(), ms = live(), v = speed(), out = [];
    for (const n of g.nodes.list) {
      if (!canWork(n) || st.black.get(n.id) > t) continue;
      const tr = trip(me, n), sec = tr.len / v, wait = Math.max(0, (backLocal(n.id) - t) / 1000 - sec);
      if (wait > 600) continue;
      const xp = xpOf(n) * (rich(n.id) ? 1.5 : 1), risk = nodeRisk(n, me, ms);
      out.push({ n, xp, sec, wait, dur: durOf(n), risk, stone: tr.stone, zone: zoneOf(n).name, score: xp / (sec + wait + durOf(n) + risk) });
    }
    return out.sort((a, b) => b.score - a.score);
  }
  // Refine the top 3 by real A* walk length (cached per node and start cell); learn the detour ratio.
  const pathCache = new Map();
  function refine(c) {
    const me = g.sim, goal = approach(c.n), k = `${c.n.id}:${Math.round(me.x / 4)}:${Math.round(me.z / 4)}`;
    let p = pathCache.get(k);
    if (p === undefined) {
      p = dist(me, goal) < 150 ? findPath(me, goal) : null;
      pathCache.set(k, p); if (pathCache.size > 200) pathCache.delete(pathCache.keys().next().value);
      const s = dist(me, goal);
      if (p && s > 10) { ad.detourN = (ad.detourN ?? 0) + 1; ad.detour = Math.min(3, Math.max(1, ema(ad.detour, p.len / s, ad.detourN))); }
    }
    const tr = trip(me, goal, p?.len), sec = tr.len / speed(), wait = Math.max(0, (backLocal(c.n.id) - Date.now()) / 1000 - sec);
    return { ...c, sec, wait, stone: tr.stone, path: p, goal, score: c.xp / (sec + wait + c.dur + c.risk) };
  }
  function plan() {
    const top = candidates().slice(0, 3).map(refine).sort((a, b) => b.score - a.score);
    return top[0] ?? null;
  }
  function pick() {
    const best = plan();
    st.pickAt = now();
    if (!best) { st.node = null; return null; }
    // Hysteresis: keep the current target unless the new one is 25 % better.
    const cur = st.node && candidates().find(c => c.n.id === st.node.n.id);
    if (cur && st.node.n.id !== best.n.id && best.score < 1.25 * cur.score) return st.node;
    if (!st.node || st.node.n.id !== best.n.id) { st.req = null; st.sendAt = 0; }
    if (!st.trip) st.trip = { z: zoneOf(best.n).id, hit: false, t0: now() };
    st.node = best;
    return best;
  }

  // --- Strike timing: send at open + 0.45 win after the glint, minus a lead (fraction of the measured RTT),
  // the lead chosen by UCB over hit rate (server judging point unknown: on receive, or RTT compensated).
  const strikeDelay = (open, win, lead) => Math.max(0, (open + 0.45 * win) * 1000 - lead);
  function strikeArm() {
    const A = ad.strike, N = A.reduce((s, a) => s + a.n, 0);
    let bi = 0, bv = -1;
    A.forEach((a, i) => { const v = a.n < 3 ? 10 - a.n : a.ok / a.n + Math.sqrt(2 * Math.log(N + 1) / a.n) * 0.5; if (v > bv) { bv = v; bi = i; } });
    return bi;
  }
  function strikeCode() { try { return JSON.parse(localStorage.getItem('ombreval-keys'))?.interact?.[0] ?? 'KeyE'; } catch { return 'KeyE'; } }
  function strikeTick() {
    const gl = g.gauge?.glint;
    if (!gl || gl.pressed || !st.strike || now() < st.strike.at) return;
    const late = (now() - gl.t0) / 1000 > gl.open + gl.win;
    if (late) { st.strike = null; return; }
    try { g.strike(strikeCode()); } catch {}
    if (!gl.pressed) { gl.pressed = true; g.send({ t: 'gather', a: 'strike', g: g.gauge.g }); } // modal open or remapped key
    st.strike.sent = now(); st.strikes = (st.strikes ?? 0) + 1;
  }

  // --- Per-tick decision.
  const hitAt = new Map();
  // --- Recovery. Costs in seconds of profession progress: gold at our gold rate, hp at the regen rate.
  const BERTRAND = { x: 8.4, z: 64.6 }, POTION_TARGET = 10, POT_HEAL = 0.55; // potion: 35 % now + 20 % over 3 s, cd 1.5 s
  const potionPrice = () => 15 + g.level * 5;
  const goldS = () => Math.max(0.2, ad.goldS ?? 0.2); // TODO(ceiling): floor = guessed worth of idle gold, learned from income while on
  function drink() {
    if (!(g.potionCd > 0) && g.char.potions > 0 && now() - (st.potAt ?? -1e9) > 1500) { st.potAt = now(); st.pots = (st.pots ?? 0) + 1; g.actions.usePotion(); return true; }
    return false;
  }
  // Pure: cheapest way to cover an hp deficit. cont = extra risk over the trips natural regen needs, halved (linear refill).
  function recoverPick(o) {
    const k = Math.max(1, o.deficit / Math.max(0.1, o.regen * o.cycleS)), heals = Math.ceil(o.deficit / (POT_HEAL * o.life));
    const c = { cont: Math.max(0, o.riskLow - o.riskFull) * k / 2, rest: o.deficit / o.regen };
    if (o.potions > 0 && o.deficit >= 0.45 * o.life) c.pot = 1.5 + o.price / o.goldS;
    if (o.potions === 0 && o.gold >= o.price * 4) { const n = Math.min(POTION_TARGET, Math.floor(o.gold / o.price)); c.shop = o.shopS / n * heals + heals * o.price / o.goldS; }
    return Object.entries(c).reduce((b, e) => e[1] < b[1] ? e : b);
  }
  function recoverTick(me) {
    const deficit = g.life - g.hp;
    if (deficit < 0.05 * g.life) { st.recover = null; return null; }
    if (!st.recover || now() - st.recover.at > 5000) {
      const c = st.node ?? plan(), ms = live();
      const shopS = (trip(me, BERTRAND).len + (c ? trip(BERTRAND, c.n).len : 0)) / speed() + 8;
      const [how, cost] = recoverPick({
        deficit, life: g.life, regen: regen(), cycleS: c ? c.sec + c.dur : 30, potions: g.char.potions ?? 0, gold: g.char.gold ?? 0,
        price: potionPrice(), goldS: goldS(), shopS,
        riskLow: c ? nodeRisk(c.n, me, ms) : 0, riskFull: c ? nodeRisk(c.n, me, ms, g.life) : 0,
      });
      if (how === 'rest' && st.recover?.how !== 'rest') st.rests = (st.rests ?? 0) + 1;
      st.recover = { how, cost: Math.round(cost), at: now(), hp: g.hp, t: now() };
    }
    const r = st.recover;
    if (r.how === 'cont') return null;
    if (r.how === 'pot') { drink(); st.recover = null; return null; }
    if (r.how === 'shop') return shopTick(me);
    // Rest out of aggro range; learn the regen rate on the way.
    const dt = (now() - r.t) / 1000;
    if (dt > 8) { ad.regenN = (ad.regenN ?? 0) + 1; ad.regen = ema(ad.regen, Math.max(0.05, (g.hp - r.hp) / dt), ad.regenN); r.t = now(); r.hp = g.hp; }
    st.phase = 'rest'; st.last = `repos (${Math.round(100 * g.hp / g.life)} % pv, ${r.cost} s)`;
    const idle = live().filter(m => dist(m.pos, me) < aggroR(m.def?.kind) + 4);
    if (!idle.length) return { move: [0, 0] };
    st.restTo = pickRetreat(me, idle.map(m => m.pos), retreatCands(me), st.restTo, 1);
    return { move: st.restTo ? travelPath(st.restTo, 'rest') : steer(me.x - idle[0].pos.x, me.z - idle[0].pos.z) };
  }
  // Shop (copy, potions only): walk to Bertrand, buyPotion every 600 ms up to the target or the gold.
  function shopTick(me) {
    st.phase = 'shop';
    if (dist(me, BERTRAND) > 3) { st.last = 'va acheter des potions'; return { move: travel(BERTRAND, 'shop') }; }
    if (now() - (st.buyAt ?? 0) > 600) {
      st.buyAt = now(); st.buyTries = (st.buyTries ?? 0) + 1;
      if (g.char.potions >= POTION_TARGET || g.char.gold < potionPrice() || st.buyTries > 14) { st.buyTries = 0; st.recover = null; st.node = null; return null; }
      g.send({ t: 'buyPotion' }); st.shopping = true;
    }
    st.last = `achète des potions (${g.char.potions})`;
    return { move: [0, 0] };
  }
  function fightTick(me, ms) {
    const m = ms.reduce((b, x) => !b || dist(x.pos, me) < dist(b.pos, me) ? x : b, null), d = dist(m.pos, me);
    if (st.phase !== 'fight') st.fights = (st.fights ?? 0) + 1;
    st.phase = 'fight'; st.last = `combat : ${m.def?.name ?? m.def?.kind ?? '?'} niv ${m.level ?? '?'}${ms.length > 1 ? ` (+${ms.length - 1})` : ''}`;
    return { move: d > 2.2 ? steer(m.pos.x - me.x, m.pos.z - me.z) : [0, 0], aim: m.pos, slots: ['Mouse0'] };
  }
  function decideRaw() {
    const me = g.sim, tick = now(), hpPct = g.hp / g.life;
    const gauging = !!g.gauge && !g.gauge.end;
    const esc = teleEscape(me);
    if (esc) { st.phase = 'flee'; st.last = 'esquive une attaque annoncée'; return { move: steer(...esc), roll: !(g.sim.cds?.roll > 0) && !NO_ROLL.has(CLS) }; }
    const ret = retreatTick(me);
    if (ret) { st.phase = 'flee'; return { move: ret }; }
    // Threatened only if the damage expected before we are done here (gauge left, or walk + gather) eats the hp margin.
    const th = threats(me), dpsObs = hpTrend();
    if (th.length && !g.dungeon) {
      tripHit();
      if (hpPct < 0.45) drink(); // under attack a potion beats a retreat or a death
      const c = st.node, tLeft = gauging || !c ? 0 : dist(me, c.goal ?? c.n) * ad.detour / speed();
      const H = gauging ? Math.max(0, g.gauge.dur - (tick - g.gauge.t0) / 1000) : c ? tLeft + c.dur : 3;
      const pred = Math.max(dpsObs * H, dmgOver(th, me, H, tLeft)), f = fight(th);
      st.threat = { n: th.length, H: +H.toFixed(1), pred: Math.round(pred), margin: Math.round(g.hp - MARGIN * g.life), win: f.win, ttk: +f.ttk.toFixed(1) };
      if (pred >= g.hp - MARGIN * g.life) {
        if (f.win) return fightTick(me, th);
        startRetreat(th, gauging ? 'récolte intenable' : `${th.length} poursuivant${th.length > 1 ? 's' : ''}`);
        const r = retreatTick(me);
        if (r) { st.phase = 'flee'; return { move: r }; }
      } else if (!gauging && f.win && th.some(m => dist(m.pos, me) < reachOf(m) + 1.5)) return fightTick(me, th); // weak attacker in reach: kill it
    } else st.threat = null;
    // Hp deficit, nothing on us: cheapest of keep going / potion / rest / shop trip, in seconds (recover()).
    if (!gauging && !th.length) { const r = recoverTick(me); if (r) return r; }
    if (gauging) {
      st.phase = 'gather'; st.last = `récolte ${g.gauge.what ?? ''}${g.gauge.glint ? ' (éclat)' : ''}`;
      strikeTick();
      return { move: [0, 0] };
    }
    if (!st.node || tick - (st.pickAt ?? 0) > 5000 || st.black.get(st.node.n.id) > Date.now()) pick();
    const c = st.node;
    if (!c) { st.phase = 'idle'; st.last = 'aucun nœud accessible, attente'; return { move: [0, 0] }; }
    const n = c.n, goal = c.goal ?? approach(n), dn = dist(me, n);
    if (dn > 2.3 && dist(me, goal) > 0.6) {
      st.phase = 'route'; st.sendAt = 0;
      const move = travel(goal, 'node');
      st.last = st.last?.startsWith('pierre') || st.last?.startsWith('attend') ? st.last : `vers ${nodeName(n)} (${Math.round(dn)} m)`;
      // Dodge on straight legs: ready, far from the target, lookahead visible 7 m or more.
      const roll = !NO_ROLL.has(CLS) && !(g.sim.cds?.roll > 0) && st.ahead && dist(me, st.ahead) >= 7 && (st.remain ?? 0) > 10 && dist(me, goal) > 10;
      return { move, aim: st.ahead, roll };
    }
    // At the node: stand still one tick, wait for it to return, random 150-600 ms, then ask (retry every 1.5 s).
    st.phase = 'gather';
    const back = backLocal(n.id) - Date.now();
    if (back > 0) { st.last = `attend la repousse (${Math.ceil(back / 1000)} s)`; return { move: [0, 0] }; }
    const stillFor = dist(me, st.prevPos ?? me) < 0.02;
    if (!st.sendAt && stillFor) st.sendAt = tick + 150 + Math.random() * 450;
    if (st.sendAt && tick >= st.sendAt && (!st.req || tick - st.req.at > 1500)) {
      const tries = st.req?.id === n.id ? st.req.n + 1 : 1;
      if (tries > 3) { st.black.set(n.id, Date.now() + 60000); st.node = null; st.req = null; st.last = 'pas de réponse, nœud ignoré 60 s'; return { move: [0, 0] }; }
      st.req = { id: n.id, at: tick, n: tries };
      g.send({ t: 'gather', a: 'node', n: n.id });
    }
    st.last = `demande la récolte de ${nodeName(n)}`;
    return { move: [0, 0] };
  }
  function decide() {
    const t = now(), me = g.sim;
    monTick(me, Math.min(200, t - (st.decAt ?? t))); st.decAt = t;
    const d = decideRaw();
    d.move = unstick(d.move);
    // Learn the real travel speed (rolls included) over 1 s windows of route walking.
    if (!st.spd || st.phase !== 'route' || st.spd.trip !== st.wayTrips) st.spd = { x: me.x, z: me.z, at: t, trip: st.wayTrips };
    else if (t - st.spd.at > 1000) {
      const v = dist(me, st.spd) / ((t - st.spd.at) / 1000);
      if (v > 2 && v < 15) { ad.speedN = (ad.speedN ?? 0) + 1; ad.speed = ema(ad.speed, v, ad.speedN); }
      st.spd = { x: me.x, z: me.z, at: t, trip: st.wayTrips };
    }
    st.prevPos = { x: me.x, z: me.z };
    // Gold rate: positive gold changes while on (shop spending excluded), over 60 s windows.
    const gold = g.char.gold ?? 0, gw = st.goldW ??= { at: t, sum: 0 };
    if (st.goldPrev != null && gold > st.goldPrev) gw.sum += gold - st.goldPrev;
    st.goldPrev = gold;
    if (t - gw.at > 60000) { ad.goldN = (ad.goldN ?? 0) + 1; ad.goldS = ema(ad.goldS, gw.sum / ((t - gw.at) / 1000), ad.goldN); st.goldW = { at: t, sum: 0 }; }
    return d;
  }

  function setKeys(keys) {
    const want = new Set(keys);
    for (const k of st.pressed) if (!want.has(k)) g.input.release(k);
    for (const k of want) g.input.press(k);
    st.pressed = want;
  }
  // __bot running (status() is heavy: read twice a second): the gatherer steps aside.
  const botOn = () => {
    if (!window.__bot) return false;
    if (now() - (st.botAt ?? 0) > 500) { st.botAt = now(); try { st.botOn = !!window.__bot.status().on; } catch { st.botOn = false; } }
    return st.botOn;
  };

  // --- Coordinator: level the character with __bot (combat) until gathering at our tier is worth more.
  // Target level per profession tier (REAPER.md priors), shifted by the measured risk share of a gather cycle.
  const TARGET = { 1: 10, 2: 18, 3: 24, 4: 32 }, HORIZON_S = 7200, MODE_EVERY = 180000; // TODO(ceiling): fixed 2 h horizon
  ad.tgtAdj ??= {};
  const lvlXp = l => Math.round(110 * l ** 1.85 + 60 * l); // char xp to the next level (bundle gI, see bot.page.js)
  const cumXp = () => { let s = g.char.ch.xp ?? 0; for (let l = 1; l < g.level; l++) s += lvlXp(l); return s; };
  const profTier = () => Math.max(1, ...(g.char.prof?.list ?? []).filter(p => Object.values(PROF).includes(p.id)).map(p => p.lvl >= 38 ? 4 : p.lvl >= 25 ? 3 : p.lvl >= 12 ? 2 : 1));
  const target = () => TARGET[profTier()] + (ad.tgtAdj[profTier()] ?? 0);
  // Pure: XP when the profession xp gained over the horizon by gathering risk-free beats what leveling costs now.
  function modePick(o) {
    if (!o.hasBot || o.lvl >= o.target) return 'récolte';
    const gain = (o.rateSafe - o.rateNow) * HORIZON_S, cost = o.rateNow * o.tLvlS, k = o.cur === 'XP' ? 0.8 : 1.25; // hysteresis
    return gain > cost * k ? 'XP' : 'récolte';
  }
  function modeEval() {
    const cs = candidates().slice(0, 5), best = cs[0];
    const rateNow = best ? best.score : 0, rateSafe = Math.max(0, ...cs.map(c => c.xp / (c.sec + c.wait + c.dur)));
    let need = 0; for (let l = g.level; l < target(); l++) need += lvlXp(l); need = Math.max(0, need - (g.char.ch.xp ?? 0));
    const tLvlS = need / CHAR_XPS();
    // Risk share of a cycle at or above target: too risky -> aim higher; safe below target -> aim lower.
    if (best) {
      const share = best.risk / (best.sec + best.wait + best.dur + best.risk), t = profTier(), a = ad.tgtAdj[t] ?? 0;
      if (g.level >= target() && share > 0.5 && a < 6) ad.tgtAdj[t] = a + 1;
      else if (g.level < target() && share < 0.1 && a > -4) ad.tgtAdj[t] = a - 1;
    }
    const mode = modePick({ hasBot: !!window.__bot, lvl: g.level, target: target(), rateNow, rateSafe, tLvlS, cur: st.mode });
    st.modeWhy = { rateNow: +rateNow.toFixed(3), rateSafe: +rateSafe.toFixed(3), tLvlS: Math.round(tLvlS), target: target() };
    if (mode !== st.mode) setMode(mode);
    st.modeAt = now();
  }
  function setMode(mode) {
    st.mode = mode; st.modeSwitches = (st.modeSwitches ?? 0) + 1; st.node = null; st.retreat = null; st.detour = null;
    if (mode === 'XP') { setKeys([]); window.__botOpts = { ...(window.__botOpts ?? {}), autoTalents: true }; st.botByUs = true; try { window.__bot.start(); } catch { st.mode = 'récolte'; } }
    else if (st.botByUs) { try { window.__bot?.pause(); } catch {} st.botByUs = false; st.botOn = false; }
    g.ui.toast?.(`Bot métiers : mode ${st.mode}`);
  }
  // While leveling: take over for a cheap node close by when nothing is on us, then hand back.
  function coordTick() {
    if (!st.on) return;
    if (!st.modeAt || now() - st.modeAt > MODE_EVERY) modeEval();
    if (st.mode !== 'XP') return;
    if (!window.__bot) { setMode('récolte'); return; }
    const t = now(), xp = cumXp(), w = st.xpW;
    if (!w || t - w.at > 60000) { if (w && xp >= w.xp) { ad.charN = (ad.charN ?? 0) + 1; ad.charXps = ema(ad.charXps, (xp - w.xp) / ((t - w.at) / 1000), ad.charN); } st.xpW = { at: t, xp }; }
    const d = st.detour;
    if (d && (t > d.until || st.lastEnd?.at > d.at || g.sim.dead)) { st.detour = null; st.node = null; try { window.__bot.start(); } catch {} return; }
    if (d || g.sim.dead || g.hp < 0.6 * g.life || threats(g.sim).length) { if (!d && !botOn()) try { window.__bot.start(); } catch {} return; }
    const c = candidates().find(c => c.sec < 4 && c.wait === 0 && c.risk < 3);
    if (!c) { if (!botOn()) try { window.__bot.start(); } catch {} return; }
    try { window.__bot.pause(); } catch {}
    st.detour = { id: c.n.id, at: t, until: t + 20000 }; st.node = c; st.req = null; st.sendAt = 0; st.detours = (st.detours ?? 0) + 1;
  }

  let alive_ = true;
  const origBuild = g.controls.build.bind(g.controls);
  const wrapper = aimPt => {
    if (!alive_ || !st.on || g.ui.typing) return origBuild(aimPt);
    try {
      if (st.mode === 'XP' && !st.detour) { if (st.pressed.size) setKeys([]); return origBuild(aimPt); } // __bot drives
      if (botOn() && !st.botByUs) { api.pause(); return origBuild(aimPt); }
      if (g.sim.dead || g.hp <= 0) {
        setKeys([]);
        if (!st.deadSince) { st.deadSince = now(); st.deaths = (st.deaths ?? 0) + 1; tripEnd(true); st.node = null; st.retreat = null; st.revive = true; }
        if (now() - st.deadSince > 3000) { g.actions.respawn(); st.deadSince = now(); }
        st.last = 'mort';
        return origBuild(aimPt);
      }
      st.deadSince = 0;
      if (st.revive) { st.revive = false; ad.respawn = { x: g.sim.x, z: g.sim.z }; saveAd(); } // bound stone, for the death cost
      // Hidden window (copy): ~1 fps, hold still until frames return.
      const gap = now() - (st.buildAt ?? now()); st.buildAt = now();
      st.frameGap = ema(st.frameGap ?? gap, Math.min(gap, 2000), 8);
      if (st.frameGap > 150) { setKeys([]); st.last = 'ralenti (fenêtre cachée), en attente'; return origBuild(aimPt); }
      st.onMs += Math.min(200, gap);
      const d = decide();
      setKeys(d.slots ?? []);
      const r = origBuild(d.aim ? { x: d.aim.x, z: d.aim.z } : aimPt);
      if (d.roll) st.rolls = (st.rolls ?? 0) + 1;
      return { ...r, b: d.roll ? r.b | 64 : r.b, mx: Math.round(d.move[0] * 1e3) / 1e3, mz: Math.round(d.move[1] * 1e3) / 1e3 };
    } catch (e) { st.last = 'erreur ' + e.message; setKeys([]); return origBuild(aimPt); }
  };
  g.controls.build = wrapper;

  // Messages: learning runs even paused (manual gathering teaches durations, respawn and xp too).
  const origOnMessage = g.onMessage.bind(g);
  const onMsg = msg => {
    const out = origOnMessage(msg);
    if (!alive_) return out;
    try { learn(msg); } catch (e) { st.err = e.message; }
    return out;
  };
  g.onMessage = onMsg;
  function learn(msg) {
    const t = msg?.t;
    if (t === 's') for (const ev of msg.ev ?? []) {
      if (ev.e === 'tele') addTele(ev);
      else if (ev.e === 'hit' && ev.id === g.meId) {
        // Hits on us carry no source: blame the nearest monster in an attack phase.
        const m = ev.s != null ? g.entities.monsters.get(ev.s)?.view : live().filter(x => [...ATTACK_STATES, 'recover'].includes(x.state) && dist(x.pos, g.sim) < reachOf(x) + 3)
          .reduce((b, x) => !b || dist(x.pos, g.sim) < dist(b.pos, g.sim) ? x : b, null), k = m?.def?.kind;
        if (m) hitAt.set(m.id, now());
        if (k) dmgWin.dmg[k] = (dmgWin.dmg[k] ?? 0) + (ev.a ?? 0) / lvlScale(m.level);
      }
    }
    if (t === 'gstart') {
      if (st.req) { ad.rttN = (ad.rttN ?? 0) + 1; ad.rtt = Math.min(1000, ema(ad.rtt, now() - st.req.at, ad.rttN)); st.req = null; }
      const n = st.node?.n ?? nearNode();
      st.gather = { g: msg.g, at: now(), n, k: n ? key(n) : null };
      if (n) ad.dur[key(n)] = msg.dur;
    }
    if (t === 'gevent' && g.gauge?.glint && st.gather?.g === msg.g) {
      const arm = strikeArm(), lead = ad.strike[arm].k * ad.rtt, jit = (Math.random() - 0.5) * 0.1 * msg.win * 1000;
      st.strike = { arm, at: now() + strikeDelay(msg.open, msg.win, lead) + jit, open: msg.open, win: msg.win };
      st.lastGlint = { open: msg.open, win: msg.win };
    }
    if (t === 'gres' && st.strike?.sent && st.gather?.g === msg.g) {
      const a = ad.strike[st.strike.arm]; a.n++; if (msg.ok) a.ok++;
      st.strike = null; saveAd();
    }
    if (t === 'death' && msg.lost != null) { const x = msg.lost + (g.char.ch.xp ?? 0); if (x > 0) { ad.lossN = (ad.lossN ?? 0) + 1; ad.lossK = ema(ad.lossK, msg.lost / x, ad.lossN); } }
    if (t === 'gend' && !msg.auto) {
      const gt = st.gather, n = gt?.n;
      if (st.on) tripEnd(false);
      st.gather = null; st.strike = null;
      if (!msg.got) { if (n && st.on) st.black.set(n.id, Date.now() + 60000); st.fails = (st.fails ?? 0) + 1; st.lastFail = msg.m ?? null; st.node = null; return; }
      if (n) {
        const k = key(n), p = profOf(n), e = ad.xp[k] ??= { v: XP_BASE[n.tier], n: 0 };
        const f = xpFactor((p?.lvl ?? 1) - n.req);
        if (msg.xp != null && f) e.v = ema(e.v, msg.xp / f, e.n++);
        const gd = ad.gdur[k] ??= { v: null, n: 0 }; gd.v = ema(gd.v, (now() - gt.at) / 1000, gd.n++);
        const s = st.stats[PROF[n.kind]] ??= { n: 0, xp: 0, ev: 0, rare: 0 };
        s.n++; s.xp += msg.xp ?? 0; if (msg.ev) s.ev++; if (msg.rare) s.rare++;
        const T = ad.tot[PROF[n.kind]] ??= { n: 0, xp: 0 }; T.n++; T.xp += msg.xp ?? 0;
        st.lastEnd = { id: n.id, k, at: now() };
      }
      if (st.node && n && st.node.n.id === n.id) st.node = null;
      saveAd();
    }
    if (t === 'nodes') {
      const e = st.lastEnd, b = e && now() - e.at < 5000 ? (msg.l ?? []).find(([id]) => id === e.id) : null;
      if (b) { const r = ad.back[e.k] ??= { v: null, n: 0 }; r.v = ema(r.v, (b[1] - serverNow()) / 1000, r.n++); st.lastEnd = null; saveAd(); }
    }
  }
  const nearNode = () => g.nodes.list.reduce((b, n) => dist(n, g.sim) < 3 && (!b || dist(n, g.sim) < dist(b, g.sim)) ? n : b, null);
  // Server clock offset: a node we can work flips back to workable exactly when server time passes its backAt.
  function flipTick() {
    const W = new Set([...g.nodes.workable()].map(n => n.id));
    for (const [id, b] of g.nodesBack) {
      const n = g.nodes.list[id - 1];
      if (!n || n.id !== id || !canWork(n)) continue;
      const empty = !W.has(id), was = st.flip.get(id);
      if (was === true && !empty && Math.abs(b - Date.now()) < 120000) { ad.bfN++; ad.bf = ema(ad.bf, b - (Date.now() - 250), ad.bfN); }
      st.flip.set(id, empty);
    }
  }

  // --- HUD (F11): professions, target, rates, learned timings.
  const hud = document.createElement('div');
  hud.id = 'gather-hud';
  hud.style.cssText = 'position:fixed;bottom:240px;left:12px;z-index:99999;width:360px;padding:10px 12px;'
    + 'background:rgba(12,14,16,.82);color:#e6e2d6;font:12px/1.45 ui-monospace,Menlo,monospace;'
    + 'border:1px solid rgba(230,226,214,.25);border-radius:6px;pointer-events:none;white-space:pre-wrap';
  hud.hidden = true; // shown on start (or F11), kept out of manual play
  document.body.appendChild(hud);
  const areaRows = () => Object.keys(ad.area).map(id => { const a = area(id); return `${id} ${a.n.toFixed(1)}/${a.a.toFixed(1)}/${a.d.toFixed(1)}`; });
  const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const perH = v => Math.round(v / Math.max(st.onMs, 60000) * 3.6e6);
  const fmtS = v => v == null ? '?' : v >= 120 ? `${Math.round(v / 60)} min` : `${Math.round(v)} s`;
  function hudText() {
    const profs = (g.char.prof?.list ?? []).map(p => {
      const s = st.stats[p.id];
      return `${(PROF_FR[p.id] ?? p.id).padEnd(10)} niv ${String(p.lvl).padStart(2)}  ${p.xp}/${lvlNeed(p.lvl)} xp`
        + (Object.values(PROF).includes(p.id) ? `  ${s ? `${perH(s.n)} nœuds/h  ${perH(s.xp)} xp/h` : '-'}` : '  (artisanat)');
    }).join('\n');
    const c = st.node, n = c?.n;
    const tgt = n ? `${nodeName(n)} T${n.tier}${rich(n.id) ? ' riche' : ''}  ${c.zone}\n  ${Math.round(dist(g.sim, n))} m  ETA ${Math.round(c.sec + c.wait)} s${c.stone ? `  pierre ${c.stone.src.id} -> ${c.stone.dst.id}` : ''}  score ${c.score.toFixed(2)}` : '-';
    const keys = [...new Set([...Object.keys(ad.dur), ...Object.keys(ad.back)])];
    const learnRows = keys.map(k => `${k.padEnd(6)} durée ${fmtS(ad.gdur[k]?.v ?? ad.dur[k])}  repousse ${fmtS(ad.back[k]?.v)}  xp ${ad.xp[k] ? ad.xp[k].v.toFixed(1) : '?'}`).join('\n') || 'rien mesuré';
    const A = ad.strike;
    return `<b style="color:#d9b26f">RÉCOLTE ${st.on ? 'ON' : 'OFF'}</b>  mode ${esc(st.mode ?? '-')}  ${esc(st.phase)}  niv ${g.level}/${target()}  vitesse ${speed().toFixed(2)} m/s\n`
      + `${esc(profs)}\n`
      + `<span style="color:#8fb3a8">cible</span>  ${esc(tgt)}\n`
      + `action : <b>${esc(st.last || '-')}</b>\n`
      + `<span style="color:#8fb3a8">mesures</span>\n${esc(learnRows)}\n`
      + `éclats : ${A.map(a => `x${a.k} ${a.ok}/${a.n}`).join('  ')}  rtt ${Math.round(ad.rtt)} ms\n`
      + `replis ${st.retreats ?? 0}  morts ${st.deaths ?? 0}  échecs ${st.fails ?? 0}  roulades ${st.rolls ?? 0}  pierres ${st.wayTrips ?? 0}\n`
      + `zones (visites/attaques/morts) : ${esc(areaRows().join(' | ') || '-')}`;
  }
  let tickN = 0;
  const hudTimer = setInterval(() => {
    try {
      if (tickN++ % 4 === 0) { flipTick(); coordTick(); }
      if (tickN % 120 === 0) saveAd();
      if (!hud.hidden) hud.innerHTML = hudText();
    } catch (e) { st.err = e.message; }
  }, 250);
  const onKey = e => {
    if (e.code !== 'F11' || g.ui.typing) return;
    e.preventDefault(); hud.hidden = !hud.hidden;
  };
  window.addEventListener('keydown', onKey, true);

  const desc = c => c && {
    id: c.n.id, node: nodeName(c.n), tier: c.n.tier, kind: c.n.kind, rich: rich(c.n.id), zone: c.zone, at: [Math.round(c.n.x), Math.round(c.n.z)],
    xp: +c.xp.toFixed(1), travelS: +c.sec.toFixed(1), waitS: +c.wait.toFixed(1), gatherS: c.dur, riskS: +c.risk.toFixed(1), score: +c.score.toFixed(3),
    stone: c.stone ? `${c.stone.src.id} -> ${c.stone.dst.id}` : null, path: c.path ? { len: Math.round(c.path.len), pts: c.path.length } : c.path === null ? 'A* échoué ou trop loin' : undefined,
  };
  const api = {
    start() {
      if (botOn()) try { window.__bot.pause(); } catch {}
      st.botOn = false; st.botAt = now();
      st.on = true; hud.hidden = false; st.node = null; st.req = null; st.retreat = null; st.mode = 'récolte'; st.modeAt = 0; st.detour = null;
      Object.defineProperty(g.input, 'overUi', { get: () => false, configurable: true });
      g.ui.toast?.('Bot métiers : marche');
    },
    pause() {
      if (!st.on) return;
      st.on = false; setKeys([]); st.phase = 'idle'; st.strike = null;
      if (st.botByUs) { try { window.__bot?.pause(); } catch {} st.botByUs = false; }
      delete g.input.overUi;
      saveAd();
      g.ui.toast?.('Bot métiers : arrêt');
    },
    stop() {
      api.pause();
      alive_ = false;
      if (g.controls.build === wrapper) g.controls.build = origBuild; // else a later wrapper holds ours: it turns into a pass-through
      if (g.onMessage === onMsg) g.onMessage = origOnMessage;
      window.removeEventListener('keydown', onKey, true);
      clearInterval(hudTimer); hud.remove();
      delete window.__gather;
    },
    // Dry run (no action): chosen node, its route and ETA, plus the next best candidates.
    plan() {
      const best = plan(), me = g.sim;
      return {
        pos: [Math.round(me.x), Math.round(me.z)], speed: +speed().toFixed(2), detour: +ad.detour.toFixed(2),
        best: desc(best), etaS: best ? Math.round(best.sec + best.wait) : null,
        route: best ? (best.stone ? [[Math.round(me.x), Math.round(me.z)], best.stone.src.id, best.stone.dst.id, [Math.round(best.goal.x), Math.round(best.goal.z)]]
          : (best.path ?? []).filter((_, i, a) => i % 5 === 0 || i === a.length - 1).map(p => [p.x, p.z])) : null,
        top: candidates().slice(0, 6).map(desc),
      };
    },
    status: () => ({
      on: st.on, mode: st.mode ?? null, target: target(), modeWhy: st.modeWhy ?? null, detours: st.detours ?? 0, modeSwitches: st.modeSwitches ?? 0, charXps: ad.charXps ?? null,
      phase: st.phase, doing: st.mode === 'XP' && !st.detour ? `XP (__bot) : ${(() => { try { return window.__bot.status().doing; } catch { return '?'; } })()}` : st.last, node: desc(st.node), lvl: g.level, cls: CLS,
      profs: (g.char.prof?.list ?? []).map(p => `${p.id} ${p.lvl} (${p.xp}/${lvlNeed(p.lvl)})`),
      min: Math.round(st.onMs / 60000), stats: st.stats,
      rate: Object.fromEntries(Object.entries(st.stats).map(([k, s]) => [k, `${perH(s.n)} nœuds/h, ${perH(s.xp)} xp/h`])),
      dur: ad.dur, gatherS: Object.fromEntries(Object.entries(ad.gdur).map(([k, v]) => [k, +v.v.toFixed(1)])),
      respawnS: Object.fromEntries(Object.entries(ad.back).map(([k, v]) => [k, Math.round(v.v)])),
      xpPer: Object.fromEntries(Object.entries(ad.xp).map(([k, v]) => [k, `${v.v.toFixed(1)} (${v.n})`])),
      strike: ad.strike.map(a => `x${a.k}:${a.ok}/${a.n}`), rttMs: Math.round(ad.rtt), clockOffsetMs: Math.round(ad.bf), lastGlint: st.lastGlint ?? null,
      speed: +speed().toFixed(2), detour: +ad.detour.toFixed(2), wayCost: Math.round(ad.wayCost),
      retreats: st.retreats ?? 0, deaths: st.deaths ?? 0, fails: st.fails ?? 0, lastFail: st.lastFail ?? null, rolls: st.rolls ?? 0, wayTrips: st.wayTrips ?? 0, unsticks: st.unsticks ?? 0,
      areas: areaRows(), rests: st.rests ?? 0, regen: +regen().toFixed(2), recover: st.recover ? `${st.recover.how} ${st.recover.cost}s` : null,
      potions: g.char.potions, gold: g.char.gold, goldS: +goldS().toFixed(3), pots: st.pots ?? 0, threat: st.threat ?? null, fights: st.fights ?? 0, chaseS: Math.round(ad.chaseS), lossK: ad.lossK ?? null,
      aggro: Object.fromEntries(Object.entries(ad.aggro).map(([k, v]) => [k, +v.d.toFixed(1)])),
      mspd: Object.fromEntries(Object.entries(ad.mspd).map(([k, v]) => [k, +v.v.toFixed(1)])),
      mdps: Object.fromEntries(Object.entries(ad.mdps).map(([k, v]) => [k, `${Math.round(v.d ?? 0)}/${Math.round(v.e ?? 0)}s`])),
      pos: [Math.round(g.sim.x), Math.round(g.sim.z)], err: st.err ?? null, bot: botOn(),
    }),
  };

  // Self-check of the pure decision math.
  (() => {
    const fail = m => console.warn('gather self-check failed: ' + m);
    const a = { id: 'a', x: 0, z: 0 }, b = { id: 'b', x: 300, z: 0 }, me = { x: 2, z: 0 };
    const far = wayRoute(me, { x: 305, z: 0 }, [a, b]), near = wayRoute(me, { x: 30, z: 0 }, [a, b]);
    if (far?.src !== a || far?.dst !== b || near) fail('wayRoute');
    if (!(xpFactor(0) > xpFactor(7) && xpFactor(7) > xpFactor(12) && xpFactor(12) > xpFactor(20))) fail('xp factor order');
    if (lvlNeed(1) !== 39 || lvlNeed(10) !== 200 || lvlNeed(49) !== 2583) fail('level xp');
    // Strike lands inside the window for any lead up to the window start.
    for (const lead of [0, 100, 300]) { const d = strikeDelay(0.8, 0.4, lead) + lead; if (d < 800 || d > 1200) fail('strike window ' + lead); }
    // Rich rate close to 12 % over all nodes and many windows.
    let r = 0, N = 0;
    for (let w = 0; w < 40; w++) for (const n of g.nodes.list) { N++; if (hash3(n.id, g.char.id, w) < 0.12) r++; }
    if (Math.abs(r / N - 0.12) > 0.02) fail('rich rate ' + (r / N).toFixed(3));
    // Risk: P(attacked) x [P(death) x death cost + rest x attack cost]; fight check sums dps over each lifetime.
    if (Math.abs(riskSec(0.5, 0.1, 40, 15) - 8.75) > 1e-9 || riskSec(0, 1, 99, 99) !== 0) fail('risk formula');
    const fc = fightCost([{ hp: 30, dps: 5 }, { hp: 10, dps: 5 }], 10, 100, 100); // kill 10 hp first: 1 s, then 4 s: 5 x 1 + 5 x 4 = 25
    if (Math.abs(fc.taken - 25) > 1e-9 || !fc.win || fightCost([{ hp: 300, dps: 20 }], 10, 100, 100).win) fail('fight cost');
    // Recovery: full risk cut by a potion beats a long rest; tiny deficit risk keeps going.
    const ro = { deficit: 300, life: 600, regen: 1.5, cycleS: 20, potions: 3, gold: 100, price: 50, goldS: 1, shopS: 60, riskLow: 30, riskFull: 2 };
    if (recoverPick(ro)[0] !== 'pot' || recoverPick({ ...ro, riskLow: 2.1 })[0] !== 'cont' || recoverPick({ ...ro, potions: 0, gold: 0, riskLow: 60 })[0] !== 'rest') fail('recover pick');
    // Mode: big risk-free gain over the horizon -> XP; at target or without __bot -> récolte; hysteresis keeps XP.
    const mo = { hasBot: true, lvl: 5, target: 10, rateNow: 0.2, rateSafe: 1, tLvlS: 3600, cur: 'récolte' };
    if (modePick(mo) !== 'XP' || modePick({ ...mo, hasBot: false }) !== 'récolte' || modePick({ ...mo, lvl: 10 }) !== 'récolte' || modePick({ ...mo, rateNow: 0.95 }) !== 'récolte') fail('mode pick');
    // Approach cell: free and within gather reach (2.8 m) of its node.
    const n0 = g.nodes.list[0], ap = approach(n0, { x: n0.x + 20, z: n0.z });
    if (solid(ap.x, ap.z) && dist(ap, n0) > 0.1) fail('approach solid');
    if (dist(ap, n0) > 2.4) fail('approach reach');
  })();

  window.__gather = api;
  return 'gather loaded (F11)';
})();
