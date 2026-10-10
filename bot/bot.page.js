// Injected into the Ombreval page. Drives the game by wrapping __game.controls.build,
// so prediction, collisions and networking stay handled by the real client.
(() => {
  if (window.__bot) window.__bot.stop();
  const g = window.__game;
  if (!g?.controls) throw new Error('__game not ready');

  const SLOT_KEYS = ['Mouse0', 'Mouse2', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'KeyR', 'Digit5'];
  // Supported classes: necromancer (default paths), shaman (SHAMAN.md) and reaper (REAPER.md), per-class branches below.
  const CLS = g.char.ch.cls, SHAMAN = CLS === 'shaman', REAPER = CLS === 'reaper', PETLESS = SHAMAN || REAPER;

  // Adaptive memory (this browser only): zone stats, caution, learned models, A/B knobs.
  // Per class: the shaman's learned dps ratio, margin and strategy stats must not overwrite the necro's.
  const AD_KEY = SHAMAN ? 'ombreval-bot-adapt-shaman' : REAPER ? 'ombreval-bot-adapt-reaper' : 'ombreval-bot-adapt';
  const ad = (() => { try { return JSON.parse(localStorage.getItem(AD_KEY)) ?? {}; } catch { return {}; } })();
  ad.zones ??= {}; ad.caution ??= 0; ad.deaths ??= []; ad.calmSince ??= Date.now();
  ad.enemy ??= {}; ad.dpsRatio ??= 1; ad.dpsN ??= 0; ad.margin ??= 1.5; ad.pull ??= {}; ad.strat ??= {};
  ad.tot ??= { xp: 0, ms: 0 }; ad.ab ??= {}; ad.ab.best ??= {};
  // leash: kind -> learned distance where a chase stops; avoid: kind -> avoid ms; spots: remembered danger areas.
  ad.leash ??= {}; ad.avoid ??= {}; ad.spots ??= []; ad.recentDeaths ??= [];
  // reach: kind -> learned strike reach and attack mix; kmargin: kind -> learned kite margin (see swingTick).
  ad.reach ??= {}; ad.kmargin ??= {};
  // Open expeditions: the server keeps an instance open some time after we leave it and caps how many are open.
  // Prior 2 open, 5 min; both are re-read from its refusal toast (see expToast). dunOpen: [{ id, at: leave time }].
  ad.exp ??= { max: 2, ms: 5 * 60000 }; ad.dunOpen ??= [];
  // Quest model: reward as a fraction of the level xp, seconds per objective unit, talk and quest durations.
  ad.qx ??= { frac: 0.4, n: 0, rate: {}, dur: 600000, dn: 0, talk: 5000, tn: 0 };
  delete ad.offset;
  // New game build (bundle URL changes): what we learned may no longer hold, so shrink every count to a few samples.
  // Means and rates stay as priors; fresh fights then outweigh them within minutes.
  const gameVer = [...document.scripts].map(x => x.src).find(u => /assets\/index/.test(u)) ?? '';
  if (gameVer && ad.gameVer && ad.gameVer !== gameVer) {
    for (const z of Object.values(ad.zones)) for (const b of [z, ...Object.values(z.lv ?? {})]) for (const k of ['xp', 'ms', 'deaths', 'kills', 'gold', 'runs']) if (b[k]) b[k] *= 0.1;
    for (const e of Object.values(ad.enemy)) e.n = Math.min(e.n, 2);
    for (const e of Object.values(ad.pull)) if (e) for (const k of ['xp', 'ms', 'n']) if (e[k]) e[k] *= 0.1;
    Object.assign(ad, { leash: {}, reach: {}, kmargin: {}, spots: [], avoid: {}, recentDeaths: [], deaths: [], caution: 0, dpsN: Math.min(ad.dpsN, 3), deathN: Math.min(ad.deathN ?? 0, 2) });
    if (ad.dunCd) ad.dunCd = {};
  }
  ad.gameVer = gameVer;
  const saveAd = () => { try { localStorage.setItem(AD_KEY, JSON.stringify(ad)); } catch {} };
  // Arm stats per character level (ad.zones[name].lv[level]): monster xp falls with the level gap and harder arms unlock,
  // so a mean measured 6 levels ago must not keep winning. Old flat stats move once to a bucket 4 levels below ours.
  // TODO(ceiling): the age of pre-bucket stats is unknown; 4 levels is a guess they shrink from.
  const STAT_KEYS = ['xp', 'ms', 'deaths', 'kills', 'gold', 'runs'];
  for (const z of Object.values(ad.zones)) if (!z.lv) {
    const b = {}; for (const k of STAT_KEYS) if (z[k]) { b[k] = z[k]; delete z[k]; }
    z.lv = b.ms ? { [Math.max(1, g.level - 4)]: { xp: 0, ms: 0, deaths: 0, ...b } } : {};
  }
  const zoneStat = name => ((ad.zones[name] ??= { lv: {} }).lv ??= {})[g.level] ??= { xp: 0, ms: 0, deaths: 0 };
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
  // dmgPct/splashPct are % of Power (crit/execute included as `hit`); castSec for bonebolt/blight is at assumptions.aps.
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
      // Shaman (shaman_skills.json, level 12); casts of claws/crows scale with aps, see castSec.
      spiritclaws: { dmgPct: 108, splashPct: 108, radius: 0.9, range: 12, castSec: 0.6, cost: 0 },
      crows: { dmgPct: 144, splashPct: 144, radius: 3, range: 12, castSec: 0.58, cost: 0, duration: 3 },
      wolfform: { castSec: 0.35, cost: 0 }, bearform: { castSec: 0.35, cost: 0, roarCd: 10 },
      ancestortotem: { dmgPct: 900, radius: 8, range: 12, castSec: 0.6, cost: 0, duration: 12 },
      boarcharge: { dmgPct: 400, radius: 1.2, range: 16, castSec: 0.55, cost: 0 },
      mammoth: { dmgPct: 800, radius: 7, castSec: 0.9, cost: 0 },
      primalcall: { dmgPct: 600, radius: 3, range: 14, castSec: 0.65, cost: 0 },
      // Reaper (reaper_skills.json, level 12); reap/harvest casts scale with aps, see castSec. cd in s.
      reap: { dmgPct: 175, splashPct: 175, radius: 4.6, inner: 1.4, range: 4.6, castSec: 0.67, cost: 0 },
      harvest: { dmgPct: 260, splashPct: 260, radius: 4.5, range: 4.5, castSec: 0.64, cost: 22 },
      souldash: { dmgPct: 550, splashPct: 550, radius: 0.95, range: 10, minRange: 4, castSec: 0.31, cd: 9 },
      doom: { dmgPct: 500, splashPct: 500, radius: 4, range: 14, castSec: 0.5, cd: 12 },
      knell: { dmgPct: 600, splashPct: 600, radius: 6.5, castSec: 0.62, cd: 15 },
      wraithform: { dmgPct: 500, splashPct: 500, radius: 7, castSec: 0.45, cd: 24, duration: 7 },
      requiem: { dmgPct: 2500, splashPct: 2500, radius: 9, castSec: 2.22, cd: 75 },
      phantom: { dmgPct: 480, splashPct: 480, radius: 1.4, range: 10, castSec: 0.5, cd: 10 },
    },
    essence: { valuePerPoint: 8.44, reserveRule: SHAMAN ? 20 : REAPER ? 0 : null },
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
  // Non-classic weapon bases redefine the clicks (bundle Vh.necromancer): slot 0 (bar 'bonebolt') and slot 1 (bar 'blight')
  // fire the weapon's LMB (cast 1/aps) and RMB (fixed dur). % of Power = coef x the classic skill (165 / 300); RMB costs blight's.
  const WPN = {
    bonewand: { aps: 1.25 },
    deathstaff: { aps: 0.9, // Crâne hurlant (missile 15 m, burst 1.5 m, fear 0.5 s) / Charnier (5 m circle, corpse burst)
      bonebolt: { dmgPct: 155.4, splashPct: 155.4, radius: 1.5, range: 15, sec: 1 / 0.9 },
      blight: { dmgPct: 345.3, splashPct: 345.3, radius: 5, range: 14, sec: 0.5, corpse: false } },
    sacrdagger: { aps: 1.6, // Saignée rituelle (60° cone 2 m, heals per hit) / Lien de sang (3 s tether, half heals)
      bonebolt: { dmgPct: 248.3, splashPct: 248.3, radius: 2, range: 2, sec: 1 / 1.6 },
      blight: { dmgPct: 645, splashPct: 0, radius: 1, range: 10, sec: 0.4, corpse: false } },
    // Shaman (bundle Vh.shaman): non-classic clicks are coef x 90 % (LMB) and coef x 20 % (RMB), no crow swarm.
    totem: { aps: 1.2 },
    antlerstaff: { aps: 1.2, // Vrille (missile 14 m) / Bosquet
      spiritclaws: { dmgPct: 90.6, splashPct: 0, radius: 0.5, range: 14, sec: 1 / 1.2 },
      crows: { dmgPct: 23, splashPct: 0, radius: 1, range: 12, sec: 0.5 } },
    hatchet: { aps: 1.1, // Taille de pierre (arc 2.3 m) / Totem lance
      spiritclaws: { dmgPct: 82.2, splashPct: 82.2, radius: 2.3, range: 2.3, sec: 1 / 1.1 },
      crows: { dmgPct: 5.4, splashPct: 5.4, radius: 3, range: 12, sec: 0.5 } },
    // Reaper (bundle Vh.reaper): sickle LMB 1.72 x reap, RMB reaping dash (line 6 m); great scythe narrow 6.5 m arc, boomerang RMB.
    scythe: { aps: 1.2 },
    sickle: { aps: 1.3,
      reap: { dmgPct: 301, splashPct: 301, radius: 2, inner: 0, range: 3.5, sec: 1 / 1.3 },
      harvest: { dmgPct: 547, splashPct: 547, radius: 0.95, range: 6, sec: 0.45, dash: 6 } },
    greatscythe: { aps: 0.75,
      reap: { dmgPct: 201, splashPct: 201, radius: 6.5, inner: 1.5, range: 6.5, sec: 1 / 0.75 },
      harvest: { dmgPct: 324, splashPct: 324, radius: 1, range: 9, sec: 0.55, dash: 9 } },
  };
  const sk = (id, base = g.char.eq?.weapon?.base) => ({ ...SV.skills[id], ...WPN[base]?.[id] });
  const PLAYER_SPEED = 5.28;
  const ATTACK_STATES = ['chase', 'windup', 'strike'];
  // TODO(ceiling): monster damage level scaling is guessed (+10%/level); learned per-kind values absorb the error.
  const lvlScale = l => 1 + 0.1 * Math.max(0, (l ?? 1) - 1);
  // EMA whose first samples weigh more (prior counts as one sample), floor 0.1 to keep tracking drift.
  const ema = (old, x, n) => old + (x - old) * Math.max(0.1, 1 / (n + 2));
  const xpps = () => ad.tot.xp / Math.max(ad.tot.ms, 60000) * 1000;
  // Death cost: learned xp lost plus xp not earned until the next kill; prior 75 s of farming.
  const deathCostXp = () => ad.deathCost ?? 75 * xpps();

  // Open-world farming zones (client table `md`, live bundle L27290): center, radius, monster level range.
  const ZONES = [
    { name: 'Bois des Hurlements', x: -52, z: 8, r: 30, lvl: [1, 3] },
    { name: 'Camp des Gobelins', x: -82, z: -48, r: 27, lvl: [3, 5] },
    { name: 'Cimetière Oublié', x: 62, z: 12, r: 28, lvl: [5, 7] },
    { name: 'Sombrebois', x: 58, z: -62, r: 30, lvl: [7, 9] },
    { name: 'Antre de Grukk', x: 0, z: -100, r: 26, lvl: [10, 12] },
    { name: 'Sylve de Moisivert', x: -130, z: 150, r: 38, lvl: [9, 13] },
    { name: 'Carrières de Rochenoire', x: -112, z: -104, r: 30, lvl: [13, 16] },
    { name: 'Marais de Brumelande', x: -160, z: 70, r: 42, lvl: [12, 16] },
    { name: 'Terres de Cendre', x: 160, z: -30, r: 44, lvl: [17, 22] },
    { name: 'Cimes de Givrecroc', x: 20, z: 178, r: 42, lvl: [17, 22] },
    { name: 'Nécropole de Malachar', x: 5, z: -170, r: 40, lvl: [23, 30] },
    { name: 'La Faille d’Ombreval', x: 160, z: 150, r: 38, lvl: [27, 30] },
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
  // Arm level: a dungeon's level, a zone's mid level, a quest area's minimum level.
  const armLvl = z => z.dun ? z.dun.d.level : z.quest ? z.lvl[0] : (z.lvl[0] + z.lvl[1]) / 2;
  // Learned xp falloff per level of gap above an arm (prior 0.9), see learnFall.
  const fall = () => ad.fall?.f ?? 0.9;
  // Level-weighted stats of an arm at level a: a bucket k levels old weighs STALE^k, and its xp is moved to our level by
  // the falloff (only the part of the gap above the arm counts).
  const STALE = 0.5;
  function armStat(name, a) {
    const o = { xp: 0, ms: 0, deaths: 0, kills: 0, gold: 0, runs: 0 };
    for (const [L, b] of Object.entries(ad.zones[name]?.lv ?? {})) {
      const w = STALE ** Math.max(0, g.level - L), f = fall() ** (Math.max(0, g.level - a) - Math.max(0, L - a));
      for (const k of STAT_KEYS) o[k] += (b[k] ?? 0) * w * (k === 'xp' ? f : 1);
    }
    return o;
  }
  // Falloff sample per arm from its two latest level buckets with 20+ kills: xp per kill ratio per level of gap.
  function learnFall() {
    for (const z of armList(st.quest)) {
      const a = armLvl(z), bs = Object.entries(ad.zones[z.name]?.lv ?? {}).filter(([, b]) => (b.kills ?? 0) >= 20).sort((x, y) => x[0] - y[0]).slice(-2);
      if (bs.length < 2) continue;
      const [[L1, b1], [L2, b2]] = bs, dg = Math.max(0, L2 - a) - Math.max(0, L1 - a);
      if (dg <= 0 || !b1.xp || !b2.xp) continue;
      // TODO(ceiling): quest and boss xp ride on kill counts; samples are bounded to [0.3, 1.5] against those outliers.
      const x = Math.min(1.5, Math.max(0.3, (b2.xp / b2.kills / (b1.xp / b1.kills)) ** (1 / dg)));
      ad.fall = { f: ema(fall(), x, ad.fall?.n ?? 0), n: (ad.fall?.n ?? 0) + 1 };
    }
  }
  // Ladder search as the UCB prior: the arm at our level gets the strongest prior (best measured rate, or our lifetime
  // rate), 15 % less per level away, held with more pseudo-trials the farther it is, so far-below arms win only on
  // measured, level-discounted value. The first unmeasured arm above the best measured one is primed 10 % above it:
  // climb while the next rung pays, step back down once it is measured worse.
  function zoneArms() {
    const q = st.quest, L = armList(q), dc = deathCostXp(), xg = xpPerGold(), t = Date.now(), lv = g.level;
    const rows = L.map(z => ({ z, a: armLvl(z), s: armStat(z.name, armLvl(z)) }));
    const fresh = rows.filter(r => r.s.ms > 5 * 60000).map(r => ({ ...r, net: armNet(r.s, xg, dc) })).sort((x, y) => y.net - x.net);
    const top = Math.max(fresh[0]?.net ?? 0, xpps() * 3600);
    const best = fresh[0], next = best && rows.filter(r => r.a > best.a && r.s.ms <= 5 * 60000 && (r.z.dun ? r.z.dun.d.level <= lv : r.z.lvl[0] <= lv)).sort((x, y) => x.a - y.a)[0];
    return rows.map(({ z, a, s }) => {
      const gap = Math.abs(a - lv), pms = ZONE_DWELL * (1 + gap);
      let prior = top * 0.85 ** gap;
      if (next && z === next.z) prior = Math.max(prior, best.net * 1.1);
      // Recent deaths there, as a death rate over the recent window: pushes the arm away for a while.
      const recent = ad.recentDeaths.filter(d => d.zone === z.name && t - d.t < RECENT_MS).length * dc / RECENT_MS * 3.6e6;
      const qb = holdsQuest(z, q) && !questArmSkipped(q) ? questBonus(q, z, s) : 0;
      const mean = (prior * pms + armNet(s, xg, dc) * s.ms) / (pms + s.ms) - recent + qb;
      const ok = z.dun ? z.dun.d.level <= lv && !(DUN_SKIP.get(z.dun.d.id) > Date.now()) && !expFull(z.dun.d.id)
        : z.quest ? (q.minLevel ?? 1) <= lv - 1 : z.lvl[0] <= lv;
      return { z, a, mean, qb, n: (pms + s.ms) / ZONE_DWELL, ok };
    });
  }
  // Quest boss absent (killed by someone, respawning): its arm is skipped for the learned respawn time of that kind
  // (prior 5 min, x2 when still absent on return, x0.75 when found), then we come back.
  const questArmSkipped = q => !!q && st.qArmSkip?.key === questKey(q) && Date.now() < st.qArmSkip.until;
  function bossWatch(q, me) {
    if (!(q?.type === 'kill' && q.need === 1 && q.x != null && st.questArm && dist(me, q) < Math.max(10, (q.r ?? 25) * 0.6))) { st.bossAbsentAt = null; return; }
    const R = ad.respawn ??= {}, key = questKey(q);
    if ([...g.entities.visibleMonsters()].some(m => !m.dead && m.hp > 0 && m.def?.name === q.kind)) {
      if (st.qArmSkip?.key === key) { R[q.kind] = Math.max(60000, (R[q.kind] ?? 300000) * 0.75); st.qArmSkip = null; }
      st.bossAbsentAt = null; return;
    }
    st.bossAbsentAt ??= now();
    if (now() - st.bossAbsentAt < 30000) return;
    if (st.qArmSkip?.key === key) R[q.kind] = Math.min(3600000, (R[q.kind] ?? 300000) * 2); // came back too early
    st.qArmSkip = { key, until: Date.now() + (R[q.kind] ?? 300000) }; st.bossAbsentAt = null; st.zonePick = null; saveAd();
    jlog('boss absent', { kind: q.kind, min: Math.round((R[q.kind] ?? 300000) / 60000) });
  }
  // Re-pick after the dwell, on a level up, on a quest change, or when the picked dungeon cannot be entered now.
  function pickZone() {
    const qk = st.quest ? questKey(st.quest) : null, p = st.zonePick;
    const blocked = (p?.dun && !g.dungeon && (DUN_SKIP.get(p.dun.d.id) > Date.now() || expFull(p.dun.d.id)))
      || (st.qArmSkip && Date.now() >= st.qArmSkip.until && !st.qArmSkip.back && (st.qArmSkip.back = true)); // boss due back
    if (p && now() - st.zonePickAt < ZONE_DWELL && p.lvl[0] <= g.level && st.zonePickQ === qk && st.zonePickLvl === g.level && !blocked) return p;
    const arms = zoneArms().filter(a => a.ok);
    st.zoneArms = arms;
    // Quests first: the arm holding the active kill/collect/dungeon step wins over the ladder.
    const qa = arms.find(a => a.qb > 0); // qb is 0 while the quest boss is away (bossWatch)
    st.zonePick = qa?.z ?? arms[ucbPick(arms)]?.z ?? ZONES[0]; st.zonePickAt = now(); st.zonePickQ = qk; st.zonePickLvl = g.level;
    (st.ladder ??= []).push(`${new Date().toTimeString().slice(0, 5)} niv${g.level} ${st.zonePick.name}`); if (st.ladder.length > 30) st.ladder.shift();
    jlog('bras', { arm: st.zonePick.name, arms: arms.map(a => `${a.z.name}|${a.a}|${Math.round(a.mean)}|${a.n.toFixed(1)}`) });
    return st.zonePick;
  }
  // Expeditions still open (left less than ad.exp.ms ago, or the one we stand in); a new dungeon needs a free slot.
  // Re-entering a still open instance must not count it twice (ids are unique; '?' fillers from the toast are not).
  const openExp = () => { const o = ad.dunOpen.filter(x => Date.now() - x.at < ad.exp.ms).map(x => x.id); return g.dungeon && !o.includes(g.dungeon.def.id) ? o.concat(g.dungeon.def.id) : o; };
  const expFull = id => { const o = openExp(); return o.length >= ad.exp.max && !o.includes(id); };
  // Refusal toast ("Vous avez déjà 2 expéditions ouvertes : elles se referment 5 minutes après votre départ."):
  // learn the cap and delay, and fill the open list up to the cap so no new door is tried before one closes.
  function expToast(m) {
    const n = /(\d+) exp[ée]ditions? ouvertes?/i.exec(m), mn = /(\d+) minutes?/i.exec(m);
    if (!n) return;
    ad.exp.max = +n[1]; if (mn) ad.exp.ms = +mn[1] * 60000;
    while (openExp().length < ad.exp.max) ad.dunOpen.push({ id: '?', at: Date.now() });
    st.zonePick = null; saveAd();
  }
  // Door of the picked dungeon arm, when it is still enterable.
  const armDoor = () => {
    const o = !g.dungeon && !grouped() && st.zonePick?.dun;
    return o && o.d.level <= g.level && !(DUN_SKIP.get(o.d.id) > Date.now()) && !expFull(o.d.id) ? o : null;
  };
  let LEASH = 45;

  const st = {
    on: false, home: null, wander: null, wanderUntil: 0, kills: 0, deaths: 0,
    xp0: null, lvl0: null, t0: 0, last: '', pressed: new Set(), deadSince: 0, nav: null,
  };
  if (window.__botCarry && Date.now() - window.__botCarry.at < 30000) { st.carrySeen = new Set(window.__botCarry.seen); setTimeout(() => { st.carrySeen = null; }, 30000); }
  delete window.__botCarry;

  const now = () => performance.now();
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  // Learned blocked cells (1 m): we pushed toward them and did not move (obstacles the client grid lacks, bodies).
  // Per collision map; a cell expires after its ttl, which doubles each time it blocks us again.
  const blocked = { c: null, m: new Map() };
  const cellKey = (x, z) => Math.round(x) * 100003 + Math.round(z);
  const blockedAt = (c, x, z) => {
    if (blocked.c !== c) return false;
    const b = blocked.m.get(cellKey(x, z));
    return !!b && Date.now() < b.until;
  };
  function markBlocked(x, z) {
    const c = g.dungeon?.collision ?? g.world?.collision;
    if (blocked.c !== c) { blocked.c = c; blocked.m.clear(); }
    const k = cellKey(x, z), b = blocked.m.get(k), ttl = b ? Math.min(3600000, b.ttl * 2) : 120000;
    blocked.m.set(k, { until: Date.now() + ttl, ttl });
  }
  const solid = (x, z) => {
    const c = g.dungeon?.collision ?? g.world?.collision;
    try { return !!c?.solidAt(x, z, 0.6) || blockedAt(c, x, z); } catch { return false; }
  };
  // Charges (bundle aT / L54721): usable while cds <= (charges - 1) x cd. Reaper: rp_dodge (+1, oath of the void +2)
  // on the roll, souldash rank 3 a 2nd charge. The roll cd ignores cdr.
  const charges = id => !REAPER ? 1 : id === 'roll' ? 1 + +!!g.char.ch.tree?.rp_dodge + (g.char.ch.tree?.rp_oath_void ? 2 : 0)
    : id === 'souldash' && (g.char.ch.tree?.souldash ?? 0) >= 3 ? 2 : 1;
  const cdOf = id => id === 'roll' ? 4.5 : (sk(id).cd ?? 0) * (1 - (g.stats?.cdr ?? 0));
  const ready = id => (g.sim.cds?.[id] ?? 0) <= (charges(id) - 1) * cdOf(id) + 1 / 60;

  // --- Group mode (window.__botOpts.group, GROUP.md): follow the party member closest in level, assist and protect.
  // Inert unless the option is on and g.party holds someone besides us.
  const grp = { leadId: null, deadAt: 0, last: null, tgt: new Map(), onMate: new Map(), band: 10, fd: 0, fn: 0 };
  const grouped = () => window.__botOpts?.group === true && (g.party?.length ?? 0) > 1;
  const BAND = SHAMAN || REAPER ? [4, 8] : [8, 12]; // necro: skeletons hold in front; shaman: totem and heal range
  // Pure pick: smallest level gap, then the real leader (lead), the nearest, the smallest id. The current one is kept
  // unless another is 2+ levels closer to ours.
  function pickLeader(party, meId, lvl, me, cur) {
    const c = party.filter(p => p.id !== meId && !p.dead);
    if (!c.length) return null;
    const key = p => [Math.abs(p.lvl - lvl), p.lead ? 0 : 1, Math.hypot(p.x - me.x, p.z - me.z), p.id];
    c.sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; });
    const keep = c.find(p => p.id === cur);
    return keep && Math.abs(keep.lvl - lvl) - Math.abs(c[0].lvl - lvl) < 2 ? keep : c[0];
  }
  // Leader dead: stay with the body up to 60 s, then pick the next one.
  function leader() {
    if (!grouped()) { grp.leadId = null; return null; }
    const cur = g.party.find(p => p.id === grp.leadId);
    if (cur?.dead) { grp.deadAt ||= now(); if (now() - grp.deadAt < 60000) return cur; } else grp.deadAt = 0;
    const l = pickLeader(g.party, g.meId, g.level, g.sim, grp.leadId);
    grp.leadId = l?.id ?? null;
    return l;
  }
  const leaderPos = l => { const r = g.remotes?.get?.(l.id); return r?.view?.pos ? { x: r.view.pos.x, z: r.view.pos.z } : { x: l.x, z: l.z }; };
  const mateIds = () => new Set((g.party ?? []).map(p => p.id).filter(id => id !== g.meId));
  // Member map: '' (or none) = world layer 1, 'cN' = another layer, else a dungeon instance key; same map = equal to g.mapKey.
  const mapOf = l => l.w || '';
  const sameMap = l => mapOf(l) === (g.mapKey || '');
  const inDungeonKey = w => !!w && !/^c\d+$/.test(w);
  // Score multiplier: the leader's target x3, a monster on a member x2 (x4 under 40 % hp), else 1.
  function groupMul(m) {
    if (!grouped()) return 1;
    if (now() - (grp.tgt.get(m.id) ?? -1e9) < 3000) return 3;
    const o = grp.onMate.get(m.id);
    if (o && now() - o.at < 4000) return (g.party.find(p => p.id === o.mate)?.hp ?? 100) < 40 ? 4 : 2;
    return 1;
  }
  const onMate = m => grouped() && now() - (grp.onMate.get(m.id)?.at ?? -1e9) < 4000;
  const leadTgt = m => grouped() && now() - (grp.tgt.get(m.id) ?? -1e9) < 3000;
  function groupHit(ev) {
    if (!grouped()) return;
    const isMon = id => g.entities.monsters.has(id);
    const owner = g.entities.allies?.get?.(ev.s)?.view?.ally;
    if ((ev.s === grp.leadId || (owner != null && owner === grp.leadId)) && isMon(ev.id)) grp.tgt.set(ev.id, now());
    if (mateIds().has(ev.id) && isMon(ev.s)) grp.onMate.set(ev.s, { at: now(), mate: ev.id });
  }
  // Follow need: leader on another map, or beyond 1.5 band.
  function needFollow() {
    const l = grouped() ? leader() : null;
    return !!l && (!sameMap(l) || dist(g.sim, leaderPos(l)) > grp.band * 1.5);
  }
  // Same map: walk to the leader. Leader in a dungeon and we outside: the door nearest its last world position, enter.
  // Leader back outside while we are in: leave. A jump over 30 m (waystone) drops the follow trip plan.
  function followRun() {
    const l = leader(), t = now();
    if (!l) return [0, 0];
    const p = { x: l.x, z: l.z };
    if (!mapOf(l)) { if (grp.last && dist(grp.last, p) > 30 && st.wayPlans) delete st.wayPlans.follow; grp.last = p; }
    st.last = `groupe : suit ${l.n}`;
    if (sameMap(l)) return travel(leaderPos(l), 'follow');
    if (inDungeonKey(mapOf(l)) && !g.dungeon && grp.last) {
      const door = (g.portals?.doors ?? []).reduce((b, o) => !b || dist(o.at, grp.last) < dist(b.at, grp.last) ? o : b, null);
      if (!door) return [0, 0];
      st.last = `groupe : rejoint ${l.n} (${door.d.name})`;
      if (dist(g.sim, door.at) > 4) return travel({ x: door.at.x, z: door.at.z }, 'follow');
      if (t - (st.dunSendAt ?? 0) > 3000) { st.dunSendAt = t; g.send({ t: 'dungeon', a: 'enter', d: door.d.id }); }
      return [0, 0];
    }
    if (!mapOf(l) && g.dungeon) { if (t - (st.dunSendAt ?? 0) > 3000) { st.dunSendAt = t; g.send({ t: 'dungeon', a: 'leave' }); } return [0, 0]; }
    return [0, 0]; // other layer: wait here, fighting what comes
  }

  function monsters() {
    const out = [], ms = meState();
    for (const m of g.entities.visibleMonsters()) {
      if (m.dead || m.hp <= 0) continue;
      // Bosses, elites and higher levels are targets whenever the engagement model says we win (dungeons: always).
      if (!g.dungeon && !engage({ hp: m.hp, dps: enemyDps(m), n: 1 }, ms).ok) continue;
      const onUs = (dist(m.pos, g.sim) < 10 && ['chase', 'windup', 'strike'].includes(m.state)) || onMate(m);
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
    const out = [], army = PETLESS ? [] : myAllies(), h = st.home ?? me;
    if (SHAMAN && totemLeft() > 0) out.push(st.totemPos); // shaman: fall back on the totem (heal 1.5 %/s at 8 m)
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
    // Too strong = the engagement model (learned dps, self-tuned margin) says we lose it alone; no fixed level/boss rule.
    const strong = conv.filter(m => !engage({ hp: m.hp, dps: enemyDps(m), n: 1 }, meState()).ok);
    const f = st.fight;
    const burn = !!f && conv.length > 0 && burnDisengage(f.pot0 - g.char.potions, g.char.potions, f.hpTot,
      [...f.seen].reduce((a, id) => { const m = g.entities.monsters.get(id)?.view; return a + (m && !m.dead ? Math.max(0, m.hp) : 0); }, 0));
    const eng = conv.length > 0 && engage({ hp: conv.reduce((a, m) => a + m.hp, 0), dps: conv.reduce((a, m) => a + enemyDps(m), 0), n: conv.length },
      { ...meState(), margin: 1 });
    if (eng) st.lastEng = { ttk: +eng.ttk.toFixed(1), ttd: +eng.ttd.toFixed(1), my: Math.round(myDps()), kinds: conv.map(m => `${m.def?.kind}${m.level}:${Math.round(enemyDps(m))}`) };
    const crowd = burn || eng && !eng.ok;
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
      win.inDmg[k] = (win.inDmg[k] ?? 0) + (ev.a ?? 0) / lvlScale(m.level) / corTaken(); // learned at 0 stacks
      if (st.fight) st.fight.dmgIn[k] = (st.fight.dmgIn[k] ?? 0) + (ev.a ?? 0);
      hitUs.set(ev.s, now());
      const sw = swings.get(ev.s), e = ad.reach[k], dh = dist(m.pos, g.sim);
      if (sw) { sw.hit = true; if (e?.d != null && dh > e.d) e.d = ema(e.d, dh, e.n++); }
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
      ad.dpsRatio = Math.max(0.05, ema(ad.dpsRatio, win.outDmg / corDealt() / win.outExp / Math.max(1, priorMyDps()), ad.dpsN++));
      win.outDmg = 0; win.outExp = 0;
    }
  }

  // --- Threat geometry. Monster reach is server side (defs carry speed and radius only), so it is learned per kind:
  // EMA of the center distance where a contact windup on us starts (both hitboxes included). Ranged: most of its
  // windups are shots. Margin: per kind EMA from how its swings on us ended while kiting: a hit adds what it closes
  // during our reaction latency, a miss gives back the slack we kept past its reach.
  const CONTACT = ['melee', 'lunge', 'smash', 'slam', 'breath', 'explode', 'ambush'];
  const SHOTS = ['shoot', 'spit', 'fireball', 'bolt', 'volley', 'multishot', 'boulder', 'hook'];
  const ME_R = 0.5; // player collision radius (bundle ej)
  const swings = new Map(), mState = new Map();
  const lat = () => (st.lat ?? 100) / 1000;
  const reachOf = m => ad.reach[m.def?.kind]?.d ?? (m.def?.radius ?? 0.6) + ME_R + 1;
  const kMargin = m => ad.kmargin[m.def?.kind]?.m ?? (m.def?.speed ?? PLAYER_SPEED) * lat();
  const isRanged = m => (e => !!e && e.rng > e.mel)(ad.reach[m.def?.kind]);
  // Distance left before a monster can strike us within horizon T: chasers close at their speed, swinging ones are set.
  const strikeGap = (d, reach, margin, v, T, chasing) => d - (chasing ? v * T : 0) - reach - margin;
  // Ideal distance band to the target: past the widest melee reach plus margin, inside our range minus what the target
  // slips away during our latency. Short weapons (range below the band) just stay in range.
  // hi keeps 10 % of the range in hand: at the very edge the target drifted out between casts (fight time without a key).
  const kiteBand = (reach, margin, range, slip) => { const hi = 0.9 * range - slip; return { lo: Math.min(reach + margin, hi), hi }; };
  console.assert(strikeGap(6, 2, 0.5, 4, 0.5, true) === 1.5 && strikeGap(6, 2, 0.5, 4, 0.5, false) === 3.5, 'strikeGap');
  console.assert((b => b.lo === 2.5 && Math.abs(b.hi - 10.7) < 1e-9)(kiteBand(2, 0.5, 13, 1)) && Math.abs(kiteBand(2, 0.5, 2.3, 0).lo - 2.07) < 1e-9, 'kiteBand');
  function swingTick(me) {
    const t = now(), army = myAllies();
    for (const m of g.entities.visibleMonsters()) {
      const prev = mState.get(m.id);
      mState.set(m.id, m.state);
      if (m.dead || m.state === prev || m.state !== 'windup') continue;
      const k = m.def?.kind, d = dist(m.pos, me);
      // Swinging at an ally, not at us: an ally closer than us in its facing cone (allies behind or beside it do not count;
      // the old "any ally closer" test dropped nearly every swing next to the army, so no margin was ever learned).
      const fx = Math.sin(m.yaw ?? 0), fz = Math.cos(m.yaw ?? 0), facing = p => ((p.x - m.pos.x) * fx + (p.z - m.pos.z) * fz) / (dist(p, m.pos) || 1);
      if (army.some(a => dist(a.pos, m.pos) < d && facing(a.pos) > 0.9)) continue;
      const e = ad.reach[k] ??= { d: null, n: 0, mel: 0, rng: 0 };
      if (SHOTS.includes(m.attack)) e.rng++;
      if (!CONTACT.includes(m.attack) || d > CHASE_PRIOR) continue;
      e.mel++; e.d = e.d == null ? d : ema(e.d, d, e.n); e.n++;
      swings.set(m.id, { k, m, v: m.def?.speed ?? PLAYER_SPEED, at: t, kite: st.strat === 'kite' && st.goal === 'fight' });
    }
    for (const [id, s] of swings) {
      if (s.m.state !== 'windup' && s.end == null) { s.end = t; s.dEnd = dist(s.m.pos, me); }
      if (!s.hit && !(s.end && t - s.end > 400) && !s.m.dead && t - s.at < 3000) continue;
      swings.delete(id);
      if (!s.kite || (!s.hit && s.dEnd == null)) continue;
      const km = ad.kmargin[s.k] ??= { m: s.v * lat(), n: 0 };
      km.m = ema(km.m, s.hit ? km.m + s.v * lat() : Math.max(0, km.m - Math.max(0, s.dEnd - ad.reach[s.k].d)), km.n++);
    }
  }

  // --- Our stat sheet (bundle yF): Power = (0.04*lvlBase + item pow) x mult, life = (lvlBase + item hp) x mult, where
  // lvlBase = 100 + (20*lvl)^1.2 and mult (class frame, talents, boons) is read off the game's sheet g.stats; affixes are
  // flat % points (caps CAPS). hit = Power x crit x execute; aps is fixed by the weapon base (haste only speeds spells).
  const UPG = [0, 4, 8, 12, 17, 22, 28, 35, 43, 52, 62]; // item +N: hp/pow x(1+UPG/100), affixes x(1+UPG/200)
  const CAPS = { crit: 60, critDmg: 300, guard: 60, execute: 75, leech: 25, haste: 50, cdr: 50 };
  function gearSum(eq) {
    const o = { hp: 0, pow: 0 };
    for (const it of Object.values(eq)) {
      if (!it) continue;
      const u = UPG[Math.min(10, it.up ?? 0)];
      o.hp += Math.round((it.hp ?? 0) * (1 + u / 100)); o.pow += Math.round((it.pow ?? 0) * (1 + u / 100));
      for (const f of it.affixes ?? []) o[f.stat] = (o[f.stat] ?? 0) + f.value * (1 + u / 200);
    }
    return o;
  }
  function sheet(swap) {
    const S = g.stats, cur = g.char.eq ?? {}, eq = { ...cur };
    if (swap) eq[swap.slot] = swap;
    const lb = 100 + (20 * Math.max(1, g.char.ch.level)) ** 1.2, a = gearSum(eq), b = gearSum(cur);
    // swap = what we wear (g.stats) plus the item delta
    const v = k => Math.min(CAPS[k], Math.max(0, (k === 'cdr' ? S.cdr * 100 : S[k] ?? 0) + (a[k] ?? 0) - (b[k] ?? 0)));
    const power = S.power / (0.04 * lb + b.pow) * (0.04 * lb + a.pow), life = S.life / (lb + b.hp) * (lb + a.hp);
    // TODO(ceiling): execute assumed to boost ~35% of our damage (share landing under 35% hp); fit from fight data.
    const hit = power * (1 + v('crit') / 100 * v('critDmg') / 100) * (1 + 0.35 * v('execute') / 100);
    const base = eq.weapon?.base, aps = WPN[base]?.aps ?? S.aps, bolt = sk(BASE_SKILLS[0], base);
    let dps;
    if (REAPER) {
      // gear.formula.dpsIndex: click 80 % of the time, harvest term (sickle dash 90, great scythe 54), spells 164 %/s, Trepas /(1-0.2).
      const sec = bolt.sec ?? 0.8 / aps, harv = base === 'sickle' ? 90 : base === 'greatscythe' ? 54 : 43;
      dps = hit * (0.8 * bolt.dmgPct / sec + harv + 164 / (1 - v('cdr') / 100)) / 100 / 0.8;
    } else if (SHAMAN) {
      // gear.formula.dpsIndex: claws 75 % of casts (0.72/aps), crows 144 %/3 s (classic totem only), totem + boar 78 %/s.
      const sec = bolt.sec ?? 0.72 / aps;
      dps = hit * (0.75 * bolt.dmgPct / sec + (bolt.sec ? 0 : 48) + 78 / (1 - v('cdr') / 100)) / 100;
    } else {
      const boltSec = bolt.sec ?? bolt.castSec * SV.assumptions.aps / aps;
      const surplus = (4 / boltSec + 2) * (S.furyGen ?? 1.1) - 0.75;
      dps = hit * (bolt.dmgPct / boltSec + SV.essence.valuePerPoint * surplus + 165 / (1 - v('cdr') / 100)) / 100;
    }
    // TODO(ceiling): leech counted as 5 s of healing at our dps; guard ignores enemy penetration.
    const ehp = life / (1 - v('guard') / 100) + v('leech') / 100 * dps * 5;
    // Reaper sustained travel speed (REAPER.md): walk w plus a 9 m pass every 4.5 s and a 10 m rush every 9 s (cdr).
    const w = PLAYER_SPEED * ((S.moveSpd ?? 1) + ((a.moveSpd ?? 0) - (b.moveSpd ?? 0)) / 100);
    const vt = w + (9 - 0.22 * w) / 4.5 + (10 - 0.3125 * w) / (9 * (1 - v('cdr') / 100));
    return { hit, aps, dps, ehp, vt };
  }
  const curSheet = () => {
    if (!st.sheet || now() - st.sheetAt > 2000) { st.sheet = sheet(); st.sheetAt = now(); }
    return st.sheet;
  };
  // Cast time: weapon clicks use their own (sec); classic bonebolt/blight scale with attack speed (dur/aps); other spells
  // are fixed but shortened by haste (aN: dur/(1+haste/100)).
  // Shaman claws/crows: 0.72/p and 0.7/p, p = aps x 1.3 under the wolf howl (g.sim.over > 0).
  // Reaper: reap 0.8/aps, harvest 0.7/sqrt(aps) (weapon clicks: their own sec).
  const castSec = id => REAPER && (id === 'reap' || id === 'harvest')
    ? sk(id).sec ?? (id === 'reap' ? 0.8 / curSheet().aps : 0.7 / Math.sqrt(curSheet().aps))
    : SHAMAN && (id === 'spiritclaws' || id === 'crows')
    ? sk(id).sec ?? (id === 'crows' ? 0.7 : 0.72) / (curSheet().aps * (g.sim.over > 0 ? 1.3 : 1))
    : (id === 'bonebolt' || id === 'blight')
    ? sk(id).sec ?? (sk(id).castSec ?? 0.58) * SV.assumptions.aps / curSheet().aps : (sk(id).castSec ?? 0.6) / (1 + (g.stats?.haste ?? 0) / 100);
  const SKEL_DPS = 0.231, GOLEM_DPS = 0.45; // weapon hits per second (30% every 1.3 s, 90% every 2 s)
  // Shaman hit units per second per target: claws (75 % of casts), the crow swarm (classic weapon only), the totem while up.
  const shParts = () => ({ claws: 0.75 * sk('spiritclaws').dmgPct / 100 / castSec('spiritclaws'),
    crows: sk('crows').sec ? 0 : sk('crows').dmgPct / 100 / (crowsDur() / 1000),
    totem: totemLeft() > 0 ? sk('ancestortotem').dmgPct / 100 / (sk('ancestortotem').duration ?? 12) : 0 });
  function priorMyDps() {
    const { hit } = curSheet();
    if (SHAMAN) { const p = shParts(); return hit * (p.claws + p.crows + p.totem); }
    if (REAPER) { // reap plus the bar spells at their cooldown, raised by the Trepas share
      const spells = g.char.bar.reduce((a, id) => a + (id && sk(id).cd ? (sk(id).dmgPct ?? 0) / 100 / cdOf(id) : 0), 0);
      return hit * (sk('reap').dmgPct / 100 / castSec('reap') + spells) / (1 - trepasTh());
    }
    return hit * (sk('bonebolt').dmgPct / 100 / castSec('bonebolt') + servantCount() * SKEL_DPS + (golemAlive() ? GOLEM_DPS : 0));
  }
  // Corruption (g.cor, bundle L7 L101719): per stack +4 % dealt, +5 % taken; at 10 the shadow drains 1 % life/s;
  // a light pylon (4.5 m) washes it off in 2 s. Learned models stay at 0 stacks; the live multipliers apply on top.
  const COR = { max: 10, dealt: 0.04, taken: 0.05, rot: 0.01, pylonR: 4.5 };
  const corDealt = () => 1 + COR.dealt * Math.min(COR.max, g.cor ?? 0), corTaken = () => 1 + COR.taken * Math.min(COR.max, g.cor ?? 0);
  // Open-world light pylons of La Faille (bundle WT L44755, plus the two by Vel'Khor at 176,168 -9,+9 / +10,-7).
  const WORLD_PYLONS = [{ x: 132, z: 138 }, { x: 146, z: 124 }, { x: 172, z: 136 }, { x: 150, z: 162 }, { x: 136, z: 176 },
    { x: 186, z: 158 }, { x: 168, z: 184 }, { x: 167, z: 177 }, { x: 186, z: 161 }];
  const myDps = () => priorMyDps() * ad.dpsRatio * corDealt();
  // Shaman: crows (3 m) and totem (8 m) hit every target, the claws line about half an extra one.
  const splashShare = () => REAPER ? 0.8 : SHAMAN ? (p => (p.crows + p.totem + 0.5 * p.claws) / (p.claws + p.crows + p.totem))(shParts())
    : (sk('bonebolt').splashPct ?? 0) / (sk('bonebolt').dmgPct || 1);

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
  // Threat floor: behind the army the learned dps of most kinds falls to ~0, which made every score 0 and let a target
  // 40 m away win over the one in range (the bot then held still out of range). A fifth of the def prior keeps the
  // time-to-kill term (distance included) deciding between near-harmless targets.
  // TODO(ceiling): the 0.2 share is a guess; a learned xp-per-second target value would replace it.
  const smith = (o, kite) => smithScore(Math.max(enemyDps(o.m), 0.2 * priorDps(o.m.def) * lvlScale(o.m.level)), o.m.hp, myDps(), o.d,
    kite && (o.m.def?.speed ?? 0) > PLAYER_SPEED, now() - (hitUs.get(o.m.id) ?? -1e9) < 3000) * questMul(o.m) * groupMul(o.m);

  // --- Engagement model: time to kill vs time to die, with a self-tuned safety margin.
  function engage(f, me) {
    const ttk = f.hp / Math.max(1e-6, me.dps * (1 + me.splash * Math.max(0, f.n - 1)));
    const pots = Math.min(me.potions, 1 + Math.floor(ttk / me.potCd));
    const ttd = (me.hp + pots * me.potHeal) / Math.max(1e-6, f.dps * (me.taken ?? 1) * (1 - me.soak));
    return { ttk, ttd, ok: ttd > ttk * me.margin };
  }
  const meState = () => ({
    dps: myDps(), hp: g.hp, potHeal: (SV.potion.instantPct + SV.potion.hotPct) / 100 * g.life, potions: g.char.potions, potCd: SV.potion.cdSec, splash: splashShare(),
    soak: SHAMAN ? shSoak() : REAPER ? rpSoak() : 0.2 + 0.2 * Math.min(1, servantCount() / skelCap()), margin: ad.margin, taken: corTaken(),
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
      const l = grouped() && grp.leadId != null ? g.party.find(p => p.id === grp.leadId) : null;
      if (l && sameMap(l)) { grp.fd += dist(g.sim, leaderPos(l)); grp.fn++; }
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
    // Group band: mean distance to the leader during fights won, within the class bounds.
    if (!died && grp.fn > 10) grp.band = Math.min(BAND[1], Math.max(BAND[0], ema(grp.band, grp.fd / grp.fn, 4)));
    grp.fd = 0; grp.fn = 0;
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
      kills: st.kills - f.kills0, xp: Math.round(gained), idle: +((f.idle ?? 0) / 1000).toFixed(1), walk: +((f.walk ?? 0) / 1000).toFixed(1),
      noKey: Object.fromEntries(Object.entries(f.why ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => [k, +(v / 1000).toFixed(1)])), outcome: died ? 'death' : f.disengaged ? 'disengage' : 'win',
      margin: +f.margin.toFixed(3), ttk: f.ttk && +f.ttk.toFixed(1), ttd: f.ttd && +f.ttd.toFixed(1) });
    if (fights.length > FIGHTS_MAX) fights.splice(0, fights.length - FIGHTS_MAX);
  }

  // --- Movement strategy: kite (threat geometry, kiteMove) against slow packs, hold behind the army against fast ones.
  // Prior from the share of slower enemies; learned xp/s per (strategy, kind) overrides once both have 1 min of data.
  function chooseStrat(eng) {
    if (!eng.length) return st.strat ?? 'hold';
    const slow = eng.filter(o => (o.m.def?.speed ?? 5) < PLAYER_SPEED).length / eng.length;
    const counts = {};
    for (const o of eng) counts[o.m.def?.kind] = (counts[o.m.def?.kind] ?? 0) + 1;
    const kind = st.mainKind = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
    if (PETLESS) return 'kite'; // no army to hold behind; kiteMove stays in the totem heal (shaman) or the scythe band (reaper)
    let s =slow >= 0.3 ? 'kite' : 'hold';
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
  // Hostile projectiles reaching us within 1.5 s: their rays, to step off. Hostile = first seen within 2 m of a monster
  // (our bolts, shards and corpse bursts start at us or at the cursor).
  const shotFoe = new Map();
  function shotsAtMe(me) {
    const out = [], list = g.projectiles?.list ?? new Map();
    for (const id of shotFoe.keys()) if (!list.has(id)) shotFoe.delete(id);
    for (const [id, p] of list) {
      if (!shotFoe.has(id)) shotFoe.set(id, [...g.entities.visibleMonsters()].some(m => !m.dead && dist(m.pos, p.pos) < 2 + (m.radius ?? 0.6)));
      if (!shotFoe.get(id)) continue;
      const rx = me.x - p.pos.x, rz = me.z - p.pos.z, v = Math.hypot(p.vel.x, p.vel.z) || 1, ux = p.vel.x / v, uz = p.vel.z / v;
      const tt = (rx * ux + rz * uz) / v;
      if (tt > 0 && tt < 1.5 && Math.abs(rx * uz - rz * ux) < 2 * ME_R) out.push({ x: p.pos.x, z: p.pos.z, ux, uz });
    }
    return out;
  }
  // Angle (rad) the pack covers seen from p: small = grouped for lines and splashes.
  function spread(p, eng) {
    if (eng.length < 2) return 0;
    const a = eng.map(o => Math.atan2(o.m.pos.z - p.z, o.m.pos.x - p.x)).sort((x, y) => x - y);
    let gap = a[0] + 2 * Math.PI - a[a.length - 1];
    for (let i = 1; i < a.length; i++) gap = Math.max(gap, a[i] - a[i - 1]);
    return 2 * Math.PI - gap;
  }
  // Threat geometry kite. Casting no longer roots (live bundle: bolts/claws/crows walk at 60 % until release, full speed
  // after), so attacks never stop; only the spot is chosen. Staying is free, moving is scored on: melee kinds we outrun
  // that can strike before our next action lands (horizon T), the band to the target, pack spread, idle packs, leash,
  // walls/danger spots, the totem heal (shaman) and hostile projectile rays. Faster kinds are fought in place (roll).
  function kiteMove(me, eng, tgtO) {
    const a = g.sim.action, T = (a ? Math.max(0, a.dur - a.t) : castSec(BASE_SKILLS[0])) + lat();
    const vMe = PLAYER_SPEED * (g.stats?.moveSpd ?? 1), tgt = tgtO?.m;
    const mel = eng.filter(o => !isRanged(o.m) && (o.m.def?.speed ?? 0) > 0);
    const flee = mel.filter(o => ATTACK_STATES.includes(o.m.state) && o.m.def.speed < vMe);
    const gapAt = (o, p) => strikeGap(dist(p, o.m.pos), reachOf(o.m), kMargin(o.m), o.m.def.speed, T, o.m.state === 'chase');
    // Reaper: the scythe edge band on the target [inner, outer - slip]; strikes are taken, so threats weigh little until hp is low.
    const band = REAPER ? { lo: sk('reap').inner ?? 1.4, hi: (sk('reap').range ?? 4.6) - Math.max(0.4, (tgt?.def?.speed ?? 0) * lat()) }
      : kiteBand(Math.max(0, ...mel.map(o => reachOf(o.m))), Math.max(0, ...mel.map(o => kMargin(o.m))),
        sk(BASE_SKILLS[0]).range ?? 12, (tgt?.def?.speed ?? 0) * lat());
    const fleeW = REAPER && g.hp / g.life >= 0.5 ? 0.3 : 3;
    const tot = SHAMAN && totemLeft() > 0, totR = (sk('ancestortotem').radius ?? 8) - ME_R;
    const idle = [...g.entities.visibleMonsters()].filter(m => !m.dead && m.hp > 0 && m.state === 'idle' && !eng.some(o => o.m === m));
    const shots = shotsAtMe(me), r = Math.max(1, vMe * T), last = now() - (st.kiteAt ?? -1e9) < 300 ? st.kiteDir : null;
    const score = p => {
      let v = 0;
      for (const o of flee) v += fleeW * Math.max(0, -gapAt(o, p));
      if (tgt) { const dt = dist(p, tgt.pos); v += Math.max(0, band.lo - dt) + Math.max(0, dt - band.hi); }
      v += spread(p, eng);
      for (const m of idle) v += Math.max(0, chaseRange(m.def?.kind) - dist(p, m.pos));
      if (st.home) v += Math.max(0, dist(p, st.home) - LEASH * 0.9);
      if (tot) v += Math.max(0, dist(p, st.totemPos) - totR);
      for (const s of shots) v += 3 * Math.max(0, 2 * ME_R - Math.abs((p.x - s.x) * s.uz - (p.z - s.z) * s.ux));
      return v;
    };
    let best = null, bv = score(me);
    for (let i = 0; i < 16; i++) {
      const ux = Math.cos(i * Math.PI / 8), uz = Math.sin(i * Math.PI / 8), p = { x: me.x + ux * r, z: me.z + uz * r };
      if (solid(p.x, p.z) || solid(me.x + ux * r / 2, me.z + uz * r / 2) || inDanger(p)) continue;
      const v = score(p) + 0.1 * r + (last ? 0.5 * (1 - ux * last[0] - uz * last[1]) : 0); // move cost, no zigzag
      if (v < bv) { bv = v; best = [ux, uz]; }
    }
    if (best && !last) {
      const n = mel.reduce((b, o) => !b || o.d < b.d ? o : b, null);
      (st.kiteLog ??= []).push({ d: n && +n.d.toFixed(1), k: n?.m.def?.kind, reach: n && +reachOf(n.m).toFixed(1), margin: n && +kMargin(n.m).toFixed(2),
        why: flee.some(o => gapAt(o, me) < 0) ? 'menace' : shots.length ? 'tir' : 'bande', casting: a?.type ?? null });
      if (st.kiteLog.length > 30) st.kiteLog.shift();
    }
    st.kiteDir = best; st.kiteAt = now();
    if (!best) { const p = dropPull(me); return p[0] || p[1] ? steer(...p) : [0, 0]; }
    return steer(...best);
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
  // --- Shaman (SHAMAN.md): state read off the predicted sim, then priority rules instead of EV.
  const FORM_FR = ['homme', 'loup', 'ours', 'mammouth', 'corbeau'];
  const crowsDur = () => (g.char.ch.tree?.sh_murder ? 4.5 : sk('crows').duration ?? 3) * 1000;
  const crowsLive = () => !!st.crowsPt && now() - st.crowsAt < crowsDur();
  const totemLeft = () => st.totemAt ? Math.max(0, (sk('ancestortotem').duration ?? 12) - (now() - st.totemAt) / 1000) : 0;
  const roarReady = () => now() - (st.roarAt ?? -1e9) > (sk('bearform').roarCd ?? 10) * 1000;
  // Harmony tier: distinct forms entered within the window (15 s, 20 with sh_circle); mammoth is III.
  // TODO(ceiling): tracked from transitions seen client side; the server count is not exposed.
  const harmonyTier = (seen, t, win) => Math.min(3, Object.values(seen).filter(at => t - at < win).length);
  const harmony = () => g.sim.form === 3 ? 3 : harmonyTier(st.formSeen ?? {}, now(), (g.char.ch.tree?.sh_circle ? 20 : 15) * 1000);
  // Per tick: form transitions (harmony, roar = bear entered with the breath ready), crow and totem casts.
  function shTick() {
    const s = g.sim, t = now(), a = s.action;
    if (s.form !== st.formPrev) {
      if (st.formPrev != null) { (st.formSeen ??= {})[s.form] = t; if (s.form === 2 && (st.comboPrev ?? 0) <= 0) st.roarAt = t; }
      st.formPrev = s.form;
    }
    st.comboPrev = s.comboTimer;
    if (a?.type === 'crows' && t - (st.crowsAt ?? -1e9) > 1000) { st.crowsAt = t; st.crowsPt = { x: a.tx, z: a.tz }; }
    if (a?.type === 'ancestortotem' && t - (st.totemAt ?? -1e9) > 2000) { st.totemAt = t; st.totemPos = { x: a.tx, z: a.tz }; }
  }
  // Damage taken saved: harmony 5 % per tier, bear 8 %, mammoth 40 %, crows make 30 % of the swarmed attackers miss.
  function shSoak() {
    const f = g.sim.form;
    if (f === 3) return 0.4;
    const near = [...g.entities.visibleMonsters()].filter(m => !m.dead && m.hp > 0 && dist(m.pos, g.sim) < 8);
    const cover = crowsLive() && near.length ? near.filter(m => dist(m.pos, st.crowsPt) <= sk('crows').radius).length / near.length : 0;
    return 0.05 * harmony() + (f === 2 ? 0.08 : 0) + 0.3 * cover;
  }
  // --- Reaper (REAPER.md): souls (g.sim.fury), Trepas threshold, spectral form, Shroud after a kill.
  const souls = () => g.sim.fury ?? 0;
  const soulTier = () => Math.min(4, Math.floor(souls() / 25));
  const trepasTh = () => 0.14 + 0.03 * soulTier() + 0.03 * (g.char.ch.tree?.rp_harvester ?? 0);
  const wraithLeft = () => st.wraithAt ? Math.max(0, (sk('wraithform').duration ?? 7) - (now() - st.wraithAt) / 1000) : 0;
  function rpTick() {
    const a = g.sim.action, t = now();
    if (a?.type === 'wraithform' && t - (st.wraithAt ?? -1e9) > 2000) st.wraithAt = t;
  }
  // Damage taken saved: spectral form 50 %, Shroud 20 % for 2 s after a kill near us.
  const rpSoak = () => wraithLeft() > 0 ? 0.5 : now() - (st.killAt ?? -1e9) < 2000 ? 0.2 : 0;
  // Roll landing point: the reaper roll teleports to the cursor (+1.6 m, 9 m max), so every roll aims explicitly.
  const rollAim = dir => { const l = Math.hypot(dir[0], dir[1]) || 1; return { x: g.sim.x + dir[0] / l * 7.4, z: g.sim.z + dir[1] / l * 7.4 }; };
  // Dodge: sh_dodge gives Raven flight a 2nd charge (cd 4 s, usable while cds.roll <= 4), so rolls may chain after 2 s.
  // Reaper: charges come from ready('roll'); 300 ms between two passes.
  const rollReady = () => REAPER ? ready('roll') && now() - (st.rollAt ?? 0) > 300
    : (SHAMAN && g.char.ch.tree?.sh_dodge ? (g.sim.cds?.roll ?? 0) <= 4.01 : ready('roll'))
    && now() - (st.rollAt ?? 0) > (SHAMAN && g.char.ch.tree?.sh_dodge ? 2000 : 4600);
  // Mobs on the line from me through each candidate within range (half width w): best direction and its end point.
  function bestLine(mobs, range, w) {
    let best = null, bn = 0;
    for (const o of mobs) {
      if (o.d > range || o.d < 0.1) continue;
      const ux = (o.m.pos.x - g.sim.x) / o.d, uz = (o.m.pos.z - g.sim.z) / o.d;
      let n = 0, far = 0;
      for (const p of mobs) {
        const px = p.m.pos.x - g.sim.x, pz = p.m.pos.z - g.sim.z, along = px * ux + pz * uz;
        if (along > 0 && along < range && Math.abs(px * uz - pz * ux) < w) { n++; far = Math.max(far, along); }
      }
      if (n > bn) { bn = n; const r = Math.min(range, far + 2); best = { x: g.sim.x + ux * r, z: g.sim.z + uz * r, n }; }
    }
    return best;
  }
  // Returns { id, slot, aim, ev (priority), toggle } or null. Forms are toggles: decideRaw presses them once.
  // In wolf/bear, slots 0/1 are the beast clicks: slot 1 (15-20 spirit, the wolf leaps) is never pressed.
  function chooseShaman({ mobs, attackers, hpPct, ess }) {
    const s = g.sim, f = s.form, bar = g.char.bar, res = reserve();
    const on = id => bar.includes(id) && ready(id), slot = id => bar.indexOf(id), R = id => sk(id).radius, rg = id => sk(id).range;
    const near = r => mobs.filter(o => o.d <= r), elite = list => list.some(o => o.m.elite || o.m.boss);
    const contact = attackers.some(o => o.d < 3), canShift = now() > (st.formNext ?? 0), t = mobs.reduce((a, o) => !a || o.d < a.d ? o : a, null);
    const go = (id, ev, aim = null, extra = {}) => ({ id, slot: slot(id), aim, ev, ...extra });
    if (f === 4 || /form$/.test(s.action?.type ?? '')) return null; // mid flight or mid shift
    if (f === 3) { // mammoth: Charge (RMB, cd 3) when ready, else Tusks at the pack
      if (t && ready('stampede') && t.d <= 10) return { id: 'stampede', slot: 1, aim: t.m.pos, ev: 9 };
      return t && t.d < 6 ? { id: 'tusks', slot: 0, aim: bestAoe(mobs, 4, 3.6) ?? t.m.pos, ev: 1 } : null;
    }
    if (f === 1 || f === 2) { // beast: back to human once the breath is ready again (heal 10 %, +15 spirit)
      const id = f === 1 ? 'wolfform' : 'bearform';
      if (s.comboTimer <= 0 && canShift && on(id)) return go(id, 8, null, { toggle: true });
      return t && t.d < 2.5 ? { id: f === 1 ? 'bite' : 'swipe', slot: 0, aim: t.m.pos, ev: 1 } : null;
    }
    // Human form.
    const bearOk = on('bearform') && canShift && roarReady() && s.comboTimer <= 0;
    if (hpPct < 0.4 && contact && bearOk && ess >= 10) return go('bearform', 10, null, { toggle: true });
    if (on('mammoth') && (near(R('mammoth')).length >= 4 || elite(near(R('mammoth'))) || (hpPct < 0.35 && attackers.length >= 2))) return go('mammoth', 9);
    if (on('ancestortotem')) {
      const aim = bestAoe(mobs, rg('ancestortotem'), R('ancestortotem')), inR = aim ? mobs.filter(o => dist(o.m.pos, aim) <= R('ancestortotem')) : [];
      if (inR.length >= 2 || elite(inR)) return go('ancestortotem', 7, aim);
    }
    if (on('boarcharge')) {
      const ln = bestLine(mobs, rg('boarcharge'), R('boarcharge'));
      if (ln && (ln.n >= 2 || elite(near(rg('boarcharge'))) || (contact && hpPct < 0.6))) return go('boarcharge', 6, ln);
    }
    if (on('primalcall')) {
      const aim = bestAoe(mobs, rg('primalcall'), R('primalcall')), inR = aim ? mobs.filter(o => dist(o.m.pos, aim) <= R('primalcall')) : [];
      if (inR.length >= 2 || elite(inR)) return go('primalcall', 5, aim);
    }
    // Circle weave: monsters within 5 m and the breath ready: bear (roar ready) or wolf, back to human 3 s later.
    if (near(5).length && s.comboTimer <= 0 && canShift && ess >= Math.max(5, res)) {
      if (bearOk) return go('bearform', 4, null, { toggle: true });
      if (on('wolfform')) return go('wolfform', 4, null, { toggle: true });
    }
    // One swarm at a time: recast when expired or empty (non-classic weapons: weak RMB, skipped).
    if (bar.includes('crows') && !sk('crows').sec && !(crowsLive() && mobs.some(o => dist(o.m.pos, st.crowsPt) <= R('crows')))) {
      const aim = bestAoe(mobs, rg('crows'), R('crows'));
      if (aim) return go('crows', 3, aim);
    }
    const aim = bestAoe(mobs, rg('spiritclaws'), 1.5); // 3 m line under the cursor
    return aim ? go('spiritclaws', 2, aim) : null;
  }
  // Reaper priorities (REAPER.md "Combat"): survival, requiem, mark, knell, spectral rush, phantom scythe, harvest, reap.
  // Clicks root: reap only on a monster inside the edge [inner, range].
  function chooseReaper({ mobs, attackers, hpPct, ess }) {
    const bar = g.char.bar, on = id => bar.includes(id) && ready(id), R = id => sk(id).radius, rg = id => sk(id).range;
    const go = (id, ev, aim = null) => ({ id, slot: bar.indexOf(id), aim, ev });
    const near = r => mobs.filter(o => o.d <= r), elite = list => list.some(o => o.m.elite || o.m.boss);
    const contact = attackers.filter(o => o.d < 3);
    if (g.sim.action?.type === 'requiem') return null;
    if (on('wraithform') && !wraithLeft() && ((hpPct < 0.5 && attackers.length >= 2) || elite(contact))) return go('wraithform', 10);
    if (on('requiem') && ((hpPct < 0.3 && !wraithLeft() && !on('wraithform') && attackers.length) || near(R('requiem')).length >= 4 || elite(near(R('requiem'))))) return go('requiem', 9);
    if (on('doom')) {
      const aim = bestAoe(mobs, rg('doom'), R('doom')), inR = aim ? mobs.filter(o => dist(o.m.pos, aim) <= R('doom')) : [];
      if (inR.length >= 2 || elite(inR)) return go('doom', 8, aim);
    }
    if (on('knell') && (near(R('knell')).length >= 2 || elite(near(R('knell'))))) return go('knell', 7);
    if (on('souldash')) {
      const ln = bestLine(mobs, rg('souldash'), R('souldash'));
      if (ln && dist(ln, g.sim) >= (sk('souldash').minRange ?? 4) && (ln.n >= 2 || elite(near(rg('souldash'))) || contact.length >= 3)) return go('souldash', 6, ln);
    }
    if (on('phantom')) {
      const ln = bestLine(mobs.filter(o => o.d >= 5), rg('phantom'), R('phantom'));
      if (ln) return go('phantom', 5, ln);
    }
    const hv = sk('harvest'), cost = (hv.cost ?? 22) - (g.char.ch.tree?.rp_harvest && !hv.dash ? 10 : 0);
    if (bar.includes('harvest') && ess >= cost) {
      if (hv.dash) { const ln = bestLine(mobs, hv.range, hv.radius); if (ln?.n >= 2) return go('harvest', 4, ln); }
      else {
        const inR = near(hv.radius), fin = inR.some(o => !o.m.boss && (o.m.hp - curSheet().hit * hv.dmgPct / 100) / (o.m.maxHp ?? o.m.hp) < trepasTh());
        if (inR.length >= 2 || fin) return go('harvest', 4, inR[0].m.pos);
      }
    }
    const rp = sk('reap'), edge = mobs.filter(o => o.d >= (rp.inner ?? 1.4) && o.d <= rp.range);
    return edge.length ? go('reap', 2, edge[0].m.pos) : null;
  }
  // TODO(ceiling): utility horizons (skeleton 20 s, golem 30 s) are guesses; xp/s learning does not tune them.
  function chooseSkill(ctx) {
    if (SHAMAN) return chooseShaman(ctx);
    if (REAPER) return chooseReaper(ctx);
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
        val = dmgAt(mobs, aim, s.radius ?? 2, pct, spl, hit) + (id === 'blight' && aim && s.corpse !== false ? corpseVal : 0);
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
  const BASE_SKILLS = SHAMAN ? ['spiritclaws', 'crows'] : REAPER ? ['reap', 'harvest'] : ['bonebolt', 'blight'];
  // TODO(ceiling): allies carry no owner field: skeletons within 25 m are assumed to be ours.
  const servantCount = () => PETLESS ? 0 : myAllies().filter(a => a.def?.kind === 'skeleton').length;
  // TODO(ceiling): allies carry no owner field: any ally within 25 m is assumed to be ours.
  const myAllies = () => [...g.entities.allies.values()].map(a => a.view).filter(v => v && !v.dead && dist(v.pos, g.sim) < 25);
  // The flesh golem ally uses the `abomination` monster def (client tints ally abominations, L70353).
  const golemAlive = () => !PETLESS && myAllies().some(v => v.def?.kind === 'abomination');
  const skelCap = () => PETLESS ? 0 : g.level >= 15 ? 6 : g.level >= 8 ? 5 : 4;
  function progress() {
    if (!BUILD || now() - (st.progAt ?? 0) < 3000) return;
    st.progAt = now();
    const ch = g.char.ch, tree = ch.tree ?? {};
    const spent = Object.values(tree).reduce((a, n) => a + n, 0);
    const next = BUILD.talents[spent];
    if (window.__botOpts?.autoTalents === true && spent < ch.level && next && next.level <= ch.level) { g.actions.learnTalent(next.id); st.lastTalent = next.id; return; }
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
  // Charges (attack 'charge': gorvak from ~15 m, crawler, beetle) carry no telegraph: during the windup, the line along
  // the charger's facing (our distance + 4 m long, its body plus ours wide) is treated as a line telegraph, left sideways.
  const LINE_ATTACKS = ['charge'];
  function chargeScan(me, mg) {
    for (const c of g.entities.visibleMonsters()) {
      if (c.dead || c.state !== 'windup' || !LINE_ATTACKS.includes(c.attack)) continue;
      const fx = Math.sin(c.yaw ?? 0), fz = Math.cos(c.yaw ?? 0), dx = me.x - c.pos.x, dz = me.z - c.pos.z;
      const along = dx * fx + dz * fz, perp = dx * fz - dz * fx, d = Math.hypot(dx, dz);
      if (d < 25 && along > -mg && along < d + 4 && Math.abs(perp) < (c.radius ?? 0.6) + ME_R + mg) { const side = perp >= 0 ? 1 : -1; return [fz * side, -fx * side]; }
    }
    return null;
  }
  function teleScan(me, m) {
    const ch = chargeScan(me, m);
    if (ch) return ch;
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
      if (!(AUTO_LOOT.has(d.kind) || (d.kind === 'item' && !bagFullNow)) || !(lootScore(d) > 0)) continue;
      const dd = dist(d.pos, me);
      if (dd < bd) { bd = dd; best = d; }
    }
    return best;
  }
  // Goal score of a drop: unknown item 0.6, upgrade up to 1.05 by relative gear score gain, else 0.45 (sell value).
  // Health globe: worth the hp it restores (learned heal fraction ad.globe, prior = what is missing), scaled by how soon
  // we need it: at once while hit in the last 4 s, else by the deficit over one globe (small deficits regen anyway).
  // The client only collects globes below full life and potions below 10, so those are worth 0 otherwise.
  // In a fight the globe is worth what the predicted hp trajectory needs: hp left after the incoming dps over the time to
  // clear what is engaged (st.incoming, st.ttkEng, set each tick), measured against the potion line plus one globe.
  // On the way (2.5 m) it is cheap; out of a fight, the deficit over one globe as before.
  function globeValue(d = 99) {
    const miss = Math.max(0, 1 - g.hp / g.life), heal = ad.globe || miss;
    if (!miss) return 0;
    const fill = Math.min(miss, heal) / heal;
    if (!st.fight) return fill * Math.min(1, miss / heal);
    const low = g.hp - (st.incoming ?? 0) * (st.ttkEng ?? 0), line = (potionAt() + heal) * g.life;
    const need = Math.min(1, Math.max(0, (line - low) / (heal * g.life)));
    return fill * Math.max(need, d < 2.5 ? 0.6 : 0);
  }
  function lootScore(d) {
    if (d?.kind === 'globe') return 0.95 * globeValue(dist(d.pos, g.sim));
    if (d?.kind === 'potion' && g.char.potions >= 10) return 0;
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
  const myWeapons = () => Object.keys(SV.gear?.weaponBases ?? {}).filter(k => k !== 'rule').concat(SV.gear ? [] : SHAMAN ? ['totem', 'antlerstaff', 'hatchet'] : REAPER ? ['scythe', 'sickle', 'greatscythe'] : ['bonewand', 'deathstaff']);
  const reqLvl = it => Math.max(1, Math.min(200, Number.isFinite(it.ilvl) ? (Math.floor(it.ilvl) === 31 ? 30 : Math.floor(it.ilvl)) : 1));
  // Score: dps x sqrt(EHP) of the whole sheet with `it` worn.
  function gearScore(it) {
    if (!it) return 0;
    if (it.slot === 'weapon' && !myWeapons().includes(it.base)) return -1;
    const s = sheet(it); return s.dps * Math.sqrt(s.ehp) * (REAPER ? s.vt / 7.95 : 1);
  }
  // Score of what we wear in that slot (empty slot: the sheet as is).
  const wornScore = slot => { const s = sheet(); return s.dps * Math.sqrt(s.ehp) * (REAPER ? s.vt / 7.95 : 1); };
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

  // Quest objective. Main story chain first (user rule: do it in order, it leads to the next zones): its HUD step when
  // actionable; then NPC markers (turn-ins, new quests), then the guided quest; a level-locked main step comes last.
  function questObjective(g, zones = []) {
    const story = g.char?.story;
    if (!story) return null;
    const me = { x: g.sim.x, z: g.sim.z };
    const d = p => Math.hypot(p.x - me.x, p.z - me.z);
    const mainId = document.querySelector('.quest.hud-block .quest-main')?.dataset.q;
    const main = mainId ? questFromBlock(g, zones, mainId) : null;
    if (main && main.type !== 'other') return { ...main, main: true };
    // NPC markers, refreshed by the client every 0.4 s (HY L73629, S1 L82608).
    const views = (g.npcs?.views ?? []).filter(v => !(QUEST_SKIP.get(v.def.id) > Date.now()));
    const at = v => ({ x: v.root.position.x, z: v.root.position.z });
    const best = m => views.filter(v => v.marker === m)
      .sort((a, b) => (b.story - a.story) || (d(at(a)) - d(at(b))))[0];
    for (const m of ['turn', 'give']) {
      const v = best(m);
      if (v) return { type: 'talk', npc: v.def.id, ...at(v), label: `${m === 'turn' ? 'Parler/rendre' : 'Prendre'} : ${v.def.name}` };
    }
    // Guided quest (compass) and its HUD block (Jae L93590).
    const id = document.querySelector('.quest.hud-block .quest-guide.on')?.dataset.guide;
    return (id && id !== mainId ? questFromBlock(g, zones, id) : null) ?? main;
  }
  function questFromBlock(g, zones, id) {
    const block = document.querySelector(`.quest.hud-block [data-q="${id}"]`);
    if (!block) return null;
    const title = block.querySelector('.quest-name span')?.textContent ?? id;
    const line = [...block.querySelectorAll('.quest-text')].find(e => !e.classList.contains('qdone') && !e.classList.contains('quest-alt'));
    if (!line) return null;
    const text = line.textContent.trim();
    const lock = text.match(/^Niveau (\d+)/);
    if (lock) return { type: 'other', minLevel: +lock[1], label: `${title} : ${text}` };
    const cnt = line.querySelector('b')?.textContent.match(/(\d+)\/(\d+)/);
    const name = (cnt ? text.slice(0, text.lastIndexOf(cnt[0])) : text).trim();
    // TODO(ceiling): the compass points at the guided quest; a main step read while another quest is guided may carry
    // that quest's target.
    const t = g.compass?.target; // {x, z, r}: zone for kill/collect, NPC, dungeon entrance...
    const base = { label: `${title} : ${text}`, ...(t ? { x: t.x, z: t.z, r: t.r } : {}) };
    if (t) {
      const zone = zones.find(z => Math.hypot(z.x - t.x, z.z - t.z) < Math.max(z.r, t.r));
      if (zone) base.minLevel = zone.lvl[0];
    }
    if (/^Tuer : /.test(name)) return { type: 'kill', kind: name.slice(7), need: cnt ? +cnt[2] : 1, have: cnt ? +cnt[1] : 0, ...base };
    if (/^Abattre /.test(name)) return { type: 'kill', kind: name.slice(8), need: 1, have: 0, ...base };
    if (/^Parler à /.test(name)) { // resolve the NPC by name so the talk goal can run it (markers do not cover main steps)
      const nm = name.slice(9).trim(), v = (g.npcs?.views ?? []).find(x => x.def?.name && (nm.startsWith(x.def.name) || x.def.name.startsWith(nm)));
      return { type: 'talk', ...base, ...(v ? { npc: v.def.id, x: v.root.position.x, z: v.root.position.z } : {}) };
    }
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
    // Nothing quest-related happened during this talk: ignore that NPC's marker for 5 min, doubled at each fruitless
    // talk in a row (a turn-in that lacks its items no longer drags the bot back every 5 min).
    const fails = st.talkFails ??= new Map();
    if ((st.questEventAt ?? 0) <= st.talk.questAt) { const n = fails.get(st.talk.npc) ?? 0; fails.set(st.talk.npc, n + 1); QUEST_SKIP.set(st.talk.npc, Date.now() + 5 * 60000 * 2 ** n); }
    else { fails.delete(st.talk.npc); ad.qx.talk = ema(ad.qx.talk, now() - st.talk.at, ad.qx.tn++); }
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
  // Monster flag bits (bundle _F/bF L57510): sealed boss (seals alive), warded (shield), enraged.
  const MF = { enraged: 2, warded: 1 << 17, sealed: 1 << 19 };
  const isSeal = m => m.def?.kind === 'seal';
  // Seals (DUNGEONS.md 0): positions from layout.seals; one is done once we stood within 8 m of it with no live seal
  // entity within 3 m, or for all once the boss is seen without the sealed bit.
  function sealsLeft() {
    const L = g.dungeon?.layout, r = st.dun;
    if (!L?.seals?.length || !r) return [];
    const done = r.sealsDone ??= new Set(), live = [...g.entities.visibleMonsters()].filter(m => !m.dead && m.hp > 0);
    const boss = live.find(m => m.boss);
    if (boss && !(boss.flags & MF.sealed)) for (const s of L.seals) done.add(`${s.x | 0},${s.z | 0}`);
    for (const s of L.seals) if (dist(g.sim, s) < 8 && !live.some(m => isSeal(m) && dist(m.pos, s) < 3)) done.add(`${s.x | 0},${s.z | 0}`);
    return L.seals.filter(s => !done.has(`${s.x | 0},${s.z | 0}`));
  }
  // Target weight in dungeons (DUNGEONS.md 3.2): seals first, then summoners/healers casting; sealed boss and warded
  // monsters are dropped from the ranking by allowedDun.
  const SUMMON = /^(mend|raise)$|call$|howl$|^warcry$|^rallyfire$|^brood$/;
  const dunMul = m => !g.dungeon ? 1 : isSeal(m) ? 1e6 : m.attack === 'cast' && m.state === 'windup' && SUMMON.test(m.spell ?? '') ? 10 : 1;
  const allowedDun = (o, list) => !g.dungeon || !((o.m.boss && o.m.flags & MF.sealed && sealsLeft().length)
    || (o.m.flags & MF.warded && list.some(x => x !== o && !(x.m.flags & MF.warded))));
  // Environment out of fights (DUNGEONS.md 3.3): warm up at a brazier when the cold bites, cleanse at a pylon when corrupted.
  // Pylon to cleanse at, or null. Up to 9 stacks corruption is a trade (+36 % dealt, +45 % taken, both in the models);
  // the 10th starts the drain, so we cleanse once at 9 (the game's max - 1), or from max - 3 when a pylon is within 15 m
  // (on the way between packs). Called between packs only (farm branch, dungeon exploration): the current pack is
  // finished first. Once there, we stand inside the 4.5 m light until the stacks are gone.
  function cleanseNeed() {
    const cor = g.cor ?? 0;
    if (!cor) { st.cleansing = false; return null; }
    const pyl = g.dungeon ? (g.dungeon.layout.placements ?? []).filter(p => p.name === 'pylon') : WORLD_PYLONS;
    const p = pyl.reduce((b, x) => !b || dist(g.sim, x) < dist(g.sim, b) ? x : b, null);
    if (!p || dist(g.sim, p) > 120) return null;
    if (st.cleansing || cor >= COR.max - 1 || (cor >= COR.max - 3 && dist(g.sim, p) < 15)) {
      if (!st.cleansing) { st.cleansing = true; st.cleanses = (st.cleanses ?? 0) + 1; jlog('purification', { cor, d: Math.round(dist(g.sim, p)) }); }
      return p;
    }
    return null;
  }
  const cleanseMove = (p, key) => { st.last = `purifie la corruption (${g.cor}) au pylône`; return dist(g.sim, p) > COR.pylonR - 1 ? travelPath({ x: p.x, z: p.z }, key) : [0, 0]; };
  function dunEnv(r, L, t) {
    const near = name => (L.placements ?? []).filter(p => p.name === name).sort((a, b) => dist(g.sim, a) - dist(g.sim, b))[0];
    if (g.dungeon.def.rule === 'cold' && !g.warm && (g.sim.chill ?? 0) >= (r.warming ? 20 : 60)) {
      const b = near('brazier'); r.warming = !!b;
      if (b) { st.last = `donjon : se réchauffe (froid ${Math.round(g.sim.chill)})`; return dist(g.sim, b) > 2.5 ? travel({ x: b.x, z: b.z }, 'dungeon') : [0, 0]; }
    } else if (g.warm && (g.sim.chill ?? 0) >= 20 && r.warming) { st.last = 'donjon : se réchauffe'; return [0, 0]; }
    else r.warming = false;
    const p = g.dungeon.def.rule === 'corruption' ? cleanseNeed() : null;
    return p ? cleanseMove(p, 'dungeon') : null;
  }
  // Boss enrage (DUNGEONS.md 3.3): enraged, or 20 s before def.boss.enrageAfter after the pull, with the boss above 30 %:
  // leave rather than die (the run is a bail).
  function enrageWatch() {
    const r = st.dun, boss = [...g.entities.visibleMonsters()].find(m => m.boss && !m.dead && m.hp > 0);
    if (!r || !boss) return;
    if (!r.pullAt && ATTACK_STATES.includes(boss.state)) r.pullAt = now();
    const after = g.dungeon.def.boss?.enrageAfter;
    if (r.pullAt && boss.hp / (boss.maxHp || boss.hp) > 0.3 && (boss.flags & MF.enraged || (after && now() - r.pullAt > (after - 20) * 1000))) {
      r.phase = 'sortie'; r.bail = true; r.flee = true;
    }
  }
  // Dungeon run for the picked dungeon arm (farming or a "Terminer : X" quest): door, rooms in order, boss, chest, leave.
  // No server cooldown exists in the client; a bailed run blocks that dungeon for 30 min.
  const DUN_SKIP = new Map(); // dungeon id -> retry timestamp after a bailed run
  function dungeonRun() {
    if (grouped() && !(g.dungeon && g.dstate?.boss && !g.dstate.opened)) return [0, 0]; // grouped: the leader runs it, we open our chest
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
      // The chest refuses players not credited with the boss kill (toast caught in onMessage, likely a server bug):
      // 3 refusals, then skip it and leave; fallback 5 sends without any answer.
      r.phase = !ds.boss ? 'exploration' : !ds.opened && (r.chestDenied ?? 0) < 3 && (r.chestTries ?? 0) < 5 ? 'coffre' : 'sortie';
      if (r.phase === 'sortie' && t - r.inAt < 10000) r.instantClear = true;
    }
    if (r.phase === 'exploration') {
      const env = dunEnv(r, L, t);
      if (env) return env;
      // Route (DUNGEONS.md 3.1): path halls, then annexes (miniboss, side: 2 of the 3 seals sit there), then the seals left,
      // then the boss. rooms[] lists the boss room inside the path, so it is never a waypoint. Past 60 % of the time
      // budget, annexes without a seal are skipped; seals never are.
      if (!r.order) {
        r.order = [...L.rooms.filter(x => x.kind === 'hall'), ...L.rooms.filter(x => x.kind === 'miniboss' || x.kind === 'side')];
        if ((L.seals?.length ?? 0) !== (dg.def.rules?.seals ?? 0)) console.warn(`bot: seals ${L.seals?.length ?? 0}/${dg.def.rules?.seals ?? 0}, partial placement`);
      }
      const late = t - r.inAt > 0.6 * DUN_MAX_MS, sealRoom = x => sealsLeft().some(sl => sl.room === x.id);
      r.oi ??= 0;
      while (r.oi < r.order.length && (dist(me, { x: r.order[r.oi].cx, z: r.order[r.oi].cz }) < 5 || (late && r.order[r.oi].kind !== 'hall' && !sealRoom(r.order[r.oi])))) r.oi++;
      r.room = r.oi + 1;
      if (r.oi < r.order.length) {
        const room = r.order[r.oi];
        st.last = `donjon : salle ${r.oi + 1}/${r.order.length} (${room.kind})`;
        return travel({ x: room.cx, z: room.cz }, 'dungeon');
      }
      const sl = sealsLeft().sort((a, b) => dist(me, a) - dist(me, b))[0];
      if (sl) { st.last = `donjon : sceau ${sealsLeft().length} restant(s)`; return travel({ x: sl.x, z: sl.z }, 'dungeon'); }
      st.last = 'donjon : boss';
      return travel(L.boss, 'dungeon');
    }
    if (r.phase === 'coffre') {
      st.last = 'donjon : ouvre le coffre';
      // Server range is tighter than the client prompt (4.4 m): each unanswered request walks 0.5 m closer.
      if (dist(me, L.chest) > 3.5) return travel(L.chest, 'dungeon');
      if (t - (st.dunSendAt ?? 0) > 2000) { st.dunSendAt = t; r.chestTries = (r.chestTries ?? 0) + 1; g.send({ t: 'dungeon', a: 'chest' }); }
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
    if (grouped() && !(g.char.bag.filter(Boolean).length >= g.char.bag.length || g.char.potions === 0)) return false;
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
    // Binary min-heap on f (the old linear scan cost O(n^2) on long trips).
    const push = e => { open.push(e); for (let i = open.length - 1; i > 0;) { const p = (i - 1) >> 1; if (open[p][0] <= open[i][0]) break; [open[p], open[i]] = [open[i], open[p]]; i = p; } };
    const pop = () => {
      const top = open[0], last = open.pop();
      if (open.length) { open[0] = last; for (let i = 0; ;) { const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < open.length && open[l][0] < open[m][0]) m = l; if (r < open.length && open[r][0] < open[m][0]) m = r;
        if (m === i) break; [open[m], open[i]] = [open[i], open[m]]; i = m; } }
      return top;
    };
    const route = (x, z) => {
      const pts = []; let k = key(x, z), p = [x, z];
      while (p) { pts.push({ x: p[0], z: p[1] }); p = came.get(k); k = p && key(p[0], p[1]); }
      pts.reverse();
      return pts.filter((_, i) => i % 3 === 0 || i === pts.length - 1);
    };
    let n = 0, best = [h(sx, sz), sx, sz];
    while (open.length && n++ < MAX_NODES) {
      const [, c, x, z] = pop();
      if (c > cost.get(key(x, z))) continue;
      if (h(x, z) < best[0]) best = [h(x, z), x, z];
      if (Math.abs(x - tx) <= 1 && Math.abs(z - tz) <= 1) return route(x, z);
      for (const [dx, dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]) {
        const nx = x + dx, nz = z + dz, nk = key(nx, nz);
        if (solid(nx, nz) || spots.some(s => Math.hypot(nx - s.x, nz - s.z) < s.r)) continue;
        if (dx && dz && (solid(x + dx, z) || solid(x, z + dz))) continue;
        const nc = c + (dx && dz ? 1.414 : 1);
        if (nc < (cost.get(nk) ?? Infinity)) { cost.set(nk, nc); came.set(nk, [x, z]); push([nc + h(nx, nz), nc, nx, nz]); }
      }
    }
    // Budget spent or goal walled off: walk to the explored cell closest to the goal (a straight line hits walls);
    // travelPath replans from there once progress stops.
    return best[1] === sx && best[2] === sz ? null : route(best[1], best[2]);
  }

  // Waystones (client table `Sd`): awakened by walking past, travel between awakened ones out of combat,
  // bind one to respawn there.
  const WAYS = [
    { id: 'valbrune', x: 11, z: 55 }, { id: 'hurlements', x: -36, z: 15 }, { id: 'gobelins', x: -64, z: -24 },
    { id: 'cimetiere', x: 38, z: 19 }, { id: 'sombrebois', x: 47, z: -30 }, { id: 'grukk', x: 8, z: -70 },
    { id: 'brumelande', x: -124, z: 44 }, { id: 'cendre', x: 128, z: -9 }, { id: 'necropole', x: 30, z: -133 },
    { id: 'rochenoire', x: -94, z: -88 }, { id: 'forteresse', x: 157, z: -62 }, { id: 'citadelle', x: -27, z: -178 },
    { id: 'moisivert', x: -104, z: 128 }, { id: 'givrecroc', x: 6, z: 142 }, { id: 'faille', x: 132, z: 126 },
    { id: 'puits', x: 40, z: 196 }, { id: 'coeur', x: 170, z: 192 },
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
    if (grouped() || !st.home || now() - (st.bindAt ?? 0) < 10000) return;
    const w = nearestWay(st.home, awake());
    if (w && g.char.bound !== w.id && dist(g.sim, w) < 3) { st.bindAt = now(); g.send({ t: 'bind', w: w.id }); st.binds = (st.binds ?? 0) + 1; }
  }

  // Follow a path to goal, taking a waystone for long trips.
  function travel(goal, key = 'goal') {
    return wayShortcut(goal, key) ?? travelPath(goal, key);
  }
  // Follow a path to goal; recompute when goal changes or no progress for 2 s.
  // One path cache per caller (key), so alternating callers never recompute each other's path.
  // Distance from p to segment ab, and a wall-free straight line from a to b (0.5 m steps).
  const segDist = (p, a, b) => { const vx = b.x - a.x, vz = b.z - a.z, l2 = vx * vx + vz * vz || 1, t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.z - a.z) * vz) / l2)); return Math.hypot(p.x - a.x - vx * t, p.z - a.z - vz * t); };
  const clearLine = (a, b) => { const n = Math.ceil(dist(a, b) / 0.5); for (let k = 1; k <= n; k++) if (solid(a.x + (b.x - a.x) * k / n, a.z + (b.z - a.z) * k / n)) return false; return true; };
  console.assert(segDist({ x: 1, z: 1 }, { x: 0, z: 0 }, { x: 2, z: 0 }) === 1 && segDist({ x: 3, z: 0 }, { x: 0, z: 0 }, { x: 2, z: 0 }) === 1, 'segDist');
  // Waypoint to walk to, never one behind us (shared by every path follower through travelPath): after a jump (reaper
  // roll/rush, knockback) or a corner cut, project onto the next segments and take the end of the closest one reached
  // when it is in line of sight; then skip any waypoint lying behind us along its outgoing segment.
  function aheadIdx(pts, i, me, los) {
    let bk = -1, bd = Infinity;
    for (let k = Math.max(0, i - 1); k < Math.min(pts.length - 1, i + 12); k++) {
      const d = segDist(me, pts[k], pts[k + 1]);
      if (d < bd) { bd = d; bk = k; }
    }
    if (bk + 1 > i && bd < 3 && los(me, pts[bk + 1])) i = bk + 1;
    const behind = k => (pts[k].x - me.x) * (pts[k + 1].x - pts[k].x) + (pts[k].z - me.z) * (pts[k + 1].z - pts[k].z) < 0;
    while (i < pts.length - 1 && behind(i) && los(me, pts[i + 1])) i++;
    return i;
  }
  (() => {
    const P = [0, 3, 6, 9, 12].map(x => ({ x, z: 0 })), yes = () => true;
    if (aheadIdx(P, 1, { x: 8, z: 0.5 }, yes) !== 3) console.warn('bot self-check failed: aheadIdx after a jump');
    if (aheadIdx(P, 1, { x: 1, z: 0 }, yes) !== 1) console.warn('bot self-check failed: aheadIdx keeps the next waypoint');
    if (aheadIdx(P, 1, { x: 8, z: 0.5 }, () => false) !== 1) console.warn('bot self-check failed: aheadIdx needs line of sight');
  })();
  function travelPath(goal, key = 'goal') {
    const me = g.sim, navs = st.navs ??= {};
    st.trav = { goal, key, n: st.tickN };
    const nav = navs[key];
    const partEnd = nav && !nav.failed && dist(me, nav.pts.at(-1)) < 1.5 && dist(nav.pts.at(-1), goal) > 2; // partial path walked
    if (!nav || dist(nav.goal, goal) > 2 || now() - nav.progressAt > 2000 || partEnd) {
      let pts = findPath(me, goal);
      if (pts && dist(pts.at(-1), goal) > 2 && dist(pts.at(-1), me) < 1.5) pts = null; // no closer cell reachable
      navs[key] = { goal, pts: pts ?? [goal], i: 0, progressAt: now(), best: Infinity, failed: !pts };
    }
    const p = navs[key];
    while (p.i < p.pts.length - 1 && dist(me, p.pts[p.i]) < 1.5) p.i++;
    if (!p.failed) p.i = aheadIdx(p.pts, p.i, me, clearLine);
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
  const GOAL_MIN_MS = { fight: 1500, shop: 60000, talk: 30000, loot: 6000, dungeon: 2000, explore: 2000, follow: 1000, farm: 2000 };
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
      // Not attacked: the kill's xp over the time left to get it (hp remaining, walk), as a score relative to farming
      // (0.2 = our xp/s); a boss at 15 % is cheap xp and keeps the fight over a talk quest.
      fight: c.attacked ? 1.5 : c.target ? Math.max(c.target.d < 14 ? 1.0 : 0.55, Math.min(1.45, killScore(c.target))) : 0,
      // Out of potions with gold: restocking beats farming a target (only being attacked is higher).
      shop: st.shopDone === false && wantsShop() ? (g.char.potions <= 1 && g.char.gold >= potionPrice() * 4 ? 1.2 : 0.8) : 0,
      // World quest steps (talk, explore) wait while we are in a dungeon: its coordinates are not ours, and the run is
      // finished first (the dungeon goal leaves through the exit when it is over).
      talk: g.dungeon ? 0 : talkScore(c.quest) * (st.fight ? 0.5 : 1), // a quest talk waits for the fight's end unless it dominates
      loot: c.drop ? lootScore(c.drop) : 0,
      // Grouped: no dungeon run of our own, only our chest once the boss is down.
      dungeon: grouped() ? (g.dungeon && g.dstate?.boss && !g.dstate.opened ? 0.65 : 0) : g.dungeon || armDoor() ? 0.65 : 0,
      explore: !g.dungeon && !grouped() && c.quest?.type === 'explore' && c.quest.x != null && (c.quest.minLevel ?? 1) <= g.level ? 1.02 * (st.fight ? 0.5 : 1) : 0,
      follow: needFollow() ? 0.7 : 0,
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
  // Kill value: learned xp per unit of def.xp (ad.xpu, from kill/xp event pairs) x the monster's def.xp, per second of
  // the remaining kill time (hp left / our dps, plus the walk into range).
  const killXp = m => (ad.xpu ?? (ad.tot.kills ? ad.tot.xp / ad.tot.kills / 10 : 1)) * (m.def?.xp ?? 10);
  function killScore(o) {
    if (!o?.m) return 0;
    const ttk = o.m.hp / Math.max(1, myDps()) + Math.max(0, o.d - (sk(BASE_SKILLS[0]).range ?? 12)) / PLAYER_SPEED;
    return 0.2 * killXp(o.m) / Math.max(0.3, ttk) / Math.max(1e-6, xpps());
  }
  // Talk value: learned quest reward over trip (waystone aware) plus talk time, plus a whole quest for a new one,
  // as a goal score relative to farming (0.2 at our measured xp/s), kept below fighting a near target.
  function talkScore(q) {
    if (grouped() || !(q?.type === 'talk' && q.npc && q.x != null) || dist(g.sim, q) >= 250) return 0;
    // Quests first: the chain's xp plus the zones it unlocks beat farming a new pull (1.0) and loose loot; mobs on us
    // (1.5), a cheap kill (killScore) and reflexes still win, and in a fight the talk score is halved (decideRaw).
    // TODO(ceiling): the progression value of a step is not measured; its xp rate alone rarely beat farming.
    const sec = tripLen(g.sim, q) / PLAYER_SPEED + ad.qx.talk / 1000 + (/^Prendre/.test(q.label) ? ad.qx.dur / 1000 : 0);
    return Math.max(1.02, Math.min(1.4, 0.2 * questReward() / sec / Math.max(1e-6, xpps())));
  }
  function goalDone(goal, c) {
    if (goal === 'fight') return !c.target;
    if (goal === 'shop') return st.shopDone !== false;
    if (goal === 'talk') return !(c.quest?.type === 'talk' && c.quest.npc);
    if (goal === 'loot') return !c.drop;
    if (goal === 'dungeon') return !g.dungeon && !armDoor();
    if (goal === 'explore') return c.quest?.type !== 'explore';
    if (goal === 'follow') return !needFollow();
    return false;
  }

  // Stuck detection: no progress for 3 s while trying to move -> sidestep 0.7 s and force a repath.
  function unstick(move) {
    const t = now(), me = g.sim;
    const moving = Math.hypot(move[0], move[1]) > 0.1;
    if (!st.stuckRef || !moving) st.stuckRef = { x: me.x, z: me.z, at: t };
    else if (dist(me, st.stuckRef) > 1.5) st.stuckRef = { x: me.x, z: me.z, at: t };
    else if (t - st.stuckRef.at > 3000) {
      const side = Math.random() < 0.5 ? 1 : -1, ml = Math.hypot(move[0], move[1]);
      // The cells we pushed into are blocked for the planner (see markBlocked).
      if (dist(me, st.stuckRef) < 0.5) for (const d of [1, 1.7]) markBlocked(me.x + move[0] / ml * d, me.z + move[1] / ml * d);
      st.sidestep = { until: t + 700, dir: [-move[1] * side, move[0] * side] };
      st.navs = {}; st.wayPlans = {}; st.stuckRef = { x: me.x, z: me.z, at: t }; st.unsticks = (st.unsticks ?? 0) + 1;
    }
    if (st.sidestep && t < st.sidestep.until) return st.sidestep.dir;
    return move;
  }

  // One decision per sim tick: returns movement, aim point and bar slots to hold.
  // Journal: one line per change of action, goal, zone, dungeon phase or level (drained by run.mjs to journal.jsonl).
  // TODO(ceiling): 3000-line ring when no runner drains it; older lines are dropped.
  const journal = [];
  function jlog(ev, extra) {
    const me = g.sim;
    journal.push({ t: Date.now(), ev, lvl: g.level, xp: g.char.ch.xp, hp: Math.round(100 * g.hp / g.life), pot: g.char.potions,
      pos: [Math.round(me.x), Math.round(me.z)], goal: st.goal ?? null, zone: st.zone ?? null, doing: st.last, ...extra });
    if (journal.length > 3000) journal.shift();
  }
  function journalTick() {
    const k = [String(st.last).replace(/-?\d+(\.\d+)?/g, '#'), st.goal, st.zone, st.dun?.phase, g.level].join('|'); // numbers (distances) do not count as a change
    if (k === st.jKey) return;
    const ev = g.level !== st.jLvl && st.jLvl != null ? 'niveau' : st.zone !== st.jZone ? 'zone' : st.dun?.phase !== st.jPh ? 'donjon' : 'action';
    st.jKey = k; st.jLvl = g.level; st.jZone = st.zone; st.jPh = st.dun?.phase;
    jlog(ev, { kills: st.kills, dun: st.dun ? { id: st.dun.id, phase: st.dun.phase, room: st.dun.room } : undefined,
      retreat: st.retreat?.why, mobs: monsters().filter(m => dist(m.pos, g.sim) < 15).map(m => `${m.def?.kind}${m.level}${m.elite ? 'E' : ''}`).slice(0, 8) });
  }
  // Point at arc length len along the current path of key, or null when the path is shorter or unknown.
  function pathPoint(key, len) {
    const nav = st.navs?.[key];
    if (!nav || nav.failed) return null;
    let prev = g.sim, acc = 0;
    for (let i = nav.i; i < nav.pts.length; i++) {
      const p = nav.pts[i], seg = dist(prev, p);
      if (seg > 0 && acc + seg >= len) { const f = (len - acc) / seg; return { x: prev.x + (p.x - prev.x) * f, z: prev.z + (p.z - prev.z) * f }; }
      acc += seg; prev = p;
    }
    return null;
  }
  // Reaper travel legs (REAPER.md "Trajet"): a pass (lands 1.6 m past the cursor) aimed 7.4 m down the path, else the
  // spectral rush aimed 10 m down it, when the line is wall free, no monster waits at the landing and the goal is > 10 m.
  // No rush in the last 3 s before a waystone or a dungeon door: it resets outOfCombat, the pass does not.
  function travelMobility(d) {
    const tr = st.trav, me = g.sim;
    if (!tr || tr.n !== st.tickN || d.roll || d.slots.length || tr.key === 'fight' || tr.key === 'loot' || Math.hypot(d.move[0], d.move[1]) < 0.5) return;
    const left = dist(me, tr.goal);
    if (left <= 10) return;
    const free = (p, over) => {
      const l = dist(me, p), ux = (p.x - me.x) / l, uz = (p.z - me.z) / l;
      for (let s = 0.5; s <= l + over; s += 0.5) if (solid(me.x + ux * s, me.z + uz * s)) return false;
      return ![...g.entities.visibleMonsters()].some(m => !m.dead && m.hp > 0 && dist(m.pos, { x: me.x + ux * (l + over), z: me.z + uz * (l + over) }) < 6);
    };
    const p1 = pathPoint(tr.key, 7.4);
    if (p1 && rollReady() && free(p1, 1.6)) { st.rollAt = now(); d.roll = true; d.aim = p1; st.passes = (st.passes ?? 0) + 1; return; }
    const gate = (tr.key.startsWith('way:') || (tr.key === 'dungeon' && !g.dungeon)) && left < 3 * curSheet().vt;
    const p2 = !gate && g.char.bar.includes('souldash') && ready('souldash') ? pathPoint(tr.key, 10) : null;
    if (p2 && free(p2, 0)) { d.slots = [g.char.bar.indexOf('souldash')]; d.aim = p2; st.rushes = (st.rushes ?? 0) + 1; }
  }
  function decide() {
    const d = decideRaw();
    if (SHAMAN) shForms(d);
    if (REAPER) travelMobility(d);
    d.move = unstick(d.move);
    try { journalTick(); } catch {}
    return d;
  }
  // Shaman toggles are pressed once: the key stays down only until the shift starts (cd up), the form changes or
  // 600 ms pass; held longer, the form would flip back at every 1.5 s cooldown. Out of a fight, wolf/bear go back
  // to human as soon as the breath is ready (no spirit burn, heal 10 %).
  function shForms(d) {
    const s = g.sim, r = st.formReq;
    if (r && (s.form !== r.from || !ready(r.id) || now() - r.at > 600)) { st.formReq = null; st.formNext = now() + 300; }
    else if (r) { d.slots = [r.slot]; return; }
    const id = s.form === 1 ? 'wolfform' : s.form === 2 ? 'bearform' : null;
    if (id && !d.slots.length && s.comboTimer <= 0 && !s.action && now() > (st.formNext ?? 0) && ready(id) && g.char.bar.includes(id)) {
      st.formReq = { id, slot: g.char.bar.indexOf(id), from: s.form, at: now() }; d.slots = [st.formReq.slot];
    }
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
    // Left an instance (run over, bail or death): it stays open ad.exp.ms from now.
    if (ad.zLvl !== g.level) { if (ad.zLvl != null) learnFall(); ad.zLvl = g.level; }
    // Seconds per corruption stack gained (status only).
    if ((g.cor ?? 0) > (st.corPrev ?? 0) && st.corAt) { const v = (now() - st.corAt) / 1000; ad.corSec = ema(ad.corSec ?? v, v, ad.corN = (ad.corN ?? 0) + 1); }
    if ((g.cor ?? 0) !== (st.corPrev ?? 0)) { st.corAt = now(); st.corPrev = g.cor ?? 0; }
    const dunId = g.dungeon?.def.id ?? null;
    if (st.dunIn && st.dunIn !== dunId) { ad.dunOpen = ad.dunOpen.filter(o => o.id !== st.dunIn && Date.now() - o.at < ad.exp.ms).concat({ id: st.dunIn, at: Date.now() }); saveAd(); }
    st.dunIn = dunId;
    const lead = grouped() ? leader() : null;
    if (lead) {
      // Grouped: home is the leader (in its dungeon too), no zone pick, no quest area.
      if (sameMap(lead)) st.home = leaderPos(lead); else st.home ??= { x: me.x, z: me.z };
      LEASH = grp.band; st.zone = 'groupe : ' + lead.n;
      for (const p of g.party) if (p.dead && !grp.deadSeen?.has(p.id) && p.id !== g.meId) { (grp.deadSeen ??= new Set()).add(p.id); if (dist(me, p) > grp.band) grp.band = 10; }
      for (const id of grp.deadSeen ?? []) if (!g.party.find(p => p.id === id)?.dead) grp.deadSeen.delete(id);
    }
    else if (g.dungeon) { st.home = { x: me.x, z: me.z }; st.zone = 'donjon : ' + g.dungeon.def.name; LEASH = 30; }
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
    swingTick(me);
    // Globe heal sample: life fraction gained 300 ms after we picked one up.
    if (st.globePick && tick - st.globePick.at > 300) { const x = Math.max(0, g.hp - st.globePick.hp) / g.life; ad.globe = ad.globe == null ? x : ema(ad.globe, x, ad.globeN = (ad.globeN ?? 0) + 1); st.globePick = null; }
    st.lat = ema(st.lat ?? dt, dt, 1e9);
    abTick(dt);
    if (tick - (st.saveAt ?? 0) > 30000) { st.saveAt = tick; relax(); saveAd(); }
    // hp trend over the last ~2 s, for ossature
    if (tick - (st.hpAt ?? 0) > 2000) { st.hpDrop = hpPct < (st.hpPrev ?? hpPct) - 0.03; st.hpPrev = hpPct; st.hpAt = tick; }
    let move = [0, 0], aim = null, slots = [], roll = false;
    if (SHAMAN) shTick();
    if (REAPER) rpTick();
    st.tickN = (st.tickN ?? 0) + 1;

    // --- reflexes
    // Local cooldown guard: g.potionCd only updates after the server answers.
    if (hpPct < potionAt() && !(g.potionCd > 0) && g.char.potions > 0 && tick - (st.potAt ?? -1e9) > SV.potion.cdSec * 1000) { st.potAt = tick; g.actions.usePotion(); zs.gold = (zs.gold ?? 0) - potionPrice(); } // potions spent count in the arm's net value
    progress();
    lootInPassing(me);
    st.reflex = null;
    const esc = teleEscape(me);
    if (esc) {
      st.reflex = 'esquive attaque annoncée';
      roll = rollReady();
      if (roll) { st.rollAt = now(); st.teleDodges = (st.teleDodges ?? 0) + 1; }
      st.last = 'esquive une attaque annoncée';
      const mv = steer(...esc);
      return { move: mv, aim: REAPER && roll ? rollAim(mv) : null, slots: [], roll };
    }
    const ret = retreatTick(me);
    if (ret) {
      const t = threat(me);
      roll = !!t && rollReady();
      if (roll) st.rollAt = now();
      return { move: ret, aim: REAPER && roll ? rollAim(ret) : null, slots: [], roll };
    }

    // Enraged boss (or its timer nearly out): run for the exit, no fighting on the way.
    if (g.dungeon && st.dun && !grouped()) {
      enrageWatch();
      if (st.dun.flee) { st.reflex = 'fuite (boss enragé)'; return { move: dungeonRun(), aim: null, slots: [], roll: false }; }
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
    // Monsters met in the current fight stay targets while alive (a boss that stops swinging is not dropped half dead).
    const met = o => st.fight?.seen.has(o.m.id) || st.carrySeen?.has(o.m.id);
    // About to hit the corruption drain (or on the way to cleanse): finish what is on us, start no new pull.
    const corHold = !!g.cor && (st.cleansing || g.cor >= COR.max - 1);
    const ranked = mobs.filter(o => anchor ? engagedOnUs(o) || o.d < 4 : engagedOnUs(o) || o.d < 6 || (plan.ids.has(o.m.id) && !corHold) || met(o) || (g.dungeon && isSeal(o.m) && o.d < 25) || leadTgt(o.m) || onMate(o.m))
      .filter((o, _, all) => allowedDun(o, all)).map(o => ({ ...o, s: smith(o, kite) * dunMul(o.m) })).sort((a, b) => b.s - a.s);
    st.top = ranked.slice(0, 3).map(o => `${o.m.def?.kind}${o.m.level} ${o.s.toFixed(2)}`);
    const tgtO = ranked[0];
    const quest = questStep();
    bossWatch(quest, me);
    // Fight forecast for the globe value: incoming dps of attackers and the time to clear what is engaged.
    st.incoming = attackers.reduce((a, o) => a + enemyDps(o.m), 0);
    st.ttkEng = eng.reduce((a, o) => a + o.m.hp, 0) / Math.max(1, myDps() * (1 + splashShare() * Math.max(0, eng.length - 1)));
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
    if (goal === 'follow') return { move: followRun(), aim: null, slots: [], roll: false };

    if ((goal === 'fight' || doorFight) && target) {
      const d = tgtO.d;
      aim = { x: target.pos.x, z: target.pos.z };
      const army = myAllies();
      if (hpPct < fleeAt()) { const c = centroid(attackers.length ? attackers : [tgtO]); move = steer(me.x - c.x, me.z - c.z); st.last = 'fuit (PV bas)'; }
      else if (attackers.length && kite) { move = kiteMove(me, eng, tgtO); st.last = `kite ${target.def?.kind ?? '?'} ${d.toFixed(1)}m`; }
      // Hold behind the army only with the target in bolt range; out of range, holding was pure idle time (approach below).
      else if (attackers.length && d <= (sk(BASE_SKILLS[0]).range ?? 12)) { move = holdMove(me, eng, army); st.last = `tient derrière l'armée ${target.def?.kind ?? '?'} ${d.toFixed(1)}m`; }
      // Close in with hysteresis: once started, walk until 15 % inside the range (stopping right at the edge flipped
      // walk/stand every tick as the target drifted across it).
      else if ((st.closing = d > (sk(BASE_SKILLS[0]).range ?? 12) * (st.closing === target.id ? 0.85 : 1) - (target.def?.speed ?? 0) * lat() ? target.id : null)) { move = travelPath({ x: target.pos.x, z: target.pos.z }, 'fight'); st.last = `tire ${plan.k} groupe(s) ${target.def?.kind ?? '?'} ${d.toFixed(1)}m`; }
      else st.last = `combat ${target.def?.kind ?? '?'} ${d.toFixed(1)}m`;

      // Shaman mammoth: stay in contact (tusks arc 3.6 m), damage taken -40 %.
      if (SHAMAN && g.sim.form === 3 && hpPct >= fleeAt()) { move = d > 2.5 ? steer(target.pos.x - me.x, target.pos.z - me.z) : [0, 0]; st.last = `mammouth ${d.toFixed(1)}m`; }
      // Targets for skills: the chosen target first in the list so ties aim at it.
      const pick = SHAMAN && st.formReq ? null : chooseSkill({ mobs: [tgtO, ...ranked.filter(o => o !== tgtO)], me, attackers, hpPct, hpDrop: st.hpDrop, ess: g.sim.fury ?? 0 });
      st.skill = pick ? `${pick.id} ${pick.ev.toFixed(1)}` : null;
      if (pick && pick.slot >= 0) {
        slots.push(pick.slot);
        if (pick.aim) aim = { x: pick.aim.x, z: pick.aim.z };
        if (pick.id === 'fleshgolem') st.golemAt = now();
        if (pick.toggle) st.formReq = { id: pick.id, slot: pick.slot, from: g.sim.form, at: now() };
      }
      const t = threat(me);
      // Reaper: strikes are taken in the scythe band; it dodges only telegraphs, or when low (survival below).
      if (t && !REAPER && rollReady()) {
        st.rollAt = now();
        roll = true;
        move = steer(me.x - t.pos.x, me.z - t.pos.z);
      }
      // Survival: low hp with an attacker in contact and no bear roar (shaman) or spectral form (reaper): roll away.
      const close = hpPct < 0.4 && (SHAMAN && pick?.id !== 'bearform' || REAPER && pick?.id !== 'wraithform' && !wraithLeft()) ? attackers.filter(o => o.d < 3) : [];
      if (!roll && close.length && rollReady()) {
        const c = centroid(close); st.rollAt = now(); roll = true; move = steer(me.x - c.x, me.z - c.z);
      }
      if (REAPER && roll) { aim = rollAim(move); slots.length = 0; }
      // Shaman: in wolf/bear slot 0 is a beast click, and nothing while a shift is cast.
      if (!slots.length && !roll && (REAPER ? d >= 1 && d <= (sk('reap').range ?? 4.6)
        : SHAMAN ? d < 12 && (g.sim.form === 0 || g.sim.form === 3) && !/form$/.test(g.sim.action?.type ?? '') : d < 13)) slots.push(0);
    } else {
      // Farm: head for the nearest monster of the planned pull, otherwise wander across the zone.
      const pyl = cleanseNeed();
      if (pyl) return { move: cleanseMove(pyl, 'pylon'), aim: null, slots: [], roll: false };
      const lure = mobs.find(o => plan.ids.has(o.m.id))?.m;
      if (lure && dist(me, st.home) <= LEASH + 8) {
        st.last = 'va chercher des ennemis';
        return { move: travelPath({ x: lure.pos.x, z: lure.pos.z }, 'lure'), aim: null, slots: [], roll: false };
      }
      const bindW = grouped() ? null : nearestWay(st.home, awake());
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
    // Corridor traps: never stand still within 2 m of one (its telegraph stays the real dodge).
    const trap = g.dungeon && !roll && !move[0] && !move[1] ? (g.dungeon.layout.traps ?? []).find(p => dist(me, p) < 2) : null;
    if (trap) move = steer(me.x - trap.x, me.z - trap.z);
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
  // The gathering coordinator (gather.page.js) owns the character outside its XP mode: yield even if started.
  const gatherOwns = () => {
    if (now() - (st.gatherAt ?? -1e9) > 500) { st.gatherAt = now(); try { const s = window.__gather?.status?.(); st.gatherOwns = !!s?.on && s.mode !== 'XP'; } catch { st.gatherOwns = false; } }
    return st.gatherOwns;
  };
  const myBuild = g.controls.build = aimPt => {
    if (!st.on || g.ui.typing) return origBuild(aimPt);
    if (gatherOwns()) { if (st.pressed.size) setKeys([]); st.last = 'cède la main au bot métiers'; return origBuild(aimPt); }
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
        jlog('mort', { killers: st.lastDeath });
      }
      if (now() - st.deadSince > 3000) { g.actions.respawn(); st.deadSince = now(); }
      st.last = 'mort';
      return origBuild(aimPt);
    }
    st.deadSince = 0;
    // Hidden window: the browser drops to ~1 fps, so we can neither fight nor learn; hold still until frames return.
    const gap = now() - (st.buildAt ?? now()); st.buildAt = now();
    st.frameGap = ema(st.frameGap ?? gap, Math.min(gap, 2000), 8);
    if (st.frameGap > 150) { setKeys([]); st.last = 'ralenti (fenêtre cachée), en attente'; return origBuild(aimPt); }
    let d;
    try { d = decide(); } catch (e) { st.last = 'erreur ' + e.message; d = { move: [0, 0], aim: null, slots: [] }; }
    setKeys(d.slots);
    // Fight time with no key held and no roll: standing idle, or walking (out of range, repositioning).
    if (st.fight && !d.slots.length && !d.roll) {
      const k = Math.hypot(d.move[0], d.move[1]) > 0.1 ? 'walk' : 'idle', dt = Math.min(200, gap), why = String(st.last).split(/ \d| [a-z]+ \d/)[0].slice(0, 24);
      st.fight[k] = (st.fight[k] ?? 0) + dt; const w = st.fight.why ??= {}; w[why] = (w[why] ?? 0) + dt;
    }
    const r = origBuild(d.aim ? { x: d.aim.x, z: d.aim.z } : aimPt);
    if (d.roll) st.rolls = (st.rolls ?? 0) + 1;
    (st.moves ??= []).push(d.move.map(v => +v.toFixed(2))); if (st.moves.length > 12) st.moves.shift();
    return { ...r, b: d.roll ? r.b | 64 : r.b, mx: Math.round(d.move[0] * 1e3) / 1e3, mz: Math.round(d.move[1] * 1e3) / 1e3 };
  };

  // Count kills and keep skills usable while the real cursor sits on a UI panel.
  const origOnMessage = g.onMessage.bind(g);
  const myOnMessage = g.onMessage = msg => {
    if (st.on && msg?.t === 's') for (const ev of msg.ev ?? []) {
      if (ev.e === 'kill') {
        const km = g.entities.monsters.get(ev.id)?.view;
        if (km?.def?.xp) st.lastKill = { at: now(), base: km.def.xp };
        st.kills++; st.killAt = now(); ad.tot.kills = (ad.tot.kills ?? 0) + 1;
        const zs = zoneStat(st.zone ?? 'fixe'); zs.kills = (zs.kills ?? 0) + 1;
        const p = st.deathPend; // death cost sample: xp lost plus xp not earned until this first kill
        if (p?.lost != null) { const v = p.lost + xpps() * (now() - p.at) / 1000; ad.deathCost = ema(ad.deathCost ?? v, v, ad.deathN = (ad.deathN ?? 0) + 1); st.deathPend = null; }
      }
      else if (ev.e === 'hit') { onHit(ev); groupHit(ev); }
      else if (ev.e === 'undrop' && ev.by === g.meId && g.drops.drops.get(ev.id)?.kind === 'globe') st.globePick = { hp: g.hp, at: now() };
      else if (ev.e === 'xp') {
        const a = ev.a ?? 0, r = ad.ab.run;
        zoneStat(st.zone ?? 'fixe').xp += a; ad.tot.xp += a; st.xpTot = (st.xpTot ?? 0) + a;
        if (r && r.zone === st.zone) r[r.side].xp += a;
        if (st.qDone) st.qDone.xp = Math.max(st.qDone.xp, a);
        st.lastXpEv = { a, at: now() };
        // xp per def.xp unit: an xp event right after a kill (same snapshot) is that kill's xp.
        if (st.lastKill && now() - st.lastKill.at < 50 && a > 0) { const u = a / st.lastKill.base; ad.xpu = ema(ad.xpu ?? u, u, ad.xpuN = (ad.xpuN ?? 0) + 1); st.lastKill = null; }
      }
      else if (ev.e === 'tele') addTele(ev);
      else if (ev.e === 'toast' && typeof ev.m === 'string') {
        expToast(ev.m);
        if (/butin revient à ceux qui ont abattu/i.test(ev.m) && st.dun) { st.dun.chestDenied = (st.dun.chestDenied ?? 0) + 1; jlog('coffre refusé', { n: st.dun.chestDenied }); }
      }
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
  const GOAL_FR = { fight: 'combat', shop: 'boutique', talk: 'quête PNJ', loot: 'butin', dungeon: 'donjon', explore: 'exploration', follow: 'suivre', farm: 'farm' };
  const bar10 = v => '█'.repeat(Math.round(Math.min(1.75, Math.max(0, v)) / 1.75 * 10)).padEnd(10, '·');
  const esc = t => String(t ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const rpHud = () => `palier ${'0 I II III IV'.split(' ')[soulTier()]}  seuil ${Math.round(trepasTh() * 100)} %  forme spectrale ${Math.round(wraithLeft())}s`;
  const shHud = () => `forme ${FORM_FR[g.sim.form] ?? g.sim.form}  harmonie ${'0 I II III'.split(' ')[harmony()]}  totem ${Math.round(totemLeft())}s`;
  const hudTimer = setInterval(() => {
    if (SHAMAN && !st.on) shTick(); // keep form/totem tracking while paused (manual play)
    if (hud.hidden) return;
    const sc = st.scores ?? {};
    const rows = Object.keys(GOAL_FR).map(k => {
      const on = k === st.goal;
      const left = on ? Math.max(0, Math.round(((GOAL_MIN_MS[k] ?? 0) - (now() - st.goalAt)) / 1000)) : 0;
      return `${on ? '▶' : ' '} ${GOAL_FR[k].padEnd(10)} ${bar10(sc[k] ?? 0)} ${(sc[k] ?? 0).toFixed(2)}${on && left ? `  min ${left}s` : ''}`;
    }).join('\n');
    const hp = g.life ? Math.round(g.hp / g.life * 100) : 0;
    hud.innerHTML = `<b style="color:#d9b26f">BOT ${st.on ? 'ON' : 'OFF'}</b>  niv ${g.level}  PV ${hp}%  potions ${g.char.potions}  ${SHAMAN ? 'esprit' : REAPER ? 'âmes' : 'ess'} ${Math.round(g.sim.fury ?? 0)}\n`
      + `réflexe : ${esc(st.reflex ?? '-')}\n`
      + `<span style="color:#8fb3a8">objectifs (inertie +${INERTIA})</span>\n${esc(rows)}\n`
      + `action : <b>${esc(st.last)}</b>\n`
      + `cible  : ${esc(st.target ?? '-')}\n`
      + `zone   : ${esc(st.zone ?? '-')}\n`
      + `quête  : ${esc(st.quest?.label ?? '-')}\n`
      + `touches: ${esc([...st.pressed].join(' ') || '-')}  ${SHAMAN ? shHud() : REAPER ? rpHud() : `squelettes ${servantCount()}/${skelCap()}`}\n`
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
      // Hot-load carry: the next instance keeps the current fight's monsters as targets for 30 s.
      window.__botCarry = { seen: [...(st.fight?.seen ?? [])], at: Date.now() };
      api.pause();
      // Unhook only if still on top: a wrapper added later (gather.page.js) would be dropped otherwise. Left in the chain,
      // ours is a pass-through once paused.
      if (g.controls.build === myBuild) g.controls.build = origBuild;
      if (g.onMessage === myOnMessage) g.onMessage = origOnMessage;
      window.removeEventListener('keydown', onKey, true);
      clearInterval(hudTimer); hud.remove();
      delete window.__bot;
    },
    drainFights: () => fights.splice(0),
    drainJournal: () => journal.splice(0),
    findPath: (from, to) => findPath(from, to), // read-only planner probe (tests, viz)
    // Read-only snapshot for viz.page.js.
    debug: () => ({
      navs: Object.fromEntries(Object.entries(st.navs ?? {}).map(([k, n]) => [k, { goal: n.goal, pts: n.pts, i: n.i, at: n.progressAt }])),
      home: st.home, leash: LEASH, zone: st.zone ?? null, goal: st.goal ?? null, wander: st.wander, target: st.tgtPos ?? null,
      dangers: ad.spots.filter(x => Date.now() < x.until).map(x => ({ x: x.x, z: x.z, r: x.r })), ways: WAYS, zones: ZONES,
      // Dry view of the class logic (no input sent): skill pick on what is around, readiness, model numbers.
      dry: (() => { try {
        const mobs = monsters().map(m => ({ m, d: dist(m.pos, g.sim) })).sort((a, b) => a.d - b.d), attackers = mobs.filter(engagedOnUs);
        const pick = mobs.length ? chooseSkill({ mobs, me: g.sim, attackers, hpPct: g.hp / g.life, hpDrop: false, ess: g.sim.fury ?? 0 }) : null;
        return { pick: pick && { id: pick.id, slot: pick.slot, ev: pick.ev }, mobs: mobs.slice(0, 5).map(o => `${o.m.def?.kind}${o.m.level} ${o.d.toFixed(1)}m`),
          ready: Object.fromEntries([...g.char.bar.filter(Boolean), 'roll'].map(id => [id, ready(id)])), rollReady: rollReady(),
          sheet: (s => ({ hit: Math.round(s.hit), dps: Math.round(s.dps), ehp: Math.round(s.ehp), vt: +s.vt.toFixed(2) }))(sheet()), myDps: Math.round(myDps()),
          castReap: +castSec(BASE_SKILLS[0]).toFixed(2), strat: chooseStrat(mobs.slice(0, 3)), nextTalent: BUILD?.talents[Object.values(g.char.ch.tree ?? {}).reduce((x, n) => x + n, 0)]?.id ?? null };
      } catch (e) { return 'erreur ' + e.message; } })(),
    }),
    status: () => ({
      on: st.on, cls: g.char.ch.cls, lvl: g.char.ch.level, xp: g.char.ch.xp,
      hp: `${g.hp}/${g.life}`, potions: g.char.potions, kills: st.kills, deaths: st.deaths, rolls: st.rolls ?? 0, lastDeath: st.lastDeath,
      min: Math.round((now() - (st.t0 || now())) / 60000), doing: st.last, retreat: st.retreat ? { why: st.retreat.why, chasers: st.retreat.ids.size, target: st.retreat.target } : null, retreats: st.retreats ?? 0, eng: st.lastEng ?? null, servants: servantCount(), talents: Object.keys(g.char.ch.tree ?? {}).length,
      goal: st.goal, moves: st.moves, goalSwitches: st.goals ?? 0, unsticks: st.unsticks ?? 0, questLabel: st.quest?.label ?? null, questEvents: st.quests ?? 0, lastQuest: st.lastQuest,
      kite: { log: (st.kiteLog ?? []).slice(-8), lat: Math.round(st.lat ?? 0), reach: Object.fromEntries(Object.entries(ad.reach).map(([k, v]) => [k, `${v.d?.toFixed(1) ?? '?'} m${v.rng > v.mel ? ' tir' : ''} (${v.n})`])),
        margin: Object.fromEntries(Object.entries(ad.kmargin).map(([k, v]) => [k, `${v.m.toFixed(2)} (${v.n})`])) },
      bound: g.char.bound ?? null, ways: g.char.ways?.length ?? 0, wayTrips: st.wayTrips ?? 0, binds: st.binds ?? 0,
      loots: st.loots ?? 0, equips: st.equips ?? 0, sold: st.sold ?? 0, claims: st.claims ?? 0, gold: g.char.gold, teleDodges: st.teleDodges ?? 0, caution: ad.caution, bought: st.bought ?? 0,
      strat: st.strat, pull: st.plan?.k ?? 0, pullOpts: st.plan?.opts.length ?? 0, margin: +ad.margin.toFixed(3), dpsRatio: +ad.dpsRatio.toFixed(3),
      top: st.top, skill: st.skill, lastFight: st.lastFight, knobs: { potion: knob('potion'), flee: knob('flee'), reserve: knob('reserve') },
      ab: ad.ab.run ? { k: ad.ab.run.k, side: ad.ab.run.side, val: ad.ab.run.val } : null, abLast: ad.ab.last ?? null,
      enemy: Object.fromEntries(Object.entries(ad.enemy).map(([k, v]) => [k, `${v.dps.toFixed(1)} dps (${v.n})`])),
      pullStats: Object.fromEntries(Object.entries(ad.pull).map(([k, v]) => [k, `${(v.xp / Math.max(1, v.ms) * 1000).toFixed(2)} xp/s (${v.n})`])),
      zoneUcb: (st.zoneArms ?? []).map(a => `${a.z.name} L${a.a} ${Math.round(a.mean)} n${a.n.toFixed(1)}`), ladder: st.ladder ?? [], fall: +fall().toFixed(3),
      xph: Object.fromEntries(Object.entries(ad.zones).map(([k, v]) => { const b = v.lv?.[g.level]; return [k, b ? `${Math.round(b.xp / Math.max(b.ms, 60000) * 3600000)} xp/h, ${b.deaths} morts (niv ${g.level})` : '-']; })),
      group: grouped() && grp.leadId != null ? (l => l && { name: l.n, lvl: l.lvl })(g.party.find(p => p.id === grp.leadId)) : null,
      corruption: { stacks: g.cor ?? 0, secPerStack: ad.corSec && +ad.corSec.toFixed(1), cleanses: st.cleanses ?? 0, cleansing: !!st.cleansing },
      expeditions: { open: openExp(), max: ad.exp.max, min: ad.exp.ms / 60000 },
      dungeon: st.dun ? { id: st.dun.id, phase: st.dun.phase, room: st.dun.room, deaths: st.dun.deaths, min: Math.round((now() - st.dun.at) / 60000) } : null,
      dangers: ad.spots.map(x => `${x.kind} ${Math.round((x.until - Date.now()) / 1000)}s r${Math.round(x.r)}`), avoid: ad.avoid,
      leash: Object.fromEntries(Object.entries(ad.leash).map(([k, v]) => [k, `${v.d.toFixed(1)} (${v.n})`])),
      quest: { frac: +ad.qx.frac.toFixed(3), rate: ad.qx.rate, talkMs: Math.round(ad.qx.talk), durMin: Math.round(ad.qx.dur / 60000) },
      deathCost: Math.round(deathCostXp()), sales: st.sales ?? [], fightsQueued: fights.length,
      zone: g.zoneName, farm: st.zone ?? 'fixe', pos: [Math.round(g.sim.x), Math.round(g.sim.z)], home: st.home,
      ...(REAPER && { souls: Math.round(souls()), tier: soulTier(), trepas: +trepasTh().toFixed(2), wraith: Math.round(wraithLeft()), passes: st.passes ?? 0, rushes: st.rushes ?? 0 }),
      ...(SHAMAN && { spirit: Math.round(g.sim.fury ?? 0), form: FORM_FR[g.sim.form] ?? g.sim.form, harmony: harmony(), totem: Math.round(totemLeft()), combo: +Math.max(0, g.sim.comboTimer).toFixed(1) }),
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
    // Group leader: level gap first, ties to the real leader, hysteresis of 2 levels, dead members skipped.
    const P = [{ id: 1, lvl: 25, x: 0, z: 0 }, { id: 2, lvl: 27, x: 0, z: 0, lead: 1 }, { id: 3, lvl: 23, x: 5, z: 0 }, { id: 4, lvl: 26, x: 0, z: 0, dead: 1 }];
    if (pickLeader(P, 1, 25, { x: 0, z: 0 }, null)?.id !== 2) fail('leader tie by lead');
    if (pickLeader([...P, { id: 5, lvl: 26, x: 0, z: 0 }], 1, 25, { x: 0, z: 0 }, 3)?.id !== 3) fail('leader hysteresis keep');
    if (pickLeader([{ id: 1, lvl: 25 }, { id: 3, lvl: 20, x: 0, z: 0 }, { id: 5, lvl: 25, x: 0, z: 0 }], 1, 25, { x: 0, z: 0 }, 3)?.id !== 5) fail('leader hysteresis switch');
    if (pickLeader([{ id: 1, lvl: 25 }], 1, 25, { x: 0, z: 0 }, null) !== null) fail('leader alone');
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
    // Shaman harmony: forms entered inside the window count once each, capped at III.
    if (harmonyTier({ 0: 9000, 1: 5000, 2: 100 }, 10000, 15000) !== 3 || harmonyTier({ 1: 0, 2: 9000 }, 20000, 15000) !== 1) fail('harmony tier');
    if (fightOver(1000, 1000 + FIGHT_GAP - 1, false) || !fightOver(1000, 1000 + FIGHT_GAP + 1, false) || !fightOver(1000, 1001, true)) fail('fight boundary');
  })();

  window.__bot = api;
  return 'bot loaded';
})();
