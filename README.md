# Ombreval bot

Bot pour le jeu navigateur Ombreval. Il s'injecte dans la page du jeu et pilote le vrai client (il enveloppe `__game.controls.build` et `onMessage`) : prédiction, collisions et réseau restent gérés par le jeu.

Ce qu'il fait :

- **Farm et montée de niveau** : choisit sa zone en échelle, kite, gère potions, repli et talents.
- **Quêtes, contrats et donjons** : suit les objectifs, parle aux PNJ, termine les expéditions.
- **Groupe** : suit le membre de niveau le plus proche et frappe la même cible.
- **Métiers** : bot de récolte séparé (`gather.page.js`).
- **Adaptatif** : seuils et choix appris au fil des combats (stats par zone, par monstre, A/B), stockés dans le `localStorage` du navigateur, par classe.

Classes gérées : nécromancien, chaman, faucheur.

## Version console (sans installation)

1. Entrer en jeu avec un personnage.
2. Ouvrir [`dist/ombreval-bot.js`](https://raw.githubusercontent.com/naashw/ombreval-bot/main/dist/ombreval-bot.js) et tout copier.
3. Dans l'onglet du jeu, ouvrir la console (F12, onglet Console), coller, Entrée. Au premier collage, Chrome et Brave demandent de taper `allow pasting` avant.

Le bot démarre aussitôt avec les panneaux F6, F10 et F11. Après un rechargement de page ou un changement de personnage, recoller le script. Pour l'arrêter : `__bot.stop()`.

Pour régénérer ce fichier après une modification du bot : `node bot/build-console.mjs`.

## Démarrage rapide (lanceur Node)

Le lanceur réinjecte le bot tout seul après un rechargement et enregistre les combats sur le disque.

Il faut Node.js (ou [Bun](https://bun.sh)) et Brave ou Chrome.

1. Récupérer le bot et ses dépendances :

```sh
git clone https://github.com/naashw/ombreval-bot.git
cd ombreval-bot/bot
bun install        # ou : npm install
```

2. Fermer complètement le navigateur, puis le relancer avec le port de debug :

```sh
brave-browser --remote-debugging-port=9222
```

Avec Chrome, le port de debug est refusé sur le profil par défaut : ajouter un profil dédié, par exemple `google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.ombreval-chrome"`.

3. Ouvrir Ombreval dans ce navigateur et entrer en jeu avec un personnage.

4. Lancer le bot depuis le dossier `bot` :

```sh
node run.mjs start
```

Le terminal affiche `bot loaded` puis l'état du bot toutes les 10 s. Laisser ce terminal ouvert : c'est lui qui réinjecte le bot si la page recharge. Ctrl+C met le bot en pause et ferme le lanceur.

## Commandes

```sh
node run.mjs start    # injecte le bot et le lance, affiche son état toutes les 10 s
node run.mjs load     # injecte le bot en pause
node run.mjs assist   # panneau d'aide au jeu manuel seulement
node run.mjs status   # état du bot
node run.mjs stop     # arrête le bot
```

`run.mjs start` reste attaché à l'onglet et réinjecte le bot après un rechargement de page (mise à jour du jeu, reconnexion).

Plusieurs personnages (par exemple une fenêtre privée sur un autre compte) : `CHAR=<nom du perso> node run.mjs start`, un process par personnage.

Autre port de debug : `CDP_PORT=9333 node run.mjs start`.

Bot de récolte : `node gather.mjs [load|start|stop|status]`.

## En jeu

| Touche | Panneau |
|---|---|
| F6 | Assistant : modes (Complet, Groupe, Métiers...), pause, réglages |
| F10 | Visualisation (chemins, dangers) |
| F11 | Bot de récolte |

`window.__bot.status()` dans la console donne l'état complet.

## Fichiers

- `bot/bot.page.js` : le bot de combat, quêtes et donjons.
- `bot/assist.page.js`, `bot/viz.page.js`, `bot/gather.page.js` : panneaux et bot de récolte.
- `bot/*_build.json`, `bot/*_skills.json`, `bot/skill_values.json` : plans de build et chiffres des compétences par classe.
- `*.md` à la racine : analyses du client (protocole, donjons, groupe, métiers, classes) qui servent de spec au bot.
- `grimoire.html` : référence des compétences et talents.
