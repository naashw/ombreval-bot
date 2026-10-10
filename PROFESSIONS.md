# Ombreval : métiers et bot de récolte

Analyse statique de `js/new.pretty.js` (bundle du 10/10) plus inspection en lecture seule de la page (perso connecté : Naashaman, chaman niveau 13, métiers Armurier 1 et Mineur 1). Les numéros `L` renvoient à `js/new.pretty.js`. "Vérifié" = lu dans le code ou dans la page ; "inconnu" = calculé côté serveur, invisible au client.

## 1. Métiers

Deux métiers au plus **par personnage** (`char.prof.list`, texte L89356 "Deux métiers au plus par personnage"). Les matériaux sont aussi par personnage (`char.mats`). Rien n'est partagé au niveau du compte (Naashobot et Naashaman progressent séparément).

| id | Nom | Type | Maître (atelier) | Établi | Voies (niveau 25) |
|---|---|---|---|---|---|
| `miner` | Mineur | récolte | Brenn, Forge des compagnons (24.4, 80) | atelier (raffinage niv. 40) | Prospecteur (gemmes x2, diamants x2) / Fondeur (+35 % lingots, Pierre de garde x3) |
| `herbalist` | Herboriste | récolte | Aubépine, Officine (20.2, 87.6) | chaudron (17.6, 87.8) | Botaniste (mandragore x2.5) / Glaneur (+35 % herbes, **cueillette 25 % plus courte**) |
| `skinner` | Dépeceur | récolte | Gaspard, Fumoir (-19.6, 52) | feu du fumoir (-16.6, 51.6) | Tanneur (+40 % cuir, peaux intactes x2) / Boucher (+60 % viande) |
| `alchemist` | Alchimiste | artisanat | Aubépine | chaudron Officine ou Elua | Élixiriste / Transmutateur |
| `cook` | Cuisinier | artisanat | Gaspard | feu du fumoir, auberge, **tout feu de camp** | Rôtisseur / Pâtissier |
| `jeweler` | Joaillier | artisanat | Orsel, Lapidaire (23, 64.2) | établi lapidaire | Lapidaire / Orfèvre |
| `armorer` | Armurier | artisanat | Brenn | enclume Forge ou Hilde (Cendre) | Maître d'armes / Maître armurier |

- **Établi** : être à moins de 4 m (`OT`, L32800 env., table `DT`).
- **Apprentissage** (`Dv`, L32730) : tâche d'intro, ex. Mineur "Exploitez 3 filons", Herboriste "Cueillez 3 plantes", Dépeceur "Dépecez 5 bêtes" (`prof.list[i].intro` = compteur).
- **Dépeceur** : passif sur les bêtes que vous tuez (message `gend` avec `auto`, cuir et viande directement en sacoche) ; les élites et "belles bêtes" laissent une carcasse à dépecer (`gather a:skin`). Il se combine donc gratuitement avec le bot d'XP.

### Niveaux et XP

- Niveau max **50**. XP pour passer du niveau L à L+1 : `S_(L) = round(30 + 8L + 0.9L²)` (L32091). Ex. 39 (1->2), 200 (10->11), 793 (25->26), 2583 (49->50). Total 1->50 : environ 47 700 XP.
- Rangs : Apprenti < 12, Compagnon 12, Artisan 25, Maître 38, Grand maître 50 (`T_`).
- Paliers débloqués : **T1 niv. 1, T2 niv. 12, T3 niv. 25, T4 niv. 38** (`b_`, L31929).
- Réduction d'XP selon l'écart (niveau du métier moins niveau requis, `D_`) : < 5 orange x1, < 10 jaune x0.7, < 18 vert x0.35, sinon gris x0.05.
- XP de base des recettes : `M_ = {1:18, 2:30, 3:44, 4:60}` multiplié par un facteur par recette (élixir 1.1, taille 1, bijou/arme 3, raffinage 2.5). **XP par récolte : inconnu (serveur)**, probablement la même base par palier avec `D_`. La commande du jour "17 fers" donne 14 XP (vérifié dans la page).
- Conséquence : récolter toujours le palier le plus haut débloqué (1 à 11 : T1, 12 à 24 : T2, 25 à 37 : T3, 38+ : T4). Les herbes ont deux espèces par palier, la seconde demande +5 niveaux (`req = b_[t] + l*5`), l'espèce propre à la zone +10.

## 2. Nœuds de récolte

**Positions connues côté client** : générées de façon déterministe (`gT`, L44088, seed 4242), exposées dans la page par `__game.nodes.list` (171 nœuds : `{id, kind:'ore'|'herb', tier, mat, req, x, z, model}`). `__game.nodes.workable()` (L91863) donne directement les nœuds récoltables par ce perso (métier appris, niveau suffisant, pas épuisé).

- **Épuisement** : message serveur `nodes {l: [[id, backAtMs], ...]}` -> `__game.nodesBack` (Map id -> heure de retour, horloge serveur `VF() = Date.now() + offset`). Liste par personnage (le serveur l'envoie à chacun). **Durée de repousse : inconnue**, à mesurer (backAt - maintenant au moment du `gend`).
- **Filon riche** : `yT(id, charId, t) = hash(id, charId, floor(t / 1 200 000)) < 0.12` (L44156) : 12 % des nœuds sont "riches" pour vous, par fenêtre de 20 min. Calculable dans le bot (copier `vT`, L44144). Rendement supérieur (quantité inconnue).
- **Portée** : 2.8 m (`fT`). Un filon a un cercle de collision de 0.7 x scale (L44836) : viser une case libre à 1.5 m du filon, pas son centre.
- Placement : jamais à moins de 2.5 m + r d'un point d'apparition de meute, 14 m d'un boss, 12 m d'une porte de donjon, 6 m d'une pierre de passage. Les meutes errent quand même jusqu'aux nœuds.

| Zone (id) | Palier | Niv. monstres | Filons | Herbes (req) | Tournée 2-opt filons / herbes / tout (m) | Pierre la plus proche |
|---|---|---|---|---|---|---|
| Bois des Hurlements (wolves) | 1 | 1-3 | 3 fer | 4 sauge (1), 4 racine-de-loup (6) | 95 / 130 / 135 | hurlements, 16 m |
| Camp des Gobelins (goblins) | 1 | 3-5 | 6 fer | 2 sauge, 2 racine | 127 / 87 / 135 | gobelins, 32 m |
| Cimetière Oublié (graveyard) | 1 | 5-7 | 4 fer | 3 sauge, 2 racine | 123 / 97 / 147 | cimetiere, 21 m |
| Sombrebois (spiders) | 1 | 7-9 | 4 fer | 4 sauge, 3 racine | 118 / 128 / 173 | sombrebois, 30 m |
| Antre de Grukk (lair) | 2 | 10-12 | 6 acier | 2 mousse (12), 1 lys de brume (17) | 115 / 69 / 134 | grukk, 26 m |
| Brumelande (swamp) | 2 | 12-16 | 3 acier | 6 mousse, 5 lys | 93 / 211 / 246 | brumelande, 35 m |
| Rochenoire (quarry) | 2 | 13-16 | **11 acier** | 1 mousse, 1 lys | **131** / 57 / 165 | rochenoire, 19 m |
| Moisivert (mycelium) | 2 | 9-13 | 4 acier | 4 mousse, 4 lys, 4 lumicèpe (22) | 117 / 218 / 231 | moisivert, 32 m |
| Terres de Cendre (ashlands) | 3 | 17-22 | 11 braisite | 6 chardon (25), 5 fleur de braise (30) | 206 / 221 / 305 | cendre, 31 m |
| Givrecroc (frost) | 3 | 17-22 | 9 braisite | 3 chardon, 3 fleur, 3 givrefleur (35) | 202 / 160 / 243 | givrecroc, 28 m |
| Nécropole (necropolis) | 4 | 23-30 | 10 ombracier | 5 chapeau-de-nuit (38), 5 lys funèbre (43) | 219 / 214 / 286 | citadelle, 28 m |
| La Faille (rift) | 4 | 27-30 | 9 ombracier | 3 + 3, 3 lys d'ombre (48) | 176 / 199 / 222 | faille, 28 m |

Totaux : T1 17 filons / 24 herbes, T2 24 / 28, T3 20 / 20, T4 19 / 19. Givrecroc : le froid ralentit jusqu'à -35 % (`chill`, `jM = 0.35`), Tisane de givrefleur pour s'en protéger.

### Récolte (mini-jeu)

1. Client : à moins de 2.8 m, sans jauge en cours -> `{t:'gather', a:'node', n:<nodeId>}` (L91856).
2. Serveur : `gstart {g, what, dur, k}` (`dur` en secondes, `k` = `herb` ou ore). Le client répond aussitôt `{t:'gather', a:'ack', g}` (L92349, fait par le client lui-même).
3. **Bouger interrompt la récolte** (texte de la jauge, L100060). Roulade et compétences annulent aussi. Interruption par les dégâts : inconnue.
4. Éventuel éclat : `gevent {g, open, win}` ; appuyer sur Interagir entre `open` et `open + win` secondes après réception -> `{t:'gather', a:'strike', g}` (L92694, via `__game.strike(code)`), verdict `gres {g, ok}`. Réussi = "récolte abondante" (`ev`).
5. Fin : `gend {got:[[mat, n]], xp, ev?, rare?, m?}` (sans `got` = échec, `m` = raison). Puis `nodes {l}`.
- Carcasse : `{t:'gather', a:'skin', id:<dropId>}` ; `gend {auto:true, got, sold, xp}` pour le dépeçage automatique.
- **Durée de récolte : inconnue** (champ `dur`), Glaneur -25 %.

## 3. Matériaux, recettes, vente

- **Sacoche** (`char.mats`, onglet "Matériaux" du sac, L102897) : ne prend **aucune place** dans le sac de 30 (texte "ne prend pas de place dans le sac", fonction `R2`), pas de plafond visible côté client. **Pas de limite d'inventaire pour la récolte**, donc aucun aller-retour de vidage obligatoire.
- Rachat fixe par le maître (`{t:'prof', a:'sell', m, n}`, prix `Cv` = barème x 0.35) :

| Matériau | T1 | T2 | T3 | T4 | Acheteur |
|---|---|---|---|---|---|
| Lingot, herbe, cuir, viande bruts | 1 | 3 | 6 | 11 | Forge (lingots), Officine (herbes), Fumoir (cuir, viande) |
| Gemme brute | 4 | 9 | 19 | 34 | Lapidaire |
| Gemme taillée | 7 | 18 | 39 | 77 | Lapidaire |
| Élixir | 9 | 21 | 46 | 91 | Officine |
| Plat | 5 | 13 | 27 | 55 | Fumoir |
| Rares (diamant, mandragore, peau intacte) | 60 | | | | ; diamant taillé 150 |

- **Commandes du jour** (`char.prof.orders`, renouvelées toutes les 24 h, `{t:'order', i}`) : bien mieux payées. Vu dans la page : 17 fers -> 88 or + 14 XP ; 4 grenats -> 62 or + 14 XP ; bottes d'armurier -> 293 or + 28 XP. Le Comptoir (hôtel des ventes `market`) reste l'autre débouché.
- Recettes (générées L32180-32500) :
  - Alchimiste : élixirs force/pierre/vif-argent/clairvoyance par palier (2 herbes du palier + essence `pale/vivid/ardent/soul` + or), Potions de soin (2 sauge + 1 racine, 6 or -> 3 potions, niv. 3), Potions de lumicèpe (T2), Grand flacon (T3), transmutations d'essences, Tisane de givrefleur, Fiole de lumière, Huile de trempe (niv. 42).
  - Cuisinier : ragoût, brochettes, tourte, bouillon par palier (viande du palier + herbes), 2 plats par fabrication.
  - Joaillier : taille 2 bruts -> 1 taillé, anneaux et amulettes de maître.
  - Armurier : pièces de maître (lingots ou cuir x7 à x10 + toile x4 + essence x3), ouvrage à étapes (`work start/push/finish`, réussite `iv`).
  - Raffinage niveau 40 : Lingot d'ombre affiné (Mineur, 10 ombracier + 2 soul), Cuir de nuit tanné (Dépeceur), Essence de mandragore (Herboriste).
- Élixir de vif-argent : +2/3/4/5 % de déplacement (T1 à T4, `yie.quick`), 1 h.

## 4. Vitesse de déplacement

Formule (L57533) : `vitesse = 5.28 x moveSpd x mult_action x moveMul_classe x (Chasse sauvage ? 1.25) x (1 - 0.35 x froid/100)`.

- `moveSpd = 1 + min(45, somme) / 100` (L57244). Sources : bottes "du Vent" +3 à 9 % (seul emplacement), talent +3 %/rang x3 = **+9 %** (Rôdeuse `rg_swift` rang 1, Voleur `ro_nimble` rang 1, Chevalier `kn_swift` rang 5, Pyromancien `py_swift` rang 5 ; aucune autre classe), élixir +2 à 5 %. Plafond 45 % inatteignable en pratique (environ 23 % max).
- Aucune différence de base par classe (le `frame` de classe ne touche que vie, garde, dégâts). Pas de monture, pas de bonus hors combat, pas de routes.
- Pendant une esquive, la marche s'arrête (seule la Dislocation du nécro a un multiplicateur 1.6) : le gain d'une esquive = distance - vitesse x durée, une fois par recharge (`FC[cls].cd`, la charge en plus ne change pas le débit soutenu).
- Les compétences de mouvement (Charge, Séisme, Ruée spectrale, Bond de retraite) remettent `outOfCombat` à 0 : 3 s sans elles avant de prendre une pierre. L'esquive ne le remet pas.

| Classe | Esquive (dist / durée / recharge) | Autres | Marche seule | + esquive | + compétences | + talent 9 % | + bottes 9 % |
|---|---|---|---|---|---|---|---|
| **Faucheur** | Passe-mort 9 m vers le curseur / 0.22 s / 4.5 s | Ruée spectrale 10 m, recharge 9 s | 5.28 | 7.02 | **7.95** | (pas de talent) | 8.39 |
| Rôdeuse | Pas chassé 4 m / 0.14 s / 2.6 s (2 charges) | Bond de retraite 7 m (curseur derrière), 8 s ; Chasse sauvage +25 % 8 s / 75 s | 5.28 | 6.53 | 7.27 | 7.71 | **8.15** |
| Pyromancien | Pas de braise 8 m / 0.18 s / 4 s | | 5.28 | 7.04 | 7.04 | 7.50 | 7.95 |
| Voleur | Fumigène 5 m / 0.24 s / 3.5 s | Disparition +30 % 5 s / 18 s | 5.28 | 6.35 | 6.79 | 7.27 | 7.75 |
| Chevalier | Garde levée (ralentit, inutile) | Charge 11 m / 9 s, Séisme 9 m / 12 s | 5.28 | 5.28 | 6.73 | 7.16 | 7.59 |
| Berserker | Ruée 6.5 m / 0.32 s / 4 s | Bond (cible requise) | 5.28 | 6.48 | 6.48 | | 6.92 |
| Chaman | Envol du corbeau 7 m / 0.45 s / 4 s | Loup x1.3 (brûle 3 Esprit/s, l'Esprit ne remonte qu'en frappant) | 5.28 | 6.44 | loup : 7.84 tant que l'Esprit dure (environ 33 s pour 100) | | 6.86 |
| Ingénieur | Saut à la poudre 6 m / 0.42 s / 5 s | | 5.28 | 6.04 | 6.04 | | 6.47 |
| Nécromancien | Dislocation 0.6 s à x1.6 / 4.5 s | | 5.28 | 5.70 | 5.70 | | 6.22 |

Valeurs en m/s, soutenues, ligne droite. Les téléportations (Passe-mort, Pas de braise) ne traversent pas les murs : en chemin sinueux le gain réel baisse ; viser le waypoint A* situé 8 à 9 m plus loin sur le chemin.

**Classement récolteur** : 1. Faucheur (+51 %, sans équipement, Ruée spectrale = talent), 2. Rôdeuse (+38 % avec talent rang 1, le meilleur avec bottes), 3. Pyromancien (+33 % dès le niveau 1, uniquement l'esquive, le plus simple à coder). Sur les persos existants : Chaman 6.44 m/s (+22 %) bat Nécromancien 5.70 (+8 %). Le chaman ne peut pas tenir la forme de loup en voyage.

### Pierres de passage

- `{t:'travel', w:<id>}` : gratuit, il faut être à une pierre éveillée, `outOfCombat >= 3` s (L104095), écran de chargement. `{t:'bind', w}` pour lier.
- Table `Qu` (L27721), **17 pierres** : le bot connaît les 15 anciennes ; nouvelles : `puits` (40, 196) et `coeur` (170, 192).
- Le surcoût appris par le bot (`ad.wayCost`, 25 m par défaut) s'applique tel quel.

## 5. Boucle de farm optimale

1. **Choix du palier** : le plus haut débloqué par le métier, borné par le niveau du perso (T2 demande de survivre à des monstres niv. 16, T3 niv. 22, T4 niv. 30). Naashaman (13) : T1 puis T2 Rochenoire/Grukk avec prudence ; Naashobot (22) : jusqu'à T3.
2. **Grappe** : une zone dense du palier (Mineur T2 : Rochenoire, 11 filons en 131 m ; Mineur T1 : Gobelins + Hurlements ; Herboriste T2 : Brumelande ou Moisivert). Pierre la plus proche liée (`bind`) pour renaître sur place.
3. **Ordonnancement** : à chaque fin de récolte, prochain nœud = argmax de `xp_attendue(nœud) / (temps_trajet + dur)` sur `workable()` plus les nœuds dont `backAt` tombe avant l'arrivée, `xp_attendue` x rendement riche (`yT`). Trajet = longueur A* / vitesse de classe, ou chemin via pierre (`wayRoute`). Variante simple : tournée 2-opt de la grappe, nœuds épuisés sautés, rejouée en boucle ; quand toute la grappe est épuisée, passer à la grappe suivante par pierre.
4. **Glints** : frapper chaque éclat (récolte abondante), filons riches en priorité.
5. **Vente** : aucune contrainte de place ; une fois par jour, livrer les commandes (`order`), sinon garder pour l'artisanat ou le Comptoir. Le rachat fixe ne paie presque rien (1 à 11 or).
- Sans repousse ni durée connues, le débit ne se calcule pas encore : ordre de grandeur pour Rochenoire, 131 m à 6.4 m/s = 20 s de marche pour 11 récoltes, donc le temps de récolte et la repousse dominent dès que la vitesse dépasse 6 m/s.

### Risques

- Meutes errantes près des nœuds, aggro pendant la jauge (immobile 'dur' secondes). Si un monstre converge (`converging`), abandonner la récolte (bouger) et laisser `retreatTick` ou le combat gérer.
- Mort : perte d'XP de perso (`death {lost}`), renaissance à la pierre liée.
- Joueurs : monde partagé, nœuds peut-être partagés (épuisement par d'autres non vérifié).
- Froid de Givrecroc, Esprit du chaman qui s'épuise en loup.
- Détection serveur possible d'un comportement trop régulier : délais aléatoires de 150 à 600 ms avant `gather` et `strike`.

## 6. Messages

| Sens | Message | Rôle |
|---|---|---|
| C->S | `{t:'gather', a:'node', n}` | démarrer une récolte (n = id de `nodes.list`) |
| C->S | `{t:'gather', a:'ack', g}` | accusé de `gstart` (le client le fait seul) |
| C->S | `{t:'gather', a:'strike', g}` | frapper l'éclat |
| C->S | `{t:'gather', a:'skin', id}` | dépecer une carcasse au sol |
| C->S | `{t:'prof', a:'learn'\|'forget', p}` / `{t:'prof', a:'spec', p, s}` | apprendre, oublier, choisir sa voie |
| C->S | `{t:'prof', a:'sell'\|'buy', m, n}` | rachat / fournitures chez le maître |
| C->S | `{t:'order', i, b?}` | livrer la commande i (b = index de l'objet pour une pièce) |
| C->S | `{t:'pcraft', r, n}` | fabriquer n fois une recette consommable (à l'établi) |
| C->S | `{t:'work', a:'start', r, ilvl, want?}` / `{a:'push'}` / `{a:'finish'}` | ouvrage d'équipement |
| C->S | `{t:'craft', r}` / `{t:'learn', r}` | forge d'Aldric (recettes d'équipement, pas les métiers) |
| C->S | `{t:'travel', w}` / `{t:'bind', w}` | pierre de passage |
| S->C | `gstart {g, what, dur, k}`, `gevent {g, open, win}`, `gres {g, ok}`, `gend {got, xp, ev, rare, m, auto, sold}` | récolte |
| S->C | `nodes {l:[[id, backAt]]}` | nœuds épuisés et leur retour |
| S->C | `char {c}` (dont `c.prof`, `c.mats`), `pmsg {ok, m}`, `atelier {a}`, `work {s, step}` | état métiers |

## 7. Spec `bot/gather.page.js`

Fichier injecté séparé (`window.__gather`), même mécanique que `bot/bot.page.js` : enveloppe `g.controls.build` (bot.page.js L1490) et `g.onMessage` (L1523). Ne jamais tourner en même temps que `__bot` : `window.__bot?.pause()` au démarrage. Lanceur : un `cmd === 'gather'` dans `run.mjs` (à ajouter par qui possède ce fichier) ou un petit `gather.mjs` calqué sur `run.mjs` `inject()`.

**À copier de bot.page.js** (noms stables, lignes au 10/10) :
- `dist`, `solid` (L197-201), `steer` (L1103), `findPath` A* 1 m sur `solidAt` (L1119, `MAX_NODES` 60000 : suffisant intra-zone, inter-zones passer par pierres).
- `WAYS` (L1151, **ajouter `puits` et `coeur`**), `awake`, `nearestWay`, `wayCost`, `wayRoute` (L1165), `wayShortcut` (L1184), `maybeBind` (L1209), `travel` / `travelPath` (L1216-1233), `unstick` (L1299).
- Danger : `converging`, `CHASE_STATES`, `chaseRange`, `remember`/`ad.spots` (L222-245), `pickRetreat` / `retreatCands` / `retreatTick` (L247-330), `teleEscape` (L728). Potion : logique L1367-1368 (`g.actions.usePotion()`, garde `g.potionCd`).
- Le combat du nécro (`chooseSkill`, `planPull`...) n'est **pas** repris : le récolteur fuit, il ne se bat que s'il est acculé (clic gauche sur l'attaquant le plus proche).

**État** : `st = {on, node, phase:'route'|'gather'|'flee', gauge:{g, t0, dur, glint}, learn:{dur:{}, back:{}}, stats:{n, xp, ev, rare, got:{}}}` et `ad` en `localStorage['ombreval-gather-adapt']` (durées mesurées par palier, repousse mesurée, `wayCost`).

**Décision par tick** (`decide()`) :
1. Mort -> `g.actions.respawn()` après 3 s (comme L1491-1505).
2. Potion si PV < 45 %. `teleEscape`, puis `retreatTick` si un monstre converge (abandonner la jauge : tout mouvement l'annule).
3. Jauge en cours (`g.gauge && !g.gauge.end`) : `move = [0, 0]`, aucune touche. Si `g.gauge.glint` sans `pressed` : à `glint.t0 + (open + 0.45 x win) x 1000` ms moins RTT/2 (`g.prediction.netStats`), appeler `g.strike(<code de la touche interact>)` (garde `pressed` côté client, envoie `strike`).
4. Sinon choisir `st.node` : candidats = `[...g.nodes.workable()]` plus nœuds dont `g.nodesBack.get(id)` arrive avant `eta`, score = `xpGuess(tier, profLvl) x (riche ? 2 : 1) / (tripLen / VIT[cls] + ad.dur[tier])`, filtre : pas dans un `ad.spots` actif, pas à moins de 12 m d'un monstre de niveau > perso + 2. Cible d'approche = case libre (`!solid`) à 1.5 m du nœud côté joueur.
5. Route : `travel(approche, 'node')`. Mobilité : si l'esquive est prête (`!(g.sim.cds.roll > 0)`), la ligne de 8 m devant est libre et le prochain waypoint est à > 6 m, renvoyer `roll: true` (bit 64) avec la visée sur le waypoint A* à 9 m (Faucheur : Passe-mort vise le curseur ; Pyro et Chaman : direction tenue). Ne pas l'utiliser à moins de 4 m de la cible ni dans les 3 s avant une pierre si la compétence remet le combat.
6. À moins de 2.4 m : stop, attendre 1 tick immobile, délai aléatoire 150 à 600 ms, `g.send({t:'gather', a:'node', n: id})` ; relancer au plus toutes les 1.5 s si aucun `gstart` (refus = `gend` sans `got`, lire `m`, blacklister 60 s).
7. Sacoche : rien à vider. Une fois par jour : aller chez le maître et livrer les commandes `mat` remplies (`order`).

**Messages écoutés** : `gstart` (mesurer `dur` par palier), `gevent`, `gres` (taux de réussite), `gend` (`got`, `xp`, `ev`, `rare` -> stats), `nodes` (`backAt - VF` estimé avec `Date.now()` -> `ad.back` par palier, la repousse réelle), `pmsg`. Chaque `gend` : `st.node = null`.

**HUD** (F8, comme le HUD F9) : métier, niveau, XP/h, nœuds/h, durée mesurée, repousse mesurée, cible, prochaine dispo.

**Auto-test** : un `assert` sur la fonction `rich(id, charId, t)` (copie de `vT`) contre `g.nodes` glint (un nœud riche émet des particules dorées 16769658) et sur la sélection de la case d'approche (case libre à moins de 2.8 m).

## Bloquant ou à mesurer

- Durée de récolte, repousse, XP par récolte, effet des dégâts sur la jauge : serveur seulement. Le premier passage du bot les mesure (`gstart.dur`, `nodes.backAt`, `gend.xp`).
- Épuisement partagé entre joueurs ou non : non vérifiable sans second compte.
