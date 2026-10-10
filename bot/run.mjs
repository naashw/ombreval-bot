// Usage: node run.mjs [start|load|assist|stop|status]
// assist: only the manual-play assist panel (F6); the bot is loaded paused when the class is supported (necromancer, shaman).
// Attaches to Brave (debug port CDP_PORT, default 9222), injects the bot, prints its status every 10 s,
// and re-injects it after a page reload (game update, reconnect).
import { chromium } from 'playwright';
import fs from 'fs';

const PORT = process.env.CDP_PORT ?? 9222;

const cmd = process.argv[2] ?? 'start';
const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
// Several game tabs (e.g. a private window on another account): CHAR=<character name> picks the tab playing it.
const tabs = browser.contexts().flatMap(c => c.pages()).filter(p => p.url().includes('ombreval'));
const nameOf = p => p.evaluate(() => window.__game?.char?.name ?? null).catch(() => null);
let page = process.env.CHAR ? null : tabs[0];
for (const t of process.env.CHAR ? tabs : []) if (await nameOf(t) === process.env.CHAR) { page = t; break; }
if (!page) { console.error(`Onglet Ombreval${process.env.CHAR ? ' de ' + process.env.CHAR : ''} introuvable dans Brave (port ${PORT}) ; onglets : ${(await Promise.all(tabs.map(nameOf))).join(', ')}`); process.exit(1); }

if (cmd === 'stop' || cmd === 'status') {
  console.log(await page.evaluate(c => window.__bot ? (c === 'stop' ? (window.__bot.stop(), 'arrêté') : window.__bot.status()) : 'bot non chargé', cmd));
  await browser.close(); process.exit(0);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const src = () => fs.readFileSync(new URL('./bot.page.js', import.meta.url), 'utf8');
// Per-class data files: build plan, then skill/gear numbers (the bot falls back to inline defaults when missing or invalid).
const FILES = { necromancer: ['build.json', 'skill_values.json'], shaman: ['shaman_build.json', 'shaman_skills.json'] };
const build = cls => JSON.parse(fs.readFileSync(new URL('./' + FILES[cls][0], import.meta.url), 'utf8'));
const skills = cls => { try { return JSON.parse(fs.readFileSync(new URL('./' + FILES[cls][1], import.meta.url), 'utf8')); } catch { return null; } };

async function inject() {
  while (!(await page.evaluate(() => !!window.__game?.inWorld && !!window.__game.char).catch(() => false))) await sleep(2000);
  const cls = await page.evaluate(() => window.__game.char.ch.cls);
  // TODO(ceiling): start/load on an unsupported class still use the necro files, as before.
  const fcls = FILES[cls] ? cls : 'necromancer';
  if (cmd !== 'assist' || FILES[cls]) {
    await page.evaluate(([b, k]) => { window.__botBuild = b; window.__botSkills = k; }, [build(fcls), skills(fcls)]);
    console.log(await page.evaluate(src()));
    // Optional overlay (F10): skipped when missing or broken, never blocks the bot.
    try { console.log(await page.evaluate(fs.readFileSync(new URL('./viz.page.js', import.meta.url), 'utf8'))); }
    catch (e) { console.log('viz non chargée :', e.message.split('\n')[0]); }
  }
  // Gathering bot (paused) so the panel's "Bot métiers" entry works after a reload too.
  try { console.log(await page.evaluate(fs.readFileSync(new URL('./gather.page.js', import.meta.url), 'utf8'))); }
  catch (e) { console.log('gather non chargé :', e.message.split('\n')[0]); }
  try { console.log(await page.evaluate(fs.readFileSync(new URL('./assist.page.js', import.meta.url), 'utf8'))); }
  catch (e) { console.log('assist non chargé :', e.message.split('\n')[0]); }
  if (cmd === 'start') await page.evaluate(() => window.__bot.start());
}

const quit = async () => { await page.evaluate(() => window.__bot?.pause()).catch(() => {}); await browser.close(); process.exit(0); };
process.on('SIGINT', quit);

await inject();
for (;;) {
  const s = await page.evaluate(a => a ? (window.__assist ? window.__bot?.status() ?? { assist: window.__assist.opt } : null) : window.__bot?.status() ?? null, cmd === 'assist').catch(() => null);
  if (!s) { console.log(new Date().toLocaleTimeString('fr-FR'), 'bot déchargé (page rechargée), réinjection'); await inject(); continue; }
  console.log(new Date().toLocaleTimeString('fr-FR'), JSON.stringify(s));
  // Fight dataset: one JSON line per fight summary drained from the page.
  const fights = await page.evaluate(() => window.__bot?.drainFights?.() ?? []).catch(() => []);
  if (fights.length) fs.appendFileSync(new URL('./fights.jsonl', import.meta.url), fights.map(f => JSON.stringify(f)).join('\n') + '\n');
  // Event journal (action, goal, zone, dungeon phase, level, death changes) for later review.
  const jr = await page.evaluate(() => window.__bot?.drainJournal?.() ?? []).catch(() => []);
  if (jr.length) fs.appendFileSync(new URL('./journal.jsonl', import.meta.url), jr.map(f => JSON.stringify(f)).join('\n') + '\n');
  await sleep(10000);
}
