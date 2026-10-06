# Plan d'implémentation : lux-tram-range

Une tâche correspond à un commit. Les références renvoient à `requirements.md`.

- [x] 1. Importer la base de l'original
  - Copier depuis `camilleroux/montpellier-temps-transport` les scripts, `templates/`, `site/app.js`,
    `site/styles.css`, `site/404.html`, les favicons, `tools/check_trips.mjs` et `LICENSE`.
  - Ne pas copier `site/data`, les pages générées, `classements`, `og`, les villes françaises ni le
    workflow Pages.
  - Commit "Import upstream montpellier-temps-transport" avec le SHA d'origine dans le message.
  - _Exigences : R12.1_

- [x] 2. Nettoyer ce qui ne sert pas au Luxembourg
  - Retirer les classements, les images OG, l'analytics et la redirection github.io.
  - Mettre à jour LICENSE (deux notices MIT) et le `.gitignore`.
  - _Exigences : R10.4, R12.1, R13.4_

- [x] 3. Configurations des Cartes
  - Créer `cities/luxembourg-ville.json` et `cities/luxembourg.json` (voir design).
  - Adapter les valeurs par défaut de `cities.py` : `kind: "train+tram"`, libellés, `areaLabel`.
  - _Exigences : R4.1, R4.2_

- [x] 4. Récupération GTFS via data.public.lu
  - Ajouter `gtfsResolve: "udata"` dans `fetch_data.py`, avec un fichier partagé entre les Cartes et un
    manifeste SHA-256.
  - _Exigences : R1.1, R1.4, R1.5_

- [x] 5. Communes et OSM
  - Récupérer les communes via Overpass (`admin_level=8`) et assembler les polygones.
  - Ajouter les rivières de type `stream` pour les noms listés et adapter les emprises OSM.
  - _Exigences : R1.2, R1.3, R1.6_

- [x] 6. Mode train et découpage par terminus
  - Ajouter le mode `train` dans `route_mode`, `RAIL_MODES` et `MODE_ACCESS_MINUTES`.
  - Écrire `split_train_routes`, avec fusion des branches rares.
  - _Exigences : R3.1, R3.2, R3.6_

- [x] 7. Paramètres par Carte et tronçons manuels
  - Lire `maxWait` et `gridCellMeters` depuis la config.
  - Ajouter `extraLinks` pour le funiculaire, avec échec explicite si un arrêt est introuvable.
  - Ajouter `routeColors`.
  - _Exigences : R3.5, R3.9, R4.2, R6.4_

- [x] 8. Noms d'arrêts
  - Ajouter les acronymes luxembourgeois à `display_name` et vérifier le regroupement des arrêts
    "Localité, Arrêt".
  - _Exigences : R3.3_

- [x] 9. Premier build et contrôle
  - Lancer `python build.py --fetch` pour les deux Cartes.
  - Vérifier le tableau de contrôle et la taille du JSON pays, et ajuster `gridCellMeters`.
  - Versionner `site/data/*.json` et `sources/*.json`.
  - _Exigences : R2.1, R2.2, R2.3, R4.3, R4.4, R14.1_

- [x] 10. check_trips par mode
  - Ajouter des seuils de vitesse par mode et les trajets de référence de R14.3.
  - Corriger le Pipeline jusqu'à ce que tout passe.
  - _Exigences : R14.2, R14.3_

- [x] 11. Application : modes, bus par défaut, géocodeur
  - Ajouter `MODE_LABELS.train` et cocher le bus par défaut, avec `bus=0` dans l'URL.
  - Brancher le géocodeur geoportail.lu et remplacer les messages `areaLabel`.
  - _Exigences : R5.2, R5.3, R5.4, R8.1, R8.2, R8.3, R9.1, R9.2_

- [x] 12. Pages
  - Adapter `build_pages.py`, `templates/city.html` et `templates/home.html` : textes, FAQ et méthode,
    crédits, licences `cc-by` et ODbL.
  - Écrire les mentions légales, le sitemap et le robots.
  - _Exigences : R10.1, R10.2, R10.3, R12.2, R12.3_

- [x] 13. Hébergement Cloudflare
  - Ajouter `wrangler.jsonc` et `site/_headers` (cache des données).
  - Mettre à jour le README : build, dev, deploy.
  - _Exigences : R13.1, R13.2, R13.3_

- [x] 14. Vérification dans le navigateur
  - Lancer `npx wrangler dev`, puis tester :
    - le départ par défaut, la heatmap et les isochrones ;
    - un clic d'arrivée et l'itinéraire ;
    - le toggle bus, le permalien et la recherche d'adresse ;
    - le glisser-déposer, la largeur mobile et une console sans erreur ;
    - le temps de calcul sur la Carte pays.
  - _Exigences : R5.1, R5.5, R6.1, R6.2, R6.3, R6.5, R7.1, R7.2, R7.3, R7.4, R9.3, R11.1, R11.2_

- [x] 15. Publication
  - Lancer `gh repo create Leyukaka/lux-tram-range --public` et pousser.
  - Lancer `npx wrangler deploy`, puis fixer `SITE_URL`, régénérer les pages et redéployer.
  - _Exigences : R13.2_

- [x] 16. Traductions
  - Extraire les textes de `app.js`, `build_pages.py` et des gabarits dans `i18n/fr.json`.
  - Rédiger `i18n/en.json` et `i18n/de.json`.
  - Générer `/en/` et `/de/`, avec le sélecteur de langue et les liens `hreflang`.
  - Ajouter l'appel aux contributeurs dans le README et le pied de page.
  - _Exigences : R15.1 à R15.6_

- [ ] 17. Carte unique : configuration et pipeline
  - Fusionner les deux Cartes dans `cities/luxembourg.json` (200 m, `viewBbox` ville, rivières).
  - Supprimer `cities/luxembourg-ville.json`.
  - Écrire le format compact (`meta.format = 2`).
  - _Exigences : R4.1, R4.2_

- [ ] 18. Décodage du format compact
  - Écrire `site/data-format.mjs` et l'utiliser dans `app.js`, `tools/check_trips.mjs` et `tools/compare_trips.mjs`.
  - _Exigences : R4.2_

- [ ] 19. Vue ville et échelle automatique
  - Zoom arrière jusqu'au pays.
  - `autoScale()` pour l'échelle et les isochrones, désactivée dès une action manuelle.
  - Paramètres d'URL `max` et `iso` uniquement en mode manuel.
  - _Exigences : R5.1, R6.3, R6.4, R9.1_

- [ ] 20. Pages et redirections
  - Une page Carte par langue à la racine, sans sélecteur de carte.
  - `site/_redirects` pour les anciennes adresses ; sitemap mis à jour.
  - _Exigences : R10.1, R10.2_

- [ ] 21. Vérification
  - Build, `check_trips`, banc d'essai, tailles (R4.2).
  - Navigateur : ville puis pays, échelle automatique, redirections, mobile.
  - _Exigences : R4.2, R6.6, R14_
