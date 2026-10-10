// Injected after bot.page.js. F10 cycles: off, on-screen path, big map, both.
// Reads the bot through window.__bot.debug() each frame, so it survives bot re-injections.
(() => {
  if (window.__viz) window.__viz.stop();
  const g = window.__game;
  if (!g) throw new Error('__game not ready');

  const MODES = ['off', 'chemin', 'carte', 'chemin + carte'];
  const Y = 0.1, EPS = 1e-3, STEP = 2, ROWS = 6, FRESH_MS = 2500;
  const PALETTE = ['#4cf', '#f6c', '#fd4', '#7f7', '#f94', '#b9f', '#4fc'];
  let mode = 0, zoom = 1, raf = 0, gameCanvas = null;

  const cv = document.createElement('canvas');
  cv.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;z-index:99990';
  document.body.appendChild(cv);
  const ctx = cv.getContext('2d');

  // --- projection (three.js matrices are column-major: e[col * 4 + row])
  const mat4mul = (a, b) => {
    const c = new Array(16);
    for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[col * 4 + k];
      c[col * 4 + row] = s;
    }
    return c;
  };
  const toClip = (m, x, y, z) => [
    m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14], m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
  const ndc = c => c[3] < EPS ? null : [c[0] / c[3], c[1] / c[3]];
  // Point on segment behind -> front where w reaches EPS (near-side clip).
  const cut = (b, f) => { const t = (EPS - b[3]) / (f[3] - b[3]); return b.map((v, i) => v + (f[i] - v) * t); };

  // Per-frame view: PV matrix and the game canvas rect.
  let PV = null, R = null;
  const scr = c => [R.left + (c[0] / c[3] + 1) / 2 * R.width, R.top + (1 - c[1] / c[3]) / 2 * R.height];
  const screenOf = (x, z) => { const c = toClip(PV, x, Y, z); return c[3] < EPS ? null : scr(c); };
  function strokeWorld(pts, closed = false) {
    if (pts.length < 2) return;
    const cs = pts.map(p => toClip(PV, p.x, Y, p.z));
    const n = closed ? cs.length : cs.length - 1;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      let a = cs[i], b = cs[(i + 1) % cs.length];
      if (a[3] < EPS && b[3] < EPS) { pen = false; continue; }
      const bCut = b[3] < EPS;
      if (a[3] < EPS) { a = cut(a, b); pen = false; } else if (bCut) b = cut(b, a);
      if (!pen) ctx.moveTo(...scr(a));
      ctx.lineTo(...scr(b));
      pen = !bCut;
    }
    ctx.stroke();
  }
  const ring = (x, z, r, n = 40) => Array.from({ length: n }, (_, i) => ({ x: x + r * Math.cos(i / n * 2 * Math.PI), z: z + r * Math.sin(i / n * 2 * Math.PI) }));

  // --- helpers
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const colorOf = key => PALETTE[[...key].reduce((h, ch) => h * 31 + ch.charCodeAt(0), 7) % PALETTE.length];
  const fresh = n => performance.now() - (n.at ?? 0) < FRESH_MS;
  const threat = m => {
    const d = (m.level ?? 0) - (g.level ?? 0);
    return d <= -3 ? '#888' : d <= 0 ? '#5c5' : d <= 2 ? '#ec4' : d <= 4 ? '#f80' : '#f33';
  };
  const values = v => v?.values ? [...v.values()] : [];
  function findGameCanvas() {
    if (gameCanvas?.isConnected) return gameCanvas;
    let best = null, ba = 0;
    for (const c of document.querySelectorAll('canvas')) {
      const r = c.getBoundingClientRect(), a = r.width * r.height;
      if (c !== cv && a > ba) { ba = a; best = c; }
    }
    return gameCanvas = best;
  }

  // --- collision raster, built incrementally (ROWS rows per frame), cached per collision object
  let raster = null;
  function rasterFor(col) {
    if (!col) return null;
    if (raster?.col === col) return raster;
    const half = col.half ?? 230, cx = col.cx ?? 0, cz = col.cz ?? 0, n = Math.ceil(2 * half / STEP);
    const can = document.createElement('canvas');
    can.width = can.height = n;
    return raster = { col, half, cx, cz, n, can, ctx: can.getContext('2d'), row: 0 };
  }
  function rasterStep(r) {
    if (r.row >= r.n) return;
    const rows = Math.min(ROWS, r.n - r.row), img = r.ctx.createImageData(r.n, rows);
    for (let j = 0; j < rows; j++) {
      const z = r.cz - r.half + (r.row + j + 0.5) * STEP;
      for (let i = 0; i < r.n; i++) {
        let s = false;
        try { s = r.col.solidAt(r.cx - r.half + (i + 0.5) * STEP, z, 0); } catch {}
        if (s) { const o = (j * r.n + i) * 4; img.data.set([120, 112, 96, 230], o); }
      }
    }
    r.ctx.putImageData(img, 0, r.row);
    r.row += rows;
  }

  // --- on-screen overlay
  function drawOverlay(d, me) {
    ctx.lineWidth = 2;
    if (d?.home) { ctx.strokeStyle = 'rgba(120,255,140,0.6)'; ctx.setLineDash([8, 6]); strokeWorld(ring(d.home.x, d.home.z, d.leash), true); ctx.setLineDash([]); }
    ctx.strokeStyle = 'rgba(255,60,60,0.9)';
    for (const s of d?.dangers ?? []) strokeWorld(ring(s.x, s.z, s.r), true);
    for (const [key, n] of Object.entries(d?.navs ?? {})) {
      if (!fresh(n) || !n.pts?.length) continue;
      const rest = n.pts.slice(n.i);
      ctx.strokeStyle = colorOf(key); ctx.lineWidth = 3;
      strokeWorld([me, ...rest]);
      rest.forEach((p, k) => {
        const s = screenOf(p.x, p.z);
        if (!s) return;
        ctx.fillStyle = k === 0 ? '#fff' : colorOf(key);
        ctx.beginPath(); ctx.arc(s[0], s[1], k === 0 ? 6 : 3.5, 0, 2 * Math.PI); ctx.fill();
      });
    }
    if (d?.target) { ctx.strokeStyle = '#f33'; ctx.lineWidth = 3; strokeWorld(ring(d.target.x, d.target.z, 1.4, 24), true); }
  }

  // --- big map
  function drawMap(d, me) {
    const W = innerWidth, H = innerHeight, P = { x: W * 0.15, y: H * 0.15, w: W * 0.7, h: H * 0.7 };
    const r = rasterFor(g.dungeon?.collision ?? g.world?.collision);
    if (r) rasterStep(r);
    const half = r?.half ?? 230, s = Math.min(P.w, P.h) / (2 * half) * zoom;
    const c0 = zoom > 1 ? me : { x: r?.cx ?? 0, z: r?.cz ?? 0 };
    // North up: screen up is -z, as in the game camera.
    const mx = x => P.x + P.w / 2 + (x - c0.x) * s, my = z => P.y + P.h / 2 + (z - c0.z) * s;
    const dot = (x, z, rad, fill) => { ctx.fillStyle = fill; ctx.beginPath(); ctx.arc(mx(x), my(z), rad, 0, 2 * Math.PI); ctx.fill(); };
    const circle = (x, z, rad) => { ctx.beginPath(); ctx.arc(mx(x), my(z), rad * s, 0, 2 * Math.PI); };
    const line = pts => { ctx.beginPath(); pts.forEach((p, k) => ctx[k ? 'lineTo' : 'moveTo'](mx(p.x), my(p.z))); ctx.stroke(); };

    ctx.fillStyle = 'rgba(10,12,18,0.82)'; ctx.fillRect(P.x, P.y, P.w, P.h);
    ctx.save();
    ctx.beginPath(); ctx.rect(P.x, P.y, P.w, P.h); ctx.clip();
    if (r) { ctx.imageSmoothingEnabled = false; ctx.drawImage(r.can, mx(r.cx - r.half), my(r.cz - r.half), 2 * r.half * s, 2 * r.half * s); }
    ctx.font = '12px sans-serif'; ctx.lineWidth = 1.5;
    if (!g.dungeon) for (const z of d?.zones ?? []) {
      ctx.strokeStyle = 'rgba(200,180,255,0.7)'; circle(z.x, z.z, z.r); ctx.stroke();
      ctx.fillStyle = '#dcf'; ctx.fillText(`${z.name} ${z.lvl[0]}-${z.lvl[1]}`, mx(z.x) - 40, my(z.z));
    }
    if (!g.dungeon) for (const w of d?.ways ?? []) {
      const on = g.char?.ways?.includes(w.id), x = mx(w.x), y = my(w.z);
      ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 5, y); ctx.closePath();
      if (on) { ctx.fillStyle = '#4ef'; ctx.fill(); } else { ctx.strokeStyle = '#999'; ctx.stroke(); }
    }
    for (const v of values(g.npcs?.views)) if (v?.def?.x != null) dot(v.def.x, v.def.z, 3, '#fe8');
    ctx.fillStyle = 'rgba(255,50,50,0.3)';
    for (const z of d?.dangers ?? []) { circle(z.x, z.z, z.r); ctx.fill(); }
    if (d?.home) { ctx.strokeStyle = 'rgba(120,255,140,0.8)'; ctx.setLineDash([6, 5]); circle(d.home.x, d.home.z, d.leash); ctx.stroke(); ctx.setLineDash([]); }
    for (const [key, n] of Object.entries(d?.navs ?? {})) {
      if (!n.pts?.length) continue;
      const live = fresh(n);
      ctx.globalAlpha = live ? 1 : 0.35; ctx.strokeStyle = colorOf(key); ctx.lineWidth = 2;
      line(n.pts);
      if (live) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; line([me, n.pts[n.i] ?? n.goal]); }
      ctx.fillStyle = colorOf(key); ctx.fillText(key, mx(n.goal.x) + 5, my(n.goal.z) - 5);
      ctx.globalAlpha = 1;
    }
    for (const m of g.entities?.visibleMonsters?.() ?? []) {
      const big = m.boss || m.elite;
      dot(m.pos.x, m.pos.z, big ? 5 : 3, threat(m));
      if (big) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke(); }
    }
    if (d?.target) { ctx.strokeStyle = '#f33'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(mx(d.target.x), my(d.target.z), 8, 0, 2 * Math.PI); ctx.stroke(); }
    // Player: triangle along yaw (direction sin(yaw), cos(yaw) in x, z).
    const yaw = me.yaw ?? 0, fx = Math.sin(yaw), fz = Math.cos(yaw), px = mx(me.x), py = my(me.z);
    ctx.fillStyle = '#fff'; ctx.beginPath();
    ctx.moveTo(px + fx * 10, py + fz * 10); ctx.lineTo(px - fx * 5 - fz * 5, py - fz * 5 + fx * 5); ctx.lineTo(px - fx * 5 + fz * 5, py - fz * 5 - fx * 5);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    // Scale bar (nice length near a fifth of the panel) and title.
    const m = [5, 10, 20, 50, 100, 200, 500].find(v => v * s >= P.w / 8) ?? 500, bx = P.x + 12, by = P.y + P.h - 14;
    ctx.strokeStyle = ctx.fillStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by); ctx.lineTo(bx + m * s, by); ctx.lineTo(bx + m * s, by - 4); ctx.stroke();
    ctx.fillText(`${m} m`, bx + m * s + 6, by);
    const area = g.dungeon ? 'donjon ' + (g.dungeon.def?.name ?? '') : (g.zoneName ?? 'monde');
    const build = r && r.row < r.n ? ` (carte ${Math.round(r.row / r.n * 100)} %)` : '';
    ctx.font = '13px sans-serif';
    ctx.fillText(`${area}${build}  |  but : ${d?.goal ?? '-'}  |  ferme : ${d?.zone ?? '-'}  |  zoom x${zoom} (molette)  |  F10`, P.x + 10, P.y + 18);
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    if (!mode) return;
    const dpr = devicePixelRatio || 1, W = innerWidth, H = innerHeight;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const me = g.sim, cam = g.renderer?.camera;
    if (!me || !g.inWorld) return;
    let d = null;
    try { d = window.__bot?.debug?.() ?? null; } catch {}
    if (mode & 1 && cam?.projectionMatrix) {
      PV = mat4mul(cam.projectionMatrix.elements, cam.matrixWorldInverse.elements);
      R = findGameCanvas()?.getBoundingClientRect() ?? { left: 0, top: 0, width: W, height: H };
      drawOverlay(d, me);
    }
    if (mode & 2) drawMap(d, me);
  }

  const onKey = e => {
    if (e.code !== 'F10') return;
    e.preventDefault();
    mode = (mode + 1) % 4;
    if (!mode) ctx.clearRect(0, 0, cv.width, cv.height);
    g.ui?.toast?.('Viz : ' + MODES[mode]);
  };
  // Wheel zoom only over the map panel; zoom 1 fits the area, above it follows the player.
  const onWheel = e => {
    if (!(mode & 2)) return;
    const W = innerWidth, H = innerHeight;
    if (e.clientX < W * 0.15 || e.clientX > W * 0.85 || e.clientY < H * 0.15 || e.clientY > H * 0.85) return;
    e.preventDefault(); e.stopPropagation();
    zoom = Math.max(1, Math.min(16, zoom * (e.deltaY < 0 ? 2 : 0.5)));
  };
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('wheel', onWheel, { capture: true, passive: false });
  raf = requestAnimationFrame(frame);

  // Self-check: synthetic camera at the game offset looking at the origin.
  (() => {
    const fail = m => console.warn('viz self-check failed: ' + m);
    const eye = [0, 17, 11.5], len = v => Math.hypot(...v), norm = v => v.map(x => x / len(v));
    const zA = norm(eye), xA = norm([zA[2], 0, -zA[0]]); // cross(up, z) with up = +y
    const yA = [zA[1] * xA[2] - zA[2] * xA[1], zA[2] * xA[0] - zA[0] * xA[2], zA[0] * xA[1] - zA[1] * xA[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const V = [xA[0], yA[0], zA[0], 0, xA[1], yA[1], zA[1], 0, xA[2], yA[2], zA[2], 0, -dot(xA, eye), -dot(yA, eye), -dot(zA, eye), 1];
    const f = 1 / Math.tan(25 * Math.PI / 180), n = 0.1, fa = 1000;
    const Pm = [f, 0, 0, 0, 0, f, 0, 0, 0, 0, (fa + n) / (n - fa), -1, 0, 0, 2 * fa * n / (n - fa), 0];
    const M = mat4mul(Pm, V), p = (x, y, z) => ndc(toClip(M, x, y, z));
    const o = p(0, 0, 0), e = p(1, 0, 0), north = p(0, 0, -5);
    if (!o || Math.abs(o[0]) > 1e-9 || Math.abs(o[1]) > 1e-9) fail('origin not at NDC center');
    if (!e || !(e[0] > 0) || Math.abs(e[1]) > 1e-9) fail('+x not to the right');
    if (!north || !(north[1] > 0)) fail('-z not up');
    if (p(0, 34, 23) !== null) fail('point behind camera not rejected');
    const c = cut([0, 0, 0, -1], [2, 2, 0, 1]);
    if (Math.abs(c[3] - EPS) > 1e-12) fail('near clip');
  })();

  window.__viz = {
    stop() {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('wheel', onWheel, { capture: true });
      cv.remove();
      delete window.__viz;
    },
  };
  return 'viz loaded (F10)';
})();
