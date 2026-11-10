// Les liens de langue gardent l'état de la carte (paramètres d'URL) ; app.js les met à jour ensuite.
for (const link of document.querySelectorAll("a[data-language], a[data-keep-state]")) link.search = location.search;
