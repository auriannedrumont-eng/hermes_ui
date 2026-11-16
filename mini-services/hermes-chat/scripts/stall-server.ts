// Serveur « muet » pour la preuve du correctif : répond à /models (le pool
// liste donc ses modèles) et NE RÉPOND JAMAIS à /chat/completions — la
// connexion reste ouverte sans octet, exactement l'enrayage qui bloquait
// le débat sur sa première voix avant la garde d'inactivité.
Bun.serve({
  port: 9299,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/models")) {
      return Response.json({ data: [{ id: "stall-model" }] });
    }
    return new Promise(() => {}); // jamais résolu : aucun octet, aucune fin
  },
});
console.log("[stall] serveur muet sur 127.0.0.1:9299 — /models OK, /chat/completions muet");
