# lux-tram-range

Carte des temps de trajet en train, tram, funiculaire et bus pour tout le Luxembourg, ouverte sur Luxembourg-Ville. Les bus sont inclus par défaut. Calcul dans le navigateur, sans cookies ni mesure d'audience.

Site : https://tram.monbot.si

## Construire, tester et publier

Python 3 et Node.js sont nécessaires. Le pipeline Python utilise la bibliothèque standard.

```sh
python build.py --fetch
npx wrangler@4.147.0 dev
npx wrangler@4.147.0 deploy
```

Pour régénérer seulement les pages après une modification des textes : `python build_pages.py`.
`SITE_URL` permet de remplacer le domaine par défaut avant cette génération.
Wrangler sert les assets de `site/`, avec une page 404, sans script serveur.
Les données ont une URL versionnée par leur empreinte (`?v=dataVersion`) et un cache long.

## Données et méthode

- Horaires GTFS : Administration des transports publics (ATP), [data.public.lu](https://data.public.lu/fr/datasets/horaires-et-arrets-des-transport-publics-gtfs/), CC-BY 4.0.
- Limites communales, eau, parcs, rivières et ponts : [OpenStreetMap](https://www.openstreetmap.org/copyright), ODbL, via Overpass.
- Recherche d'adresse : [Geoportail Luxembourg](https://map.geoportail.lu/), directement depuis le navigateur.

Un jour ouvré de référence fournit les horaires de 7 h à 20 h. Marche à 4,5 km/h en ligne droite, avec les ponts pour les rivières de la carte ville. Attente : moitié de l'intervalle moyen, plafonnée à 30 minutes. Correspondance : 1,5 minute de marche et attente, plus 1 minute d'accès au quai pour les trains et le funiculaire. Les trains sont divisés par terminus. Le funiculaire Pfaffenthal-Kirchberg est ajouté manuellement car absent du feed. Pas de temps réel.

La provenance, les dates de téléchargement, les empreintes, la période GTFS et le jour de référence sont dans `sources/<slug>.json`. Les données brutes de `data/` restent locales. Les JSON calculés de `site/data/` sont communs aux langues.

## Langues

Français à la racine, anglais sous `/en/`, allemand sous `/de/`. Les traductions sont des premières versions. Contributions bienvenues, en particulier pour le luxembourgeois.

Pour ajouter le luxembourgeois, copier `i18n/fr.json` vers `i18n/lb.json`, traduire ses valeurs en conservant les clés et les variables entre accolades, ajouter `lb` à `LANGUAGES` dans `build_pages.py`, puis régénérer les pages. Les clés manquantes utilisent le français. Le sélecteur conserve les paramètres de trajet.

## Crédits et licences

[Anthony Castrio, NYC Transit Time Cartogram](https://castrio.me/nyc/) → [Jules Grandin, Paris](https://github.com/JulesGrandin/paris-temps-transport) → [Camille Roux, À portée de tram](https://tram.camilleroux.com/) → [Badré Yann, portage Luxembourg](https://github.com/Leyukaka/lux-tram-range).

Le code original [camilleroux/montpellier-temps-transport](https://github.com/camilleroux/montpellier-temps-transport) a été importé au commit `59c7b13`. Code sous MIT, notices Camille Roux et Badré Yann conservées dans [LICENSE](LICENSE). Bases calculées sous [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/), avec attribution OpenStreetMap et ATP (CC-BY 4.0).

## Auteur

Badré Yann : [GitHub](https://github.com/Leyukaka) · [LinkedIn](https://www.linkedin.com/in/yann-badr%C3%A9-26852733/)
