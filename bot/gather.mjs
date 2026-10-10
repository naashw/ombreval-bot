// Usage: node gather.mjs [load|start|stop|status]
// Attaches to Brave (debug port 9222), injects the gathering bot (paused unless `start`), prints its status every 10 s,
// and re-injects it after a page reload. Ctrl+C pauses it.
import { chromium } from 'playwright';
import fs from 'fs';

const cmd = process.argv[2] ?? 'load';
const browser = await chromium.connectOverCDP('http://localhost:9222');
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('ombreval'));
if (!page) { console.error('Onglet Ombreval introuvable dans Brave (port 9222)'); process.exit(1); }

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
