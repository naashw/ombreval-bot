# Ombreval : protocole client/serveur et modèle d'entrée

Analyse statique de `js/index.pretty.js` (build `370e06f-muzx6u32`, protocole `v: 29`). Aucun code exécuté, aucune connexion. Les numéros de ligne renvoient à ce fichier.

Point important : le lobby annonce "Le monde est partagé : vous croiserez d'autres joueurs" (L87342). Ce n'est pas un mode solo isolé, un bot y est visible des autres joueurs.

## 1. Connexion

- **Auth HTTP** (L52869-52944) : `POST /api/login` ou `/api/register` avec `{username, password}` en JSON, réponse `{token, username}`. Token stocké en `localStorage["ombreval-token"]`, envoyé en `Authorization: Bearer <token>` sur toutes les routes `/api/*`. Pas de cookie, pas de basic auth. Un 401 efface le token.
- **Routes REST** : `GET /api/characters` -> `{characters:[{id, name, cls, look, weapon, ...}], max}` ; `POST /api/characters {name, cls}` ; `DELETE /api/characters/:id {name}` ; `GET|PUT /api/settings {keys}` (keymap) ; `POST /api/logout` ; `GET /api/leaderboard`.
- **Dernier perso** : `localStorage["ombreval-last-char"]`.
- **WebSocket** (classe `F3`, L87146-87258) : `wss://${location.host}/ws`, JSON texte, une trame = un objet `{t: ...}`.
- **Handshake** : à `onopen`, le client envoie `{t:'join', token, char: <charId>, v: 29}`. Le token passe donc dans le premier message, pas dans l'URL.
- **Réponse** `welcome` : `{t:'welcome', id, k, c, me, online, map, e, layer, now, b}`.
  - `id` = id d'entité du joueur local (`game.meId`), `k` = tick serveur, `c` = objet personnage complet, `me` = état propre (voir 3), `e` = epoch, `layer` = canal, `now` = horloge serveur (ms), `map` = donjon ou `null` (monde ouvert), `b` = hash de build.
  - Si `b` diffère de `370e06f-muzx6u32`, le client recharge la page une fois (garde en `sessionStorage["ombreval-reload-for"]`).
- **Fin** : `{t:'bye', reload?, f?, m?}`. `reload` = version obsolète ; `f` = raison fatale (`auth` renvoie au login, autre renvoie à la sélection de perso), `m` = message. Pas de reconnexion après un `bye` fatal.
- **Heartbeat** : après `welcome`, `{t:'ping', c: performance.now()}` toutes les 2 s. Aucun `pong` traité côté client (la synchro d'horloge passe par `k` des snapshots).
- **Reconnexion** : backoff `[500, 1000, 2000, 3000, 5000, 8000, 10000]` ms, multiplié par `0.5 + random()`, puis nouveau `join` complet.
- **Création/sélection** : uniquement via REST, puis `join` avec l'id. `window.__play(charId)` lance la connexion pour un perso donné (L101284).

## 2. Messages client -> serveur

### Entrée de mouvement et combat : `in` (L86597-86605, encodage L55680-55693)

```js
{ t:'in', l: [[seq, mx, mz, ax, az, dx, dz, b], ...], rk: <int>, e: <epoch>, k: <tick connu> }
```

- **Fréquence** : simulation client à pas fixe 30 Hz (`TT = 1/30`, L40885). Chaque frame (rAF), les entrées produites depuis la dernière frame partent en un seul `in`, regroupées par `k`. Donc environ 30 entrées/s, en 15 à 60 trames/s selon le framerate. Hors ligne, l'outbox garde les 30 dernières.
- `seq` : compteur croissant par entrée, acquitté par `ack` dans les snapshots.
- `mx, mz` : **vecteur de déplacement en axes monde**, normalisé, arrondi à 1e-3. Haut (W) = `mz -1`, bas = `mz +1`, gauche = `mx -1`, droite = `mx +1`. La caméra ne tourne jamais, donc écran = monde.
- `ax, az` : **point visé en coordonnées monde** (plan y=0), arrondi à 1e-2. Pour le voleur (sorts) et certaines esquives "behind", remplacé par la position du monstre survolé.
- `dx, dz` : **direction de visée normalisée** après aim-assist (cône 0.6 rad, portée `vf[cls].assist` + allonge pour les mêlées, `GV.assist` L61355).
- `b` : **bitmask des boutons** tenus ce tick (table `k`, L34945) : `LMB 1, RMB 2, K1 4, K2 8, K3 16, K4 32, ROLL 64, T1 128, T2 256, T3 512, N1 1024 ... N5 16384`. Le bit vient du champ `btn` de la compétence posée dans l'emplacement de barre (`jT[skillId].btn`), pas de la touche physique.
- `rk` : tick de rendu client (`clock.renderTick()`, interpolation à 4 à 8 ticks de retard), sert vraisemblablement à la compensation de latence côté serveur.
- `e` : epoch reçue dans `welcome`/`map` ; une entrée d'une epoch périmée est sans doute ignorée.
- `k` : dernier tick serveur connu au moment de l'entrée.

Compétences, esquive et ultime passent toutes par `b` dans `in` : il n'y a pas de message "cast". L'esquive est latchée (un appui = un tick `ROLL`), les autres bits restent levés tant que la touche est tenue.

### Autres messages (tous ponctuels, sur action UI)

| `t` | Champs | Rôle |
|---|---|---|
| `potion` | | Boire une potion (touche F) |
| `respawn` | | Réapparaître après la mort |
| `pickup` | `id` | Ramasser un objet au sol (clic sur l'étiquette). Or, matériaux, globes, potions, parchemins sont ramassés automatiquement par le serveur |
| `talk` / `talkEnd` | `n` (id PNJ) | Parler à un PNJ (E à portée), fermer le dialogue |
| `say` | `at`, `i` | Choix de réplique dans un dialogue |
| `dungeon` | `a: enter, d` / `a: leave` / `a: chest` | Entrer (E à < 4.8 m d'une porte), sortir, ouvrir le coffre |
| `travel` / `bind` | `w` (waystone) | Voyage rapide, lier une pierre |
| `talent` / `talentReset` | `id` | Arbre de compétences |
| `alloc` / `attrReset` | `a`, `n?` | Points d'attributs |
| `bar` | `l` (8 ids de compétence) | Disposition de la barre d'action |
| `equip` / `unequip` | `i, id` / `s` (slot) | Équipement |
| `sell` `destroy` `buy` `buyPotion` `restock` | `i, id` | Marchand |
| `stash` `stashPut` `stashTake` | `i, id` | Coffre |
| `salvage` `salvageAll` `upgrade` `reforge` `claim` | divers | Forge |
| `gather` | `a: skin\|node\|ack\|strike`, `id`/`n`/`g` | Récolte (mini-jeu : `strike` au bon moment sur E) |
| `craft` `learn` `pcraft` `work` `prof` `order` `use` | divers | Métiers |
| `market` `vbuy` | `a: open\|search\|buy\|sell\|collect\|cancel` | Hôtel des ventes |
| `party` `trade` | `a: invite\|accept\|decline\|leave\|kick\|request\|offer\|ready\|cancel` | Groupe, échange |
| `chat` | `m` | Chat |
| `qdrop` | `q` | Abandonner une quête |
| `dismantle` | `id` | Ingénieur : démonter une tourelle |
| `ping` | `c` | Heartbeat 2 s |

Pas de message de ciblage : la cible est déduite de `ax/az` + `dx/dz`.

## 3. Messages serveur -> client (`t3.onMessage`, L86306-86432)

### Snapshot `s` (`onSnapshot`, L86578)

```js
{ t:'s', k, ack, me, n?, p, m, lo?, ev?, g? }
```

- `k` : tick serveur (30 Hz, `qJ = 1000/30` ms). `ack` : dernier `seq` d'entrée appliqué.
- `me` : état autoritaire du joueur local (décodé par `qF`, L55727) : `s` (sim : `x, z, yaw, fury, action, cds{skillId:sec}, combo, speed, dead, root, freeze, form, ...`), `hp`, `life` (= PV max), `warcry`, `guard`, `shield`, `potionCd`, `poisoned`, `cx`, `aura`, `hid`...
- `n` : descripteurs d'entités nouvellement visibles (`entities.describe`, L71865) :
  - joueur `ty:'p'` : `id, name, lvl, cls, look, weapon, up` ;
  - cadavre `ty:'c'`, invocation/corps `ty:'b'` (`body`) ;
  - sinon monstre (ou allié si `ally` présent) : `id, kind` (clé de `RT`), `name, lvl, elite, boss, maxHp, radius, scale, ally`.
- `p` : tuples joueurs `[id, x, z, yaw, hpPct, actionIdx, combo, k*100, speed*10, jump*100, aura, formFlags]` ; `actionIdx = -2` = mort, sinon index dans `tM` (liste de toutes les compétences, L40887).
- `m` : tuples monstres/alliés/corps `[id, x, z, yaw, hp, stateIdx, attackIdx, flags]` ; `state` = `zT[idx]` (`idle, chase, windup, strike, recover, leap, dead, reassemble`, L41631), `attack` = `BT[idx]`, `flags` = bits `PF` (`stunned 1, enraged 2, slowed 4, marked 8, ...`, L55651).
- `lo` : paires `[id, every]` (LOD réseau : entité mise à jour tous les N ticks, défaut 2).
- `ev` : événements, `g` : ids disparus. Ils sont rejoués avec retard, quand le tick de rendu atteint `k`.
- Le joueur local est identifié par `welcome.id` (`meId`). Sa position vient de `me.s`, pas de `p` (probablement absent de `p`, non vérifié).

### Événements `ev[]` (`pX.apply`, L74540-75140), champ discriminant `e`

- `hit {id, s, a, dx, dz, m?, g?}` : dégâts `a` de `s` sur `id` (`a = 0` = bloqué, `m` = raté).
- `kill {id, dx, dz}` : mort d'un monstre. `pdie {id}` / `previve {id}` : joueur mort/relevé. `death {lost}` : mort du joueur local.
- `drop {id, kind, x, z, item, m, a}` : butin au sol (`kind` : `item, gold, mat, globe, potion, scroll, carcass`). `undrop {id, by}` : ramassé/disparu.
- `gold {a}`, `xp {a}`, `got {p, m, s}`, `lvl {id, lvl}`, `quest {q, k: start|step|ready|done|drop|item}`, `act {n}`, `toast {m, kind}`, `victory {k}`, `online {n}`.
- Visuels : `heal, rise, tele, tcancel, impact, eslash, sfx, proj, pend, pfx, unfx, nova, soul, gore, pet, tether, parry, buff, hawk, servants, wraith, gear, trap, untrap`. `tele` annonce les attaques télégraphiées des monstres (utile pour esquiver).

### Autres messages

`map {map, me, k, e, layer}` (changement de zone/donjon, reset de la prédiction), `dstate {boss, opened}`, `char {c}` (perso complet : `ch.level, ch.xp, ch.unspent, ch.tree, gold, potions, bag[30], eq, bar, story, ways, ...`), `chat {f, m, sys}`, `who {l}`, `party {l}`, `invite {f}`, `tradeReq {f}`, `trade {s}`, `stash {l, open}`, `shop`, `forge`, `runeforge`, `dlg {n, at, c}`, `vendor {s, open}`, `forged`, `atelier {a}`, `pmsg`, `gstart/gevent/gres/gend` (récolte), `nodes {l}`, `work`, `market`, `mymarket`, `events`.

### Carte et collisions : entièrement côté client

- **Monde ouvert** : généré de façon déterministe par `Ene()` (L43139, seed `cd(1337)`), carré de 460 m centré sur l'origine (`XT(230)`). Collisions = grille spatiale `XT` (L41890) de cercles et boîtes orientées, cellules de 8 m, `solidAt(x, z, r)` et `resolve(sim, radius)`. Accès : `__game.world.collision`.
- **Donjons** : `Ane(def, seed)` (L43799) à partir de `map.d` + `map.seed`, donne `layout {collision, walls, placements, exit, boss, chest, portal}`. Accès : `__game.dungeon.collision`, `__game.dungeon.layout`.
- Pas de navmesh : un bot doit faire son propre A* sur une grille échantillonnée avec `solidAt`.
- Portes de donjon : `__game.portals.doors` (`{d, at}`), interaction à < 4.8 m. PNJ : `__game.npcs`.
- La simulation de déplacement (`OF`, L55525) est partagée avec le serveur (prédiction + réconciliation), donc rejouable hors navigateur si on extrait ce code.

## 4. Clavier, souris et visée

Keymap par défaut (`fj`, L52752 ; surcharges utilisateur en `localStorage["ombreval-keys"]` et `/api/settings`) :

| Action | Touches |
|---|---|
| Déplacement | WASD (codes `KeyW/A/S/D`, donc positionnels, ZQSD sur AZERTY) + flèches |
| Esquive | Espace |
| Potion | F |
| Interagir (parler, ouvrir, voyager, récolter) | E |
| Barre slot0..slot7 | Clic G, Clic D, 1, 2, 3, 4, R, 5 |
| Sac / Perso / Talents / Quêtes / Métiers / Carte / Chat / Touches / Muet | I ou B / C / K ou P / J / N / Tab / Entrée / O / M |

- Barre par défaut (`IT`, L40941) : slot0 = compétence `LMB`, slot1 = `RMB`, slots 2 à 7 remplis selon les rangées de talents (rangée 8 = ultime, slot7 = touche 5).
- Les entrées sont lues via `KeyboardEvent.code` et `MouseEvent.button` ; aucun contrôle `isTrusted` dans le bundle.
- **Souris vers monde** : `ndcX = clientX/innerWidth*2-1`, `ndcY = -(clientY/innerHeight)*2+1`, puis raycast caméra vers le plan y=0 (`GV.aimPoint`, L61343).
- **Caméra** : perspective, FOV vertical 42, near 0.5, far 220, `camOffset = (0, 17, 11.5)` au-dessus/derrière le joueur, sans rotation, avec ressort de suivi et secousses. Pour projeter un point monde vers l'écran, utiliser la vraie caméra `__game.renderer.camera` (matrices `projectionMatrix` et `matrixWorldInverse`) plutôt qu'un calcul fixe.
- Un clic sur une étiquette HTML (butin, joueur) est capté par l'UI : `input.overUi` bloque alors les compétences.

## 5. Anti-triche et limites visibles côté client

- Serveur autoritaire : le client n'envoie que des entrées, `seq` + `ack`, réconciliation ; un écart > 4 m ou un changement d'état mort/vivant = téléportation (`a$.reconcile`, L81083). Les valeurs sont arrondies avant envoi.
- `e` (epoch) et `k` lient chaque entrée à un état serveur ; `rk` permet sans doute au serveur de vérifier la cohérence temporelle.
- Contrôle de version strict : `v: 29` dans `join`, hash de build dans `welcome`, `bye {reload}` si obsolète.
- Validations UI côté client (niveau requis, or, ceinture de 10 potions, portée de 4.8 m pour les portes, 6.5 m pour les PNJ) : le serveur les refait très probablement.
- Rien de visible : pas de captcha, pas de détection `webdriver`, pas de `isTrusted`, pas d'empreinte, pas de limite de débit côté client. Une détection côté serveur (cadence parfaite, sessions 24 h) reste possible et invisible ici.

## 6. Points d'accroche dans la page

Exposés explicitement sur `window` (L101279) : `Object.assign(window, { __game, __ui, __play, __audio })`, plus `window.__fps`.

- `__game` (classe `t3`, L86145) : `meId`, `char` (perso complet), `level`, `hp`, `life`, `potionCd`, `alive`, `sim` (position prédite `x, z, yaw, cds, dead`), `pos` (position rendue), `stats`, `inWorld`, `map`, `dungeon`, `dstate`, `world`, `party`, `hovered`.
- `__game.entities` (`dY`, L71847) : `monsters` / `players` / `allies` (`Map id -> {view, buf}`) ; `view` (`_J`, L70289) expose `pos, hp, maxHp, level, elite, boss, state, attack, flags, dead, def.kind, radius`. Générateur `visibleMonsters()` (L72237).
- `__game.drops.drops` (Map des butins au sol), `__game.npcs`, `__game.portals`, `__game.prediction` (`pending`, `netStats`), `__game.clock`.
- `__game.onMessage` : à envelopper pour tout observer côté serveur. `__game.conn.ws` : la socket brute. `__game.send(obj)` : envoie n'importe quel message par la connexion existante.
- Entrées synthétiques sans événement DOM : `__game.input.press('KeyW')` / `release('KeyW')` (L52726), `__game.input.ndcX/ndcY`, ou remplacer `__game.controls.build` / `aimPoint` (`GV`, L61322) pour fournir `{mx, mz, ax, az, dx, dz, b}` directement.
- `__game.actions` (`_B`, L59577) : `usePotion()`, `respawn()`, `learnTalent(id)`, `allocate(a)`, `equipFromBag(i)`, `sell(i, id)`, `buyPotion()`, etc.
- Attention : toute la boucle (entrées incluses) tourne dans `requestAnimationFrame` (L101286). Onglet masqué ou minimisé = plus aucune entrée envoyée.
