# Mode groupe

Le bot joue avec son groupe : il suit le membre dont le niveau est le plus proche du sien, frappe ce que ce membre frappe et protège le groupe. Lignes `L` = `js/new.pretty.js` (bundle actuel), lignes `bot.page.js` relevées le 2026-10-10 (le fichier bouge : se fier aux noms de fonctions).

## 1. Mécanique du jeu

### Former un groupe

- Client -> serveur : `{t:'party', a:'invite', n:<nom>}`, `{t:'party', a:'accept'}`, `{t:'party', a:'decline'}`, `{t:'party', a:'leave'}`, `{t:'party', a:'kick', n:<nom>}` (L102055-102110, L101991). Chat : `/inviter nom`, `/g message` (envoyés tels quels dans `{t:'chat', m}`, L106732, analysés côté serveur).
- Serveur -> client : `{t:'invite', f:<nom>}` ouvre un popup Accepter/Refuser de 60 s (`Xie = 6e4`, L57598 ; `ask` L102030). Refus automatique si l'invitant est ignoré. Pas d'acceptation automatique côté client.
- Seuls le chef (`lead === 1`) ou un joueur sans groupe peuvent inviter ; seul le chef exclut (L102088-102110).
- Quatre joueurs maximum (guide, L101605).

### État client

- `{t:'party', l}` remplace `g.party` (L92305), renvoyé environ 1 fois par seconde (mesuré : 10 mises à jour en 10 s). `g.party = []` en sortie de monde (L92485).
- Entrée de `g.party` (relevé live) : `{id, n, lvl, hp, x, z, lead?, dead?, w?}`.
  - `hp` : pourcentage entier (0 à 100). `x, z` : entiers, position serveur même hors de vue.
  - `lead: 1` sur le chef seulement, `dead` si mort.
  - `w` : clé de carte du membre, comparée à `g.mapKey` (L94229, L101025) : absente ou `''` = monde (couche 1), `'c2'`... = autre couche (`Jie`, L57566), sinon clé d'instance de donjon (`g.map.k`, ex. `'mv2ddze2-10'`).
  - On est soi même dans la liste (`id === g.meId`).
- Un saut de position de plus de 30 m entre deux mises à jour = pierre de passage ou mort (relevé : 129,124 -> 12,57 en 1 s).

### Autres joueurs dans les entités

- `g.remotes` = `g.entities.players` (L92247), seulement à portée de vue : `{id, name, lvl, hp (pourcent), view.pos, buf}` (L76300).
- Tuple de snapshot `buf.at(-1).v` (décodé L76456-76490) : `[id, x, z, yaw, hp%, action, combo, k, vitesse*10, saut*100, aura, flags]`. `action` = index dans `AM` (`-1` aucune, `-2` mort). `flags & 15` = forme, `flags & 16` = camouflé.
- Pas de cible dans le tuple, ni joueur ni monstre : les monstres sont `[id, x, z, yaw, hp, état, attaque, flags]` (L74808). PROTOCOL.md : la cible se déduit de la visée, aucun message de ciblage.
- Seule source fiable de cible : les événements `hit` du snapshot, `{e:'hit', id:<victime>, s:<source>, a:<dégâts>, g?, dx, dz}` (L85421, L85483). `s === chef` et `id` monstre = cible du chef ; `id === membre` et `s` monstre = monstre sur ce membre.
- Invocations : `g.entities.allies`, `view.ally` porte le propriétaire probable (L74779, non vérifié en live). `{e:'pet', o}` donne le propriétaire (L85439).

### Partage et donjons

- XP et avancée des quêtes partagées dans le groupe, butin personnel (guide L101605, L102133). Portée du partage : côté serveur, non visible dans le client (non vérifié).
- Donjon : `{t:'dungeon', a:'enter', d:<id>}` à moins de 4.8 m de la porte (L86633). Guide : "Votre groupe entre avec vous dans le même donjon" (L101402). Le mécanisme exact (téléport automatique des membres ou entrée par la porte dans l'instance du groupe) est côté serveur : non vérifié. Les membres dans la même instance ont le même `w`.
- Citadelle Sépulcrale et Cœur de la Faille après le niveau 30 : niveau du plus faible du groupe (L101416).
- Sortie : `{t:'dungeon', a:'leave'}`. Pierres : `{t:'travel', w}` (PROTOCOL.md).
- Carte et minicarte : marqueur `mate` pour chaque membre de la même carte (L94229, L95463, L101025). Pas de ping ni de marqueur posé par les joueurs ; seul le canal `/g` existe (lignes `[Groupe] ...` dans `{t:'chat'}`, L101910).

## 2. Comportement

### Choix du chef suivi

- Candidats : membres de `g.party` sauf soi, non morts.
- Score : `|lvl - g.level|`, puis à égalité le vrai chef (`lead`), puis le plus proche, puis le plus petit `id`.
- Hystérésis : on garde le chef courant tant qu'il est candidat ; on change seulement si un autre a un écart de niveau plus petit de 2 ou plus, ou s'il quitte le groupe.
- Chef mort : on reste sur place (on protège son corps) jusqu'à 60 s, puis on prend le suivant.

### Suivi

- Position du chef : `g.remotes.get(id).view.pos` si visible, sinon `{x, z}` de `g.party` (1 Hz, entier).
- Bande de distance : rester entre 4 et `followMax` m (prior 10 m). `followMax` appris : moyenne glissante de la distance au chef pendant les combats qu'il gagne, bornée 6 à 14 m (nécro : 8 à 12, le squelette tient devant ; chaman : 4 à 8, totem et soin de groupe).
- Hors combat : `st.home` = position du chef, `LEASH` = `followMax`. Le patrouilleur existant reste dans la laisse, donc colle au chef.
- Loin (plus de 60 m, ou `w` différent) : `travel(chef)` (A* plus pierres de passage). Saut de plus de 30 m sur la même carte = le chef a pris une pierre : `travel` vers sa nouvelle position, `wayShortcut` choisit seul la pierre.
- Chef dans un donjon (`w` = clé d'instance, différent de `g.mapKey`) : marcher à la porte la plus proche de sa dernière position monde et envoyer `enter` pour cette porte. Chef sorti du donjon (`w === ''`) alors qu'on y est : `leave`.

### Ciblage d'assistance

Dans l'ordre :
1. Cible du chef : dernier monstre touché par le chef ou ses invocations depuis moins de 3 s.
2. Monstres qui ont touché un membre depuis moins de 4 s, le plus bas en PV de groupe d'abord.
3. Monstre le plus proche du chef, dans `followMax + 8`.

Pas de pull à soi : `planPull` reste, mais restreint aux groupes de monstres à moins de `LEASH + 8` du chef.

### Protection

- Membre sous 40 % de PV avec un monstre dessus : ce monstre prend le bonus maximal (le bot tire l'aggro en le frappant).
- Nécro : `holdMove` se place derrière l'armée entre le chef et la menace, les squelettes suivent le bot.
- Chaman : le totem vise le barycentre des monstres qui touchent le groupe (pas seulement les nôtres), pour que son soin couvre le chef.
- Repli (`retreatTick`) : les points candidats sont pris autour du chef, pas d'un point de farm.

### Interdits en groupe

- Pas de `pickZone`, pas de bras donjon (`armDoor`), pas de quête explore ni talk lointaine, pas de lien automatique à une pierre (`maybeBind`), pas de boutique sauf sacs pleins ou potions à 0.

### Sans groupe ou chef hors portée

- `g.party` vide : jeu normal (comme Jouer complet), le statut dit "pas de groupe".
- Chef sur une autre couche (`w = 'cN'`) ou injoignable (pas de chemin) : attendre 60 s au dernier point connu en combattant ce qui arrive, puis jeu normal autour de ce point jusqu'à son retour.

## 3. Spécification du crochet dans bot.page.js

Interrupteur : `window.__botOpts.group === true` (posé par assist.page.js, mode Groupe ; `false` dans tous les autres modes). Tout le reste du bot est inchangé quand il est faux.

### Nouveau bloc (près de `monsters()`, vers L224)

```js
// --- Group mode (window.__botOpts.group): follow the party member closest in level, assist and protect.
const grp = { leadId: null, deadAt: 0, last: null, tgt: new Map(), onMate: new Map(), band: 10 };
const grouped = () => window.__botOpts?.group === true && g.party.length > 1;
function leader() { /* score |lvl - g.level|, lead, distance, id ; hysteresis 2 levels ; dead 60 s */ }
function leaderPos(l) { const r = g.remotes.get(l.id); return r ? { x: r.view.pos.x, z: r.view.pos.z } : { x: l.x, z: l.z }; }
const mateIds = () => new Set(g.party.map(p => p.id).filter(id => id !== g.meId));
// Score multiplier for a monster: leader's target x3, on a member x2 (x4 if that member < 40 % hp), else 1.
function groupMul(m) { /* reads grp.tgt / grp.onMate, ages 3 s / 4 s */ }
```

### Points à toucher

| Fonction (ligne actuelle) | Changement |
|---|---|
| `g.onMessage`, branche `ev.e === 'hit'` (L1821) | Si `grouped()` : `ev.s` est le chef (ou une invocation dont `view.ally` est le chef) et `ev.id` un monstre -> `grp.tgt.set(ev.id, now())` ; `ev.id` dans `mateIds()` et `ev.s` monstre -> `grp.onMate.set(ev.s, { at: now(), mate: ev.id })`. |
| `decideRaw`, bloc `st.home` (L1619-1627) | Avant le `if (g.dungeon)` : si `grouped()` et `leader()` : `st.home = leaderPos(l)`, `LEASH = grp.band`, `st.zone = 'groupe : ' + l.n`, et on saute `pickZone()` et le bloc quête. Dans un donjon du chef, même chose (home = chef, pas `me`). |
| `monsters()` (L224-235) | Le filtre `dist(m.pos, st.home) > LEASH + 8` mesure déjà au chef via `st.home` ; ajouter `grp.onMate.has(m.id)` en OU à `onUs` pour garder les monstres sur un membre. |
| `smith` (L506) | Multiplier par `groupMul(o.m)` quand `grouped()`. |
| `ranked` dans `decideRaw` (L1683) | Accepter aussi `grp.tgt.has(o.m.id)` ou `grp.onMate.has(o.m.id)` dans le filtre. |
| `armDoor` (vers L204) et `chooseGoal` score `dungeon` (L1512) | `armDoor` renvoie `null` si `grouped()`. Nouveau but `follow` (score 0.7, sous `fight` attaqué 1.5) quand le chef est à plus de `grp.band * 1.5` ou sur une autre clé `w`. |
| Nouvelle `followRun()` (à côté de `dungeonRun`, L1204) | Même carte : `travel(leaderPos(l), 'follow')`. Chef en donjon et nous dehors : porte la plus proche de `grp.last` (dernière position monde du chef), `travel` puis `{t:'dungeon', a:'enter', d}` toutes les 3 s. Chef dehors et nous dedans : `{t:'dungeon', a:'leave'}`. Saut de plus de 30 m : vider `st.wayPlans.follow`. |
| `dungeonRun` (L1204) | Si `grouped()` : pas de phase `porte` ni `sortie` décidée seule ; on garde seulement `coffre` (chacun a le sien). |
| `maybeBind` (L1453), bloc `bindW` (vers L1745), `questStep`/`talkScore`, `explore` | Désactivés si `grouped()`. |
| `retreatCands` (L277) | Déjà relatif à `st.home`, donc au chef : rien à faire. |
| `chooseShaman`, totem (L798) | Si `grouped()` : `bestAoe` sur les monstres de `grp.onMate` en plus de `mobs`. |
| `api.status` (L1920) | Ajouter `group: grouped() && grp.leadId != null ? { name, lvl } : null`. assist.page.js affiche `Groupe : suit <name> niv X`, sinon `Groupe : pas de groupe`. |
| Self-check final | Ajouter un test de `leader()` sur une liste factice : écart de niveau, égalité départagée par `lead`, hystérésis de 2 niveaux. |

### Apprentissage de la bande

`grp.band` : après chaque combat terminé sans mort (`endFight(false)`), `band = ema(band, distance moyenne au chef pendant le combat)`, bornée par classe (nécro 8 à 12, chaman 4 à 8). Remise au prior 10 si un membre meurt pendant qu'on était à plus de `band`.
