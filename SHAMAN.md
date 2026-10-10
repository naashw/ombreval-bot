# Chaman : build de farm solo du bot

Source : bundle prettifié `js/new.pretty.js` (constantes vers L29510 à 29700, compétences `Fne`/`Ine` vers L37740, arbre `kre` vers L41397, clics vers L56300, `yF` L57190). Chiffres en % de Puissance, hors critiques. Données machine : `bot/shaman_skills.json`, plan : `bot/shaman_build.json`.

## Mécanique

- **Esprit** (`g.sim.fury`, max 100, gains x 1,1) : Griffes +7 par lancer, Nuée +1 par coup de bec, souffle humain +15, x1,5 au pied du totem. Aucun sort humain ne coûte d'Esprit.
- **Formes** loup et ours : bascules (presser à nouveau rend l'homme), 0,35 s, recharge 1,5 s, 5 d'Esprit pour entrer puis 3/s brûlés. En bête, les clics deviennent ceux de la bête.
- **Cercle des bêtes** : changer de forme quand `comboTimer <= 0` libère le souffle de la nouvelle forme, puis 3 s d'attente.

| Souffle | Effet |
|---|---|
| Homme | soin 6 % (10 % avec sh_circle II), +15 Esprit |
| Loup | 5 doses de saignement (150 %) à 5 m, +30 % vitesse des clics 6 s |
| Ours | 300 % à 5 m, étourdit 1,5 s, bouclier 20 % de la vie (1 fois / 10 s) |

- **Harmonie** : formes différentes prises en 15 s (20 avec sh_circle I) : +8 / 16 / 25 % dégâts, -5 / 10 / 15 % dégâts subis.

## Compétences (niveau 12, aps 1,2)

| Compétence | Dégâts | Zone | Cast | Recharge |
|---|---|---|---|---|
| Griffes d'esprit (LMB) | 108 % | ligne 3 m au curseur, 12 m | 0,6 s | 0 |
| Nuée de corbeaux (RMB) | 6 x 24 % = 144 % par cible, -30 % précision ennemie | cercle 3 m, 12 m, une seule nuée | 0,58 s | 0 |
| Totem des ancêtres | 6 x 150 % = 900 % par cible, soin 1,5 %/s | 8 m, 12 s | 0,6 s | 20 s |
| Charge du sanglier | 400 %, étourdit 2,5 s, regroupe | ligne 16 m | 0,55 s | 12 s |
| Esprit du Mammouth | 800 % (renverse 2,5 s), puis 15 s à -40 % dégâts subis | 7 m | 0,9 s | 90 s |
| Appel primal (homme) | aigle 600 %, étourdit 2,5 s, exposé +30 % | 3 m, 14 m | 0,65 s | 14 s |
| Envol du corbeau | 7 m, invulnérable 0,45 s | | | 4 s |

## Build : lanceur humain qui tisse les formes

| Niveaux | Barre (LMB, RMB, 1, 2, 3, 4, R, 5) |
|---|---|
| 1 à 5 | Griffes, Nuée, Loup |
| 6 à 9 | + Ours |
| 10 à 13 | + Totem |
| 14 à 18 | + Sanglier |
| 19 à 35 | + Mammouth |
| 36 à 50 | + Appel primal |

Talents clés : **Totem** (10, R2 au 17 : attire et étourdit), **Mammouth** (19, R2 27), **Bosquet sacré** (24, +30 % sorts humains), **Griffes profondes** (3, +20 % et ralentit), **Labour d'esprit** (30). Les 9 premiers choix reprennent l'arbre actuel du personnage.

## Règles d'usage (ordre de priorité)

1. **Survie** : PV < 40 % avec attaquant au contact : Ours si rugissement prêt et Esprit >= 10, sinon Envol à l'opposé.
2. **Mammouth** : 4+ monstres à 7 m, élite ou boss, ou PV < 35 % avec 2+ attaquants. Pendant 15 s : au contact, LMB au centre, RMB dès prête.
3. **Totem** : 2+ monstres à 8 m du point visé ou élite. Rester ensuite à 6 à 8 m du totem.
4. **Sanglier** : 2+ monstres sur la ligne ou élite, viser vers le totem ou la nuée pour regrouper.
5. **Appel primal** : 2+ monstres à 3 m du point ou élite, avant le totem et la nuée.
6. **Tissage** : monstres à 5 m et `comboTimer <= 0` : homme vers Ours (rugissement prêt) ou Loup, puis retour homme 3 s après (soin + 15 Esprit). Réserve : 20 d'Esprit.
7. **Nuée** : aucune nuée active (3 s) ou plus personne dedans, viser le meilleur cercle de 3 m.
8. **Griffes** : remplissage, ligne qui couvre le plus de monstres.

## Armes

| Rang | Base | aps | Pourquoi |
|---|---|---|---|
| 1 | **Bâton totémique** (classique) | 1,2 | Vraies Griffes et Nuée, talents compris ; la Nuée fait environ 35 % des dégâts |
| 2 | Bois de cerf | 1,2 | Vrille 91 % à 14 m qui soigne un allié ; Bosquet ne vaut que 1,15 x 20 % = 23 % par coup |
| 3 | Hachette de pierre | 1,1 | Arc 2,3 m (mêlée), double l'Esprit (inutile ici), totem lancé 5 % par onde |

Dégâts d'un clic d'arme non classique = coef x dégâts de la compétence classique (Griffes 90 %, Nuée 20 % par impulsion) : le RMB des armes non classiques est très faible. Ne changer de base que si son pow dépasse celui du meilleur totem d'au moins 60 %.
