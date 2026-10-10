# Donjons : mécaniques et spec bot

Source : bundle live du 2026-10-10 (`live.pretty.js`, noté `L:<ligne>`), comparé à `js/new.pretty.js` (ancien, noté `O:<ligne>`).
Le serveur n'est pas dans le bundle : tout ce qui est marqué **serveur** est déduit, pas vérifié.

## 0. URGENT : Skadra "en armure" = boss scellé

Cas live : Skadra `flags = 524289` = `1` (stunned) + `1<<19` (**sealed**).

| Point | Réponse | Source |
|---|---|---|
| Bit 19 | `sealed` : bulle permanente autour du boss tant qu'un sceau vit. Quand le bit tombe : onde de choc blanche (`fx.shell`) | L:57526-57532, L:76435-76460 |
| Règle | `rules.seals: 3` : il faut **détruire 3 entités `seal`** ("Sceau", hp 3.75x, dmg 0, speed 0, ne bouge pas, n'attaque pas). Pas "tuer tous les trash" | L:42769, L:42803, L:42502-42514 |
| Donjons concernés | **Citadelle Sépulcrale** et **Le Puits de Givre** uniquement | L:42769, L:42803 |
| Global ou par salle | Global (3 sceaux pour tout le donjon, posés dans des salles différentes) | L:45056-45081 |
| Où | Généré côté client par `kre()` (même code que le serveur, même seed) : `dungeon.layout.seals = [{x, z, room}]`. Ordre : salles `side` d'abord (pas la salle `miniboss`), la plus profonde en premier, puis les `hall` les plus profonds. Centre de salle +-2 m | L:45056-45081, L:45102 |
| Effet sur le boss | **serveur**. Le texte d'aide dit "sceaux à briser avant de toucher le maître" (L:103041) mais le live montre Skadra à 4582/15761 PV avec le bit 19 : donc dégâts **réduits**, pas immunité totale (ou le bit a été posé après coup). Taux inconnu | L:103041, snapshot live |
| Compteur restant exposé | **Non**. Seuls : positions `layout.seals`, entités `kind === 'seal'` quand elles sont dans le rayon d'intérêt, et le bit 19 du boss (vrai tant qu'au moins un sceau vit) | |
| Nouveau aujourd'hui ? | Non : `rules.seals`, `sealed`, `dormant` existaient déjà | O:42875, O:42901, O:57589 |

### Pourquoi le bot échoue (bot/bot.page.js)

1. **Ordre des salles** (L1276-1281) : `L.rooms` = chemin principal (entrée, halls, **boss** à l'index `path-1`) **puis** les salles annexes (miniboss, side) ajoutées à la fin. Le bot visite dans l'ordre des index : il entre dans la salle du boss **avant** les salles annexes où sont 2 des 3 sceaux.
2. **Score de cible** (`smithScore` L557) = `dps / ttk` : un sceau a `dmg 0` donc score 0, jamais choisi tant qu'autre chose vit.
3. **Cibles autorisées** (L1730) : `engagedOnUs || d < 6 || plan.ids` : un sceau est toujours `idle`, il n'est jamais "engagé", donc ignoré sauf collé à lui.
4. Rien ne lit `flags & (1<<19)` : le bot tape le boss scellé.

### Règle bot (à implémenter en premier)

```js
const F = { stunned: 1, enraged: 2, warded: 1 << 17, tethering: 1 << 18, sealed: 1 << 19, dormant: 1 << 20 };
const sealsLeft = () => (g.dungeon?.layout.seals ?? []).filter(s => !st.dun.sealsDone?.has(`${s.x|0},${s.z|0}`));
// Un sceau est "fait" quand on est à < 8 m de sa position et qu'aucun monstre kind 'seal' vivant n'est à < 3 m.
```

- **Route** : avant d'aller au boss, si `layout.seals.length` et qu'il en reste : aller à chaque position de sceau (plus proche d'abord), tuer l'entité `def.kind === 'seal'` à < 3 m, marquer fait.
- **Priorité** : `kind === 'seal'` visible = cible n°1, ajoutée aux cibles autorisées même `idle`, quelle que soit la distance (< 25 m).
- **Boss scellé** (`boss.flags & F.sealed`) : sortir le boss du classement. S'il nous colle : kiter vers le sceau restant le plus proche (le boss suit, on tape le sceau). Ne le taper que si plus aucun sceau n'est connu (fallback : sceau introuvable après visite).
- Quand le bit 19 tombe sur le boss : vider `sealsLeft` (tous détruits).

## 1. Données communes (client)

| Élément | Où | Source |
|---|---|---|
| Défs donjons `yT` | `g.dungeon.def` : `path` (salles du chemin), `side` (annexes, la 1re = miniboss), `rules`, `rule`, `boss.enrageAfter` (s), `boss.phases` | L:42650-42850 |
| Layout `kre(def, seed)` | `g.dungeon.layout` : `rooms[{id,kind,cx,cz,x0..z1,depth}]`, `corridors`, `packs[{x,z,room,tier,ambush?}]`, `traps[{x,z,every,phase}]`, `seals`, `boss`, `chest`, `portal`, `exit`, `placements[{name,x,z}]` | L:44885-45120 |
| Kinds de salles | `entrance`, `hall`, `boss` (dernière du chemin), `miniboss` (1re annexe), `side` | L:44890-44915 |
| Portes / grilles | **Aucune** : pas de porte conditionnelle côté client, le sol est ouvert. Le miniboss "garde le chemin" (L:103041) mais aucune condition visible | |
| `g.dstate` | `{boss, opened}` seulement. Message `dstate` | L:93926-93929 |
| Bits de flags monstre | `stunned 1, enraged 2, slowed 4, marked 8, doomed 16, tethered 32, inspired 64, bleeding 128, cursed 256, plagued 512, agonized 1024, axed 2048`, brûlure `(f>>12)&7`, `seed 1<<15`, `hidden 1<<16`, `warded 1<<17`, `tethering 1<<18`, `sealed 1<<19`, `dormant 1<<20`, `designated 1<<21`, `poisoned 1<<22`, `blinded 1<<23`, `taunted 1<<24` | L:57510-57538 |
| `dormant` / `hidden` | `group.visible = false` : **absent de `visibleMonsters()`** | L:76410, L:78267 |
| Sorts annoncés | Event `tele` (forme, rayon, durée, `sp` = id du sort) puis `tcancel`. `m.spell` + `m.attack === 'cast'` en windup | L:87xxx case `tele`, L:76787 |
| Pièges | `rules.traps` : 1 ou 2 pièges par couloir de longueur >= 3, cadence `every` 3.2-4.8 s, `phase`. Rendu/dégâts **serveur** (rien de spécifique côté client, sans doute via `tele`/`impact`) | L:45039-45054 |
| Embuscade | `rules.ambush` : chaque pack `tier: 'pack'` d'un `hall` a cette proba d'avoir `ambush: true` (monstres `dormant`, invisibles jusqu'au réveil) | L:45031-45038 |
| Froid (`rule: 'cold'`) | `g.sim.chill` 0-100, ralentit jusqu'à -35 %, mord à 100. `g.warm` vrai près d'un feu/brasero. Braseros du Puits dans `layout.placements` (`name === 'brazier'`) | L:54673, L:93675, L:101763, L:45371-45377 |
| Corruption (`rule: 'corruption'`) | `g.cor` 0-10 charges : +4 % dégâts infligés, +5 % subis par charge, à 10 ça ronge. Pylône (`placements` `name === 'pylon'`) : rester à < 4.5 m ~2 s lave tout et soigne | L:101719-101731, L:107245, L:45397-45405 |
| Enrage | `boss.enrageAfter` s après le pull (**serveur**), bit `enraged` (2), windups x0.7 | L:42667..42834, L:75149 |

## 2. Par donjon

| Donjon (id, niv) | Layout | Gating boss | Mécaniques / environnement | Miniboss |
|---|---|---|---|---|
| Cryptes de Saint-Vorn (`crypt`, 8) | path 6, side 2 | Aucun côté client | `ambush 0.4` (packs endormis). Boss Vorn, phases 66/33 %, enrage 240 s | Rongeos (ghoul) |
| Mines de Rochenoire (`mines`, 15) | path 7, side 2 | Aucun | `traps: rocks` dans les couloirs. Gorvak, phases 70/40 %, enrage 270 s | Mâchefer (crawler) |
| Forteresse de Braise (`forge`, 23) | path 7, side 3 | Aucun | `traps: flames`. Ignarok, phases 70/35 %, enrage 300 s | Enclume (golem) |
| Le Puits de Givre (`frostwell`, 21) | path 7, side 3 | **3 sceaux** (2 en annexes `side`, 1 dans le hall le plus profond) | `traps: ice`, **froid** (braseros). Skadra, phases 70/35 %, enrage 300 s | Croc-Blanc (yeti) |
| Citadelle Sépulcrale (`citadel`, 30+, héroïque x1.3 PV x1.15 dmg) | path 8, side 3 | **3 sceaux** (idem) | Morgalis, phases 70/40 %, enrage 330 s | Couturier (abomination) |
| Le Cœur de la Faille (`riftcore`, 30+, héroïque x1.35/x1.2) | path 8, side 3 | Aucun bit de gating, mais `warded` possible (voir ci-dessous) | `ambush 0.5`, `traps: void`, **corruption** (pylônes). Nyx'Ara, phases 70/40 %, enrage 330 s | Le Gardien brisé (colossus) |

### Sorts de boss (noms client, attribution **déduite** des noms, l'association boss/sort est serveur)

| Boss | Sorts probables (`eX`, L:76720-76741) |
|---|---|
| Vorn | `graves` Tombes ouvertes |
| Gorvak | `rockfall` Éboulement |
| Ignarok | `lava` Coulée de lave, `meteor` Pluie de météores |
| Morgalis | `ring` Cercles d'âmes, `raise` Appel des serviteurs (adds) |
| Skadra | `icicles` Pluie de stalactites, `whiteout` Souffle de l'hiver (vu en live), `prison` Prisons de glace |
| Nyx'Ara | `gravity` Puits d'ombre, `eclipse` Éclipse, `shards` Couronne d'éclats, `pools` Flaques d'ombre, `ward` **Bouclier du vide** |

### Nouveau dans le bundle du jour

Table `sY` de sorts d'élites/minibosses (absente de l'ancien bundle) : L:74633-75144. Les plus importants pour le bot :

| Sort | Effet | Règle bot |
|---|---|---|
| `mend` Totem de soins | soigne les alliés à 12 m (15 %) | tuer le lanceur en priorité |
| `packhowl`, `blizzardhowl`, `warcry`, `gravecall`, `sappercall`, `rallyfire`, `brood` | invoque 2 adds + `inspired` 6-10 s | focus le lanceur, AoE les adds |
| `frenzy` | buff 6 s | kiter 6 s |
| `pounce`/`*pounce`/`crush`/`talondive` (range 4-12) | saut + recul | rester < 4 m ou > 12 m, ou esquiver le `tele` |
| `quake`, `ring`, `lanes`, `rain`, `fan`, `bombs`, `drag`, `pools` | zones annoncées | déjà couvert par `teleEscape` ; `pools` = zones persistantes (6-7 s) à ne pas traverser |

## 3. Spec d'implémentation (bot.page.js)

Tout est piloté par l'état exposé, aucun cas par donjon.

### 3.1 Route d'exploration (remplace L1276-1281)

```js
// path rooms (without boss) -> annex rooms (miniboss, side) -> seals -> boss
const order = [...L.rooms.filter(r => r.kind === 'hall'), ...L.rooms.filter(r => r.kind === 'miniboss' || r.kind === 'side')];
```

1. Visiter `order` (seuil 5 m, comme aujourd'hui).
2. Puis chaque sceau de `sealsLeft()` (plus proche d'abord).
3. Puis `L.boss`. La salle `boss` n'est jamais un waypoint intermédiaire.
4. Si `t - r.inAt` dépasse le budget, couper les annexes sans sceau, jamais les sceaux.

### 3.2 Priorité de cible (dans le classement L1730)

1. `def.kind === 'seal'` (autorisé même `idle`, < 25 m).
2. Monstre en windup `attack === 'cast'` avec `spell` dans `{mend, raise}` ou un `*call/*howl` (invocation).
3. Ordre `smith` actuel.
4. Exclure : boss avec `sealed` tant qu'un sceau est connu ; toute cible `warded` si une autre cible non `warded` est à portée (effet **serveur**, sans doute absorption) ; `dormant`/`hidden` (déjà invisibles).

### 3.3 Positionnement / esquive

| Condition (état exposé) | Action |
|---|---|
| `g.dungeon.def.rule === 'cold'` et `g.sim.chill >= 60` et `!g.warm` | aller au brasero (`placements` `brazier`) le plus proche hors combat, attendre `chill < 20` |
| `def.rule === 'corruption'` et `g.cor >= 7` | aller à < 4 m du pylône (`placements` `pylon`) le plus proche, rester 2.5 s |
| `def.rules.traps` | ne pas s'arrêter (combat, loot) à < 2 m d'un `layout.traps[i]` ; `tele` reste la vraie esquive |
| `def.rules.ambush` | pack `ambush: true` de `layout.packs` : y entrer PV > 70 %, servants levés |
| boss `enraged` ou `t - pullAt > enrageAfter - 20` et boss PV > 30 % | sortir (`leave`) plutôt que mourir |
| boss `tethering` (bit 18) | lien sur un joueur (`wtether`) : s'éloigner au-delà du rayon (**serveur**, rayon inconnu) |

### 3.4 Check à laisser

Self-check au chargement : `kre`-layout du donjon courant a `seals.length === def.rules?.seals ?? 0` (sinon log `seals: placement partiel`, la boucle de placement peut en sauter un, L:45064-45079).

## 4. Non vérifiable côté client

- Réduction exacte des dégâts sur un boss `sealed` (immunité vs armure).
- Si le miniboss doit mourir pour ouvrir quoi que ce soit (rien de visible).
- Rythme, forme et dégâts des pièges de couloir ; association boss / sort ; seuils de phase et adds de phase ; effet de `warded` et `tethering`.
- Rayon d'intérêt : une entité `seal` lointaine n'est pas dans `g.entities` ; on ne sait qu'elle est morte qu'en allant voir.
