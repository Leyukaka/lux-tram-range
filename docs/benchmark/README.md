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
plus pessimiste.

| Trajet | Carte | mobiliteit.lu | écart | Google | écart |
|---|---:|---:|---:|---:|---:|
| Gare Centrale - Kirchberg, Luxexpo | 26 | 22 | +5 | 26 | 0 |
| Gare Centrale - Hamilius | 8 | 8 | 0 | 10 | -1 |
| Gare Centrale - Gasperich, Cloche d'Or | 18 | 17 | +1 | 17 | +1 |
| Kirchberg, Philharmonie - Belair, Sacré-Coeur | 26 | 20 | +6 | 22 | +4 |
| Gare Centrale - Esch-sur-Alzette | 35 | 33 | +2 | 35 | -1 |
| Gare Centrale - Mersch | 29 | 25 | +4 | 28 | +1 |
| Gare Centrale - Ettelbruck | 40 | 39 | 0 | 43 | -4 |
| Gare Centrale - Clervaux | 64 | 73 | -9 | 75 | -11 |
| Gare Centrale - Wiltz | 96 | 74 | +23 | 76 | +21 |
| Gare Centrale - Echternach | 83 | 70 | +13 | 79 | +4 |
| Gare Centrale - Remich | 54 | 51 | +3 | 53 | +1 |
| Gare Centrale - Vianden | 84 | 79 | +5 | 92 | -7 |
| Esch-sur-Alzette - Belval-Université | 15 | 9 | +6 | 11 | +4 |
| Ettelbruck - Diekirch | 22 | 14 | +8 | 14 | +8 |

| Référence | Écart moyen | Écart absolu moyen |
|---|---:|---:|
| mobiliteit.lu | +4,8 min | 6,1 min |
| Google Maps | +1,4 min | 4,9 min |

Sur 10 trajets sur 14, la carte est à 5 minutes près des deux calculateurs.

## Écarts expliqués

- **Correspondances cadencées (Wiltz, +23).** Les trains pour Wiltz se séparent à Kautenbach : le changement est
  garanti, sans attente. Le modèle ne connaît que la fréquence de la navette Kautenbach - Wiltz et compte
  l'attente moyenne, plafonnée à 30 minutes.
- **Plusieurs lignes pour un même trajet (Philharmonie - Belair, Esch - Belval, Ettelbruck - Diekirch).** Le
  voyageur prend le premier bus ou train qui va à destination, quelle que soit la ligne. Le modèle compte
  l'attente d'une seule ligne : il surestime l'attente sur les trajets courts desservis par plusieurs lignes.
  C'est la principale cause de l'écart moyen positif.
- **Clervaux (-9).** Le modèle est plus optimiste : il suppose des départs réguliers, alors que l'horaire réel
  de la fenêtre laisse un trou entre deux trains.
- **Echternach (+13 avec mobiliteit.lu, +4 avec Google).** mobiliteit.lu trouve un trajet en bus direct plus
  rapide. Le modèle passe par le tram et une ligne RGTR, avec deux attentes moyennes.
- **Gare - Luxexpo (+5 avec mobiliteit.lu).** mobiliteit.lu propose le train jusqu'à Pfaffenthal-Kirchberg puis
  le funiculaire et le tram (17 min). Le modèle et Google restent sur le tram direct (25 min).

## Pistes d'amélioration

- Attente commune à plusieurs lignes : compter, pour une paire d'arrêts, tous les passages qui y mènent (le
  « common lines problem »), comme `shared_train_waits` le fait déjà pour les trains.
- Correspondances garanties : utiliser `block_id` ou `transfers.txt` du GTFS pour ne pas compter d'attente
  quand un train continue sous un autre numéro ou se sépare.
