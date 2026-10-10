// Usage: node run.mjs [start|load|stop|status]
// Attaches to Brave (debug port 9222), injects the bot, prints its status every 10 s,
// and re-injects it after a page reload (game update, reconnect).
import { chromium } from 'playwright';
import fs from 'fs';

const cmd = process.argv[2] ?? 'start';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('ombreval'));
if (!page) { console.error('Onglet Ombreval introuvable dans Brave (port 9222)'); process.exit(1); }

if (cmd === 'stop' || cmd === 'status') {
  console.log(await page.evaluate(c => window.__bot ? (c === 'stop' ? (window.__bot.stop(), 'arrêté') : window.__bot.status()) : 'bot non chargé', cmd));
  await browser.close(); process.exit(0);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const src = () => fs.readFileSync(new URL('./bot.page.js', import.meta.url), 'utf8');
const build = () => JSON.parse(fs.readFileSync(new URL('./build.json', import.meta.url), 'utf8'));
// Skill/gear numbers from the analyst; the bot falls back to inline defaults when missing or invalid.
const skills = () => { try { return JSON.parse(fs.readFileSync(new URL('./skill_values.json', import.meta.url), 'utf8')); } catch { return null; } };

async function inject() {
  while (!(await page.evaluate(() => !!window.__game?.inWorld && !!window.__game.char).catch(() => false))) await sleep(2000);
  await page.evaluate(([b, k]) => { window.__botBuild = b; window.__botSkills = k; }, [build(), skills()]);
  console.log(await page.evaluate(src()));
  // Optional overlay (F10): skipped when missing or broken, never blocks the bot.
  try { console.log(await page.evaluate(fs.readFileSync(new URL('./viz.page.js', import.meta.url), 'utf8'))); }
  catch (e) { console.log('viz non chargée :', e.message.split('\n')[0]); }
  if (cmd === 'start') await page.evaluate(() => window.__bot.start());
}

const quit = async () => { await page.evaluate(() => window.__bot?.pause()).catch(() => {}); await browser.close(); process.exit(0); };
process.on('SIGINT', quit);

await inject();
for (;;) {
  const s = await page.evaluate(() => window.__bot?.status() ?? null).catch(() => null);
  if (!s) { console.log(new Date().toLocaleTimeString('fr-FR'), 'bot déchargé (page rechargée), réinjection'); await inject(); continue; }
  console.log(new Date().toLocaleTimeString('fr-FR'), JSON.stringify(s));
  // Fight dataset: one JSON line per fight summary drained from the page.
  const fights = await page.evaluate(() => window.__bot?.drainFights?.() ?? []).catch(() => []);
  if (fights.length) fs.appendFileSync(new URL('./fights.jsonl', import.meta.url), fights.map(f => JSON.stringify(f)).join('\n') + '\n');
  await sleep(10000);
}
