// Injected into the Ombreval page. Drives the game by wrapping __game.controls.build,
// so prediction, collisions and networking stay handled by the real client.
(() => {
  if (window.__bot) window.__bot.stop();
  const g = window.__game;
  if (!g?.controls) throw new Error('__game not ready');

  const SLOT_KEYS = ['Mouse0', 'Mouse2', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyR', 'Digit5'];
  const KITE_MAX = 11;

  // Adaptive memory (this browser only): zone stats, caution, learned models, A/B knobs.
  const AD_KEY = 'ombreval-bot-adapt';
  const ad = (() => { try { return JSON.parse(localStorage.getItem(AD_KEY)) ?? {}; } catch { return {}; } })();
  ad.zones ??= {}; ad.caution ??= 0; ad.deaths ??= []; ad.calmSince ??= Date.now();
  ad.enemy ??= {}; ad.dpsRatio ??= 1; ad.dpsN ??= 0; ad.margin ??= 1.5; ad.pull ??= {}; ad.strat ??= {};
  ad.tot ??= { xp: 0, ms: 0 }; ad.ab ??= {}; ad.ab.best ??= {};
  // leash: kind -> learned distance where a chase stops; avoid: kind -> avoid ms; spots: remembered danger areas.
  ad.leash ??= {}; ad.avoid ??= {}; ad.spots ??= []; ad.recentDeaths ??= [];
  // Quest model: reward as a fraction of the level xp, seconds per objective unit, talk and quest durations.
  ad.qx ??= { frac: 0.4, n: 0, rate: {}, dur: 600000, dn: 0, talk: 5000, tn: 0 };
  delete ad.offset;
  const saveAd = () => { try { localStorage.setItem(AD_KEY, JSON.stringify(ad)); } catch {} };
  const zoneStat = name => (ad.zones[name] ??= { xp: 0, ms: 0, deaths: 0 });
  // Cheap knobs tuned by A/B runs (variant B active during its half of a run).
  const KNOBS = { potion: { def: 0.4, step: 0.08 }, flee: { def: 0.25, step: 0.06 }, reserve: { def: 1, step: 0.3 } };
  const knob = k => ad.ab.run?.k === k && ad.ab.run.side === 'B' ? ad.ab.run.val : ad.ab.best[k] ?? KNOBS[k].def;
  const potionAt = () => knob('potion') + 0.1 * ad.caution;
  const fleeAt = () => knob('flee') + 0.08 * ad.caution;
  // 2 deaths in the same zone within 15 min: get more careful (zone choice itself is learned).
  const RECENT_MS = 15 * 60000;
  function onDeath(zone) {
    const t = Date.now();
    zoneStat(zone).deaths++;
    ad.recentDeaths = ad.recentDeaths.filter(d => t - d.t < RECENT_MS).concat({ t, zone });
    ad.deaths = ad.deaths.filter(d => t - d.t < 15 * 60000).concat({ t, zone });
    if (ad.deaths.filter(d => d.zone === zone).length >= 2) { ad.caution = Math.min(3, ad.caution + 1); ad.deaths = []; }
    const r = ad.ab.run;
    if (r && r.zone === zone) r[r.side].d++;
    ad.calmSince = t; saveAd();
  }
  // 25 min without dying: relax caution.
  function relax() {
    if (Date.now() - ad.calmSince < 25 * 60000) return;
    if (ad.caution > 0) ad.caution--;
    ad.calmSince = Date.now(); saveAd();
  }

  // Skill/essence/gear numbers: skill_values.json (window.__botSkills, injected by run.mjs) over inline defaults.
  // dmgPct/splashPct are % of the average weapon hit; castSec for bonebolt/blight is at assumptions.aps.
  const SV_DEFAULT = {
    assumptions: { aps: 1.25 },
    skills: {
      bonebolt: { dmgPct: 206.25, splashPct: 62.5, radius: 1.8, range: 13, castSec: 0.58, cost: 0 },
      blight: { dmgPct: 360, splashPct: 168, radius: 2.5, range: 12, castSec: 0.56, cost: 15 },
      raise: { radius: 4.5, range: 14, castSec: 0.6, cost: 15 },
      decrepify: { radius: 4.5, range: 13, castSec: 0.6, cost: 0 },
      corpsex: { dmgPct: 200, radius: 3.5, range: 14, castSec: 0.55, cost: 0 },
      fleshgolem: { dmgPct: 90, castSec: 0.8, cost: 30 },
      colossus: { dmgPct: 960, radius: 6, range: 10, castSec: 0.9, cost: 0 },
      sacrifice: { dmgPct: 150, radius: 3, castSec: 0.45, cost: 0 },
      ossature: { castSec: 0.6, cost: 0 },
    },
    essence: { valuePerPoint: 8.44, reserveRule: null },
    // Client potion tooltip (L93399): 35 % life at once, then 20 % over 3 s, 1.5 s cooldown.
    potion: { instantPct: 35, hotPct: 20, hotSec: 3, cdSec: 1.5 },
    gear: null,
  };
  const SV = (() => {
    const o = structuredClone(SV_DEFAULT), src = window.__botSkills ?? {};
    for (const id in src.skills ?? {}) o.skills[id] = { ...o.skills[id], ...src.skills[id] };
    for (const k of ['assumptions', 'essence', 'potion']) if (src[k] && typeof src[k] === 'object') o[k] = { ...o[k], ...src[k] };
    if (src.gear?.formula) o.gear = src.gear;
    return o;
  })();
  const sk = id => SV.skills[id] ?? {};
  const PLAYER_SPEED = 5.28;
  const ATTACK_STATES = ['chase', 'windup', 'strike'];
  // TODO(ceiling): monster damage level scaling is guessed (+10%/level); learned per-kind values absorb the error.
  const lvlScale = l => 1 + 0.1 * Math.max(0, (l ?? 1) - 1);
  // EMA whose first samples weigh more (prior counts as one sample), floor 0.1 to keep tracking drift.
  const ema = (old, x, n) => old + (x - old) * Math.max(0.1, 1 / (n + 2));
  const xpps = () => ad.tot.xp / Math.max(ad.tot.ms, 60000) * 1000;
  // Death cost: learned xp lost plus xp not earned until the next kill; prior 75 s of farming.
  const deathCostXp = () => ad.deathCost ?? 75 * xpps();

  // Open-world farming zones (client table `bd`): center, radius, monster level range.
  const ZONES = [
    { name: 'Bois des Hurlements', x: -52, z: 8, r: 30, lvl: [1, 3] },
    { name: 'Camp des Gobelins', x: -82, z: -48, r: 27, lvl: [3, 5] },
    { name: 'Cimetière Oublié', x: 62, z: 12, r: 28, lvl: [5, 7] },
    { name: 'Sombrebois', x: 58, z: -62, r: 30, lvl: [7, 9] },
    { name: 'Antre de Grukk', x: 0, z: -100, r: 26, lvl: [10, 12] },
    { name: 'Sylve de Moisivert', x: -130, z: 150, r: 38, lvl: [9, 13] },
    { name: 'Carrières de Rochenoire', x: -112, z: -104, r: 30, lvl: [13, 16] },
  ];
  // UCB1 over arms {mean, n}: unvisited arms first, exploration scaled by the best mean.
  function ucbPick(arms, c = 1) {
    const N = arms.reduce((a, x) => a + x.n, 0), scale = Math.max(1e-9, ...arms.map(x => Math.abs(x.mean)));
    let bi = -1, bv = -Infinity;
    arms.forEach((x, i) => {
      const v = x.n > 0 ? x.mean + c * scale * Math.sqrt(Math.log(N + 1) / x.n) : Infinity;
      if (v > bv) { bv = v; bi = i; }
    });
    return bi;
  }
  // Arm choice: UCB over net value per hour, arms near the ladder base only. Arms are the farm zones, the
  // dungeons whose doors the client knows (g.portals.doors, defs `UT` L41700), and a quest area outside all zones.
  // Prior: the ladder base (hardest arm whose top level is below ours) as a pseudo-observation of 10 min.
  const ZONE_DWELL = 10 * 60000;
  // Net xp/h of measured stats: xp plus loot (gold + sale value of picked items) at the measured xp per gold, minus deaths.
  // TODO(ceiling): gold weighs like xp at the average rates; a real exchange rate (what gold buys) would be better.
  const armNet = (s, xpPerGold, deathXp) => (s.xp + (s.gold ?? 0) * xpPerGold - s.deaths * deathXp) / Math.max(1, s.ms) * 3.6e6;
  const xpPerGold = () => ad.tot.gold ? ad.tot.xp / ad.tot.gold : 0;
  // Quest value rate (xp/h): reward over the time to finish the remaining units plus the trip.
  const questRate = (reward, left, secPer, tripSec) => reward / Math.max(1, left * secPer + tripSec) * 3600;
  const lvlXp = l => Math.round(110 * l ** 1.85 + 60 * l); // client gI (L55884), levels <= 30
  const questReward = () => ad.qx.frac * lvlXp(g.level);
  const questKey = q => q.label.replace(/\d+\/\d+/g, '').trim();
  const isFarmQuest = q => (q?.type === 'kill' || q?.type === 'collect') && q.x != null;
  const holdsQuest = (arm, q) => !!q && (arm.dun ? q.type === 'dungeon' && q.label.includes(arm.dun.d.name)
    : isFarmQuest(q) && dist(arm, q) < Math.max(arm.r, q.r ?? 0));
  const secPerKill = s => (s?.kills > 3 ? s.ms / s.kills : ad.tot.kills ? ad.tot.ms / ad.tot.kills : 10000) / 1000;
  function questBonus(q, z, s) {
    const dun = q.type === 'dungeon';
    const left = dun ? 1 : Math.max(1, (q.need ?? 1) - (q.have ?? 0));
    const per = dun ? (s.runs ? s.ms / s.runs : DUN_MAX_MS) / 1000 : ad.qx.rate[q.kind]?.v ?? secPerKill(s);
    return questRate(questReward(), left, per, tripLen(g.sim, z) / PLAYER_SPEED);
  }
  function armList(q) {
    const doors = (g.portals?.doors ?? []).map(o => ({ name: 'donjon : ' + o.d.name, x: o.at.x, z: o.at.z, r: 6, lvl: o.d.levels ?? [o.d.level, o.d.level], dun: o }));
    const list = [...ZONES, ...doors];
    if (isFarmQuest(q) && !ZONES.some(z => holdsQuest(z, q)))
      list.push({ name: 'quête : ' + questKey(q), x: q.x, z: q.z, r: Math.max(15, q.r ?? 25), lvl: [q.minLevel ?? 1, q.minLevel ?? 1], quest: true });
    return list.sort((a, b) => a.lvl[0] - b.lvl[0] || a.lvl[1] - b.lvl[1]);
  }
  function zoneArms() {
    const q = st.quest, L = armList(q), dc = deathCostXp(), xg = xpPerGold();
    const base = L.reduce((best, z, i) => z.lvl[1] <= g.level - 1 ? i : best, 0);
    const known = L.map(z => ad.zones[z.name]).filter(s => s?.ms > 60000);
    const top = Math.max(xpps() * 3600, ...known.map(s => armNet(s, xg, dc)));
    const t = Date.now();
    return L.map((z, i) => {
      const s = ad.zones[z.name] ?? { xp: 0, ms: 0, deaths: 0 };
      const prior = top * (1 - 0.2 * Math.abs(i - base)), pms = ZONE_DWELL;
      // Recent deaths there, as a death rate over the recent window: pushes the arm away for a while.
      const recent = ad.recentDeaths.filter(d => d.zone === z.name && t - d.t < RECENT_MS).length * dc / RECENT_MS * 3.6e6;
      const qb = holdsQuest(z, q) ? questBonus(q, z, s) : 0;
      const mean = (prior * pms + armNet(s, xg, dc) * s.ms) / (pms + s.ms) - recent + qb;
      const lvlOk = z.dun ? z.dun.d.level <= g.level && !(DUN_SKIP.get(z.dun.d.id) > Date.now())
        : z.quest ? (q.minLevel ?? 1) <= g.level - 1 : z.lvl[0] <= g.level;
      return { z, mean, qb, n: (pms + s.ms) / ZONE_DWELL, ok: lvlOk && (Math.abs(i - base) <= 2 || qb > 0) };
    });
  }
  function pickZone() {
    const qk = st.quest ? questKey(st.quest) : null;
    if (st.zonePick && now() - st.zonePickAt < ZONE_DWELL && st.zonePick.lvl[0] <= g.level && st.zonePickQ === qk) return st.zonePick;
    const arms = zoneArms().filter(a => a.ok);
    st.zoneArms = arms;
    st.zonePick = arms[ucbPick(arms)]?.z ?? ZONES[0]; st.zonePickAt = now(); st.zonePickQ = qk;
    return st.zonePick;
  }
  // Door of the picked dungeon arm, when it is still enterable.
  const armDoor = () => {
    const o = !g.dungeon && st.zonePick?.dun;
    return o && o.d.level <= g.level && !(DUN_SKIP.get(o.d.id) > Date.now()) ? o : null;
  };
  let LEASH = 45;

  const st = {
    on: false, home: null, wander: null, wanderUntil: 0, kills: 0, deaths: 0,
    xp0: null, lvl0: null, t0: 0, last: '', pressed: new Set(), deadSince: 0, nav: null,
  };

  const now = () => performance.now();
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const solid = (x, z) => {
    const c = g.dungeon?.collision ?? g.world?.collision;
    try { return !!c?.solidAt(x, z, 0.6); } catch { return false; }
  };
  const ready = id => !(g.sim.cds?.[id] > 0);

  function monsters() {
    const out = [];
    for (const m of g.entities.visibleMonsters()) {
      if (m.dead || m.hp <= 0) continue;
      // Inside a dungeon picked for our level, the boss and its guards are fair game.
      if (!g.dungeon && (m.boss || m.level > g.level + 2)) continue;
      // Elites (pack leaders) are skipped unless already on us: running is useless, they outrun us.
      if (m.elite && !(dist(m.pos, g.sim) < 10 && ['chase', 'windup', 'strike'].includes(m.state))) continue;
      const onUs = dist(m.pos, g.sim) < 10 && ['chase', 'windup', 'strike'].includes(m.state);
      if (!onUs && st.home && dist(m.pos, st.home) > LEASH + 8) continue;
      if (!onUs && inDanger(m.pos)) continue;
      out.push(m);
    }
    return out;
  }

  // --- Disengage: chase ranges are server side, so they are learned per kind (distance where a chase stopped).
  const CHASE_PRIOR = 14; // the old fixed detection radius, until a kind's range is learned
  const CHASE_STATES = ['chase', 'windup', 'strike', 'recover', 'leap'];
  const chaseRange = kind => ad.leash[kind]?.d ?? CHASE_PRIOR;
  const converging = (m, d) => ATTACK_STATES.includes(m.state) && d < chaseRange(m.def?.kind) + (m.def?.speed ?? PLAYER_SPEED);
  // A chaser is done once it left its chase states, or is beyond its chase range plus one second of its run.
  const retreatOver = (state, d, range, speed) => !CHASE_STATES.includes(state) || (range != null && d > range + speed);
  // Avoid time per kind: doubled when it gets us again near a remembered spot, halved (down to the prior) after a clean expiry.
  const AVOID_PRIOR = 60000;
  const avoidNext = (ms, rehit) => rehit ? ms * 2 : Math.max(AVOID_PRIOR, ms / 2);
  const inDanger = p => ad.spots.some(s => Date.now() < s.until && Math.hypot(p.x - s.x, p.z - s.z) < s.r);
  function remember(kind, p, r, ret) {
    const t = Date.now(), ms = ad.avoid[kind] ??= AVOID_PRIOR;
    const s = ad.spots.find(x => x.kind === kind && Math.hypot(x.x - p.x, x.z - p.z) < x.r);
    if (!s) { ad.spots.push({ x: p.x, z: p.z, kind, r, until: t + ms, ret }); return; }
    if (s.ret !== ret) { s.ret = ret; ad.avoid[kind] = avoidNext(ms, true); }
    s.until = Math.max(s.until, t + ad.avoid[kind]);
  }
  // Spots stay on probation for one more avoid time after expiry; a clean probation decays the kind's avoid time.
  function expireSpots() {
    const t = Date.now();
    ad.spots = ad.spots.filter(s => {
      if (t < s.until + (ad.avoid[s.kind] ?? AVOID_PRIOR)) return true;
      ad.avoid[s.kind] = avoidNext(ad.avoid[s.kind] ?? AVOID_PRIOR, false);
      return false;
    });
  }
  // Retreat target: keep the current one while we still reach it before any chaser; else the candidate with the
  // best clearance at arrival (its distance to the nearest chaser minus our walk scaled by the chasers' speed ratio).
  function pickRetreat(me, chasers, cands, cur, vRatio) {
    const clear = c => Math.min(...chasers.map(p => dist(p, c))) - dist(me, c) * vRatio;
    if (cur && dist(me, cur) > 2 && clear(cur) > 0) return cur;
    let best = null, bv = 0;
    for (const c of cands) {
      const v = clear(c);
      if (dist(me, c) > 2 && v > bv) { bv = v; best = { x: c.x, z: c.z }; }
    }
    return best;
  }
  function retreatCands(me) {
    const out = [], army = myAllies(), h = st.home ?? me;
    if (army.length) out.push({ x: army.reduce((a, v) => a + v.pos.x, 0) / army.length, z: army.reduce((a, v) => a + v.pos.z, 0) / army.length });
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI / 6, c = Math.cos(a), s = Math.sin(a);
      out.push({ x: h.x + c * LEASH * 0.9, z: h.z + s * LEASH * 0.9 }, { x: me.x + c * 20, z: me.z + s * 20 }, { x: me.x + c * 40, z: me.z + s * 40 });
    }
    for (const w of awake()) out.push(w);
    out.push(BERTRAND);
    return out.filter(p => !solid(p.x, p.z) && !inDanger(p));
  }
  // Potion burn: potions drunk so far, scaled by the enemy hp still left over the hp removed, exceed the potions left.
  const burnDisengage = (used, left, hpTot, hpRem) => used >= 1 && used * hpRem / Math.max(1e-6, hpTot - hpRem) > left;
  // Disengage reflex: a too-strong monster, or a converging crowd (event adds included) that kills us before we kill it,
  // starts a retreat that lasts until every chaser gave up.
  function retreatTick(me) {
    expireSpots();
    if (g.dungeon) { st.retreat = null; return null; }
    const conv = [...g.entities.visibleMonsters()].filter(m => !m.dead && m.hp > 0 && converging(m, dist(m.pos, me)));
    const strong = conv.filter(m => m.boss || m.level > g.level + 2);
    const f = st.fight;
    const burn = !!f && conv.length > 0 && burnDisengage(f.pot0 - g.char.potions, g.char.potions, f.hpTot,
      [...f.seen].reduce((a, id) => { const m = g.entities.monsters.get(id)?.view; return a + (m && !m.dead ? Math.max(0, m.hp) : 0); }, 0));
    const crowd = burn || conv.length > 0 && !engage({ hp: conv.reduce((a, m) => a + m.hp, 0), dps: conv.reduce((a, m) => a + enemyDps(m), 0), n: conv.length },
      { ...meState(), margin: 1 }).ok;
    if (strong.length || crowd) {
      const r = st.retreat ??= { ids: new Map(), t0: now(), target: null, why: strong.length ? 'ennemi trop fort' : burn ? 'potions brûlées' : `foule de ${conv.length}` };
      for (const m of crowd ? conv : strong) if (!r.ids.has(m.id)) r.ids.set(m.id, m.state);
      for (const m of strong) remember(m.def?.kind ?? '?', m.pos, chaseRange(m.def?.kind) + (m.def?.speed ?? PLAYER_SPEED), r.t0);
      if (crowd) {
        const c = { x: conv.reduce((a, m) => a + m.pos.x, 0) / conv.length, z: conv.reduce((a, m) => a + m.pos.z, 0) / conv.length };
        remember('foule', c, CHASE_PRIOR + Math.max(...conv.map(m => dist(m.pos, c))), r.t0);
      }
      if (st.fight) st.fight.disengaged = true;
    }
    const r = st.retreat;
    if (!r) return null;
    const chasers = [];
    let vMax = 0;
    for (const [id, last] of r.ids) {
      const m = g.entities.monsters.get(id)?.view;
      if (!m || m.dead || m.hp <= 0) { r.ids.delete(id); continue; }
      const d = dist(m.pos, me), kind = m.def?.kind;
      if (last === 'chase' && !CHASE_STATES.includes(m.state)) { const e = ad.leash[kind] ??= { d, n: 0 }; e.d = ema(e.d, d, e.n++); }
      r.ids.set(id, m.state);
      if (retreatOver(m.state, d, ad.leash[kind]?.d, m.def?.speed ?? PLAYER_SPEED)) { r.ids.delete(id); continue; }
      chasers.push(m.pos); vMax = Math.max(vMax, m.def?.speed ?? PLAYER_SPEED);
    }
    if (!chasers.length) { st.retreat = null; st.retreats = (st.retreats ?? 0) + 1; return null; }
    r.target = pickRetreat(me, chasers, retreatCands(me), r.target, vMax / PLAYER_SPEED);
    st.reflex = `repli (${r.why})`;
    st.last = r.target ? `repli vers ${Math.round(r.target.x)},${Math.round(r.target.z)}` : 'repli (fuite directe)';
    if (r.target) return travelPath(r.target, 'retreat');
    const cx = chasers.reduce((a, p) => a + p.x, 0) / chasers.length, cz = chasers.reduce((a, p) => a + p.z, 0) / chasers.length;
    return steer(me.x - cx, me.z - cz);
  }


  // --- Learned enemy model: per kind EMA of damage per second dealt to us while engaged,
  // normalized to level 1. Prior: def.dmg per hit, one hit every ~1.5 s.
  const priorDps = def => (def?.dmg ?? 5) / 1.5;
  const enemyDps = m => (ad.enemy[m.def?.kind]?.dps ?? priorDps(m.def)) * lvlScale(m.level);
  const win = { inDmg: {}, inExp: {}, def: {}, outDmg: 0, outExp: 0, at: now() };
  const hitUs = new Map(); // monster id -> last time it hit us
  // Engaged = attacking now, or attacked us in the last 4 s and still close (its 'recover' phase between swings
  // used to drop it from the list, flipping the bot between fighting and walking away).
  const engagedAt = new Map();
  const engagedOnUs = o => {
    const now_ = now();
    if (ATTACK_STATES.includes(o.m.state) && (o.d < 8 || (o.m.state !== 'chase' && o.d < 15))) { engagedAt.set(o.m.id, now_); return true; }
    return now_ - (engagedAt.get(o.m.id) ?? -1e9) < 4000 && o.d < 15;
  };
  function onHit(ev) {
    if (ev.id === g.meId) {
      const m = g.entities.monsters.get(ev.s)?.view;
      if (!m) return;
      const k = m.def?.kind;
      win.inDmg[k] = (win.inDmg[k] ?? 0) + (ev.a ?? 0) / lvlScale(m.level);
      if (st.fight) st.fight.dmgIn[k] = (st.fight.dmgIn[k] ?? 0) + (ev.a ?? 0);
      hitUs.set(ev.s, now());
    } else if (g.entities.monsters.has(ev.id) && (ev.s === g.meId || g.entities.allies.has(ev.s))) win.outDmg += ev.a ?? 0;
  }
  // Called every tick: accumulate exposure, flush samples every 4 s.
  function account(dt, mobs) {
    for (const o of mobs) if (engagedOnUs(o)) {
      const k = o.m.def?.kind;
      win.inExp[k] = (win.inExp[k] ?? 0) + dt / 1000; win.def[k] = o.m.def;
    }
    if (st.goal === 'fight' && mobs.some(o => o.d < 13)) win.outExp += dt / 1000;
    if (now() - win.at < 4000) return;
    win.at = now();
    for (const k in win.inExp) if (win.inExp[k] >= 1.5) {
      const e = ad.enemy[k] ??= { dps: priorDps(win.def[k]), n: 0 };
      e.dps = ema(e.dps, (win.inDmg[k] ?? 0) / win.inExp[k], e.n++);
      win.inDmg[k] = 0; win.inExp[k] = 0;
    }
    if (win.outExp >= 2) {
      ad.dpsRatio = Math.max(0.05, ema(ad.dpsRatio, win.outDmg / win.outExp / Math.max(1, priorMyDps()), ad.dpsN++));
      win.outDmg = 0; win.outExp = 0;
    }
  }

  // --- Our stat sheet (analyst formula, skill_values.json "gear"): hit, aps, dps index, effective HP.
  function sheet(swap) {
    const lvl = g.level, eq = { ...(g.char.eq ?? {}) };
    if (swap) eq[swap.slot] = swap;
    const s = { ...(g.char.ch.alloc ?? {}) };
    let armorBase = 0;
    for (const it of Object.values(eq)) {
      if (!it) continue;
      armorBase += it.armor ?? 0;
      for (const f of it.affixes ?? []) s[f.stat] = (s[f.stat] ?? 0) + f.value;
    }
    const v = k => s[k] ?? 0, w = eq.weapon;
    const avgHit = w ? (w.dmgMin + w.dmgMax) / 2 + v('flatDmg') : 5;
    const mult = 1 + (5 * (lvl - 1) + 0.5 * v('pow') + v('dmgPct')) / 100;
    const aps = (w?.aps ?? 1.25) * (1 + (v('atkSpd') + 0.15 * (lvl - 1)) / 100 + 0.002 * Math.min(v('agi'), 300));
    const critF = 1 + Math.min(60, 5 + 0.1 * (lvl - 1) + 0.15 * v('prec') + v('crit')) / 100 * (50 + 1.5 * v('fer') + v('critDmg')) / 100;
    const hit = avgHit * mult * critF * (1 + 0.35 * v('execute') / 100);
    const gen = 1 + (v('furyGen') + 0.5 * (lvl - 1) + 0.5 * v('wil')) / 100;
    const boltDur = sk('bonebolt').castSec * SV.assumptions.aps;
    const surplus = (4 * aps / boltDur + 2) * gen - 0.75;
    const dps = hit * (sk('bonebolt').dmgPct * aps / boltDur + SV.essence.valuePerPoint * surplus + 165) / 100;
    const life = (150 + 22 * (lvl - 1) + 4 * v('vit') + v('life')) * (1 + v('lifePct') / 100) * 0.9;
    const armor = (5 + 2 * (lvl - 1) + armorBase + v('armor') + 2 * v('tgh')) * 0.85;
    const red = Math.min(0.75, armor / (armor + 25 + 14 * lvl));
    const ehp = life / (1 - red) / (1 - Math.min(40, v('dr')) / 100);
    return { hit, aps, dps, ehp };
  }
  const curSheet = () => {
    if (!st.sheet || now() - st.sheetAt > 2000) { st.sheet = sheet(); st.sheetAt = now(); }
    return st.sheet;
  };
  // Cast time: bonebolt/blight scale with attack speed (dur/aps), the other spells are fixed.
  const castSec = id => (id === 'bonebolt' || id === 'blight')
    ? (sk(id).castSec ?? 0.58) * SV.assumptions.aps / curSheet().aps : sk(id).castSec ?? 0.6;
  const SKEL_DPS = 0.231, GOLEM_DPS = 0.45; // weapon hits per second (30% every 1.3 s, 90% every 2 s)
  function priorMyDps() {
    const { hit } = curSheet();
    return hit * (sk('bonebolt').dmgPct / 100 / castSec('bonebolt') + servantCount() * SKEL_DPS + (golemAlive() ? GOLEM_DPS : 0));
  }
  const myDps = () => priorMyDps() * ad.dpsRatio;
  const splashShare = () => (sk('bonebolt').splashPct ?? 0) / (sk('bonebolt').dmgPct || 1);

  // --- Target priority (Smith's rule): incoming dps removed per second of our time.
  function smithScore(dps, hp, ourDps, d, fastKite, onUs) {
    const ttk = Math.max(0.3, hp / Math.max(1, ourDps)) + Math.max(0, d - 12) / PLAYER_SPEED;
    return dps * (fastKite ? 1.5 : 1) * (onUs ? 1.5 : 1) / ttk;
  }
  // Quest kill targets weigh 1 + ln(1 + extra xp per kill / average xp per kill).
  // TODO(ceiling): the log damps the quest bonus so it cannot fully override threat order; tune from fight data.
  function questMul(m) {
    const q = st.quest;
    if (q?.type !== 'kill' || m.def?.name !== q.kind || !ad.tot.kills) return 1;
    const per = questReward() / Math.max(1, (q.need ?? 1) - (q.have ?? 0));
    return 1 + Math.log1p(per / Math.max(1, ad.tot.xp / ad.tot.kills));
  }
  const smith = (o, kite) => smithScore(enemyDps(o.m), o.m.hp, myDps(), o.d,
    kite && (o.m.def?.speed ?? 0) > PLAYER_SPEED, now() - (hitUs.get(o.m.id) ?? -1e9) < 3000) * questMul(o.m);

  // --- Engagement model: time to kill vs time to die, with a self-tuned safety margin.
  function engage(f, me) {
    const ttk = f.hp / Math.max(1e-6, me.dps * (1 + me.splash * Math.max(0, f.n - 1)));
    const pots = Math.min(me.potions, 1 + Math.floor(ttk / me.potCd));
    const ttd = (me.hp + pots * me.potHeal) / Math.max(1e-6, f.dps * (1 - me.soak));
    return { ttk, ttd, ok: ttd > ttk * me.margin };
  }
  const meState = () => ({
    dps: myDps(), hp: g.hp, potHeal: (SV.potion.instantPct + SV.potion.hotPct) / 100 * g.life, potions: g.char.potions, potCd: SV.potion.cdSec, splash: splashShare(),
    soak: 0.2 + 0.2 * Math.min(1, servantCount() / skelCap()), margin: ad.margin,
  });
  // Single-linkage clusters (8 m) of all live visible monsters; a group with a non-target member is not pullable.
  function groupsOf(all, allowed) {
    const left = [...all], out = [];
    while (left.length) {
      const grp = [left.pop()];
      for (let i = 0; i < grp.length; i++) for (let j = left.length - 1; j >= 0; j--)
        if (dist(left[j].m.pos, grp[i].m.pos) < 8) grp.push(left.splice(j, 1)[0]);
      out.push({ mobs: grp, d: Math.min(...grp.map(o => o.d)), hp: grp.reduce((a, o) => a + o.m.hp, 0),
        dps: grp.reduce((a, o) => a + enemyDps(o.m), 0), ok: grp.every(o => allowed.has(o.m.id)) });
    }
    return out.sort((a, b) => a.d - b.d);
  }
  const bucketOf = k => Math.min(4, Math.max(1, k));
  // Pull plan: every prefix of the nearest pullable groups that survives the model is an option;
  // the pull-size bucket (1, 2, 3, 4+) is chosen by UCB on learned net xp/s, 4+ takes the largest safe option.
  function planPull(mobs) {
    const allowed = new Set(mobs.map(o => o.m.id)), me = g.sim;
    const all = [...g.entities.visibleMonsters()].filter(m => !m.dead && m.hp > 0).map(m => ({ m, d: dist(m.pos, me) }));
    const eng = all.filter(o => engagedOnUs(o) || converging(o.m, o.d)), engIds = new Set(eng.map(o => o.m.id));
    const acc = { hp: eng.reduce((a, o) => a + o.m.hp, 0), dps: eng.reduce((a, o) => a + enemyDps(o.m), 0), n: eng.length };
    const ms = meState(), groups = groupsOf(all.filter(o => !engIds.has(o.m.id) && (!st.home || dist(o.m.pos, st.home) < LEASH + 8)), allowed);
    const opts = [];
    for (const grp of groups) {
      if (!grp.ok) continue;
      acc.hp += grp.hp; acc.dps += grp.dps; acc.n += grp.mobs.length;
      const e = engage(acc, ms);
      if (!e.ok) break;
      opts.push({ k: opts.length + 1, e, groups: [...(opts.at(-1)?.groups ?? []), grp] });
    }
    if (!opts.length) {
      // Nothing deemed safe while pullable groups exist and we are idle: let the margin drift down (exploration).
      if (!eng.length && !st.fight && groups.some(grp => grp.ok)) ad.margin = Math.max(1, ad.margin * 0.995);
      return { k: 0, ids: new Set(), opts, e: null };
    }
    const buckets = [...new Set(opts.map(o => bucketOf(o.k)))];
    const arms = buckets.map(b => { const s = ad.pull[b]; return { mean: s ? s.xp / Math.max(1, s.ms) * 1000 : 0, n: s?.n ?? 0 }; });
    const b = buckets[ucbPick(arms)];
    const pick = opts.filter(o => bucketOf(o.k) === b).at(-1);
    return { k: pick.k, ids: new Set(pick.groups.flatMap(grp => grp.mobs.map(o => o.m.id))), opts, e: pick.e };
  }
  // Fight episodes feed pull-size and strategy stats, and tune the margin.
  // Fight = first engagement until FIGHT_GAP without engagement, or death. One summary per fight goes to window.__botFights.
  const FIGHT_GAP = 5000, FIGHTS_MAX = 200;
  const fightOver = (last, t, died) => died || t - last > FIGHT_GAP;
  const fights = window.__botFights = window.__botFights ?? [];
  function fightTrack(inFight, hpPct, attackers) {
    const t = now();
    if (inFight) {
      st.fight ??= { t0: t, at: Date.now(), xp0: st.xpTot ?? 0, b: bucketOf(st.plan?.k || 1), k: st.plan?.k ?? 0, minHp: 1, hp0: hpPct, pot0: g.char.potions,
        kinds: {}, strat: st.strat, comp: {}, seen: new Set(), maxAtk: 0, hpTot: 0, ess: 0, casts: {}, dmgIn: {}, kills0: st.kills, zone: st.zone, lvl: g.level,
        margin: ad.margin, ttk: st.plan?.e?.ttk ?? null, ttd: st.plan?.e?.ttd ?? null, fury: g.sim.fury ?? 0, cds: { ...(g.sim.cds ?? {}) } };
      const f = st.fight;
      f.minHp = Math.min(f.minHp, hpPct); f.last = t; f.strat = st.strat;
      if (st.mainKind) f.kinds[st.mainKind] = 1;
      f.maxAtk = Math.max(f.maxAtk, attackers.length);
      for (const o of attackers) if (!f.seen.has(o.m.id)) {
        f.seen.add(o.m.id);
        const key = `${o.m.def?.kind}${o.m.level}${o.m.elite ? 'E' : ''}`;
        f.comp[key] = (f.comp[key] ?? 0) + 1; f.hpTot += o.m.maxHp ?? o.m.hp;
      }
    }
    const f = st.fight;
    if (!f) return;
    const fury = g.sim.fury ?? 0, cds = g.sim.cds ?? {};
    if (fury < f.fury) f.ess += f.fury - fury;
    f.fury = fury;
    for (const id in cds) if (cds[id] > 0 && !(f.cds[id] > 0) && id !== 'roll') f.casts[id] = (f.casts[id] ?? 0) + 1;
    f.cds = { ...cds };
    if (!inFight && fightOver(f.last, t, false)) endFight(false);
  }
  function endFight(died) {
    const f = st.fight; st.fight = null;
    if (!f) return;
    const ms = now() - f.t0, gained = (st.xpTot ?? 0) - f.xp0, xp = gained - (died ? deathCostXp() : 0);
    const add = (o, key) => { const s = o[key] ??= { xp: 0, ms: 0, n: 0 }; s.xp += xp; s.ms += ms; s.n++; };
    add(ad.pull, f.b);
    for (const k in f.kinds) add(ad.strat, `${f.strat}|${k}`);
    const close = died || f.disengaged || f.minHp < potionAt() || g.char.potions < f.pot0;
    if (close) ad.margin *= died || f.disengaged ? 1.3 : 1.08;
    else if (f.minHp > 0.7) ad.margin = Math.max(1, ad.margin * 0.97);
    st.lastFight = `${f.b} grp ${Math.round(ms / 1000)}s ${Math.round(xp)}xp${close ? ' serré' : ''}`;
    const pct = v => Math.round(v * 100);
    fights.push({ t0: f.at, t1: Date.now(), zone: f.zone, strat: f.strat, pull: f.k, comp: f.comp, maxAtk: f.maxAtk, lvl: f.lvl,
      hp0: pct(f.hp0), hpMin: pct(f.minHp), hpEnd: died ? 0 : pct(g.hp / g.life), potions: Math.max(0, f.pot0 - g.char.potions),
      ess: Math.round(f.ess), casts: f.casts, dmgIn: Object.fromEntries(Object.entries(f.dmgIn).map(([k, v]) => [k, Math.round(v)])),
      kills: st.kills - f.kills0, xp: Math.round(gained), outcome: died ? 'death' : f.disengaged ? 'disengage' : 'win',
      margin: +f.margin.toFixed(3), ttk: f.ttk && +f.ttk.toFixed(1), ttd: f.ttd && +f.ttd.toFixed(1) });
    if (fights.length > FIGHTS_MAX) fights.splice(0, fights.length - FIGHTS_MAX);
  }

  // --- Movement strategy: kite slow packs in a circle, hold behind the army against fast ones.
  // Prior from the share of slower enemies; learned xp/s per (strategy, kind) overrides once both have 1 min of data.
  function chooseStrat(eng) {
    if (!eng.length) return st.strat ?? 'hold';
    const slow = eng.filter(o => (o.m.def?.speed ?? 5) < PLAYER_SPEED).length / eng.length;
    const counts = {};
    for (const o of eng) counts[o.m.def?.kind] = (counts[o.m.def?.kind] ?? 0) + 1;
    const kind = st.mainKind = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    let s = slow >= 0.3 ? 'kite' : 'hold';
    const rate = x => x && x.ms > 60000 ? x.xp / x.ms : null;
    const rk = rate(ad.strat[`kite|${kind}`]), rh = rate(ad.strat[`hold|${kind}`]);
    if (rk != null && rh != null) s = rk >= rh ? 'kite' : 'hold';
    if (st.fight && (st.fight.explore ??= Math.random() < 0.1)) s = s === 'kite' ? 'hold' : 'kite';
    return s;
  }
  const centroid = list => ({ x: list.reduce((a, o) => a + o.m.pos.x, 0) / list.length, z: list.reduce((a, o) => a + o.m.pos.z, 0) / list.length });
  // Nearby item drop to drift toward while moving (does not override the strategy).
  function dropPull(me) {
    for (const d of g.drops.drops.values()) if (d.kind === 'item' && dist(d.pos, me) < 6 && !st.lootTried?.has(d.id)) {
      const dd = dist(d.pos, me) || 1;
      return [(d.pos.x - me.x) / dd * 0.35, (d.pos.z - me.z) / dd * 0.35];
    }
    return [0, 0];
  }
  // Orbit the enemy centroid at ~9 m, staying inside the zone and flipping direction at walls.
  function kiteMove(me, eng) {
    const c = centroid(eng), dx = me.x - c.x, dz = me.z - c.z, d = Math.hypot(dx, dz) || 1, R = 9;
    st.orbit ??= 1;
    const radial = (R - d) / R * 1.5;
    let vx = -dz / d * st.orbit + dx / d * radial, vz = dx / d * st.orbit + dz / d * radial;
    const hd = dist(me, st.home ?? me);
    if (st.home && hd > LEASH * 0.8) { vx += (st.home.x - me.x) / hd * hd / LEASH; vz += (st.home.z - me.z) / hd * hd / LEASH; }
    const [px, pz] = dropPull(me); vx += px; vz += pz;
    const vl = Math.hypot(vx, vz) || 1;
    if (solid(me.x + vx / vl * 1.5, me.z + vz / vl * 1.5) && now() - (st.orbitFlip ?? 0) > 1500) { st.orbit *= -1; st.orbitFlip = now(); }
    return steer(vx, vz);
  }
  // Stand on the far side of the army from the attackers, on a corpse if one is close to that spot.
  function holdMove(me, eng, army) {
    if (!army.length || !eng.length) { const p = dropPull(me); return p[0] || p[1] ? steer(...p) : [0, 0]; }
    const ax = army.reduce((a, v) => a + v.pos.x, 0) / army.length, az = army.reduce((a, v) => a + v.pos.z, 0) / army.length;
    const e = centroid(eng), vx = ax - e.x, vz = az - e.z, vl = Math.hypot(vx, vz) || 1;
    let spot = { x: ax + vx / vl * 3, z: az + vz / vl * 3 };
    const c = corpsesNear(spot, 4).best;
    if (c) spot = { x: c.x, z: c.z };
    return dist(me, spot) > 1 ? steer(spot.x - me.x, spot.z - me.z) : [0, 0];
  }

  // --- Skill choice by expected value (weapon-hit units per second of cast).
  // Overkill-capped damage: core on the monster nearest pt, splash on the others within r.
  function dmgAt(mobs, pt, r, core, splash, hit) {
    if (!pt) return 0;
    const inR = mobs.filter(o => dist(o.m.pos, pt) <= r).sort((a, b) => dist(a.m.pos, pt) - dist(b.m.pos, pt));
    return inR.reduce((a, o, i) => a + Math.min((i ? splash : core) * hit, o.m.hp), 0);
  }
  // Essence reserve (analyst reserveRule): one raise while the army is below cap, a golem while none is alive.
  function reserve() {
    const r = SV.essence.reserveRule, bar = g.char.bar;
    let need = typeof r === 'number' ? r : 0;
    if (typeof r !== 'number') {
      if (bar.includes('raise') && servantCount() < skelCap()) need = Math.max(need, sk('raise').cost ?? 15);
      if (bar.includes('fleshgolem') && !golemAlive()) need = Math.max(need, sk('fleshgolem').cost ?? 30);
    }
    return need * knob('reserve');
  }
  // TODO(ceiling): utility horizons (skeleton 20 s, golem 30 s) are guesses; xp/s learning does not tune them.
  function chooseSkill(ctx) {
    const { mobs, me, attackers, hpPct, hpDrop, ess } = ctx;
    const hit = curSheet().hit, essVal = SV.essence.valuePerPoint / 100 * hit;
    const missing = skelCap() - servantCount(), raiseOn = g.char.bar.includes('raise');
    const corpseVal = missing > 0 && raiseOn ? hit * SKEL_DPS * 20 : 0;
    const res = reserve(), out = [];
    for (const id of g.char.bar) {
      if (!id || !ready(id)) continue;
      const s = sk(id), cost = s.cost ?? 0;
      if (ess < cost || ess - cost < (id === 'raise' || id === 'fleshgolem' ? 0 : res)) continue;
      const pct = (s.dmgPct ?? 0) / 100, spl = (s.splashPct ?? 0) / 100;
      let val = 0, aim = null;
      if (id === 'bonebolt' || id === 'blight') {
        aim = bestAoe(mobs, s.range ?? 12, s.radius ?? 2);
        val = dmgAt(mobs, aim, s.radius ?? 2, pct, spl, hit) + (id === 'blight' && aim ? corpseVal : 0);
      } else if (id === 'raise' && missing > 0) {
        const c = corpsesNear(me, s.range ?? 14);
        if (c.best) { aim = c.best; val = Math.min(2, missing, corpsesNear(c.best, s.radius ?? 4.5).n) * corpseVal; }
      } else if (id === 'decrepify' && attackers.length) {
        aim = bestAoe(attackers, s.range ?? 13, s.radius ?? 4.5);
        val = attackers.filter(o => aim && dist(o.m.pos, aim) <= (s.radius ?? 4.5)).reduce((a, o) => a + enemyDps(o.m), 0) * 0.25 * 8;
      } else if (id === 'ossature' && attackers.length) {
        const inc = attackers.reduce((a, o) => a + enemyDps(o.m), 0);
        val = Math.min(10 * inc, 3 * 0.3 * g.life) * (hpDrop ? 1 : 0.3) * (2 - hpPct);
      } else if (id === 'corpsex' && (!raiseOn || missing <= 0)) {
        for (const c of g.entities.corpses?.list?.values?.() ?? []) {
          const pos = c.group?.position;
          if (c.gone || !pos || dist(pos, me) > (s.range ?? 14)) continue;
          const near = [...g.entities.corpses.list.values()].filter(x => !x.gone && x.group?.position && dist(x.group.position, pos) < 5).map(x => x.group.position).slice(0, 3);
          const v = mobs.reduce((a, o) => a + Math.min(near.filter(p => dist(p, o.m.pos) <= (s.radius ?? 3.5)).length * pct * hit, o.m.hp), 0);
          if (v > val) { val = v; aim = { x: pos.x, z: pos.z }; }
        }
      } else if (id === 'fleshgolem' && !golemAlive() && now() - (st.golemAt ?? -1e9) > 5000) {
        aim = { x: me.x, z: me.z }; val = hit * GOLEM_DPS * 30;
      } else if (id === 'colossus') {
        aim = bestAoe(mobs, s.range ?? 10, s.radius ?? 6);
        const inR = aim ? mobs.filter(o => dist(o.m.pos, aim) <= (s.radius ?? 6)) : [];
        if (inR.length >= 3 || inR.some(o => o.m.elite || o.m.boss)) val = dmgAt(mobs, aim, s.radius ?? 6, pct, pct, hit);
      } else if (id === 'sacrifice' && servantCount()) {
        const army = myAllies().filter(a => a.def?.kind === 'skeleton');
        val = mobs.filter(o => army.some(a => dist(a.pos, o.m.pos) <= (s.radius ?? 3))).reduce((a, o) => a + Math.min(pct * hit, o.m.hp), 0)
          - army.length * 0.25 * hit * SKEL_DPS * 20;
      }
      const ev = (val - cost * essVal) / castSec(id);
      if (ev > 0) out.push({ id, ev, aim, slot: g.char.bar.indexOf(id) });
    }
    out.sort((a, b) => b.ev - a.ev);
    return out[0] ?? null;
  }

  // --- A/B test of cheap knobs: 15 min per side in the same zone, keep the better net xp/h.
  const AB_MS = 15 * 60000;
  function abTick(dt) {
    let r = ad.ab.run;
    if (r && Date.now() - r.started > 4 * AB_MS) r = ad.ab.run = null; // zone left for too long: restart
    if (!r) {
      const keys = Object.keys(KNOBS), k = keys[ad.ab.i = ((ad.ab.i ?? -1) + 1) % keys.length];
      const b = ad.ab.best[k] ?? KNOBS[k].def;
      r = ad.ab.run = { k, val: Math.max(0.05, +(b + KNOBS[k].step * (Math.random() < 0.5 ? -1 : 1)).toFixed(3)), zone: st.zone, side: 'A',
        started: Date.now(), A: { xp: 0, ms: 0, d: 0 }, B: { xp: 0, ms: 0, d: 0 } };
    }
    if (st.zone !== r.zone) return;
    const cur = r[r.side];
    cur.ms += dt;
    if (cur.ms < AB_MS) return;
    if (r.side === 'A') { r.side = 'B'; return; }
    const v = x => (x.xp - x.d * deathCostXp()) / x.ms;
    const winB = v(r.B) > v(r.A);
    if (winB) ad.ab.best[r.k] = r.val;
    ad.ab.last = `${r.k} ${winB ? r.val : ad.ab.best[r.k] ?? KNOBS[r.k].def} (A ${Math.round(v(r.A) * 3.6e6)} / B ${Math.round(v(r.B) * 3.6e6)} xp/h)`;
    ad.ab.run = null; saveAd();
  }

  // Build plan (build.json, injected by run.mjs as window.__botBuild): talents, attributes, bar.
  const BUILD = window.__botBuild;
  const BASE_SKILLS = ['bonebolt', 'blight'];
  // TODO(ceiling): allies carry no owner field: skeletons within 25 m are assumed to be ours.
  const servantCount = () => myAllies().filter(a => a.def?.kind === 'skeleton').length;
  // TODO(ceiling): allies carry no owner field: any ally within 25 m is assumed to be ours.
  const myAllies = () => [...g.entities.allies.values()].map(a => a.view).filter(v => v && !v.dead && dist(v.pos, g.sim) < 25);
  // The flesh golem ally uses the `abomination` monster def (client tints ally abominations, L70353).
  const golemAlive = () => myAllies().some(v => v.def?.kind === 'abomination');
  const skelCap = () => g.level >= 15 ? 6 : g.level >= 8 ? 5 : 4;
  function progress() {
    if (!BUILD || now() - (st.progAt ?? 0) < 3000) return;
    st.progAt = now();
    const ch = g.char.ch, tree = ch.tree ?? {};
    const spent = Object.values(tree).reduce((a, n) => a + n, 0);
    const next = BUILD.talents[spent];
    if (spent < ch.level && next && next.level <= ch.level) { g.actions.learnTalent(next.id); st.lastTalent = next.id; return; }
    if (ch.unspent > 0) {
      const rule = BUILD.attributes.find(r => ch.level >= r.from && ch.level <= r.to) ?? BUILD.attributes.at(-1);
      // Spend toward the split ratio: the attribute furthest below its share gets the point.
      const [a] = Object.entries(rule.split).sort(([a, wa], [b, wb]) => (ch.alloc[a] ?? 0) / wa - (ch.alloc[b] ?? 0) / wb)[0];
      g.actions.allocate(a);
      return;
    }
    const plan = BUILD.bar.filter(b => b.from <= ch.level).at(-1)?.l;
    if (plan) {
      const want = plan.map(id => id && (BASE_SKILLS.includes(id) || tree[id] > 0) ? id : null);
      if (want.some((id, i) => id !== (g.char.bar[i] ?? null))) g.send({ t: 'bar', l: want });
    }
  }

  // Aim point that hits the most monsters within radius r (centroid of the best cluster in range).
  function bestAoe(mobs, range, r) {
    let best = null, bestN = 0;
    for (const { m, d } of mobs) {
      if (d > range) continue;
      const group = mobs.filter(o => dist(o.m.pos, m.pos) <= r);
      if (group.length > bestN) {
        bestN = group.length;
        best = { x: group.reduce((a, o) => a + o.m.pos.x, 0) / group.length, z: group.reduce((a, o) => a + o.m.pos.z, 0) / group.length };
      }
    }
    return best;
  }

  // Monster winding up an attack close enough to reach us: dodge through it with Dislocation.
  function threat(me) {
    for (const m of g.entities.visibleMonsters()) {
      if (m.dead || m.hp <= 0 || m.state !== 'windup') continue;
      if (dist(m.pos, me) < (m.radius ?? 0.6) + 3.5) return m;
    }
    return null;
  }

  // Telegraphed monster attacks (server `tele` events): dodge out of the marked area.
  const teles = [];
  function addTele(e) {
    const src = e.follow ? g.entities.monsters.get(e.id)?.view : null;
    teles.push({ src, x: e.x, z: e.z, sh: e.sh, r: e.r ?? 0, ha: e.ha ?? 0, yaw: e.yaw ?? 0, len: e.len ?? 0, w: e.w ?? 0, until: now() + (e.dur ?? 1) * 1000 });
  }
  // Returns an escape direction if we stand inside an active telegraph, else null.
  // Margin grows while escaping so the boundary does not chatter (in/out each tick gave opposite moves).
  function teleEscape(me) {
    const out = teleScan(me, st.escaping ? 1.7 : 0.7);
    st.escaping = !!out;
    return out;
  }
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
        if (along > -m && along < t.len + m && Math.abs(perp) < t.w / 2 + m) {
          const side = perp >= 0 ? 1 : -1;
          return [fz * side, -fx * side];
        }
      }
    }
    return null;
  }

  // Ground loot: walk onto item drops and pick them up (gold/mats/globes are auto-collected).
  // Everything on the ground is worth taking: items need a pickup message (and bag room),
  // gold/mats/globes/potions/scrolls are auto-collected by walking onto them. Carcasses need gathering: skipped.
  const AUTO_LOOT = new Set(['gold', 'mat', 'globe', 'potion', 'scroll']);
  function lootTarget(me) {
    const bagFullNow = g.char.bag.filter(Boolean).length >= g.char.bag.length;
    let best = null, bd = 14;
    for (const d of g.drops.drops.values()) {
      if (st.lootTried?.has(d.id)) continue;
      if (!(AUTO_LOOT.has(d.kind) || (d.kind === 'item' && !bagFullNow))) continue;
      const dd = dist(d.pos, me);
      if (dd < bd) { bd = dd; best = d; }
    }
    return best;
  }
  // Goal score of a drop: unknown item 0.6, upgrade up to 1.05 by relative gear score gain, else 0.45 (sell value).
  function lootScore(d) {
    if (AUTO_LOOT.has(d?.kind)) return 0.95; // beats dungeon/farm (+inertia) so nothing is left behind
    const it = d?.item;
    if (!it?.slot) return 0.6;
    const w = wornScore(it.slot), gain = (gearScore(it) - w) / Math.max(1e-6, Math.abs(w) || 1);
    return gain > 0.02 ? 0.6 + 0.45 * Math.min(1, gain * 5) : 0.45;
  }
  // Reflex: grab any item drop within 2.5 m, at most once per 2 s per drop, 3 tries.
  function lootInPassing(me) {
    if (g.char.bag.filter(Boolean).length >= g.char.bag.length) return;
    for (const d of g.drops.drops.values()) {
      if (d.kind !== 'item' || dist(d.pos, me) > 2.5) continue;
      const p = (st.passTry ??= new Map()).get(d.id) ?? { n: 0, at: -1e9 };
      if (p.n >= 3 || now() - p.at < 2000) continue;
      st.passTry.set(d.id, { n: p.n + 1, at: now() });
      g.send({ t: 'pickup', id: d.id }); st.loots = (st.loots ?? 0) + 1;
    }
  }
  function loot(drop) {
    const me = g.sim;
    const auto = AUTO_LOOT.has(drop.kind), reach = auto ? 0.5 : 1.2;
    const tries = st.lootSince?.id === drop.id ? st.lootSince : (st.lootSince = { id: drop.id, at: now() });
    if (dist(drop.pos, me) > reach && now() - tries.at < 10000) { st.last = auto ? `ramasse ${drop.kind}` : 'ramasse un objet'; return travelPath({ x: drop.pos.x, z: drop.pos.z }, 'loot'); }
    if (!auto) g.send({ t: 'pickup', id: drop.id });
    (st.lootTried ??= new Set()).add(drop.id);
    st.loots = (st.loots ?? 0) + 1;
    return [0, 0];
  }

  // Gear: equip better items from the bag, keep future upgrades, sell the rest at Bertrand.
  const AFFIX_W = { vit: 2, tgh: 1.7, pow: 1.2, wil: 0.6, prec: 0.6, fer: 0.4, agi: 0.4 };
  const myWeapons = () => Object.keys(SV.gear?.weaponBases ?? {}).filter(k => k !== 'rule').concat(SV.gear ? [] : ['bonewand', 'deathstaff']);
  const reqLvl = it => Math.max(1, Math.min(200, Number.isFinite(it.ilvl) ? (Math.floor(it.ilvl) === 31 ? 30 : Math.floor(it.ilvl)) : 1));
  // Analyst score (dps x sqrt(EHP) of the whole sheet with `it` worn) when skill_values.json has a gear
  // section, else the old per-item affix weights.
  function gearScore(it) {
    if (!it) return 0;
    if (it.slot === 'weapon' && !myWeapons().includes(it.base)) return -1;
    if (SV.gear) { const s = sheet(it); return s.dps * Math.sqrt(s.ehp); }
    const aff = (it.affixes ?? []).reduce((a, f) => a + (AFFIX_W[f.stat] ?? 0.3) * f.value, 0);
    if (it.slot === 'weapon') return ((it.dmgMin + it.dmgMax) / 2) * it.aps * 3 + aff;
    return (it.armor ?? 0) + aff;
  }
  // Score of what we wear in that slot (empty slot: the sheet without it, or 0 with the old score).
  const wornScore = slot => SV.gear ? (g.char.eq?.[slot] ? gearScore(g.char.eq[slot]) : (() => { const s = sheet(); return s.dps * Math.sqrt(s.ehp); })()) : gearScore(g.char.eq?.[slot]);
  const beats = it => it && gearScore(it) > wornScore(it.slot) * 1.02;
  // Future upgrades to keep: best per (slot, required level) among items beating what we wear, then the best 2 per slot.
  function keepers() {
    const best = new Map();
    for (const it of g.char.bag) if (it && beats(it)) {
      const k = `${it.slot}|${reqLvl(it)}`, sc = gearScore(it);
      if (!best.has(k) || sc > best.get(k).sc) best.set(k, { it, sc });
    }
    const bySlot = {};
    for (const x of best.values()) (bySlot[x.it.slot] ??= []).push(x);
    return Object.values(bySlot).flatMap(l => l.sort((a, b) => b.sc - a.sc).slice(0, 2));
  }
  function manageGear() {
    if (now() - (st.gearAt ?? 0) < 4000) return;
    st.gearAt = now();
    const bag = g.char.bag;
    for (let i = 0; i < bag.length; i++) {
      const it = bag[i], key = `${it?.id}:${g.level}`; // retried after each level up
      if (!it || reqLvl(it) > g.level || st.equipTried?.has(key)) continue;
      if (beats(it)) {
        (st.equipTried ??= new Set()).add(key);
        g.actions.equipFromBag(i); st.equips = (st.equips ?? 0) + 1;
        return;
      }
    }
  }
  // At Bertrand: sell gear that is neither a keeper (set aside for later) nor an equippable upgrade, then claim
  // finished hunt contracts. Items without a slot are never sold. The last 10 sales are logged for audit.
  function sellAndClaim() {
    const bag = g.char.bag, keepIds = new Set(keepers().map(x => x.it.id));
    for (let i = 0; i < bag.length; i++) {
      const it = bag[i];
      if (!it?.slot || keepIds.has(it.id) || (reqLvl(it) <= g.level && beats(it))) continue;
      g.actions.sell(i, it.id); st.sold = (st.sold ?? 0) + 1;
      (st.sales ??= []).push({ name: it.name, slot: it.slot, reason: it.slot === 'weapon' && !myWeapons().includes(it.base) ? 'arme hors classe' : 'ni mieux que porté ni réserve' });
      if (st.sales.length > 10) st.sales.shift();
      return true;
    }
    const cs = g.char.contracts ?? [];
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i];
      if (c && !c.claimed && c.have >= c.need && !st.claimTried?.has(i + ':' + c.need)) {
        (st.claimTried ??= new Set()).add(i + ':' + c.need);
        g.send({ t: 'claim', i }); st.claims = (st.claims ?? 0) + 1; return true;
      }
    }
    return false;
  }
  const bagFull = () => g.char.bag.filter(Boolean).length >= g.char.bag.length - 4;
  const contractReady = () => (g.char.contracts ?? []).some(c => c && !c.claimed && c.have >= c.need);

  // Quest following (see QUESTS.md): objective from NPC markers / HUD tracker, dialogue by panel tags.
  // NPCs whose 'give'/'turn' marker led nowhere (profession markers, etc.): npc id -> retry timestamp.
  const QUEST_SKIP = new Map();

  function questObjective(g, zones = []) {
    const story = g.char?.story;
    if (!story) return null;
    const me = { x: g.sim.x, z: g.sim.z };
    const d = p => Math.hypot(p.x - me.x, p.z - me.z);
    // 1. NPC markers, refreshed by the client every 0.4 s (HY L73629, S1 L82608).
    const views = (g.npcs?.views ?? []).filter(v => !(QUEST_SKIP.get(v.def.id) > Date.now()));
    const at = v => ({ x: v.root.position.x, z: v.root.position.z });
    const best = m => views.filter(v => v.marker === m)
      .sort((a, b) => (b.story - a.story) || (d(at(a)) - d(at(b))))[0];
    for (const m of ['turn', 'give']) {
      const v = best(m);
      if (v) return { type: 'talk', npc: v.def.id, ...at(v), label: `${m === 'turn' ? 'Parler/rendre' : 'Prendre'} : ${v.def.name}` };
    }
    // 2. Guided quest (compass, '@main' by default) and its HUD block (Jae L93590).
    const id = document.querySelector('.quest.hud-block .quest-guide.on')?.dataset.guide
      ?? document.querySelector('.quest.hud-block .quest-main')?.dataset.q;
    const block = id && document.querySelector(`.quest.hud-block [data-q="${id}"]`);
    if (!block) return null;
    const title = block.querySelector('.quest-name span')?.textContent ?? id;
    const line = [...block.querySelectorAll('.quest-text')].find(e => !e.classList.contains('qdone') && !e.classList.contains('quest-alt'));
    if (!line) return null;
    const text = line.textContent.trim();
    const lock = text.match(/^Niveau (\d+)/);
    if (lock) return { type: 'other', minLevel: +lock[1], label: `${title} : ${text}` };
    const cnt = line.querySelector('b')?.textContent.match(/(\d+)\/(\d+)/);
    const name = (cnt ? text.slice(0, text.lastIndexOf(cnt[0])) : text).trim();
    const t = g.compass?.target; // {x, z, r}: zone for kill/collect, NPC, dungeon entrance...
    const base = { label: `${title} : ${text}`, ...(t ? { x: t.x, z: t.z, r: t.r } : {}) };
    if (t) {
      const zone = zones.find(z => Math.hypot(z.x - t.x, z.z - t.z) < Math.max(z.r, t.r));
      if (zone) base.minLevel = zone.lvl[0];
    }
    if (/^Tuer : /.test(name)) return { type: 'kill', kind: name.slice(7), need: cnt ? +cnt[2] : 1, have: cnt ? +cnt[1] : 0, ...base };
    if (/^Abattre /.test(name)) return { type: 'kill', kind: name.slice(8), need: 1, have: 0, ...base };
    if (/^Parler à /.test(name)) return { type: 'talk', ...base };
    if (/^Explorer /.test(name)) return { type: 'explore', ...base };
    if (/^Terminer : /.test(name)) return { type: 'dungeon', ...base };
    if (/^(Préparer|Forger|Un objet|Choisir|Tenir|Refermer|Repousser|Réussir)|points dépensés|Parlez à|Retournez/.test(name)) return { type: 'other', ...base };
    return { type: 'collect', kind: name, need: cnt ? +cnt[2] : 1, have: cnt ? +cnt[1] : 0, ...base };
  }

  // Returns the `say` index (an entry of dlgMsg.c) to send, or null to send talkEnd.
  // Call it one tick after the `dlg` event so the dialogue panel (Ise L99773) is rendered.
  const dlgSeen = new Set();
  function dialogueStep(g, m) {
    if (!m?.n) { dlgSeen.clear(); return null; }
    const key = `${m.n}|${m.at}`;
    if (dlgSeen.has(key)) return null; // already answered this node: avoid loops
    dlgSeen.add(key);
    const btns = [...document.querySelectorAll('.panel-dialogue .dlg-choice')];
    if (btns.length !== m.c.length) return null;
    const tag = k => btns.findIndex(b => b.querySelector(`.dlg-tag.tag-${k}`));
    let i = tag('turn');
    if (i < 0) i = tag('give');
    // Outside the hub, the server picked a quest node (talk step): follow the first real reply.
    if (i < 0 && m.at !== 'hub') i = btns.findIndex(b => !b.classList.contains('bye') && !b.querySelector('.tag-trade'));
    return i < 0 ? null : m.c[i];
  }

  // Talk objective: walk to the NPC, open the dialogue, answer nodes until it closes.
  function questTalk(obj) {
    const me = g.sim, npc = { x: obj.x, z: obj.z };
    if (dist(me, npc) > 3.2) { st.last = `quête : va voir ${obj.npc}`; return travel(npc, 'quest'); }
    const t = now();
    if (!st.talk || st.talk.npc !== obj.npc) {
      dlgSeen.clear();
      st.talk = { npc: obj.npc, at: t, questAt: st.questEventAt ?? 0 };
      g.send({ t: 'talk', n: obj.npc });
    } else if (st.dlg && t - st.dlg.at > 200) {
      const m = st.dlg.m; st.dlg = null;
      const c = dialogueStep(g, m);
      if (c != null) g.send({ t: 'say', at: m.at, i: c });
      else endTalk();
    } else if (t - st.talk.at > 12000) endTalk();
    st.last = `quête : parle à ${obj.npc}`;
    return [0, 0];
  }
  function endTalk() {
    if (!st.talk) return;
    g.send({ t: 'talkEnd' });
    // Nothing quest-related happened during this talk: ignore that NPC's marker for 5 min.
    if ((st.questEventAt ?? 0) <= st.talk.questAt) QUEST_SKIP.set(st.talk.npc, Date.now() + 5 * 60000);
    else ad.qx.talk = ema(ad.qx.talk, now() - st.talk.at, ad.qx.tn++);
    st.talk = null; dlgSeen.clear();
  }
  function questStep() {
    if (now() - (st.questAt ?? 0) > 2000) { st.questAt = now(); try { st.quest = questObjective(g, ZONES); } catch { st.quest = null; } }
    // Seconds per objective unit, timed only while farming the arm that holds the objective.
    const q = st.quest, p = st.qProg;
    if (isFarmQuest(q) && q.kind) {
      if (!p || p.kind !== q.kind || q.have < p.have) st.qProg = { kind: q.kind, have: q.have, ms: 0 };
      else if (q.have > p.have) {
        if (p.ms > 500) { const v = p.ms / 1000 / (q.have - p.have), r = ad.qx.rate[q.kind] ??= { v, n: 0 }; r.v = ema(r.v, v, r.n++); }
        p.have = q.have; p.ms = 0;
      }
    }
    return st.quest;
  }

  // Dungeon run (quest step "Terminer : <dungeon>"): door, rooms in order, boss, chest, leave.
  const DUN_MAX_MS = 12 * 60000;
  // Dungeon run for the picked dungeon arm (farming or a "Terminer : X" quest): door, rooms in order, boss, chest, leave.
  // No server cooldown exists in the client; a bailed run blocks that dungeon for 30 min.
  const DUN_SKIP = new Map(); // dungeon id -> retry timestamp after a bailed run
  function dungeonRun() {
    const me = g.sim, t = now(), dg = g.dungeon, door = dg ? null : armDoor();
    const id = dg?.def.id ?? door?.d.id ?? (st.dun?.phase === 'sortie' ? st.dun.id : null);
    if (!id) { if (st.dun) st.dun.phase = 'fini'; return [0, 0]; }
    if (!st.dun || st.dun.id !== id || st.dun.phase === 'fini') st.dun = { id, name: dg?.def.name ?? door?.d.name, phase: 'porte', at: t, deaths: 0, room: 1 };
    const r = st.dun;
    if (r.phase !== 'sortie' && (t - r.at > DUN_MAX_MS || r.deaths >= 2)) { r.phase = 'sortie'; r.bail = true; }
    if (!dg) {
      // Outside: either the run is over, or we walk to the door (again, after a death) and enter.
      if (r.phase === 'sortie') {
        r.phase = 'fini'; zoneStat('donjon : ' + r.name).runs = (zoneStat('donjon : ' + r.name).runs ?? 0) + 1;
        // A finished instance stays cleared server side for a while: wait before rerunning it. Entering and finding it
        // already cleared (boss dead + chest opened within seconds) doubles that dungeon's learned reset delay.
        const cds = ad.dunCd ??= {};
        if (r.instantClear) cds[id] = Math.min(240, (cds[id] ?? 20) * 2);
        DUN_SKIP.set(id, Date.now() + (r.bail ? 30 : (cds[id] ?? 20)) * 60000); saveAd();
        st.zonePick = null; // let the UCB weigh this run before the next one
        return [0, 0];
      }
      r.phase = 'porte';
      st.last = `donjon : va à la porte ${door.d.name}`;
      if (dist(me, door.at) > 4) return travel({ x: door.at.x, z: door.at.z }, 'dungeon');
      if (t - (st.dunSendAt ?? 0) > 3000) { st.dunSendAt = t; g.send({ t: 'dungeon', a: 'enter', d: id }); }
      return [0, 0];
    }
    const L = dg.layout, ds = g.dstate;
    r.inAt ??= t;
    if (r.phase !== 'sortie') {
      r.phase = !ds.boss ? 'exploration' : !ds.opened ? 'coffre' : 'sortie';
      if (r.phase === 'sortie' && t - r.inAt < 10000) r.instantClear = true;
    }
    if (r.phase === 'exploration') {
      // Visit rooms along the generated order (0 is the spawn, the last one is the boss room).
      while (r.room < L.rooms.length - 1 && dist(me, { x: L.rooms[r.room].cx, z: L.rooms[r.room].cz }) < 5) r.room++;
      const room = L.rooms[r.room], goal = r.room < L.rooms.length - 1 ? { x: room.cx, z: room.cz } : L.boss;
      st.last = `donjon : salle ${r.room}/${L.rooms.length - 1}`;
      return travel(goal, 'dungeon');
    }
    if (r.phase === 'coffre') {
      st.last = 'donjon : ouvre le coffre';
      if (dist(me, L.chest) > 3.5) return travel(L.chest, 'dungeon');
      if (t - (st.dunSendAt ?? 0) > 2000) { st.dunSendAt = t; g.send({ t: 'dungeon', a: 'chest' }); }
      return [0, 0];
    }
    // Leave works anywhere out of combat, or at the exit/portal even in combat.
    const out = ds.boss ? L.portal : L.exit;
    st.last = `donjon : sortie${r.bail ? ' (abandon)' : ''}`;
    if ((dist(me, out) < 3.5 || (g.sim.outOfCombat ?? 0) >= 3) && t - (st.dunSendAt ?? 0) > 3000) { st.dunSendAt = t; g.send({ t: 'dungeon', a: 'leave' }); }
    return dist(me, out) > 3 ? travel(out, 'dungeon') : [0, 0];
  }

  // Potion restock at Bertrand (village weapon merchant, shop panel sells potions).
  const BERTRAND = { x: 8.4, z: 64.6 }, POTION_TARGET = 10;
  const potionPrice = () => 15 + g.level * 5;
  const lowPotions = () => g.char.potions < 3 && g.char.gold >= potionPrice() * 4;
  function wantsShop() {
    return (bagFull() || contractReady() || lowPotions()) && dist(g.sim, BERTRAND) < 200;
  }
  // Open a merchant through its dialogue, as the client does: `talk`, then `say` the choice tagged 'trade'
  // (`do: { open: 'shop' | 'vendor' }`, L98219 / L99163). The server answers `shop` (Bertrand) or `vendor` (Hilde).
  function openMerchant(npc) {
    const t = now();
    if (!st.shopTalk) { st.shopTalk = t; st.dlg = null; g.send({ t: 'talk', n: npc }); return; }
    if (st.dlg && t - st.dlg.at > 200) {
      const m = st.dlg.m; st.dlg = null;
      const btns = [...document.querySelectorAll('.panel-dialogue .dlg-choice')];
      const i = btns.findIndex(b => b.querySelector('.dlg-tag.tag-trade'));
      if (i >= 0 && m?.c?.[i] != null) g.send({ t: 'say', at: m.at, i: m.c[i] });
    } else if (t - st.shopTalk > 5000) st.shopOpen = true; // no answer: go on, buyPotion does not need the panel
  }
  // Single best purchase for one slot per visit: it must beat what we wear and every usable item of that slot in the bag,
  // keeping gold for 10 potions. cands: [{ it, price, i }].
  function bestBuy(cands) {
    const keepGold = potionPrice() * POTION_TARGET, done = st.boughtSlots ??= new Set();
    let best = null, bg = 0;
    for (const c of cands) {
      const it = c.it;
      if (!it?.slot || done.has(it.slot) || st.buyTried?.has(it.id) || reqLvl(it) > g.level || g.char.gold - c.price < keepGold) continue;
      const bar = Math.max(wornScore(it.slot) * 1.02, ...g.char.bag.filter(b => b?.slot === it.slot && reqLvl(b) <= g.level).map(gearScore));
      const gain = gearScore(it) - bar;
      if (gain > bg) { bg = gain; best = c; }
    }
    if (best) { done.add(best.it.slot); (st.buyTried ??= new Set()).add(best.it.id); st.bought = (st.bought ?? 0) + 1; }
    return best;
  }
  function buyGear() {
    const c = bestBuy((g.char.shop ?? []).map((it, i) => ({ it, price: (it?.value ?? 0) * 4, i })));
    if (c) g.actions.buy(c.i);
    return !!c;
  }
  // Hilde (armures & cuirs, L32113) at Cendre: visited once per stock period (6 h, T1 L82831) when her waystone is awake.
  const HILDE = { x: 121.6, z: -5.4 }, VENDOR_PERIOD = 216e5;
  const hildeWanted = () => g.char.ways?.includes('cendre') && Date.now() - (ad.vendorAt?.hilde ?? 0) > VENDOR_PERIOD
    && g.char.gold > potionPrice() * POTION_TARGET;
  function hildeVisit() {
    if (dist(g.sim, HILDE) > 3) { st.last = 'va chez Hilde (armures)'; st.shopTalk = 0; st.vendorOk = false; return travel(HILDE, 'shop'); }
    st.last = 'Hilde : achète une armure';
    if (now() - (st.buyAt ?? 0) < 600) return [0, 0];
    st.buyAt = now();
    const v = st.vendorOk ? g.vendor : null; // only a stock the server sent during this visit
    if (v?.v !== 'hilde') { openMerchant('hilde'); if (!st.shopOpen) return [0, 0]; }
    const c = v?.v === 'hilde' && bestBuy(v.l.map((e, i) => ({ it: e.k === 'item' ? e.item : null, price: e.price, i, e }))
      .filter(x => x.it && !(x.e.limit && (v.b[x.i] ?? 0) >= x.e.limit)));
    if (c) { g.send({ t: 'vbuy', v: v.v, p: v.p, i: c.i, h: c.e.h }); return [0, 0]; }
    (ad.vendorAt ??= {}).hilde = Date.now(); saveAd();
    st.hilde = false; st.shopDone = true; st.shopOpen = false; st.boughtSlots = null;
    if (st.shopTalk) { g.send({ t: 'talkEnd' }); st.shopTalk = 0; }
    return [0, 0];
  }
  function shop() {
    const me = g.sim;
    if (st.hilde) return hildeVisit();
    if (dist(me, BERTRAND) > 3) { st.last = 'va à la boutique'; st.shopOpen = false; st.shopTalk = 0; return travel(BERTRAND, 'shop'); }
    if (now() - (st.buyAt ?? 0) > 600) {
      st.buyAt = now();
      st.buyTries = (st.buyTries ?? 0) + 1;
      if (sellAndClaim()) { st.buyTries--; }
      else if (!st.shopOpen) { st.buyTries--; openMerchant('bertrand'); }
      else if (buyGear()) { st.buyTries--; }
      else if (g.char.potions >= POTION_TARGET || g.char.gold < potionPrice() || st.buyTries > 14) {
        st.buyTries = 0; st.shopOpen = false; st.boughtSlots = null;
        if (st.shopTalk) { g.send({ t: 'talkEnd' }); st.shopTalk = 0; }
        if (hildeWanted()) st.hilde = true; else st.shopDone = true;
      }
      else g.send({ t: 'buyPotion' });
    }
    st.last = 'boutique : vend, achète';
    return [0, 0];
  }

  // Pick a free direction close to the wanted one by sampling around it.
  function steer(dx, dz) {
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) return [0, 0];
    dx /= len; dz /= len;
    const { x, z } = g.sim;
    for (const off of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2, 1.6, -1.6, 2.2, -2.2, Math.PI]) {
      const c = Math.cos(off), s = Math.sin(off);
      const rx = dx * c - dz * s, rz = dx * s + dz * c;
      if (!solid(x + rx * 1.5, z + rz * 1.5) && !solid(x + rx * 3, z + rz * 3)) return [rx, rz];
    }
    return [dx, dz];
  }

  // A* on a 1 m grid sampled with solidAt. Returns waypoints (simplified) or null.
  // TODO(ceiling): bounded to MAX_NODES expansions, long trips fail: cache a coarse village/zone graph if needed.
  const MAX_NODES = 60000;
  function findPath(from, to) {
    const sx = Math.round(from.x), sz = Math.round(from.z), tx = Math.round(to.x), tz = Math.round(to.z);
    const key = (x, z) => x * 100003 + z;
    const h = (x, z) => Math.hypot(x - tx, z - tz);
    // Active danger spots are walls, except the ones holding the start or the goal.
    const t = Date.now(), spots = ad.spots.filter(s => t < s.until && dist(s, from) > s.r && dist(s, to) > s.r);
    const open = [[h(sx, sz), 0, sx, sz]], came = new Map([[key(sx, sz), null]]), cost = new Map([[key(sx, sz), 0]]);
    let n = 0;
    while (open.length && n++ < MAX_NODES) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
      const [, c, x, z] = open[bi]; open[bi] = open[open.length - 1]; open.pop();
      if (c > cost.get(key(x, z))) continue;
      if (Math.abs(x - tx) <= 1 && Math.abs(z - tz) <= 1) {
        const pts = []; let k = key(x, z), p = [x, z];
        while (p) { pts.push({ x: p[0], z: p[1] }); p = came.get(k); k = p && key(p[0], p[1]); }
        pts.reverse();
        return pts.filter((_, i) => i % 3 === 0 || i === pts.length - 1);
      }
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
        const nx = x + dx, nz = z + dz, nk = key(nx, nz);
        if (solid(nx, nz) || spots.some(s => Math.hypot(nx - s.x, nz - s.z) < s.r)) continue;
        if (dx && dz && (solid(x + dx, z) || solid(x, z + dz))) continue;
        const nc = c + (dx && dz ? 1.414 : 1);
        if (nc < (cost.get(nk) ?? Infinity)) { cost.set(nk, nc); came.set(nk, [x, z]); open.push([nc + h(nx, nz), nc, nx, nz]); }
      }
    }
    return null;
  }

  // Waystones (client table `Sd`): awakened by walking past, travel between awakened ones out of combat,
  // bind one to respawn there.
  const WAYS = [
    { id: 'valbrune', x: 11, z: 55 }, { id: 'hurlements', x: -36, z: 15 }, { id: 'gobelins', x: -64, z: -24 },
    { id: 'cimetiere', x: 38, z: 19 }, { id: 'sombrebois', x: 47, z: -30 }, { id: 'grukk', x: 8, z: -70 },
    { id: 'brumelande', x: -124, z: 44 }, { id: 'cendre', x: 128, z: -9 }, { id: 'necropole', x: 30, z: -133 },
    { id: 'rochenoire', x: -94, z: -88 }, { id: 'forteresse', x: 157, z: -62 }, { id: 'citadelle', x: -27, z: -178 },
    { id: 'moisivert', x: -104, z: 128 }, { id: 'givrecroc', x: 6, z: 142 }, { id: 'faille', x: 132, z: 126 },
  ];
  const awake = () => WAYS.filter(w => g.char.ways?.includes(w.id));
  const nearestWay = (p, list) => list.reduce((b, w) => !b || dist(w, p) < dist(b, p) ? w : b, null);
  // Teleport overhead in walking meters (3 s out of combat + loading).
  // TODO(ceiling): straight-line distances, not A* lengths: walls and rivers make real walks longer.
  // Teleport overhead in meters, learned: grows when a stone trip gets interrupted, shrinks on clean trips.
  const wayCost = () => (ad.wayCost ??= 25);
  // Cheapest (src, dst) stone pair for me -> goal, or null when walking straight there is cheaper.
  function wayRoute(me, goal, list) {
    let best = null, bestCost = dist(me, goal);
    for (const src of list) for (const dst of list) {
      if (src === dst) continue;
      const c = dist(me, src) + wayCost() + dist(dst, goal);
      if (c < bestCost) { bestCost = c; best = { src, dst }; }
    }
    return best;
  }
  (() => {
    const a = { id: 'a', x: 0, z: 0 }, b = { id: 'b', x: 300, z: 0 }, me = { x: 2, z: 0 };
    const far = wayRoute(me, { x: 305, z: 0 }, [a, b]), near = wayRoute(me, { x: 30, z: 0 }, [a, b]);
    if (far?.src !== a || far?.dst !== b || near) console.warn('bot: wayRoute self-check failed', far, near);
  })();
  // Trip shortcut: returns a move toward the departure stone, [0,0] while teleporting, or null to walk.
  const tripLen = (me, goal) => { const r = wayRoute(me, goal, awake()); return r ? dist(me, r.src) + wayCost() + dist(r.dst, goal) : dist(me, goal); };
  // Route choice is made once per trip and only when calm, with hysteresis (stones must save >= 30%);
  // walking is committed too, so release/re-aggro no longer flips walk <-> stone. Chasers on the way are
  // fought by the fight goal (killing them near the stone is fine), we never stand waiting at a stone in combat.
  function wayShortcut(goal, key) {
    if (g.dungeon || st.retreat) return null;
    const me = g.sim, plans = st.wayPlans ??= {};
    const calm = (g.sim.outOfCombat ?? 0) >= 3 && ![...g.entities.visibleMonsters()].some(m => !m.dead && m.hp > 0 && converging(m, dist(m.pos, g.sim)));
    let plan = plans[key];
    if (plan && (dist(plan.goal, goal) > 2 || (!plan.route && now() - plan.at > 60000))) plan = plans[key] = null;
    if (!plan) {
      if (!calm) return null;
      const route = wayRoute(me, goal, awake());
      const ok = route && dist(me, route.src) + wayCost() + dist(route.dst, goal) < 0.7 * dist(me, goal);
      plan = plans[key] = { goal: { x: goal.x, z: goal.z }, route: ok ? route : null, at: now() };
    }
    if (!plan.route) return null;
    const { src, dst } = plan.route;
    if (dist(me, src) > 2.5) return travelPath({ x: src.x, z: src.z }, 'way:' + key);
    if (!calm) { st.last = 'nettoie la pierre'; plan.interrupted = true; st.anchor = { x: src.x, z: src.z, at: now() }; return null; }
    if (now() - (st.wayAt ?? 0) > 5000) {
      st.wayAt = now(); st.navs = {}; st.wayPlans = {}; st.wayTrips = (st.wayTrips ?? 0) + 1;
      ad.wayCost = plan.interrupted ? Math.min(150, wayCost() + 10) : Math.max(15, wayCost() * 0.95); saveAd();
      g.send({ t: 'travel', w: dst.id });
    }
    st.last = `pierre de passage : ${src.id} -> ${dst.id}`;
    return [0, 0];
  }
  // Bind to the awakened stone closest to the farm zone when we walk past it.
  function maybeBind() {
    if (!st.home || now() - (st.bindAt ?? 0) < 10000) return;
    const w = nearestWay(st.home, awake());
    if (w && g.char.bound !== w.id && dist(g.sim, w) < 3) { st.bindAt = now(); g.send({ t: 'bind', w: w.id }); st.binds = (st.binds ?? 0) + 1; }
  }

  // Follow a path to goal, taking a waystone for long trips.
  function travel(goal, key = 'goal') {
    return wayShortcut(goal, key) ?? travelPath(goal, key);
  }
  // Follow a path to goal; recompute when goal changes or no progress for 2 s.
  // One path cache per caller (key), so alternating callers never recompute each other's path.
  function travelPath(goal, key = 'goal') {
    const me = g.sim, navs = st.navs ??= {};
    const nav = navs[key];
    if (!nav || dist(nav.goal, goal) > 2 || now() - nav.progressAt > 2000) {
      const pts = findPath(me, goal);
      navs[key] = { goal, pts: pts ?? [goal], i: 0, progressAt: now(), best: Infinity, failed: !pts };
    }
    const p = navs[key];
    while (p.i < p.pts.length - 1 && dist(me, p.pts[p.i]) < 1.5) p.i++;
    const wp = p.pts[p.i], d = dist(me, wp);
    if (d < p.best - 0.3 || p.i > (p.lastI ?? -1)) { p.best = d; p.lastI = p.i; p.progressAt = now(); }
    return p.failed ? steer(wp.x - me.x, wp.z - me.z) : [(wp.x - me.x) / (d || 1), (wp.z - me.z) / (d || 1)];
  }

  function corpsesNear(p, r) {
    let n = 0, best = null, bd = Infinity;
    for (const c of g.entities.corpses?.list?.values?.() ?? []) {
      if (c.gone) continue;
      const pos = c.group?.position;
      if (!pos) continue;
      const d = dist(pos, p);
      if (d < r) { n++; if (d < bd) { bd = d; best = pos; } }
    }
    return { n, best };
  }

  // Goal layer: re-scored every 0.5 s with inertia and minimum durations (hysteresis),
  // executed every tick. Reflexes (telegraph dodge, potion, danger retreat) bypass it.
  const GOAL_MIN_MS = { fight: 1500, shop: 60000, talk: 30000, loot: 6000, dungeon: 2000, explore: 2000, farm: 2000 };
  const INERTIA = 0.25;
  function chooseGoal(c) {
    const t = now(), cur = st.goal;
    // Being attacked preempts any other goal at once (no min duration, no scoring throttle).
    if (c.attacked && c.target && cur !== 'fight') {
      if (cur === 'talk') endTalk();
      st.goal = 'fight'; st.goalAt = t; st.scoreAt = t; st.goals = (st.goals ?? 0) + 1;
      return 'fight';
    }
    if (cur && t - st.goalAt < (GOAL_MIN_MS[cur] ?? 1000) && !goalDone(cur, c)) return cur;
    if (t - (st.scoreAt ?? 0) < 500 && cur && !goalDone(cur, c)) return cur;
    st.scoreAt = t;
    const score = {
      fight: c.attacked ? 1.5 : c.target ? (c.target.d < 14 ? 1.0 : 0.55) : 0,
      // Out of potions with gold: restocking beats farming a target (only being attacked is higher).
      shop: st.shopDone === false && wantsShop() ? (g.char.potions <= 1 && g.char.gold >= potionPrice() * 4 ? 1.2 : 0.8) : 0,
      talk: talkScore(c.quest),
      loot: c.drop ? lootScore(c.drop) : 0,
      dungeon: g.dungeon || armDoor() ? 0.65 : 0,
      explore: c.quest?.type === 'explore' && c.quest.x != null && (c.quest.minLevel ?? 1) <= g.level ? 0.6 : 0,
      farm: 0.2,
    };
    if (cur && !goalDone(cur, c)) score[cur] += INERTIA;
    st.scores = score;
    const best = Object.entries(score).sort((x, y) => y[1] - x[1])[0][0];
    if (best !== cur) {
      if (cur === 'talk') endTalk();
      st.goal = best; st.goalAt = t; st.goals = (st.goals ?? 0) + 1;
    }
    return best;
  }
  // Talk value: learned quest reward over trip (waystone aware) plus talk time, plus a whole quest for a new one,
  // as a goal score relative to farming (0.2 at our measured xp/s), kept below fighting a near target.
  function talkScore(q) {
    if (!(q?.type === 'talk' && q.npc && q.x != null) || dist(g.sim, q) >= 250) return 0;
    const sec = tripLen(g.sim, q) / PLAYER_SPEED + ad.qx.talk / 1000 + (/^Prendre/.test(q.label) ? ad.qx.dur / 1000 : 0);
    return Math.min(0.9, 0.2 * questReward() / sec / Math.max(1e-6, xpps()));
  }
  function goalDone(goal, c) {
    if (goal === 'fight') return !c.target;
    if (goal === 'shop') return st.shopDone !== false;
    if (goal === 'talk') return !(c.quest?.type === 'talk' && c.quest.npc);
    if (goal === 'loot') return !c.drop;
    if (goal === 'dungeon') return !g.dungeon && !armDoor();
    if (goal === 'explore') return c.quest?.type !== 'explore';
    return false;
  }

  // Stuck detection: no progress for 3 s while trying to move -> sidestep 0.7 s and force a repath.
  function unstick(move) {
    const t = now(), me = g.sim;
    const moving = Math.hypot(move[0], move[1]) > 0.1;
    if (!st.stuckRef || !moving) st.stuckRef = { x: me.x, z: me.z, at: t };
    else if (dist(me, st.stuckRef) > 1.5) st.stuckRef = { x: me.x, z: me.z, at: t };
    else if (t - st.stuckRef.at > 3000) {
      const side = Math.random() < 0.5 ? 1 : -1;
      st.sidestep = { until: t + 700, dir: [-move[1] * side, move[0] * side] };
      st.navs = {}; st.wayPlans = {}; st.stuckRef = { x: me.x, z: me.z, at: t }; st.unsticks = (st.unsticks ?? 0) + 1;
    }
    if (st.sidestep && t < st.sidestep.until) return st.sidestep.dir;
    return move;
  }

  // One decision per sim tick: returns movement, aim point and bar slots to hold.
  function decide() {
    const d = decideRaw();
    d.move = unstick(d.move);
    return d;
  }
  // Loot income per arm: gold gained plus the sale value of items seen for the first time (shop trips excluded).
  function trackLoot(zs) {
    const gold = g.char.gold ?? 0, gd = gold - (st.goldPrev ?? gold), counted = st.goal !== 'shop';
    st.goldPrev = gold;
    let loot = gd > 0 && counted ? gd : 0;
    const fresh = !st.seenIds;
    st.seenIds ??= new Set();
    for (const it of [...g.char.bag, ...Object.values(g.char.eq ?? {})]) if (it && !st.seenIds.has(it.id)) {
      st.seenIds.add(it.id);
      if (!fresh && counted) loot += it.value ?? 0;
    }
    if (loot) { zs.gold = (zs.gold ?? 0) + loot; ad.tot.gold = (ad.tot.gold ?? 0) + loot; }
  }
  // Delayed learning samples: quest reward xp (largest xp event right after a 'done') and xp lost on death.
  function trackLearn() {
    if (st.qDone && now() - st.qDone.at > 1500) {
      if (st.qDone.xp > 0) ad.qx.frac = ema(ad.qx.frac, st.qDone.xp / lvlXp(st.qDone.lvl), ad.qx.n++);
      st.qDone = null;
    }
    const p = st.deathPend;
    if (p && p.lost == null) p.lost = g.level === p.lvl ? Math.max(0, p.xp - g.char.ch.xp) : 0;
    st.lastXp = g.char.ch.xp; st.lastLvl = g.level;
  }
  function decideRaw() {
    const me = g.sim, hpPct = g.hp / g.life;
    if (g.dungeon) { st.home = { x: me.x, z: me.z }; st.zone = 'donjon : ' + g.dungeon.def.name; LEASH = 30; }
    else if (!st.pinned) {
      // The quest area narrows the home only when the arm holding it won the UCB (value, deaths included).
      const z = pickZone(), q = st.quest;
      st.zone = z.name; st.questArm = holdsQuest(z, q);
      if (st.questArm && !z.dun) { st.home = { x: q.x, z: q.z }; LEASH = Math.max(15, q.r ?? 25); }
      else { st.home = { x: z.x, z: z.z }; LEASH = z.r; }
    }
    else if (!st.home) st.home = { x: me.x, z: me.z };
    const mobs = monsters().map(m => ({ m, d: dist(m.pos, me) })).sort((a, b) => a.d - b.d);
    const tick = now(), zs = zoneStat(st.zone ?? 'fixe'), dt = Math.min(200, tick - (st.tickAt ?? tick));
    zs.ms += dt; ad.tot.ms += dt; st.tickAt = tick;
    if (st.questArm && st.qProg) st.qProg.ms += dt;
    trackLoot(zs);
    trackLearn();
    account(dt, mobs);
    abTick(dt);
    if (tick - (st.saveAt ?? 0) > 30000) { st.saveAt = tick; relax(); saveAd(); }
    // hp trend over the last ~2 s, for ossature
    if (tick - (st.hpAt ?? 0) > 2000) { st.hpDrop = hpPct < (st.hpPrev ?? hpPct) - 0.03; st.hpPrev = hpPct; st.hpAt = tick; }
    let move = [0, 0], aim = null, slots = [], roll = false;

    // --- reflexes
    // Local cooldown guard: g.potionCd only updates after the server answers.
    if (hpPct < potionAt() && !(g.potionCd > 0) && g.char.potions > 0 && tick - (st.potAt ?? -1e9) > SV.potion.cdSec * 1000) { st.potAt = tick; g.actions.usePotion(); }
    progress();
    lootInPassing(me);
    st.reflex = null;
    const esc = teleEscape(me);
    if (esc) {
      st.reflex = 'esquive attaque annoncée';
      roll = ready('roll') && now() - (st.rollAt ?? 0) > 4600;
      if (roll) { st.rollAt = now(); st.teleDodges = (st.teleDodges ?? 0) + 1; }
      st.last = 'esquive une attaque annoncée';
      return { move: steer(...esc), aim: null, slots: [], roll };
    }
    const ret = retreatTick(me);
    if (ret) {
      const t = threat(me);
      roll = !!t && ready('roll') && now() - (st.rollAt ?? 0) > 4600;
      if (roll) st.rollAt = now();
      return { move: ret, aim: null, slots: [], roll };
    }

    // --- goal selection
    if ((bagFull() || contractReady() || lowPotions()) && !st.shopping) { st.shopDone = false; st.shopping = true; }
    if (st.shopDone) st.shopping = false;
    manageGear();
    maybeBind();
    const attackers = mobs.filter(engagedOnUs);
    const attacked = attackers.some(o => o.d < 7);
    if (tick - (st.planAt ?? -1e9) > 500) { st.planAt = tick; st.plan = planPull(mobs); }
    const plan = st.plan;
    const eng = mobs.filter(o => engagedOnUs(o) || (plan.ids.has(o.m.id) && o.d < 15));
    if (tick - (st.stratAt ?? -1e9) > 500) { st.stratAt = tick; st.strat = chooseStrat(eng); }
    const kite = st.strat === 'kite';
    // Allowed targets: what is on us (or within 6 m) plus the planned pull, ranked by Smith's rule.
    // Anchored fight (attacked at a dungeon door or a waystone): only attackers, no pull, so nothing else gets pulled.
    const anchor = st.anchor && now() - st.anchor.at < 1500 ? st.anchor : null;
    const ranked = mobs.filter(o => anchor ? engagedOnUs(o) || o.d < 4 : engagedOnUs(o) || o.d < 6 || plan.ids.has(o.m.id))
      .map(o => ({ ...o, s: smith(o, kite) })).sort((a, b) => b.s - a.s);
    st.top = ranked.slice(0, 3).map(o => `${o.m.def?.kind}${o.m.level} ${o.s.toFixed(2)}`);
    const tgtO = ranked[0];
    const quest = questStep();
    const drop = lootTarget(me);
    const goal = chooseGoal({ attacked, target: tgtO, quest, drop });
    const target = tgtO?.m;
    st.tgtPos = target?.pos ?? null;
    st.target = target ? `${target.def?.kind} niv${target.level} ${Math.round(tgtO.d)}m${target.elite ? ' élite' : ''}` : null;
    fightTrack(goal === 'fight' && (attackers.length > 0 || (tgtO?.d ?? 99) < 14), hpPct, attackers);

    if (goal === 'shop') return { move: shop(), aim: null, slots: [] };
    if (goal === 'talk') return { move: questTalk(quest), aim: null, slots: [], roll: false };
    if (goal === 'loot') return { move: loot(drop), aim: null, slots: [], roll: false };
    // The door refuses entry in combat ("Impossible d'entrer en plein combat"): clear the attackers first.
    const doorFight = goal === 'dungeon' && !g.dungeon && (g.sim.outOfCombat ?? 0) < 3 && target && (tgtO?.d ?? 99) < 18;
    if (doorFight) { const dr = armDoor(); if (dr) st.anchor = { x: dr.at.x, z: dr.at.z, at: now() }; }
    if (goal === 'dungeon' && !doorFight) return { move: dungeonRun(), aim: null, slots: [], roll: false };
    if (goal === 'explore') { st.last = `quête : explore ${quest.label}`; return { move: travel(quest, 'quest'), aim: null, slots: [], roll: false }; }

    if ((goal === 'fight' || doorFight) && target) {
      const d = tgtO.d;
      aim = { x: target.pos.x, z: target.pos.z };
      const army = myAllies();
      if (hpPct < fleeAt()) { const c = centroid(attackers.length ? attackers : [tgtO]); move = steer(me.x - c.x, me.z - c.z); st.last = 'fuit (PV bas)'; }
      else if (attackers.length && kite) { move = kiteMove(me, eng); st.last = `kite ${target.def?.kind ?? '?'} ${d.toFixed(1)}m`; }
      else if (attackers.length) { move = holdMove(me, eng, army); st.last = `tient derrière l'armée ${target.def?.kind ?? '?'} ${d.toFixed(1)}m`; }
      else if (d > KITE_MAX) { move = travelPath({ x: target.pos.x, z: target.pos.z }, 'fight'); st.last = `tire ${plan.k} groupe(s) ${target.def?.kind ?? '?'} ${d.toFixed(1)}m`; }
      else st.last = `combat ${target.def?.kind ?? '?'} ${d.toFixed(1)}m`;

      // Targets for skills: the chosen target first in the list so ties aim at it.
      const pick = chooseSkill({ mobs: [tgtO, ...ranked.filter(o => o !== tgtO)], me, attackers, hpPct, hpDrop: st.hpDrop, ess: g.sim.fury ?? 0 });
      st.skill = pick ? `${pick.id} ${pick.ev.toFixed(1)}` : null;
      if (pick && pick.slot >= 0) {
        slots.push(pick.slot);
        if (pick.aim) aim = { x: pick.aim.x, z: pick.aim.z };
        if (pick.id === 'fleshgolem') st.golemAt = now();
      }
      const t = threat(me);
      if (t && ready('roll') && now() - (st.rollAt ?? 0) > 4600) {
        st.rollAt = now();
        roll = true;
        move = steer(me.x - t.pos.x, me.z - t.pos.z);
      }
      if (!slots.length && d < 13) slots.push(0);
    } else {
      // Farm: head for the nearest monster of the planned pull, otherwise wander across the zone.
      const lure = mobs.find(o => plan.ids.has(o.m.id))?.m;
      if (lure && dist(me, st.home) <= LEASH + 8) {
        st.last = 'va chercher des ennemis';
        return { move: travelPath({ x: lure.pos.x, z: lure.pos.z }, 'lure'), aim: null, slots: [], roll: false };
      }
      const bindW = nearestWay(st.home, awake());
      if (bindW && g.char.bound !== bindW.id && dist(me, bindW) < 40 && now() - (st.bindAt ?? 0) > 10000) {
        st.last = `va se lier à ${bindW.id}`;
        return { move: travelPath({ x: bindW.x, z: bindW.z }, 'bind'), aim: null, slots: [], roll: false };
      }
      if (dist(me, st.home) > LEASH || !st.wander || now() > st.wanderUntil || dist(me, st.wander) < 2) {
        st.wander = st.home;
        if (dist(me, st.home) <= LEASH) for (let i = 0; i < 20; i++) {
          const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * LEASH * 0.9;
          const pt = { x: st.home.x + Math.cos(a) * r, z: st.home.z + Math.sin(a) * r };
          if (!solid(pt.x, pt.z) && !inDanger(pt)) { st.wander = pt; break; }
        }
        st.wanderUntil = now() + 15000;
      }
      move = travel(st.wander, 'wander');
      st.last = dist(me, st.home) > LEASH ? 'retour zone' : 'patrouille';
    }
    // Anchored: hold within 5 m of the anchor instead of kiting away (dodge rolls still allowed).
    if (anchor && !roll) {
      const da = dist(me, anchor);
      move = da > 5 ? steer(anchor.x - me.x, anchor.z - me.z) : [0, 0];
      st.last = `tient la position (${Math.round(da)} m)`;
    }
    return { move, aim, slots, roll };
  }

  function setKeys(slots) {
    const want = new Set(slots.map(s => SLOT_KEYS[s]));
    for (const k of st.pressed) if (!want.has(k)) g.input.release(k);
    for (const k of want) g.input.press(k);
    st.pressed = want;
  }

  const origBuild = g.controls.build.bind(g.controls);
  g.controls.build = aimPt => {
    if (!st.on || g.ui.typing) return origBuild(aimPt);
    if (g.sim.dead || g.hp <= 0) {
      setKeys([]);
      if (!st.deadSince) {
        st.deadSince = now(); st.deaths++; st.shopDone = false; onDeath(st.zone ?? 'fixe'); endFight(true);
        st.deathPend = { xp: st.lastXp ?? g.char.ch.xp, lvl: st.lastLvl ?? g.level, at: now() };
        st.retreat = null; st.zonePick = null; // re-weigh arms with this death at once
        if (st.dun && g.dungeon) st.dun.deaths++;
        // Snapshot what killed us, for tuning.
        st.lastDeath = [...g.entities.visibleMonsters()].filter(m => !m.dead && dist(m.pos, g.sim) < 12)
          .map(m => `${m.def?.kind}${m.level}${m.elite ? 'E' : ''}`).join(' ') + ` | nuit:${g.time && g.ui?.night ? 1 : 0}`;
      }
      if (now() - st.deadSince > 3000) { g.actions.respawn(); st.deadSince = now(); }
      st.last = 'mort';
      return origBuild(aimPt);
    }
    st.deadSince = 0;
    let d;
    try { d = decide(); } catch (e) { st.last = 'erreur ' + e.message; d = { move: [0, 0], aim: null, slots: [] }; }
    setKeys(d.slots);
    const r = origBuild(d.aim ? { x: d.aim.x, z: d.aim.z } : aimPt);
    if (d.roll) st.rolls = (st.rolls ?? 0) + 1;
    (st.moves ??= []).push(d.move.map(v => +v.toFixed(2))); if (st.moves.length > 12) st.moves.shift();
    return { ...r, b: d.roll ? r.b | 64 : r.b, mx: Math.round(d.move[0] * 1e3) / 1e3, mz: Math.round(d.move[1] * 1e3) / 1e3 };
  };

  // Count kills and keep skills usable while the real cursor sits on a UI panel.
  const origOnMessage = g.onMessage.bind(g);
  g.onMessage = msg => {
    if (st.on && msg?.t === 's') for (const ev of msg.ev ?? []) {
      if (ev.e === 'kill') {
        st.kills++; ad.tot.kills = (ad.tot.kills ?? 0) + 1;
        const zs = zoneStat(st.zone ?? 'fixe'); zs.kills = (zs.kills ?? 0) + 1;
        const p = st.deathPend; // death cost sample: xp lost plus xp not earned until this first kill
        if (p?.lost != null) { const v = p.lost + xpps() * (now() - p.at) / 1000; ad.deathCost = ema(ad.deathCost ?? v, v, ad.deathN = (ad.deathN ?? 0) + 1); st.deathPend = null; }
      }
      else if (ev.e === 'hit') onHit(ev);
      else if (ev.e === 'xp') {
        const a = ev.a ?? 0, r = ad.ab.run;
        zoneStat(st.zone ?? 'fixe').xp += a; ad.tot.xp += a; st.xpTot = (st.xpTot ?? 0) + a;
        if (r && r.zone === st.zone) r[r.side].xp += a;
        if (st.qDone) st.qDone.xp = Math.max(st.qDone.xp, a);
        st.lastXpEv = { a, at: now() };
      }
      else if (ev.e === 'tele') addTele(ev);
      else if (ev.e === 'quest') {
        st.questEventAt = now(); st.quests = (st.quests ?? 0) + 1; st.lastQuest = `${ev.q}:${ev.k}`;
        if (ev.k === 'start') (st.qStart ??= {})[ev.q] = now();
        if (ev.k === 'done') {
          const x = st.lastXpEv && now() - st.lastXpEv.at < 50 ? st.lastXpEv.a : 0;
          st.qDone = { at: now(), xp: x, lvl: g.level };
          if (st.qStart?.[ev.q]) { ad.qx.dur = ema(ad.qx.dur, now() - st.qStart[ev.q], ad.qx.dn++); delete st.qStart[ev.q]; }
        }
      }
    }
    if (st.on && msg?.t === 'dlg') st.dlg = { m: msg, at: now() };
    if (st.on && (msg?.t === 'shop' || msg?.t === 'vendor')) st.shopOpen = true;
    if (st.on && msg?.t === 'vendor') st.vendorOk = true;
    return origOnMessage(msg);
  };

  // Live decision HUD (F9): reflexes, goal scores with inertia, current action, target, quest, keys.
  const hud = document.createElement('div');
  hud.id = 'bot-hud';
  hud.style.cssText = 'position:fixed;top:190px;right:12px;z-index:99999;width:340px;padding:10px 12px;'
    + 'background:rgba(12,14,16,.82);color:#e6e2d6;font:12px/1.45 ui-monospace,Menlo,monospace;'
    + 'border:1px solid rgba(230,226,214,.25);border-radius:6px;pointer-events:none;white-space:pre-wrap';
  document.body.appendChild(hud);
  const GOAL_FR = { fight: 'combat', shop: 'boutique', talk: 'quête PNJ', loot: 'butin', dungeon: 'donjon', explore: 'exploration', farm: 'farm' };
  const bar10 = v => '█'.repeat(Math.round(Math.min(1.75, Math.max(0, v)) / 1.75 * 10)).padEnd(10, '·');
  const esc = t => String(t ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const hudTimer = setInterval(() => {
    if (hud.hidden) return;
    const sc = st.scores ?? {};
    const rows = Object.keys(GOAL_FR).map(k => {
      const on = k === st.goal;
      const left = on ? Math.max(0, Math.round(((GOAL_MIN_MS[k] ?? 0) - (now() - st.goalAt)) / 1000)) : 0;
      return `${on ? '▶' : ' '} ${GOAL_FR[k].padEnd(10)} ${bar10(sc[k] ?? 0)} ${(sc[k] ?? 0).toFixed(2)}${on && left ? `  min ${left}s` : ''}`;
    }).join('\n');
    const hp = g.life ? Math.round(g.hp / g.life * 100) : 0;
    hud.innerHTML = `<b style="color:#d9b26f">BOT ${st.on ? 'ON' : 'OFF'}</b>  niv ${g.level}  PV ${hp}%  potions ${g.char.potions}  ess ${Math.round(g.sim.fury ?? 0)}\n`
      + `réflexe : ${esc(st.reflex ?? '-')}\n`
      + `<span style="color:#8fb3a8">objectifs (inertie +${INERTIA})</span>\n${esc(rows)}\n`
      + `action : <b>${esc(st.last)}</b>\n`
      + `cible  : ${esc(st.target ?? '-')}\n`
      + `zone   : ${esc(st.zone ?? '-')}\n`
      + `quête  : ${esc(st.quest?.label ?? '-')}\n`
      + `touches: ${esc([...st.pressed].join(' ') || '-')}  squelettes ${servantCount()}/${skelCap()}\n`
      + `<span style="color:#8fb3a8">modèle</span>\n`
      + `stratégie ${esc(st.strat ?? '-')}  pull ${st.plan?.k ?? 0} grp (options ${st.plan?.opts.length ?? 0})  marge ${ad.margin.toFixed(2)}\n`
      + `smith  : ${esc((st.top ?? []).join(' | ') || '-')}\n`
      + `sort   : ${esc(st.skill ?? '-')}  dps x${ad.dpsRatio.toFixed(2)}  réserve ${Math.round(reserve())}\n`
      + `zones  : ${esc((st.zoneArms ?? []).map(a => `${a.z.name.split(' ').pop()} ${Math.round(a.mean)}${a.qb ? ' (q)' : ''}`).join(' | ') || '-')}\n`
      + `repli  : ${esc(st.retreat ? `${st.retreat.why}, ${st.retreat.ids.size} poursuivant(s)` : '-')}\n`
      + `dangers: ${esc(ad.spots.filter(x => Date.now() < x.until).map(x => `${x.kind} ${Math.round((x.until - Date.now()) / 1000)}s`).join(' | ') || '-')}\n`
      + `A/B    : ${esc(ad.ab.run ? `${ad.ab.run.k} ${ad.ab.run.side} (B=${ad.ab.run.val}) ${Math.round(ad.ab.run[ad.ab.run.side].ms / 60000)}/15 min` : '-')}\n`
      + `prudence ${ad.caution}  blocages ${st.unsticks ?? 0}  dernier combat ${esc(st.lastFight ?? '-')}`;
  }, 250);

  const onKey = e => {
    if (e.code === 'F8') { e.preventDefault(); st.on ? api.pause() : api.start(); }
    if (e.code === 'F9') { e.preventDefault(); hud.hidden = !hud.hidden; }
  };
  window.addEventListener('keydown', onKey, true);

  const api = {
    start(home = null) {
      st.on = true; st.home = home; st.pinned = !!home; st.shopDone = false; st.t0 ||= now();
      st.xp0 ??= g.char.ch.xp; st.lvl0 ??= g.char.ch.level;
      Object.defineProperty(g.input, 'overUi', { get: () => false, configurable: true });
      g.ui.toast?.('Bot : marche (F8 pour couper)');
    },
    pause() {
      st.on = false; setKeys([]);
      delete g.input.overUi;
      g.ui.toast?.('Bot : arrêt');
    },
    stop() {
      api.pause();
      g.controls.build = origBuild; g.onMessage = origOnMessage;
      window.removeEventListener('keydown', onKey, true);
      clearInterval(hudTimer); hud.remove();
      delete window.__bot;
    },
    drainFights: () => fights.splice(0),
    // Read-only snapshot for viz.page.js.
    debug: () => ({
      navs: Object.fromEntries(Object.entries(st.navs ?? {}).map(([k, n]) => [k, { goal: n.goal, pts: n.pts, i: n.i, at: n.progressAt }])),
      home: st.home, leash: LEASH, zone: st.zone ?? null, goal: st.goal ?? null, wander: st.wander, target: st.tgtPos ?? null,
      dangers: ad.spots.filter(x => Date.now() < x.until).map(x => ({ x: x.x, z: x.z, r: x.r })), ways: WAYS, zones: ZONES,
    }),
    status: () => ({
      on: st.on, cls: g.char.ch.cls, lvl: g.char.ch.level, xp: g.char.ch.xp,
      hp: `${g.hp}/${g.life}`, potions: g.char.potions, kills: st.kills, deaths: st.deaths, rolls: st.rolls ?? 0, lastDeath: st.lastDeath,
      min: Math.round((now() - (st.t0 || now())) / 60000), doing: st.last, retreat: st.retreat ? { why: st.retreat.why, chasers: st.retreat.ids.size, target: st.retreat.target } : null, retreats: st.retreats ?? 0, servants: servantCount(), talents: Object.keys(g.char.ch.tree ?? {}).length,
      goal: st.goal, moves: st.moves, goalSwitches: st.goals ?? 0, unsticks: st.unsticks ?? 0, questLabel: st.quest?.label ?? null, questEvents: st.quests ?? 0, lastQuest: st.lastQuest,
      bound: g.char.bound ?? null, ways: g.char.ways?.length ?? 0, wayTrips: st.wayTrips ?? 0, binds: st.binds ?? 0,
      loots: st.loots ?? 0, equips: st.equips ?? 0, sold: st.sold ?? 0, claims: st.claims ?? 0, gold: g.char.gold, teleDodges: st.teleDodges ?? 0, caution: ad.caution, bought: st.bought ?? 0,
      strat: st.strat, pull: st.plan?.k ?? 0, pullOpts: st.plan?.opts.length ?? 0, margin: +ad.margin.toFixed(3), dpsRatio: +ad.dpsRatio.toFixed(3),
      top: st.top, skill: st.skill, lastFight: st.lastFight, knobs: { potion: knob('potion'), flee: knob('flee'), reserve: knob('reserve') },
      ab: ad.ab.run ? { k: ad.ab.run.k, side: ad.ab.run.side, val: ad.ab.run.val } : null, abLast: ad.ab.last ?? null,
      enemy: Object.fromEntries(Object.entries(ad.enemy).map(([k, v]) => [k, `${v.dps.toFixed(1)} dps (${v.n})`])),
      pullStats: Object.fromEntries(Object.entries(ad.pull).map(([k, v]) => [k, `${(v.xp / Math.max(1, v.ms) * 1000).toFixed(2)} xp/s (${v.n})`])),
      zoneUcb: (st.zoneArms ?? []).map(a => `${a.z.name} ${Math.round(a.mean)}`),
      xph: Object.fromEntries(Object.entries(ad.zones).map(([k, v]) => [k, `${Math.round(v.xp / Math.max(v.ms, 60000) * 3600000)} xp/h, ${v.deaths} morts`])),
      dungeon: st.dun ? { id: st.dun.id, phase: st.dun.phase, room: st.dun.room, deaths: st.dun.deaths, min: Math.round((now() - st.dun.at) / 60000) } : null,
      dangers: ad.spots.map(x => `${x.kind} ${Math.round((x.until - Date.now()) / 1000)}s r${Math.round(x.r)}`), avoid: ad.avoid,
      leash: Object.fromEntries(Object.entries(ad.leash).map(([k, v]) => [k, `${v.d.toFixed(1)} (${v.n})`])),
      quest: { frac: +ad.qx.frac.toFixed(3), rate: ad.qx.rate, talkMs: Math.round(ad.qx.talk), durMin: Math.round(ad.qx.dur / 60000) },
      deathCost: Math.round(deathCostXp()), sales: st.sales ?? [], fightsQueued: fights.length,
      zone: g.zoneName, farm: st.zone ?? 'fixe', pos: [Math.round(g.sim.x), Math.round(g.sim.z)], home: st.home,
    }),
  };
  // Self-check of the pure decision math.
  (() => {
    const fail = m => console.warn('bot self-check failed: ' + m);
    // Smith: a hard hitter that dies fast goes before a weak tank; hitting us outranks hitting skeletons.
    if (!(smithScore(10, 20, 10, 5, false, false) > smithScore(2, 200, 10, 5, false, false))) fail('smith ordering');
    if (!(smithScore(5, 50, 10, 5, false, true) > smithScore(5, 50, 10, 5, false, false))) fail('smith onUs bonus');
    // UCB: unvisited arm first, then the better mean with equal counts.
    if (ucbPick([{ mean: 1, n: 10 }, { mean: 2, n: 10 }, { mean: 0, n: 0 }]) !== 2) fail('ucb unvisited');
    if (ucbPick([{ mean: 1, n: 100 }, { mean: 2, n: 100 }]) !== 1) fail('ucb best');
    // Engagement: a small pack is safe, a pack out-damaging our hp pool is not.
    const me = { dps: 50, hp: 300, potHeal: 100, potions: 3, potCd: 10, splash: 0.3, soak: 0.3, margin: 1.5 };
    if (!engage({ hp: 100, dps: 10, n: 2 }, me).ok) fail('engage small pack');
    if (engage({ hp: 2000, dps: 120, n: 8 }, me).ok) fail('engage deadly pack');
    // Being attacked preempts a non-fight goal still inside its min duration.
    const keep = { goal: st.goal, goalAt: st.goalAt, scoreAt: st.scoreAt, goals: st.goals };
    st.goal = 'shop'; st.goalAt = now(); st.scoreAt = now();
    if (chooseGoal({ attacked: true, target: { d: 3 }, quest: null, drop: null }) !== 'fight') fail('attack preemption');
    Object.assign(st, keep);
    // Retreat end: a chaser that stopped, or ran out of its learned range; recover keeps the retreat going.
    if (!retreatOver('idle', 5, null, 5) || retreatOver('chase', 5, null, 5) || retreatOver('recover', 3, 14, 5)) fail('retreat state end');
    if (!retreatOver('chase', 30, 14, 5) || retreatOver('chase', 15, 14, 5)) fail('retreat range end');
    // Danger avoid time: doubles on a re-hit, halves after a clean probation, never below the prior.
    if (avoidNext(AVOID_PRIOR, true) !== 2 * AVOID_PRIOR || avoidNext(4 * AVOID_PRIOR, false) !== 2 * AVOID_PRIOR || avoidNext(AVOID_PRIOR, false) !== AVOID_PRIOR) fail('avoid timing');
    // Potion burn: 3 potions for 40 % of the hp with 2 left must disengage; 1 potion for 80 % with 8 left must not.
    if (!burnDisengage(3, 2, 1000, 600) || burnDisengage(1, 8, 1000, 200)) fail('potion burn');
    // Arm valuation: xp/h, gold at the xp-per-gold rate, deaths at their cost; quest rate over time to finish.
    const H = 3.6e6;
    if (armNet({ xp: 3600, gold: 100, deaths: 1, ms: H }, 2, 500) !== 3300) fail('arm net value');
    if (questRate(1000, 2, 50, 100) !== 18000) fail('quest rate');
    // Retreat direction: away from the chaser, and the same target over consecutive ticks of a static scene.
    const ring = Array.from({ length: 12 }, (_, i) => ({ x: 5 + 20 * Math.cos(i * Math.PI / 6), z: 20 * Math.sin(i * Math.PI / 6) }));
    const t1 = pickRetreat({ x: 5, z: 0 }, [{ x: 0, z: 0 }], ring, null, 1);
    const t2 = pickRetreat({ x: 5.5, z: 0 }, [{ x: 0.3, z: 0 }], ring, t1, 1);
    if (!t1 || t1.x <= 5 || t2 !== t1) fail('retreat direction stability');
    // Alternating callers keep their own path: each heading stays the same across interleaved calls.
    const navKeep = st.navs, me0 = { x: g.sim.x, z: g.sim.z };
    st.navs = {};
    const ga = { x: me0.x + 6, z: me0.z }, gb = { x: me0.x - 6, z: me0.z };
    const ha = travelPath(ga, 'a'), hb = travelPath(gb, 'b'), ha2 = travelPath(ga, 'a'), hb2 = travelPath(gb, 'b');
    if (ha[0] !== ha2[0] || ha[1] !== ha2[1] || hb[0] !== hb2[0] || hb[1] !== hb2[1] || st.navs.a.goal !== ga) fail('nav cache per caller');
    st.navs = navKeep;
    // Fight boundary: still on within the gap, over after it or at death.
    if (fightOver(1000, 1000 + FIGHT_GAP - 1, false) || !fightOver(1000, 1000 + FIGHT_GAP + 1, false) || !fightOver(1000, 1001, true)) fail('fight boundary');
  })();

  window.__bot = api;
  return 'bot loaded';
})();
