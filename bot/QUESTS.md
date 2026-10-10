# Quêtes, dialogues et contrats (bundle `js/index.pretty.js`)

## 1. Modèle de données

- **Définitions** : tableaux `MY` (histoire, L72383), `NY` (L72859), `PY` (L72980), fusionnés en `FY` ; index `IY = {id: def}` (L73560), `LY` = quêtes `main`. **Aucun n'est accessible depuis `window.__game`** (variables de module).
- **Une quête** : `{ id, title, kind: main|chapter|side, act, level, min, giver?, turnIn, req?: [ids], alt?, remote?, stages: [{ text, obj: [...] }], reward }`. `min` = niveau requis pour la prendre, `req` = quêtes à terminer avant.
- **Objectifs** (constructeurs L72377-72382) : `kill {kind, n}`, `boss {boss}`, `collect {item, from: [kinds], chance, n}`, `talk {npc}`, `explore {place}`, plus `dungeon {d}`, `craft {cat, n}`, `upgrade {up}`, `tree {n}`, `event {n, kind?}`. Quantité requise : `yY` (L72283), `n` pour kill/collect/craft/event, sinon 1.
- **Progression** `g.char.story` : `{ q: { [id]: { s, c: [] } }, done: [ids], flags: [] }`. `s` = index de l'étape courante, `c[i]` = compteur de l'objectif `i` de `stages[s].obj`. `s >= stages.length` = prête à rendre.
- **Statut** `bY(story, def, IY, level)` (L72287) : `done` si dans `done`, `ready` / `active` si dans `q`, sinon `locked` (req manquante ou `level < min`) ou `open`.
- **Quête suivie** : `qQ` (L80942) lit la boussole en localStorage (`ombreval-compass-<charId>`, défaut `@main` = première quête `main` non terminée via `zY` L73569). `$Y` (L73702) = liste du HUD (main + 3 suivies max).
- **Objectif courant** : `PQ(id, story, level)` (L80850) renvoie `{q, text, where, x, z, zone}` : position du giver si `open`/`locked`, du turnIn si `ready`, sinon du premier objectif non rempli (talk = PNJ, kill/collect = zone `bd` qui contient le monstre via `jQ` L80837, boss, donjon, atelier...). `event` et `tree` n'ont pas de cible.
- **Accessible depuis la page** : `g.compass.target = {x, z, r}` (classe `i$` L81004, recalculée toutes les 0,25 s via `FQ` L80902, `r` = rayon de zone ou 6), et les **marqueurs PNJ** `g.npcs.views[i].marker` (`give` = quête à prendre, `turn` = objectif talk ou quête à rendre, `wait` = quête en cours chez lui) + `.story` (vrai si quête principale), calculés par `HY` (L73629) toutes les 0,4 s (L82708). Position réelle : `view.root.position` (les PNJ errants bougent, `def.x/z` = point de départ).
- **Tracker HUD** (classe `Jae` L93590) : `.quest.hud-block > .quest-block[data-q=<id>]`, titre `.quest-name span`, lignes `.quest-text` (`qdone` si rempli, `dim` si verrouillée « Niveau N pour X. », `quest-alt` « En attendant »). Texte d'objectif via `BY` (L73574) : `Tuer : <Nom>`, `Abattre <Boss>`, nom d'objet pour collect, `Parler à <PNJ>`, compteur `<b>have/need</b>`. Bouton boussole active : `.quest-guide.on[data-guide=<id>]`.
- **Piège** : `S1` (L82608) pose aussi `give`/`turn` sur les PNJ de métier (premier métier dès niveau 5, commandes de matériaux). Leur dialogue ne contient pas de quête, d'où `QUEST_SKIP` ci-dessous.

## 2. Comment chaque objectif se valide (serveur)

- **talk** : réponse de dialogue `do: { talk: <questId> }` sur un nœud d'entrée spécifique (ex. Ysolde `arrivee2` L98274). Le serveur choisit ce nœud via `entries` (`if: Hd(q, étape)`), donc hors `hub`.
- **kill / boss / collect / event / dungeon** : automatiques côté serveur (kill du bon `kind`, drop à `chance` sur `from`). Event `quest {q, k: step|item|ready}`.
- **Prise** : `do: { start: id }` ; **rendu** : `do: { complete: id }` (souvent combinés : Garin L98424 fait `talk + complete m_arrivee + start m_loups`). Une quête `remote` se rend toute seule.
- **Abandon** : `qdrop {q}`.

## 3. Dialogue : séquence exacte

1. Se placer à moins de **3,6 m** du PNJ (portée de la touche E, `iv` L31965) ; le serveur ferme au delà de **6,5 m** (L82721).
2. `g.send({ t: 'talk', n: npcId })` (L82738).
3. Le serveur répond `dlg { n, at, c }` : `at` = nœud, `c` = indices des choix visibles (déjà filtrés par `if`).
4. `g.send({ t: 'say', at, i })` où `i` est **une valeur de `c`** (indice dans `node.choices`, L99836), pas la position du bouton.
5. Nouveau `dlg` ou `dlg {}` sans `n` = fermé (L86365). Sinon `g.send({ t: 'talkEnd' })`.

Arbre (`Mse` L98209, helpers L27751-27765) : `{ npc, entries: [{if?, node}], nodes: { id: { text, choices: [{ text, to?, do?, if? }] } } }`. `Id(q)` = choix « offre » visible si `open`, `Ld(q)` = `[accepter (do.start), « Pas maintenant. » (to hub)]`, `Rd(q)` = info si `active`, `Pd()` = au revoir (ni `to` ni `do`), `Fd()` = retour au hub. Le client tague chaque choix (`Fse` L99753, recherche `CY` L72334 dans le sous arbre) : `.dlg-tag.tag-give` (mène à un `start`), `.tag-turn` (mène à un `complete`), `.tag-trade` (boutique), et `.bye` sur les choix terminaux. **`do.talk` n'est pas tagué**, d'où la règle « hors hub, suivre la première vraie réplique ».

## 4. Contrats de chasse (Bertrand)

- **Pas d'acceptation** : aucun message client pour en prendre un. Ils sont attribués par le serveur (« contrats de chasse du jour », L97524 ; « chaque jour », L95473) et arrivent dans `g.char.contracts` via `char {c}`. Forme : `{ kind?, boss?, need, have, gold, xp, claimed }`, libellé `g7` (L93579).
- Le HUD ne les affiche qu'à partir du **niveau 5** (L93682). La progression est automatique (kills).
- **Réclamer** : boutique de Bertrand ouverte (dialogue, choix `do: { open: 'shop' }` L98218, tagué `trade`), puis `g.send({ t: 'claim', i })` avec `i` = index dans `contracts` (L97535). Le bot le fait déjà (`sellAndClaim`).
- **Tableau vide au niveau 6 : non vérifiable côté client.** Hypothèse la plus probable : le serveur tire les contrats à l'ouverture de la boutique ou au reset quotidien. Test : ouvrir la boutique une fois, puis relire `g.char.contracts`.

## 5. Code pour la page

`questObjective(g, ZONES)` : marqueurs PNJ d'abord (`turn` puis `give`, histoire puis plus proche), sinon quête guidée lue dans le HUD + `g.compass.target`. `minLevel` vient de la table `ZONES` du bot (centre/rayon/`lvl`) pour kill/collect, ou de « Niveau N » si verrouillée. Après un dialogue qui n'a produit aucun event `quest`, faire `QUEST_SKIP.set(npc, Date.now() + 10 * 60000)`. Appeler `dialogueStep` un tick après chaque `dlg` (setTimeout 0) et vider `dlgSeen` avant chaque `talk`.

```js
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
  if (/^(Explorer|Terminer|Préparer|Forger|Un objet|Choisir|Tenir|Refermer|Repousser|Réussir)|points dépensés|Parlez à|Retournez/.test(name)) return { type: 'other', ...base };
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
```
