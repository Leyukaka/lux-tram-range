# Conception : lux-tram-range

> Depuis le 2026-10-06, une seule Carte couvre le pays : la section « Carte unique » ci-dessous remplace ce
> qui est dit plus haut des deux Cartes (`luxembourg-ville`, `luxembourg`).

## Vue d'ensemble

Le projet part du code de `camilleroux/montpellier-temps-transport` (MIT) et le garde au plus près.
Il conserve le même découpage :

- un Pipeline Python en local (stdlib seule) produit un JSON compact par Carte ;
- une application JavaScript sans dépendance dessine la carte sur un canvas et calcule les trajets dans
  le navigateur ;
- des pages HTML statiques sont générées à partir de gabarits.

Seul l'hébergement change : un Cloudflare Worker en assets statiques remplace GitHub Pages.

```
data.public.lu (GTFS ATP) ──┐
Overpass (OSM)  ────────────┼─> fetch_data.py ─> data/<slug>/      (non versionné)
                            │
cities/<slug>.json ─────────┴─> build_data.py ─> site/data/<slug>.json   (versionné, ODbL)
                                              └> sources/<slug>.json    (provenance)
                               build_pages.py ─> site/<slug>/index.html, site/index.html, ...
                               wrangler deploy ─> Cloudflare Worker (assets: ./site)
```

## Arborescence

Fichiers repris de l'original, adaptés :

```
build.py, fetch_data.py, build_data.py, build_pages.py, cities.py
cities/luxembourg-ville.json, cities/luxembourg.json
templates/city.html, templates/home.html
site/app.js, site/styles.css, site/404.html, site/favicon.*, site/robots.txt
tools/check_trips.mjs
LICENSE (MIT, notices Camille Roux + portage), README.md
```

Fichiers ajoutés :

```
wrangler.jsonc
docs/specs/* (requirements, design, tasks)
```

Fichiers retirés :

- `tools/rankings.py`, `tools/render_og.py`, `sources/rankings.json` ;
- `site/classements/`, `site/og/` ;
- les 23 configurations de villes françaises ;
- `.github/workflows/pages.yml`.

## Données d'entrée : constats sur le Feed

Constats sur le GTFS du 2026-09-30 :

| Constat | Conséquence |
|---|---|
| Agences : 1 RGTR, 6 AVL, 11 CFL (train), 16 TICE, 111 Luxtram, 171 CFL (bus) | `agencies` non filtré ; tout entre dans le calcul |
| Trains : 5 routes seulement, une par catégorie (IC, RE, RB, TER, TGV), en route_type 2 | Découpage en lignes par terminus (voir plus bas) |
| Tram : route `2466`, T1, route_type 0 | Mode `tram` |
| Pas de route_type 7 : le funiculaire Pfaffenthal-Kirchberg est absent | Tronçon déclaré à la main (`extraLinks`) |
| `route_color` vide sur 712 des 716 routes | Couleurs dans la configuration (`modeColors`, `agencyColors`) |
| `shapes.txt` présent (41 Mo) | `railGeometry: "gtfs"` pour train et tram |
| Arrêts de 48,95 à 50,28 N et de 5,71 à 6,99 E (Metz, Trèves, Arlon) | `stopsBbox` par Carte |
| Pas de `parent_station` (location_type 0 partout) | Regroupement par nom de l'original, inchangé |
| Noms au format "Localité, Arrêt" en UTF-8 | `display_name` adapté (acronymes CFL, AVL, RGTR, TICE, P+R) |
| Suffixes "(Tram)" et "(Bus)" sur un même lieu (ex. "Limpertsberg, Theater (Tram)" / "(Bus)") | `normalize_name` retire ces suffixes pour que tram et bus forment un seul Complexe |
| `frequencies.txt` vide, `transfers.txt` présent | `transfers.txt` ignoré, comme dans l'original |
| Lignes de nuit CN1 à CN8 (AVL) | Éliminées par la fenêtre 7 h - 20 h |

## Écarts par rapport à l'original

| # | Original | Portage | Exigence |
|---|---|---|---|
| E1 | GTFS par réseau, URL fixe dans la config | URL résolue par l'API data.public.lu (`gtfsDataset` + `gtfsResolve: "udata"`) | R1.1 |
| E2 | Communes via geo.api.gouv.fr (EPCI) | Communes via Overpass, `admin_level=8`, `ISO3166-2=LU-*` ou zone `LU` ; champ `nom` rempli depuis `name` | R1.2 |
| E3 | Trains classés `metro` | Nouveau mode `train` (libellé "Train", accès quai 1 min), `kind: "train+tram"` | R3.1 |
| E4 | Une route GTFS = une ligne | Pour les routes de mode `train` : `route_id` synthétique `<cat>:<terminusA>-<terminusB>` (terminus triés) | R3.2 |
| E5 | `MAX_WAIT = 15` | `maxWait` par Carte, 30 par défaut | R3.5 |
| E6 | Pas de tronçon manuel | `extraLinks` dans la config de Carte | R3.9 |
| E7 | Bus désactivés par défaut, `bus=1` dans l'URL | Bus activés par défaut, `bus=0` dans l'URL | R8.1, R9.1 |
| E8 | Géocodeur BAN (`api-adresse.data.gouv.fr`) | Géocodeur geoportail.lu `https://map.geoportail.lu/fulltextsearch?query=&limit=` (CORS `*` vérifié) | R5.2 |
| E9 | Couleurs de ligne lues dans le GTFS | Couleur par mode (tram, train) puis par opérateur pour les bus (`modeColors`, `agencyColors`), avant celle du GTFS | R6.4 |
| E10 | GitHub Pages, beacon Cloudflare Analytics | Worker en assets statiques, aucun traceur | R13 |
| E11 | Classements, images OG | Retirés | R10.4 |
| E12 | Seuil de vitesse unique dans check_trips (35 km/h) | Seuil par mode (tram 35, train 90) | R14.2 |

Tout le reste est inchangé : constantes, algorithme de jour de référence, regroupement, graphe d'états,
grille, rendu canvas, palette, isochrones, panneau, recherche locale, permaliens et mise en page mobile.

## Pipeline

### Configuration d'une Carte (`cities/<slug>.json`)

Champs de l'original conservés : `slug`, `order`, `name`, `network`, `kind`, `defaultFrom`,
`searchExample`, `published`, `gtfsDataset`, `gtfsLicence`, `stopsBbox`, `osmBbox`, `parksBbox`,
`osmRailBbox`, `lat0`, `communes`, `rivers`, `viewBbox`.

Champs ajoutés :

```jsonc
{
  "gtfsResolve": "udata",            // E1 : résoudre la dernière ressource via l'API data.public.lu
  "gtfsShared": "lu",                // les deux Cartes partagent data/_shared/lu/gtfs.zip
  "communesSource": "osm",           // E2
  "gridCellMeters": 200,             // 200 pour la ville ; 300 à 400 pour le pays, ajusté pour R4.2
  "maxWait": 30,                     // E5
  "splitTrainRoutes": true,          // E4
  "modeColors": {                    // E9 : une couleur pour le tram, une pour les trains
    "tram": "#8E24AA", "funicular": "#8E24AA", "train": "#37474F"
  },
  "agencyColors": {                  // E9 : bus en bleus, une nuance par opérateur (agency_id)
    "6": "#0D47A1", "1": "#1E88E5", "16": "#0288D1", "171": "#5C6BC0"
  },
  "extraLinks": [                    // E6 : funiculaire Pfaffenthal-Kirchberg
    { "id": "FUN", "name": "Funiculaire", "mode": "funicular",
      "from": "Pfaffenthal-Kirchberg, Gare", "to": "Kirchberg, Rout Bréck - Pafendall (Tram)",
      "minutes": 1.0, "headway": 4 }
  ]
}
```

Les deux noms d'arrêts du funiculaire existent dans le Feed : la gare CFL en bas, la station de tram en haut.
Couleurs choisies par l'owner : tram violet, trains ardoise, bus en bleus (AVL, RGTR, TICE, bus CFL). Elles
évitent le vert et le rouge de la carte de chaleur. `routeColors` (par nom court) reste possible pour une
exception. Le texte des badges est noir ou blanc selon le contraste WCAG.

`luxembourg-ville` :
- `communes: ["Luxembourg"]` ;
- `stopsBbox` sur le Grand-Duché (les trajets peuvent sortir de la ville et y revenir) ;
- `rivers: ["Alzette", "Pétrusse"]` ;
- grille de 200 m.

`luxembourg` :
- `communes: "all"` ;
- `stopsBbox` [49.40, 5.70, 50.20, 6.55], un peu plus large que le pays ;
- `rivers: ["Alzette", "Sûre", "Moselle"]` ;
- grille de 300 m, à ajuster ;
- `lat0: 49.6`.

### fetch_data.py

- `fetch_gtfs` :
  1. Si `gtfsResolve == "udata"`, faire un GET sur l'API du jeu de données.
  2. Prendre la ressource dont `format` est `zip` et dont `last_modified` est le plus récent.
  3. Télécharger le fichier dans `data/_shared/lu/gtfs.zip`.
  4. Ne pas retélécharger si le SHA-256 n'a pas changé.
- `fetch_communes_osm` : requête Overpass
  `area["ISO3166-1"="LU"][admin_level=2]->.lu; relation(area.lu)["boundary"="administrative"]["admin_level"="8"]; out geom;`.
  Les relations sont assemblées en polygones (anneaux extérieurs et intérieurs) puis converties en
  GeoJSON avec `properties.nom = name`.
- La requête des rivières accepte aussi `waterway=stream` pour les noms listés, car la Pétrusse est
  cartographiée comme `stream` sur une partie de son cours.
- Le `USER_AGENT` est remplacé par `lux-tram-range (build script)`.

### build_data.py

- `route_mode` : route_type 2 ou 100-199 donne `train`. Les autres correspondances sont inchangées.
- `RAIL_MODES` reçoit `train`.
- `MODE_ACCESS_MINUTES` reçoit `train: 1.0`.
- `split_train_routes(trips, stop_times)` : pour chaque course de mode train, la clé de ligne est
  `(route_short_name, sorted(complexe_premier_arrêt, complexe_dernier_arrêt))`.
  - Le `route_id` synthétique et `routeInfo.name` valent par exemple "RE Luxembourg - Troisvierges".
  - Les branches à moins de 4 courses dans la fenêtre sont rattachées à la branche la plus proche, celle
    qui partage le plus d'arrêts, pour éviter les attentes plafonnées artificiellement.
- `Timetable` : départs et arrivées de la journée par arrêt, ligne et sens.
  - Attente au départ : attente moyenne pour une arrivée uniforme dans la fenêtre, sur les départs regroupés. Un
    départ d'une autre ligne compte s'il dessert tous les arrêts restants du parcours habituel (le plus fréquent)
    de la ligne : plusieurs bus sur le même tronc, ou IC et RE vers le nord, mais pas un RB vers Diekirch pour un
    train vers Troisvierges.
  - Attente de correspondance : moyenne, sur les arrivées de la ligne quittée, du temps jusqu'au prochain départ
    regroupé de la ligne prise. Les correspondances garanties (trains séparés à Kautenbach) prennent leur vraie
    attente courte.
- Graphe : deux états par arrêt, ligne et sens. L'état « montée » reçoit les voyageurs à pied et les
  correspondances ; l'état « descente » n'est atteint qu'en roulant et seul il ouvre les correspondances. Il porte
  une attente de 99 min pour ne jamais servir de départ.
- Élagage des correspondances à pied : pas de marche vers un arrêt voisin pour une ligne qui passe déjà là, ni
  depuis une ligne qui dessert aussi l'arrêt voisin.
- Résultat sur le banc d'essai (`docs/benchmark/`) : écart absolu moyen de 6,1 à 3,4 min avec mobiliteit.lu.
- `extra_links(config, complexes)` : chaque lien crée une ligne synthétique à deux arrêts, avec deux arêtes
  de trajet (aller et retour) et une attente `clamp(headway/2)`.
- `MAX_WAIT` est lu depuis `config.maxWait`, `GRID_CELL_METERS` depuis `config.gridCellMeters`.
- `display_name` : ajout de `CFL`, `AVL`, `RGTR`, `TICE`, `P+R`, `LTEtt`, `CHL` aux acronymes. Le préfixe
  "Localité, " est conservé ; c'est l'usage local.
- `network_stats` : inchangé ; il porte sur le seul réseau ferré, comme dans l'original.

Le format de `site/data/<slug>.json` est inchangé : `meta`, `boroughs`, `water`, `parks`, `rivers`,
`bridges`, `routes`, `routeInfo`, `stations`, `routeStates`, `stationStates`, `adjacency`, `cells`,
`mask`. `routeInfo[*].mode` peut maintenant valoir `train`.

## Application (`site/app.js`)

- `MODE_LABELS` reçoit `train: "Train"`. Le badge de ligne affiche la catégorie (RE, RB...), et le nom
  complet apparaît en info-bulle.
- Le toggle bus est coché par défaut. `syncUrl` écrit `bus=0` quand il est décoché, et la lecture de
  l'URL suit la même logique.
- Le géocodeur `GEOCODER_URL = "https://map.geoportail.lu/fulltextsearch"` reçoit
  `query=<q>&limit=6`.
  - Pour une géométrie `Point`, on prend ses coordonnées.
  - Sinon, on prend le centre de `bbox`, ou la moyenne des sommets si `bbox` est vide.
  - Le libellé vient de `properties.label`, le contexte de `properties.layer_name`, traduit (adresse,
    rue, localité, lieu-dit).
  - Le filtre "sur la terre ferme" de l'original est conservé, ce qui garantit R5.3.
- Les toasts "hors de la Métropole" deviennent "hors de la commune de Luxembourg" ou "hors du
  Luxembourg", selon un champ `areaLabel` de la config.
- Le reste est inchangé.

## Pages

- `build_pages.py` :
  - `SITE_NAME`, `SITE_URL` (URL du Worker, à fixer au déploiement) et `GITHUB_URL`
    (`https://github.com/Leyukaka/lux-tram-range`) sont adaptés ;
  - `ANALYTICS` est supprimé, ainsi que la redirection github.io ;
  - `LICENCES` reçoit `cc-by` ;
  - les fonctions de classement sont retirées ;
  - le texte de méthode de la FAQ est mis à jour : bus inclus par défaut, trains, plafond d'attente.
- La page d'accueil présente deux cartes de choix (Ville, Pays), sans vignettes générées.
- Les mentions légales indiquent l'éditeur (le mainteneur du dépôt) et l'hébergeur (Cloudflare), et
  précisent l'absence de cookies et de mesure d'audience, ainsi que les licences.

## Carte unique (2026-10-06)

Les deux cartes ont été fusionnées à la demande de l'owner : une Carte pays à 200 m, ouverte sur la ville.

- `cities/luxembourg.json` : `gridCellMeters: 200`, `viewBbox` sur Luxembourg-Ville, rivières Alzette, Pétrusse
  (cours d'eau), Sûre, Moselle. `cities/luxembourg-ville.json` est supprimé.
- **Format compact** de `site/data/luxembourg.json` (`meta.format = 3`, novembre 2026), décodé au chargement par
  `site/data-format.mjs` (`decode(data)`) dans la forme historique ; le reste de `app.js` et les outils
  (`tools/*.mjs`) restent inchangés. Le décodeur lit encore le format 2 (une page en cache peut le demander juste
  après un déploiement) et refuse tout autre format. Le calcul des trajets (marche avec ponts, plus courts chemins,
  meilleur arrêt d'arrivée) est dans `site/solver.mjs` (`createModel(data)`), importé par `app.js` et par les deux
  outils de contrôle, qui testent donc le code livré. Les deux modules sont servis en `Cache-Control: no-cache`
  (`site/_headers`), pour qu'un `app.js` récent ne tombe jamais sur un décodeur périmé.
  - `routeStates` : `{"station": [...], "route": [indice dans "routeIds"], "wait": [...], "access": [...]}`
    et `routeIds` ; `stationStates` n'est plus écrit, le décodeur le déduit de `routeStates.station` ;
  - `adjacency` : `{"targets": [...], "weights": [...]}`, par état les arêtes triées par cible, chaque cible en
    écart à la précédente (la première : à l'état source), les poids en dixièmes de minute ;
  - `cells` : `{"runs": [écart, longueur, ...], "stops": [[station, ...]], "bridged": [case, rang, mètres, ...]}`.
    Rangée, colonne et centre se déduisent du rang et de `meta.bounds` ; la marche vers un arrêt est la ligne
    droite depuis le centre, arrondie au mètre, sauf les paires listées dans `bridged` (détour par un pont) ;
  - géométrie de dessin (`boroughs`, `arrondissements`, `water`, `parks`, `context`, tracés de `routes`) au
    mètre, en écarts `[x0, y0, dx1, dy1, ...]` ; `outline` se déduit des anneaux extérieurs, `stations[].id`
    n'est plus écrit. Rivières, ponts et arrêts restent au décimètre (calcul des traversées).
  - Résultat (GTFS du 2026-11-05) : 17,6 Mo / 4,50 Mo gzip en format 2, 9,4 Mo / 1,74 Mo gzip en format 3.
    Réseau et cases décodés identiques au format 2, géométrie à 0,5 m près.
- **Zoom** : `fitView` cadre `viewBounds` (la ville) ; le zoom arrière descend jusqu'au cadrage de
  `meta.bounds` (le pays).
- **Échelle automatique** : `autoScale()` choisit `maxMinutes` selon la largeur visible (45 min à 12 km, 90 min
  à 70 km, interpolation linéaire, pas de 5) et les isochrones (15/30 sous 60 min, 30/60 au-delà). Désactivée
  dès que l'utilisateur touche le curseur ou les isochrones, ou si l'URL porte `max` ou `iso`.
- **Pages** : la page de la Carte est la racine de chaque langue ; plus de page d'accueil ni de sélecteur de
  carte. `site/_redirects` redirige les anciennes adresses (`/luxembourg-ville/* -> /`, etc.) ; les Workers
  Static Assets conservent la chaîne de requête.

## Hébergement

```jsonc
// wrangler.jsonc
{
  "name": "lux-tram-range",
  "compatibility_date": "2026-10-01",
  "assets": { "directory": "./site", "not_found_handling": "404-page" }
}
```

- Aucun script Worker. Les requêtes sont servies par la couche d'assets.
- Les fichiers de données doivent rester sous la limite de 25 Mo par asset.
- `site/data/*.json` est servi en compression automatique.
- `_headers` met en cache longue durée les données, dont l'URL est versionnée par `dataVersion`.

## Risques et décisions ouvertes

| Risque | Mesure |
|---|---|
| Taille du JSON pays (environ 30 000 cellules à 300 m avec 8 accès chacune) | Ajuster `gridCellMeters` ; mesurer au build (R4.2) |
| Le découpage des trains crée des branches rares avec une attente plafonnée | Fusion des branches de moins de 4 courses (voir build_data) |
| Le modèle d'attente (moitié de l'intervalle) sous-estime les correspondances rurales RGTR peu fréquentes | Assumé : c'est le modèle de l'original, et la FAQ le dit |
| Les arrêts du funiculaire sont mal identifiés dans le Feed | Vérification manuelle au build ; le build échoue si un nom d'`extraLinks` est introuvable |
| Disponibilité d'Overpass | Serveur de repli de l'original, 6 tentatives |
| Le géocodeur geoportail.lu change de format | Résultats locaux de stations toujours disponibles |

## Langues (R15)

- `i18n/fr.json`, `i18n/en.json` et `i18n/de.json` : un dictionnaire plat de clés vers des textes.
  Les variables s'écrivent `{nom}`. Le français sert de référence. `build_pages.py` complète chaque langue avec
  les clés françaises manquantes.
- `build_pages.py` génère toutes les pages pour chaque langue : le français à la racine, les autres sous
  `/<lang>/`. Les données `site/data/*.json` sont communes à toutes les langues.
- Les textes de l'interface sont injectés dans la page via `<script id="i18n" type="application/json">`
  (le sous-ensemble nécessaire à `app.js`). `app.js` lit ses textes via `t(key, vars)`.
- Le sélecteur de langue est un lien vers la page équivalente. Il recopie `location.search` au clic.
- Les noms d'arrêts et de communes restent ceux des sources ; seuls les libellés de l'interface sont traduits.

## Vue 3D (R17, essai de novembre 2026)

Trois maquettes ont été montrées à l'owner (relief habillé, temps = altitude, maquette de nuit). Retenu : un mélange
du relief habillé (jour) et de la maquette de nuit.

### Architecture

- **Moteur** : three.js 0.186.1 (publié en septembre 2026 ; la 0.187 avait moins de deux semaines), copié dans `site/vendor/three-0.186.1/` par `tools/vendor_three.py` (version
  épinglée, empreinte vérifiée, imports réécrits en chemins relatifs, licence MIT). L'archive npm de cette version n'a pas de fichiers minifiés : environ 440 Ko compressés
  (`three.core.js` 286 Ko, `three.module.js` 131 Ko, contrôles et lignes 20 Ko), en cache immuable. Ni worker, ni eval, ni import
  map : la CSP du site reste valable.
- **Code partagé** : `site/map-core.mjs` (grille, image de la carte de chaleur, isochrones, itinéraire,
  géographie), déplacé tel quel de `app.js`. `tools/check_grid.mjs` donne une empreinte de la grille, de l'image
  et des isochrones pour 4 départs ; elle est identique avant et après le déplacement.
- **Relief** : `build_terrain.py` lit le MNT LiDAR 2024 (COG de 40 Go, EPSG:2169) par requêtes partielles avec
  GDAL (`gdalwarp` sur `/vsicurl`, dans l'image `ghcr.io/osgeo/gdal` lancée par Podman : les DLL de GDAL sont
  bloquées par la stratégie de contrôle des applications de Windows). La grille de sortie est en EPSG:4326 alignée
  sur les mètres du site (x et y sont proportionnels à la longitude et à la latitude), donc sans reprojection
  côté client. Pays : 596 x 842 à environ 100 m (moyenne) ; ville : 1006 x 1002 à environ 10 m (bilinéaire) sur
  `viewBbox`. Écriture en décimètres, écarts par ligne, JSON servi compressé par Cloudflare.
  Résultat (2026-11-11) : pays 131 à 557 m, 1,44 Mo (372 Ko gzip) ; ville 228 à 413 m, 2,62 Mo (679 Ko gzip).
  Contrôle : l'Alzette au Grund (241 m) et au Pfaffenthal (236 m), la Pétrusse sous le pont Adolphe (251 m)
  tombent en fond de vallée ; Kirchberg 321 m, place d'Armes 305 m.
- **Lignes** : `site/data/luxembourg-lines.json`, à part du fichier principal (R4.2 inchangé) : forme la plus
  fréquente par ligne AVL (agence 6, lignes de jour 2 à 33 et CN1 à CN8) et T1, simplifiée à 25 m.
- **Page** : `templates/3d.html`, `site/app3d.js`, pages générées par `build_pages.py`.

### Direction artistique et interaction (proposée par Fable)

Un seul moteur, deux ambiances. Par défaut « Jour » : relief réel, carte de chaleur drapée, isochrones 15 et 30,
lignes en rubans opaques à liseré. Bascule « Nuit » : fond sombre, lignes lumineuses, véhicules brillants. La nuit
est un choix mémorisé, pas une conséquence de `prefers-color-scheme`.

- **Carte de chaleur** : même calcul et même palette que la 2D, drapée sur le relief, jamais en mélange additif.
  L'ombrage du relief reste borné (plus ou moins 12 % de luminance) pour ne pas fausser les couleurs. Nuit : sol
  `#10151f`, eau `#0a1626`, fond `#070a10`, carte de chaleur à 0,88.
- **Isochrones** : 15 et 30 min, trait de 2 px, noir à liseré blanc le jour, blanc à 90 % la nuit ; étiquettes en
  HTML superposé.
- **Lignes** : tram `#8E24AA`, trains `#37474F` (nuit `#B0BEC5`). Bus AVL : 12 teintes par numéro modulo 12
  (`#1565C0`, `#EF6C00`, `#00838F`, `#C62828`, `#2E7D32`, `#AD1457`, `#283593`, `#F9A825`, `#00897B`, `#6D4C41`,
  `#D81B60`, `#558B2F`), éclaircies de 35 % la nuit ; le liseré porte le contraste. Rubans au-dessus du relief
  lissé par maximum glissant sur 300 m, pour enjamber l'Alzette et la Pétrusse. Nuit : second passage additif,
  trois fois plus large, opacité 0,22, en guise de lueur, sans bloom.
- **Relief et caméra** : exagération verticale de 1,5 en vue proche à 2,5 en vue lointaine, affichée dans la
  légende. Vue de dessus, nord en haut. Inclinaison et distance bornées. Soleil au nord-ouest, pas d'ombres
  portées. Brouillard lié à la distance de la caméra.
- **Véhicules** : nombre par ligne tiré de l'intervalle médian réel, temps accéléré, plafonnés (300 sur
  ordinateur, 120 sur mobile), désactivés par défaut si `prefers-reduced-motion`.
- **Rendu** : à la demande, boucle seulement si des véhicules circulent et que l'onglet est visible.
- **Bascules** : jour/nuit, bus, lignes de nuit CN, isochrones, véhicules, bâtiments (option), vue de dessus.
- **À éviter** : carte de chaleur en lueur, post-traitement plein écran, tubes 3D pour les lignes, boucle de rendu
  permanente, nuit automatique.

