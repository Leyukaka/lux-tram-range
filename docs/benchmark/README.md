# Comparaison avec mobiliteit.lu et Google Maps

Ce banc d'essai compare les temps de la carte avec deux calculateurs d'itinéraire : mobiliteit.lu (ATP, même
source GTFS que la carte) et Google Maps. Il porte sur 14 trajets d'arrêt à arrêt : courts en ville, en train
vers le nord et le sud, en bus vers l'est, et deux trajets qui ne passent pas par le centre.

## Méthode

La carte donne un temps **moyen** pour un jour de semaine : marche, attente égale à la moitié de l'intervalle,
trajet. Un calculateur donne des correspondances **à heure fixe**. Pour comparer les mêmes choses :

- les deux calculateurs sont interrogés pour le mardi 10 novembre 2026, jour de référence de la carte, à 8 h 00 ;
  pour Google, on fait aussi une recherche à 8 h 20 ;
- on relève toutes les correspondances proposées (heure de départ, heure d'arrivée) dans `references.json` ;
- `tools/compare_trips.mjs` en déduit le temps moyen porte à porte d'un voyageur qui se présente à une minute
  quelconque entre 8 h 00 et 8 h 30. Ce temps compte l'attente jusqu'à la correspondance qui arrive le plus tôt ;
- le temps de la carte est calculé par le même modèle que le site, bus compris, sur la carte du pays.

Relevés faits à la main dans un navigateur le 6 octobre 2026. Google signale qu'il ne dispose pas des horaires
les plus récents pour le Luxembourg.

```sh
node tools/compare_trips.mjs
```

## Résultats

Minutes porte à porte, fenêtre 8 h 00 - 8 h 30. L'écart est carte moins référence : positif quand la carte est
plus pessimiste. « Avant » est le modèle de l'original (moitié de l'intervalle par ligne), « après » le modèle
actuel (attentes tirées de l'horaire, voir plus bas).

| Trajet | mobiliteit.lu | Google | Carte avant | Carte après |
|---|---:|---:|---:|---:|
| Gare Centrale - Kirchberg, Luxexpo | 22 | 26 | 26 | 26 |
| Gare Centrale - Hamilius | 8 | 10 | 8 | 8 |
| Gare Centrale - Gasperich, Cloche d'Or | 17 | 17 | 18 | 18 |
| Kirchberg, Philharmonie - Belair, Sacré-Coeur | 20 | 22 | 26 | 23 |
| Gare Centrale - Esch-sur-Alzette | 33 | 35 | 35 | 36 |
| Gare Centrale - Mersch | 25 | 28 | 29 | 26 |
| Gare Centrale - Ettelbruck | 39 | 43 | 40 | 44 |
| Gare Centrale - Clervaux | 73 | 75 | 64 | 69 |
| Gare Centrale - Wiltz | 74 | 76 | 96 | 74 |
| Gare Centrale - Echternach | 70 | 79 | 83 | 75 |
| Gare Centrale - Remich | 51 | 53 | 54 | 56 |
| Gare Centrale - Vianden | 79 | 92 | 84 | 78 |
| Esch-sur-Alzette - Belval-Université | 9 | 11 | 15 | 16 |
| Ettelbruck - Diekirch | 14 | 14 | 22 | 22 |

| Référence | Avant : écart moyen | Avant : écart absolu | Après : écart moyen | Après : écart absolu |
|---|---:|---:|---:|---:|
| mobiliteit.lu | +4,8 min | 6,1 min | +2,6 min | 3,3 min |
| Google Maps | +1,4 min | 4,9 min | -0,8 min | 3,5 min |

## Ce qui a changé dans le modèle

Le premier relevé montrait deux limites du modèle de l'original. Elles sont corrigées :

- **Plusieurs lignes pour un même trajet.** L'attente au départ est calculée sur l'horaire réel et compte tous les
  véhicules qui desservent les mêmes arrêts que le parcours habituel de la ligne (plusieurs bus sur un même tronc,
  IC et RE vers le nord). Un train qui ne va pas aussi loin, comme un RB vers Diekirch pour un voyageur vers
  Clervaux, ne compte pas.
- **Correspondances garanties.** L'attente de correspondance est la moyenne, sur les arrivées de la ligne quittée,
  du temps jusqu'au départ suivant de la ligne prise. Les trains qui se séparent à Kautenbach ne coûtent plus
  30 minutes d'attente : Gare - Wiltz passe de +23 à 0 minute d'écart.
- Une correspondance n'est possible qu'après un trajet : un voyageur qui arrive à pied à un arrêt ne profite pas
  d'une correspondance calée sur un bus qu'il n'a pas pris.

## Écarts restants

- **Trajets courts à plusieurs modes (Esch - Belval, Ettelbruck - Diekirch, +6 à +8).** Le train et plusieurs bus
  y vont, mais leurs parcours diffèrent : le modèle ne les regroupe pas et attend une seule ligne.
- **Vianden (-14 avec Google).** Google ne propose pas de départ entre 8 h 14 et 9 h 14 ; mobiliteit.lu, qui
  utilise le même GTFS que la carte, est à 1 minute.
- **Gare - Luxexpo (+5 avec mobiliteit.lu).** mobiliteit.lu propose le train jusqu'à Pfaffenthal-Kirchberg puis le
  funiculaire et le tram (17 min). Le modèle et Google restent sur le tram direct.
