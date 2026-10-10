# Faucheur : build du bot récolteur

Source : bundle prettifié `js/new.pretty.js` (constantes `pm`/`mm`/`ym`/`xm`/`Cm`/`wm`/`Em`/`Dm`/`Om`/`km`/`Am`/`Fm` vers L29275 à 29445, armes `Vh.reaper` L29928, compétences `bne` L37320, arbre `yre` L40548, logique `oF` L56831 à 57047, vitesse L57533, `yF` L57190) et lecture seule du perso Prospecteur (faucheur, niveau 4 à 5 pendant l'analyse, arbre vide, Faux ébréchée). Chiffres en % de Puissance, hors critiques. Données machine : `bot/reaper_skills.json`, plan : `bot/reaper_build.json`.

Objectif : la récolte. Le combat ne sert qu'à monter de niveau, à vider un nœud gardé et à se défendre pendant la jauge. On privilégie donc la mobilité, la survie et le nettoyage rapide de petits groupes.

## Mécanique

- **Âmes** (`g.sim.fury`, max 100) : +10 par monstre qui meurt à 10 m de soi, peu importe qui le tue (+30 pour un rare, un champion ou un seigneur), +3,2 par coup de faux, +8 par cible du Glas, +6 par mort marquée. Retombent de 3/s après 5 s hors combat.
- **Le Trépas** (passif) : un monstre ordinaire que nos coups laissent sous le seuil meurt net. Seuil = 14 % + 3 % par palier d'âmes (25, 50, 75, 100) + 3 % par rang de rp_harvester, soit 20 à 32 % avec le build. À partir du palier III, il touche aussi les rares et champions à mi-seuil, jamais les seigneurs. Chaque Trépas donne le Linceul (-20 % de dégâts subis pendant 2 s).
- **Les clics enracinent** : aucune marche pendant le Fauchage (0,8/aps) ni la Moisson (0,7/sqrt(aps)). Seul le Siphon permet de marcher (50 %).
- **Passe-mort** (esquive) : téléportation au curseur + 1,6 m, 9 m au plus, jamais à travers un mur. Dure 0,22 s, invulnérable 0,3 s, recharge 4,5 s (les Recharges ne la réduisent pas). Il vise **le curseur**, pas la direction de marche.
- **Monstre « passé »** (traversé par le Passe-mort ou la Ruée) : le Fauchage suivant sur lui est un critique assuré et son seuil de Trépas monte de 10 % pendant 1,5 s.

## Compétences (niveau 12, faux aps 1,2)

| Compétence | Débloquée | Dégâts | Zone | Cast | Recharge | Effet |
|---|---|---|---|---|---|---|
| Fauchage (LMB) | 1 | 175 % au fil, 60 % au manche | demi-cercle de 1,4 à 4,6 m (rp_reap I) | 0,67 s | 0 | +15 % de chance de critique au fil |
| Moisson (RMB) | 1 | 260 % | cercle 4,5 m | 0,64 s | 0 | aspire ; coûte 22 âmes (12 avec rp_harvest) |
| Passe-mort | 1 | | 9 m au curseur | 0,22 s | 4,5 s | invulnérable ; 2 charges avec rp_dodge |
| Ruée spectrale | talent 1 | 550 % | ligne 10 m x 1,9 | 0,31 s | 9 s | invulnérable, étourdit 1,5 s ; R2 : Trépas 30 % ; R3 : 2 charges |
| Marque du trépas | talent 6 | 500 % | 4 m au curseur, 14 m | 0,5 s | 12 s | Trépas +15 % 10 s, les marqués explosent (500 % à 4 m) |
| Glas funèbre | talent 10 | 600 % | 6,5 m autour de soi | 0,62 s | 15 s | terreur 3 s, ralentit 6 s, exposé +25 % 4 s ; R3 : attire au fil |
| Tombes ouvertes (non prise) | talent 10 | 800 % | 4,2 m au curseur | 0,52 + 0,6 s | 12 s | traîne et tient 2,5 s ; exclusive avec le Glas |
| Forme spectrale | talent 14 | onde 500 % | 7 m | 0,45 s | 24 s | 7 s à -50 % de dégâts subis, 4 % de vol de vie ; R3 : se déclenche seule sous 30 % |
| Siphon d'âmes (non pris) | talent 14 | 6 x 120 % + 400 % | 4 liens, 9 m | canal 2,42 s | 16 s | 30 % en soin, coûte 20 âmes ; exclusif avec la Forme |
| Requiem (ultime) | talent 19 | 4 x 625 % | 9 m | 2,22 s | 75 s | invulnérable, tient 1 s par vague, terreur 3 s à la fin |
| Faux fantôme | talent 36 | 240 % aller + 240 % retour | ligne 10 m | 0,5 s | 10 s | ramène les proies à 3 m |

## Arbre (rangées aux niveaux 1, 3, 6, 10, 14, 19, 24, 30, 36, 43, 50)

Rang N d'une active : niveau de rangée + 7 x (N - 1), +8 pour l'ultime. Passifs, maîtrises et stats : tous les rangs dès la rangée. Groupes exclusifs : c (knell, graves), d (wraithform, siphon), k (rp_eternal, rp_cortege, rp_bell), s (rp_oath_ferry, rp_oath_void, rp_oath_toll).

| Niv. | Col 0 | Col 1 | Col 2 |
|---|---|---|---|
| 1 | souldash (3) | rp_edge +4 % Puissance (3) | rp_bone +2 % Garde (3) |
| 3 | rp_reap : fil plus large / manche repousse (2) | rp_harvester : Trépas +3 % (2) | rp_shroud +5 % vie (3) |
| 6 | doom (3) | rp_harvest : Moisson -10 / dépense tout (2) | rp_dodge : 2e charge / ombre 80 % (2) |
| 10 | knell ou graves (3, c) | rp_feast : Trépas soigne 2 % (2) | rp_tempo +4 % Recharges (3) |
| 14 | wraithform ou siphon (3, d) | rp_eye +2 % critique (3) | rp_angel : Trépas sur rares au seuil plein (1) |
| 19 | requiem (2) | rp_cruel +12 % dégâts crit. (3) | rp_hunger : +2 âmes par mort (1) |
| 24 | rp_eternal (k) | rp_cortege (k) | rp_bell : Trépas terrifie 0,5 s à 3 m (k) |
| 30 | rp_whet : +30 % crit. au fil / +4 âmes (2) | rp_fullscythe : lame d'âme au palier IV (1) | rp_keen +10 % dégâts crit. (3) |
| 36 | phantom (3) | rp_endure +2 % Garde (3) | rp_veil : charge rendue / Trépas double (2) |
| 43 | rp_reaping : Moisson tire au fil +20 % (2) | rp_macabre : +25 % 3 s après Passe-mort (1) | rp_quick +3 % Recharges (3) |
| 50 | rp_oath_ferry (s) | rp_oath_void : +2 charges, 10 âmes (s) | rp_oath_toll : Trépas ralentit et expose à 4 m (s) |

## Build

| Niveaux | Barre (LMB, RMB, 1, 2, 3, 4, R, 5) |
|---|---|
| 1 à 8 | Fauchage, Moisson, Ruée |
| 9 | + Marque |
| 10 à 13 | + Glas |
| 14 à 18 | + Forme spectrale |
| 19 à 35 | + Requiem |
| 36 à 50 | + Faux fantôme |

Ordre des talents (1 point par niveau, le perso part de zéro) :

| Niveaux | Talents |
|---|---|
| 1 à 8 | souldash, rp_edge, rp_reap, rp_harvester x2, rp_harvest, rp_dodge, souldash II |
| 9 à 15 | doom, knell, rp_tempo x3, wraithform, souldash III |
| 16 à 25 | rp_feast, knell II, rp_feast II, requiem, rp_shroud, wraithform II, rp_shroud x2, rp_bell, knell III |
| 26 à 35 | rp_bone, requiem II, wraithform III, rp_bone x2, rp_edge x2, doom II, rp_reap II, rp_whet |
| 36 à 50 | phantom, rp_endure x3, rp_veil, doom III, rp_whet II, phantom II, rp_quick x3, rp_macabre, rp_reaping, rp_hunger, rp_oath_toll |

Niveau de personnage visé par palier de métier (zones : T1 1 à 9, T2 9 à 16, T3 17 à 22, T4 23 à 30) : **10 pour T1, 18 pour T2, 24 pour T3, 32 pour T4**. Au-delà de 32, tous les nœuds sont accessibles et le combat ne sert plus qu'à se défendre.

## Vitesse de trajet soutenue (m/s, ligne droite)

Formule : `v = w + (9 - 0,22 w) / 4,5 + (10 - 0,3125 w) / (9 x (1 - Recharges))`, avec `w = 5,28 x (1 + moveSpd / 100)`.

| Niveau | Recharges | Sans bottes | Bottes +9 % | Bottes légendaires +10 (+14,7 %) |
|---|---|---|---|---|
| Marche seule | | 5,28 | 5,76 | 6,06 |
| Passe-mort seul (avant la Ruée) | 0 | 7,02 | 7,47 | |
| 1 à 10 | 0 | **7,95** | 8,39 | 8,66 |
| 11 | 4 % | 7,99 | 8,42 | 8,70 |
| 12 | 8 % | 8,03 | 8,46 | 8,74 |
| 13 à 43 | 12 % | **8,08** | 8,51 | 8,78 |
| 44 / 45 | 15 / 18 % | 8,11 / 8,15 | 8,55 / 8,59 | |
| 46 à 50 | 21 % | **8,20** | 8,63 | 8,90 |

- Le faucheur n'a aucun talent de vitesse : les bottes « du Vent » (seul emplacement, 3 à 9 %) et l'élixir quick (2 à 5 %) sont la seule marge. Le froid de Givrecroc retire jusqu'à 35 % de la marche.
- Les 2 charges (Passe-mort au niveau 7, Ruée au niveau 15) ne changent pas le débit soutenu, seulement la pointe pour fuir : 9 + 9 + 10 + 10 m en moins d'1 s.
- À 7,95 m/s, le faucheur distance sur la durée tous les monstres rapides (Chien infernal 6,8, Loup de givre 6,6, Loup 6,4).

## Temps pour tuer (estimation)

Modèle : PV d'un monstre ≈ 30 x niveau^1,1 x `def.hp` (ajusté sur les gobelins, sapeurs et rampants de niveau 14 à 16 lus en jeu, à ±40 % près). Puissance ≈ (0,04 x lvlBase + 1,5 x niveau de pow d'équipement) x talents. Trépas pris à 23 %.

| Palier | Monstre (niv.) | Niv. perso | Avec Ruée + Glas + Marque (1 cible / pack de 3) | Au Fauchage seul (1 / 3) |
|---|---|---|---|---|
| T1 | Loup (2), Gobelin (4) | 4 à 6 | 0,3 s (la Ruée suffit) | 0,6 à 0,8 s |
| T1 | Squelette (6), Araignée (8) | 8 à 10 | 0,3 s / 1 s | 1,6 à 2,1 s |
| T2 | Scarabée (12), Noyé (14) | 14 à 16 | 0,9 s | 2,6 à 3,7 s |
| T2 | Sapeur (15), Rampant (16) | 17 à 18 | 0,3 à 1,4 s | 1,1 à 4,3 s |
| T3 | Diablotin, Loup de givre (20) | 22 | 0,9 s | 1,6 à 2,3 s |
| T3 | Yéti (21) | 24 | 3,4 / 4,1 s | 8,3 / 9,7 s |
| T4 | Spectre (27), Traqueur (29), Éclat (30) | 30 à 34 | 0,9 s | 2,3 à 3,4 s |
| T4 | Chevalier de la mort (28) | 32 | 1,4 s | 4,3 / 5,1 s |

Le vrai coût d'un combat est donc l'approche et le replacement, pas les dégâts : ne combattre que ce qui garde un nœud ou nous attaque.

## Règles d'usage

### Combat (ordre de priorité)

1. **Survie** : PV < 50 % avec 2+ attaquants, ou élite au contact : Forme spectrale. PV < 30 % et Forme en recharge : Requiem (2,2 s invulnérable). PV < 40 % avec attaquant au contact : Passe-mort à l'opposé (viser le point d'arrivée).
2. **Requiem** : 4+ monstres à 9 m, élite ou boss.
3. **Marque** : 2+ monstres à 4 m du point visé ou élite, avant le Glas.
4. **Glas** : 2+ monstres à 6,5 m, ou 1 attaquant au contact pendant une récolte.
5. **Ruée spectrale** : 2+ monstres sur la ligne de 10 m, ou élite, ou pour sortir d'un encerclement (on traverse invulnérable).
6. **Faux fantôme** : monstres sur un nœud à 5 à 10 m, pour les ramener à soi avant de récolter.
7. **Moisson** : âmes >= coût, et 2+ monstres à 4,5 m ou une cible qu'elle achève par le Trépas.
8. **Fauchage** : remplissage, seulement si la cible est dans le fil (1,4 à 4,6 m). Sinon se replacer : reculer sous 1,4 m, avancer au-delà de 4,2 m.

### Trajet entre nœuds

- **Passe-mort** dès qu'il est prêt : viser le point du chemin A* à 7,4 m (arrivée à 9 m), ligne libre de murs, pas de meute sur le trajet, nœud à plus de 10 m.
- **Ruée spectrale** dès qu'elle est prête, visée à 10 m sur le chemin, aux mêmes conditions. Sauf dans les 3 s avant une pierre de passage ou une porte de donjon : la Ruée remet `outOfCombat` à 0, le Passe-mort non.
- **Ne jamais cliquer** en trajet (les clics enracinent).
- Avec la serpe et des âmes en trop après un combat (>= 12) : la Ruée moissonneuse (6 m en 0,45 s) peut servir pour le premier tronçon. Les âmes retombent 5 s après le combat.

### Récolte

- Avant la jauge : nœud gardé, alors Faux fantôme (ramène) ou Ruée à travers, puis Marque, Glas, Fauchage.
- Pendant la jauge : un monstre qui converge, on lâche la récolte. Un seul attaquant au contact, Glas (terreur 3 à 4 s) puis Fauchage. 2+, Forme spectrale puis combat. Bouger, rouler ou lancer un sort annule la récolte.

## Armes

| Rang | Base | aps | Pourquoi |
|---|---|---|---|
| 1 | **Faux** (classique) | 1,2 | Vrais Fauchage et Moisson, maîtrises comprises (rp_reap, rp_harvest, rp_whet), la Moisson aspire |
| 2 | Serpe | 1,3 | Clic gauche 1,72 x 175 = 301 % (+35 % brut) mais arc de 2 m, petit pas de 2,5 m. Clic droit Ruée moissonneuse 547 % en ligne de 6 m, soigne 1 % par traversé, même coût que la Moisson. À prendre seulement si son pow dépasse de 30 % celui de la meilleure faux |
| 3 | Grande faux | 0,75 | Arc étroit de 6,5 m, 151 %/s seulement ; faux boomerang 324 % sur 9 m qui ramène. À prendre seulement à +80 % de pow |

Sur une arme non classique, le dégât d'un clic vaut coef x le dégât de la compétence classique (Fauchage 175 %, Moisson 260 %). Côté serveur, il n'est pas vérifié que les maîtrises s'appliquent aux clics d'armes non classiques.

## Intégration dans bot.page.js (spec de la prochaine phase)

Les numéros de ligne sont ceux de la version lue le 10/10. Chaque point reprend la façon dont le chaman a été ajouté.

| Ligne | Existant | Équivalent faucheur |
|---|---|---|
| 10 | `CLS`, `SHAMAN` | ajouter `REAPER = CLS === 'reaper'` |
| 14 | `AD_KEY` par classe | `'ombreval-bot-adapt-reaper'` |
| 64 à 86 | `SV_DEFAULT.skills`, `essence.reserveRule` | valeurs par défaut reap, harvest, souldash, doom, knell, wraithform, requiem, phantom (cf. JSON) ; `reserveRule: 0` |
| 100 à 116 | `WPN` | `scythe {aps 1.2}`, `sickle {aps 1.3, reap {dmgPct 301, radius 2, range 3.5, sec 1/1.3}, harvest {dmgPct 547, range 6, sec 0.45, dash 6}}`, `greatscythe {aps 0.75, reap {dmgPct 201, radius 6.5, range 6.5, inner 1.5, sec 1/0.75}, harvest {dmgPct 324, range 9, sec 0.55}}` |
| 222 | `ready(id)` = `cds <= 0` | charges : `souldash` utilisable tant que `cds <= (charges - 1) x cd` (2 charges dès le rang 3) |
| 278 | `retreatCands` : `army = SHAMAN ? [] : myAllies()` | idem pour REAPER |
| 443 à 466 | `sheet()` : branche SHAMAN | branche REAPER = `gear.formula.dpsIndex` (clic 175 %/(0,8/aps), +43 Moisson, +164/(1-cdr), /(1-0,2)) ; `bolt = sk('reap')` |
| 474 à 477 | `castSec` | reap `0.8/aps`, harvest `0.7/sqrt(aps)` (ou `sk.sec` sur arme non classique) ; sorts : castSec/(1+haste) |
| 480 à 486 | `shParts`, `priorMyDps` | `hit x (reap 1,75 x couverture / castSec + somme des sorts prêts / recharge) / (1 - trepasTh())` |
| 490 | `splashShare` | environ 0,8 (demi-cercle, cercles, ligne de la Ruée) |
| 518 | `soak` : `shSoak()` | `rpSoak()` : 0,5 sous Forme spectrale, 0,2 dans les 2 s après un Trépas (Linceul), 0 sinon |
| 612 à 618 | `chooseStrat` : SHAMAN renvoie `'kite'` | REAPER : `'kite'` avec une bande de mêlée (voir 663) |
| 663 à 670 | `kiteMove` : bande `kiteBand(reach, margin, range 12)` | REAPER : bande `[inner 1,4 ; 4,2]` sur la cible, pas la portée de tir ; pas de totem |
| 720 | `reserve()` | 0 pour REAPER |
| 729 à 776 | bloc chaman (`shTick`, `shSoak`, `harmony`) | bloc faucheur : `souls()`, `soulTier()` (paliers 25/50/75/100), `trepasTh()` (0,14 + 0,03 x palier + 0,03 x rp_harvester), `wraithLeft()` (début lu sur `g.sim.action.type === 'wraithform'`), `st.doomAt/doomPt`, `st.trepasAt` (kills) pour le Linceul |
| 759 | `rollReady` (sh_dodge : `cds.roll <= 4.01`, 2 s) | REAPER avec rp_dodge : `cds.roll <= 4.5 + 0.01`, 300 ms entre deux ; sans : `ready('roll')` |
| 778 à 823 | `chooseShaman` | `chooseReaper` : priorités ci-dessus, chaque règle renvoie `{id, slot, aim, ev}` ; Glas et Forme sans visée ; Ruée visée sur `bestLine(mobs, 10, 0.95)` |
| 825 | `if (SHAMAN) return chooseShaman(ctx)` | `if (REAPER) return chooseReaper(ctx)` |
| 900 | `BASE_SKILLS` | `['reap', 'harvest']` |
| 902 à 907 | `servantCount`, `golemAlive`, `skelCap` | 0 / false / 0 comme le chaman |
| 1045 | `myWeapons` (repli) | `['scythe', 'sickle', 'greatscythe']` ; score d'objet x `vTravel/7,95` (bottes moveSpd) |
| 1566 à 1585 | `decide` : `shForms(d)` | rien (pas de bascule) ; appeler `rpTick()` à 1643 à la place de `shTick()` |
| 1650 à 1665 | esquive et repli : `roll` avec `aim: null` | REAPER : `aim` = point d'arrivée (`me + dir x 7,4`), sinon le Passe-mort part vers la vraie souris |
| 1696 à 1702, 1743 à 1760 | trajets (`shop`, `talk`, `loot`, `dungeon`, `explore`, `lure`, `wander`) : `roll: false` | `travelMobility()` : Passe-mort ou Ruée (slot de la barre) quand prêts, visée sur le chemin, règles du trajet ci-dessus |
| 1702 | mammouth : rester au contact | REAPER : garder la cible entre 1,4 et 4,2 m |
| 1726 à 1735 | roulade sur menace (et survie chaman) | même chose avec `aim` explicite à l'opposé ; survie : Forme spectrale avant le Passe-mort |
| 1736 | clic par défaut `slots.push(0)` si `d < 13` | REAPER : seulement si `1,0 <= d <= 4,6` (sinon on s'enracine dans le vide) |
| 1854, 1861 | HUD : `esprit`, `shHud()` | `âmes N (palier I, seuil 23 %)  forme spectrale Xs` |
| 1928 | `status()` : champs chaman | `souls`, `tier`, `trepas`, `wraith` |
| run.mjs 27 | `FILES` | `reaper: ['reaper_build.json', 'reaper_skills.json']` (et le commentaire ligne 2) |
| gather.page.js 480 | roulade de trajet (`aim: st.ahead`) | ajouter la Ruée spectrale (slot de la barre) aux mêmes conditions, sauf 3 s avant une pierre |
