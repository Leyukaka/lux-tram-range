// Les liens de langue gardent l'état de la carte (paramètres d'URL) ; app.js les met à jour ensuite.
for (const link of document.querySelectorAll("a[data-language]")) link.search = location.search;
