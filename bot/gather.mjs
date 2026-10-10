// Usage: node gather.mjs [load|start|stop|status]
// Attaches to Brave (debug port CDP_PORT, default 9222), injects the gathering bot (paused unless `start`), prints its status every 10 s,
// and re-injects it after a page reload. Ctrl+C pauses it.
import { chromium } from 'playwright';
import fs from 'fs';

const PORT = process.env.CDP_PORT ?? 9222;

const cmd = process.argv[2] ?? 'load';
const browser = await chromium.connectOverCDP(`http://localhost:${PORT}`);
// Several game tabs (e.g. a private window on another account): CHAR=<character name> picks the tab playing it.
const tabs = browser.contexts().flatMap(c => c.pages()).filter(p => p.url().includes('ombreval'));
const nameOf = p => p.evaluate(() => window.__game?.char?.name ?? null).catch(() => null);
let page = process.env.CHAR ? null : tabs[0];
for (const t of process.env.CHAR ? tabs : []) if (await nameOf(t) === process.env.CHAR) { page = t; break; }
if (!page) { console.error(`Onglet Ombreval${process.env.CHAR ? ' de ' + process.env.CHAR : ''} introuvable dans Brave (port ${PORT}) ; onglets : ${(await Promise.all(tabs.map(nameOf))).join(', ')}`); process.exit(1); }

if (cmd === 'stop' || cmd === 'status') {
  console.log(await page.evaluate(c => window.__gather ? (c === 'stop' ? (window.__gather.stop(), 'arrêté') : window.__gather.status()) : 'bot métiers non chargé', cmd));
  await browser.close(); process.exit(0);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function inject() {
  while (!(await page.evaluate(() => !!window.__game?.inWorld && !!window.__game.char).catch(() => false))) await sleep(2000);
  console.log(await page.evaluate(fs.readFileSync(new URL('./gather.page.js', import.meta.url), 'utf8')));
  if (cmd === 'start') await page.evaluate(() => window.__gather.start());
}

const quit = async () => { await page.evaluate(() => window.__gather?.pause()).catch(() => {}); await browser.close(); process.exit(0); };
process.on('SIGINT', quit);

await inject();
for (;;) {
  const s = await page.evaluate(() => window.__gather?.status() ?? null).catch(() => null);
  if (!s) { console.log(new Date().toLocaleTimeString('fr-FR'), 'bot métiers déchargé (page rechargée), réinjection'); await inject(); continue; }
  console.log(new Date().toLocaleTimeString('fr-FR'), JSON.stringify(s));
  await sleep(10000);
}
