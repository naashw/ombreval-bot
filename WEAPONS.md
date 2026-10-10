# Armes du nécromancien (mise à jour "l'arme définit les clics")

Source : bundle `index-ybquqU8B.js` (copie prettifiée hors repo, scratchpad `bundle/index.pretty.js`, table `Vh` vers la ligne 29600, logique des clics vers 57100). Comparé à l'ancien bundle `index-tvX5cP96.js`.

## Règles générales (vérifiées dans le code)

- **Arme "classique"** (`classic: true`, le Sceptre d'os pour le nécro) : les clics restent les vraies compétences de classe (`bonebolt`, `blight`), avec leurs talents, leur cadence (`0,72 / aps` et `0,70 / aps`) et leurs effets.
- **Arme non classique** : clics `wpnL` / `wpnR` génériques. Dégâts par coup = `Puissance x dmg de la compétence classique x coef` :
  - clic gauche : `1,65` (dmg d'Épines d'os) `x coef` ;
  - clic droit : `3,0` (dmg de Flétrissure) `x coef`.
- **Durée d'un clic** : gauche = `1 / aps`, droit = `dur` de l'arme (défaut 0,5 s).
- **Coût du clic droit** = coût de Flétrissure, talents compris (20, ou **15 avec nc_blight** : observé en jeu, chutes de 15 exactement). Le clic gauche ne coûte rien.
- **Cadence fixe** : la Hâte n'accélère plus les clics ("vitesse de lancement des compétences (pas des clics)"), seule l'`aps` de l'arme compte.
- **Niveau requis** = `ilvl` de l'objet (31 ramené à 30), identique pour toutes les bases. Une arme d'une autre classe est marquée inutilisable.
- **pow / hp de l'arme** : s'ajoutent à plat à la Puissance et à la vie (`Puissance = (0,04 x base_niveau + somme des pow) x bonus % x cadre de classe`), multipliés par l'amélioration `+N` (`+4 %` à `+62 %` de `+1` à `+10`). Aucun multiplicateur propre à la base n'est visible côté client.
- **Affixes d'arme possibles** : pen, crit, critDmg, execute, leech, haste (haste inutile pour les clics).
- **Côté serveur, non vérifiable dans le bundle** : application des talents `nc_bonebolt` / `nc_blight` aux clics d'arme non classique, gain d'essence du clic gauche, soin "par coup" (par cible ou par coup).

## Les trois bases du nécromancien

Chiffres en % de Puissance. P = 87 (niveau 20 actuel), P ~ 145 (estimation niveau 30, gear du même ilvl). DPS mono-cible, hors critiques et hors talents.

| Base | aps | Clic gauche | Clic droit | Légendaires |
|---|---|---|---|---|
| **Sceptre d'os** (`bonewand`, classique) | 1,25 | Épines d'os : cercle 1,5 m au curseur (13 m), 165 % + 50 % autour (1,8 m), 1,74 coup/s, **+4 essence par coup**, serviteurs sur la cible | Flétrissure : 300 % + 140 % (2,5 m), **crée un cadavre**, 15 essence, 0,56 s | Sceptre du Charnier (+2 squelettes, éclats à la levée), Sceptre de la Peste noire |
| **Dague sacrificielle** (`sacrdagger`) | 1,60 | Saignée rituelle : arc 60°, **2 m**, coef 1,505 = 248 %, **soigne 2 % de la vie par coup** | Lien de sang : lien 3 s, 10 m (casse à 12 m), coef 2,15 = 645 %, **la moitié soigne**, 15 essence, 0,4 s | aucun |
| **Bâton funeste** (`deathstaff`) | 0,90 | Crâne hurlant : projectile 15 m, éclat 1,5 m, coef 0,942 = 155 %, **peur 0,5 s** | Charnier : zone 5 m au curseur (14 m), **chaque cadavre dedans explose**, coef 1,151 = 345 % par cadavre, 15 essence, 0,5 s, **sans recharge** | aucun |

| Base | DPS clic gauche (P 87 / 145) | Soin | Portée | Cadavres |
|---|---|---|---|---|
| Sceptre d'os | 249 / 415 (311 / 519 avec nc_bonebolt x1,25) + éclaboussure | 2 % par cadavre consommé (passif) | 13 m | **en produit** (Flétrissure) |
| Dague sacrificielle | 346 / 576 par cible du cône | ~3,2 % vie/s au clic gauche (77 PV/s), lien : ~280 PV par lancer à P 87 | 2 m (lien 10 m) | n'en produit pas |
| Bâton funeste | 122 / 203 par cible de l'éclat | aucun direct | 15 m | n'en produit pas, en **consomme** beaucoup |

Comparaison utile : Explosion cadavérique fait 450 % sur 3 cadavres max, recharge 8 s. Charnier fait 345 % par cadavre, sans limite de nombre visible, sans recharge, pour 15 essence, mais vole les cadavres de Relever les morts.

## Classement pour le farm solo avec notre build

| Rang | Base | Pourquoi |
|---|---|---|
| 1 | **Sceptre d'os** | Seule arme qui garde nos talents (nc_bonebolt x2, nc_blight), l'essence garantie et les cadavres de Flétrissure qui nourrissent squelettes et Explosion cadavérique, à 13 m. |
| 2 | Dague sacrificielle | Meilleur DPS brut (+39 % vs Épines d'os sans talent) et vrai soin, mais mêlée 2 m qui casse le kite, et aucun cadavre créé. |
| 3 | Bâton funeste | Sûr (15 m, peur) et Charnier énorme sur une meute morte, mais clic gauche très faible, aucun cadavre créé et Charnier concurrence Relever les morts. |

**Auto-équipement du bot** : préférer `bonewand` à pow égal ou presque. Ne passer à `sacrdagger` ou `deathstaff` que si leur pow dépasse nettement celui du meilleur sceptre (ordre de grandeur : +40 % de pow, à confirmer en jeu). Le personnage porte actuellement un Bâton funeste ilvl 19 (pow 15) : c'est le choix le plus faible pour ce build.

## Autres bases (bref)

| Classe | Classique | Alternatives |
|---|---|---|
| Rôdeur | Arc long 0,95 | Arc court 1,8 (tir en marchant, ricochet), Arc de vigie 0,8 (marque +15 %, pluie de flèches) |
| Faucheur | Faux 1,2 | Serpe 1,3 (ruée qui soigne 1 %), Grande faux 0,75 (arc 6,5 m, faux boomerang) |
| Berserker | Haches jumelles 1,42 | Couperets 1,0 (soin 1,5 % sur cible qui saigne), Fléau 2,0 (cercle en marchant, tourbillon) |
| Pyromancien | Bâton de feu 0,92 | Baguette de braise 5,0 (jet tenu), Lanterne ardente 0,8 (orbe perçant, chute de braises) |
| Ingénieur | Arbalète 1,15 | Arbalète à répétition 2,4 (salve + chausse-trapes), Marteau de forge 1,0 (répare, mines) |
| Voleur | Dagues jumelles 1,45 | Kriss 1,8 (poison, détonation), Couteaux de lancer 1,5 (éventail + saut arrière) |
| Chaman | Bâton totémique 1,2 | Bois de cerf 1,2 (soin d'allié, bosquet), Hachette de pierre 1,1 (double Esprit, totem) |
| Chevalier | Épée longue 1,35 | Masse 1,3 (charge), Marteau de guerre 0,8 (bond fracassant, expose) |
