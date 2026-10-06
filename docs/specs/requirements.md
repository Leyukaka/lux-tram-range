# Exigences : lux-tram-range

## Introduction

lux-tram-range est un portage pour le Luxembourg du site "À portée de tram" de Camille Roux
(https://tram.camilleroux.com/, code source https://github.com/camilleroux/montpellier-temps-transport,
licence MIT pour le code, ODbL pour les données calculées).

Le site redessine un territoire selon le temps de trajet en transports en commun depuis un point
de départ : une carte de chaleur, des courbes isochrones à 15 et 30 minutes, et l'itinéraire vers
un point d'arrivée choisi d'un clic. Une seule carte couvre le pays entier ; elle s'ouvre sur
Luxembourg-Ville et se dézoome jusqu'au pays.

Le portage suit le fonctionnement de l'original. Les écarts sont limités à ce qu'impose le contexte
luxembourgeois et sont listés dans `design.md`.

## Glossaire

- **Feed** : le GTFS national publié par l'Administration des transports publics (ATP) sur
  data.public.lu, licence CC-BY. Il couvre AVL, CFL (train et bus), Luxtram, RGTR et TICE.
- **Carte** : la configuration `cities/luxembourg.json` (pays entier). Une seule Carte depuis le 2026-10-06
  (les cartes `luxembourg-ville` et `luxembourg` ont été fusionnées).
- **Complexe** : un regroupement d'arrêts du Feed portant le même nom normalisé et proches de 350 m au plus.
- **Ferré** : les modes tram, train et funiculaire.
- **Jour de référence** : le jour ouvré dont les horaires servent au calcul.
- **Pipeline** : les scripts Python exécutés en local qui produisent `site/data/<slug>.json`.
- **Application** : la page web et `site/app.js` exécutés dans le navigateur.

## Exigences

### R1 : Récupération des données

**User story :** en tant que mainteneur, je veux récupérer les données sources en une commande,
afin de reconstruire le site quand l'ATP publie un nouveau GTFS.

1. QUAND le mainteneur lance `python build.py --fetch`, le Pipeline DOIT interroger l'API
   `https://data.public.lu/api/1/datasets/horaires-et-arrets-des-transport-publics-gtfs/` et
   télécharger la ressource GTFS la plus récente.
2. Le Pipeline DOIT télécharger les limites des communes luxembourgeoises depuis OpenStreetMap
   (relations `boundary=administrative`, `admin_level=8`) via Overpass.
3. Le Pipeline DOIT télécharger depuis OpenStreetMap l'eau, les parcs, les rivières nommées et les ponts
   piétons de l'emprise de chaque Carte.
4. Le Pipeline DOIT enregistrer pour chaque fichier téléchargé la source, la date, la taille et le
   SHA-256 dans `data/<slug>/manifest.json`.
5. SI un téléchargement échoue après les tentatives prévues, ALORS le Pipeline DOIT s'arrêter avec un
   message qui nomme la source en échec.
6. Le Pipeline DOIT fonctionner avec la seule bibliothèque standard de Python.

### R2 : Jour et fenêtre de référence

**User story :** en tant qu'utilisateur, je veux des temps représentatifs d'un jour de semaine
ordinaire.

1. Le Pipeline DOIT choisir le Jour de référence avec la règle de l'original : un mardi ou un jeudi
   dans les 60 jours, dont le volume de courses atteint au moins 92 % du jour le plus chargé, et
   dont l'ensemble de services est le plus fréquent.
2. Le Pipeline DOIT ne retenir que les courses du Jour de référence qui partent entre 7 h et 20 h.
3. Le Pipeline DOIT publier le Jour de référence et la période de validité du Feed dans
   `sources/<slug>.json` et sur la page de la Carte.

### R3 : Modèle de réseau

**User story :** en tant qu'utilisateur, je veux des temps de trajet crédibles, avec la marche, l'attente
et les correspondances.

1. Le Pipeline DOIT classer les lignes en modes : `tram` (route_type 0), `train` (route_type 2), `funicular`
   (route_type 7) et `bus` (route_type 3 et autres).
2. Le Pipeline DOIT découper chaque catégorie de train du Feed (RB, RE, IC, TER, TGV) en lignes distinctes,
   identifiées par leurs deux terminus, et orientées par l'ordre de ces terminus (le `direction_id` des
   catégories de train s'inverse à Luxembourg).
3. Le Pipeline DOIT regrouper les arrêts en Complexes avec la règle de l'original : même nom normalisé,
   lien simple à 350 m au plus.
4. Le Pipeline DOIT calculer le temps de trajet entre deux arrêts consécutifs comme la médiane des courses
   de la fenêtre, avec un minimum de 0,4 minute.
5. Le Pipeline DOIT calculer l'attente au départ, par arrêt, ligne et sens, comme l'attente moyenne d'un
   voyageur arrivant à un instant quelconque de la fenêtre, sur l'horaire réel. Elle compte tous les départs dont
   le parcours restant couvre le parcours habituel de la ligne, quelle que soit leur ligne. Elle est bornée entre
   1 minute et une borne haute configurable par Carte, de 30 minutes par défaut.
6. Le Pipeline DOIT compter une correspondance comme 1,5 minute de marche, plus l'attente moyenne entre
   chaque arrivée de la ligne quittée et le départ suivant de la ligne prise (horaire réel, ce qui inclut les
   correspondances garanties), plus 1 minute d'accès au quai pour les trains et le funiculaire. Une
   correspondance n'est possible qu'après un trajet : un voyageur arrivé à pied prend l'attente au départ.
7. Le Pipeline DOIT relier à pied, à 75 m/min (4,5 km/h), les Complexes distants de 450 m au plus.
8. LORSQU'une marche en ligne droite traverse une rivière configurée, le Pipeline et l'Application DOIVENT
   faire passer le trajet par le pont piéton le plus favorable, dans la limite de 3 km de détour.
9. OÙ un tronçon ferré manque au Feed, comme le funiculaire Pfaffenthal-Kirchberg, le Pipeline DOIT
   permettre de le déclarer dans la configuration de la Carte, avec ses arrêts, son temps de parcours et
   son intervalle.
10. Le Pipeline DOIT ignorer les courses hors du Luxembourg au-delà de l'emprise `stopsBbox` de la Carte.

### R4 : Emprise et grille

**User story :** en tant qu'utilisateur, je veux une seule carte, détaillée en ville et couvrant le pays.

1. La Carte DOIT couvrir les 100 communes du pays avec une grille de 200 m partout.
2. `site/data/luxembourg.json` DOIT rester sous 24 Mo non compressé (limite de 25 Mio par fichier des Workers)
   et sous 5 Mo compressé en gzip. Le Pipeline DOIT pour cela écrire un format compact (voir design.md).
3. Le Pipeline DOIT exclure de la grille les cellules hors des communes et celles sur une étendue d'eau
   de plus de 1 km².
4. Pour chaque cellule, le Pipeline DOIT précalculer les 5 arrêts les plus proches et les 3 gares ou
   stations ferrées les plus proches, avec leur distance de marche.

### R5 : Point de départ

**User story :** en tant qu'utilisateur, je veux choisir mon départ par adresse, par arrêt ou par ma
position.

1. Au chargement sans paramètre, l'Application DOIT placer le départ sur le point `defaultFrom` de la
   Carte (Gare Centrale) et cadrer la vue sur Luxembourg-Ville (`viewBbox`). Le zoom arrière DOIT permettre
   de voir le pays entier.
2. QUAND l'utilisateur saisit au moins 3 caractères, l'Application DOIT proposer jusqu'à 3 stations
   ferrées locales, puis des adresses du géocodeur de geoportail.lu, 7 résultats au total.
3. L'Application DOIT n'afficher que les adresses situées dans l'emprise de la Carte.
4. QUAND l'utilisateur active "Ma position" et l'autorise, l'Application DOIT placer le départ sur sa
   position. Si la position est hors de l'emprise, elle DOIT afficher un message.
5. L'Application DOIT permettre de déplacer les marqueurs par glisser-déposer et d'inverser départ et
   arrivée.

### R6 : Carte de chaleur et isochrones

**User story :** en tant qu'utilisateur, je veux voir d'un coup d'oeil ce qui est accessible depuis mon
départ.

1. QUAND un départ est choisi, l'Application DOIT calculer dans le navigateur le temps vers chaque cellule
   (Dijkstra sur le graphe précalculé) et colorer la carte avec la palette de l'original, du vert au rouge.
2. L'Application DOIT tracer par défaut les isochrones à 15 et 30 minutes, et proposer aussi 45 et
   60 minutes.
3. L'Application DOIT permettre de régler l'échelle des couleurs entre 20 et 150 minutes, par pas de 5.
4. Tant que l'utilisateur n'a touché ni à l'échelle ni aux isochrones (et qu'aucun `max` ou `iso` n'est dans
   l'URL), l'Application DOIT adapter l'échelle au zoom : 45 minutes quand environ 12 km sont visibles,
   jusqu'à 90 minutes quand le pays entier l'est, par pas de 5. Les isochrones suivent : 15 et 30 minutes
   tant que l'échelle est sous 60 minutes, 30 et 60 au-delà.
5. L'Application DOIT afficher le réseau ferré avec la couleur de chaque ligne, ainsi que les arrêts.
   Elle DOIT aussi afficher les noms des arrêts au-delà d'un certain niveau de zoom.
6. Le calcul complet pour un départ DOIT prendre moins de 300 ms sur la Carte, sur un ordinateur portable
   récent.

### R7 : Arrivée et itinéraire

**User story :** en tant qu'utilisateur, je veux savoir combien de temps il me faut pour aller à un endroit
précis, et comment y aller.

1. QUAND l'utilisateur clique ou touche la carte, l'Application DOIT y placer l'arrivée et afficher la
   durée totale.
2. L'Application DOIT détailler l'itinéraire étape par étape, au format de l'original :
   - marche jusqu'à l'arrêt ;
   - trajets avec le badge de ligne et l'attente estimée ;
   - correspondances à pied ;
   - marche finale.
3. SI la marche directe est plus rapide, ALORS l'Application DOIT afficher "Tout à pied".
4. L'Application DOIT afficher la part des stations ferrées atteignables en moins de 30 minutes depuis le
   départ.

### R8 : Bus

**User story :** en tant qu'utilisateur luxembourgeois, je veux que les bus comptent par défaut, car ils
forment l'essentiel du réseau.

1. Au chargement, l'Application DOIT inclure les bus (AVL, RGTR, TICE, bus CFL) dans le calcul.
2. QUAND l'utilisateur décoche "Bus", l'Application DOIT recalculer avec le seul réseau ferré.
3. L'Application DOIT afficher les arrêts de bus uniquement quand les bus sont inclus.

### R9 : Liens et partage

1. L'Application DOIT refléter son état dans l'URL :
   - `from`, `to` ;
   - `bus=0` si les bus sont exclus ;
   - `max`, `iso`, `carte=arrivee`.
   Les valeurs par défaut sont omises.
2. QUAND une URL contenant ces paramètres est ouverte, l'Application DOIT restaurer cet état.
3. QUAND l'utilisateur clique sur "Partager", l'Application DOIT utiliser le partage natif, ou à défaut
   copier le lien.

### R10 : Pages

1. Le site DOIT générer, par langue, une page unique à la racine (`/`, `/en/`, `/de/`) qui porte la Carte,
   avec les sections de l'original :
   - titre et accroche ;
   - recherche ;
   - carte et contrôles ;
   - "en chiffres" (part atteignable en 30 min, nombre de stations ferrées, meilleure fréquence, station
     la plus lointaine) ;
   - tableau des lignes ferrées ;
   - FAQ avec la méthode de calcul ;
   - crédits.
2. Le site DOIT proposer une page de mentions légales, une page 404, un `sitemap.xml` et un `robots.txt`.
   Les anciennes adresses `/luxembourg-ville/` et `/luxembourg/` (et leurs versions `/en/`, `/de/`) DOIVENT
   rediriger vers la page de la Carte dans la même langue, en conservant les paramètres d'URL.
3. Le site DOIT être en français par défaut (voir R15 pour les autres langues).
4. Les pages de classement des villes françaises et les images de prévisualisation générées ne font pas
   partie de cette version.

### R11 : Mobile

1. SI la largeur d'écran est de 720 px au plus, ALORS l'Application DOIT reprendre la mise en page mobile
   de l'original : carte à 60 % de la hauteur, panneau d'itinéraire sous la carte, zones de toucher
   élargies.
2. L'Application DOIT gérer le pincement pour zoomer et le glisser pour déplacer.

### R12 : Licences et crédits

1. Le dépôt DOIT conserver la notice MIT de Camille Roux pour le code repris, et ajouter celle du portage.
2. Les données calculées DOIVENT être publiées sous ODbL 1.0, avec l'attribution OpenStreetMap et ATP
   (CC-BY).
3. Le site DOIT créditer la lignée de la visualisation : Anthony Castrio (New York), Jules Grandin (Paris),
   Camille Roux (villes de France).

### R13 : Hébergement

1. Le site DOIT être servi par un Cloudflare Worker en assets statiques, sans code serveur.
2. QUAND le mainteneur lance `npx wrangler deploy`, le contenu de `site/` DOIT être publié.
3. Une URL inconnue DOIT renvoyer la page 404 du site.
4. Le site NE DOIT PAS déposer de cookie ni charger de traceur.

### R14 : Contrôle qualité

1. Le Pipeline DOIT afficher en fin de build un tableau de contrôle par Carte : Jour de référence, nombre
   de lignes par mode, nombre de stations ferrées, taille du fichier.
2. `node tools/check_trips.mjs <slug>` DOIT calculer les trajets du centre vers chaque terminus et chaque
   gare. Il DOIT signaler toute vitesse moyenne inférieure à 8 km/h (trajets de plus de 2 km), ainsi que
   toute vitesse supérieure à 35 km/h pour le tram ou à 90 km/h pour le train.
3. Les trajets de référence suivants DOIVENT tomber dans les fourchettes indiquées :
   - Gare Centrale vers Luxexpo en tram : 18 à 30 min ;
   - Gare Centrale vers Ettelbruck : 30 à 45 min ;
   - Gare Centrale vers Esch-sur-Alzette : 25 à 40 min.
   Ces fourchettes encadrent les temps relevés sur mobiliteit.lu et Google Maps (`docs/benchmark/`).
4. Sur le banc d'essai `docs/benchmark/` (14 trajets), l'écart absolu moyen avec mobiliteit.lu DOIT rester
   sous 5 minutes.

### R15 : Langues

**User story :** en tant que résident ou frontalier, je veux utiliser le site dans ma langue.

1. Le site DOIT être disponible en français (par défaut, à la racine), en anglais (`/en/`) et en
   allemand (`/de/`).
2. Chaque page DOIT proposer un sélecteur de langue qui renvoie vers la même page dans l'autre langue, en
   conservant les paramètres d'URL.
3. Les textes de l'interface (`site/app.js`) et des pages (`build_pages.py`, gabarits) DOIVENT provenir
   d'un fichier de traductions par langue (`i18n/<lang>.json`), le français servant de référence.
4. SI une clé manque dans une langue, ALORS le texte français DOIT être affiché.
5. Le README et le pied de page DOIVENT indiquer que les traductions sont des premières versions et que
   les contributions sont bienvenues, en particulier pour le luxembourgeois.
6. Les pages DOIVENT déclarer `lang` et des liens `hreflang` entre les versions.
