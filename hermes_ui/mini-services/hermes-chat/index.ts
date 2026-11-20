// Service hermes-chat — socket.io sur 3003 (v0.3.0).
// Événements du domaine stockage (page Stockage du volet) :
//   storage:list / storage:deleteVersion / storage:cleanProject / storage:undo
//   diffusion storage:changed après chaque mutation.
import { createServer } from "node:http";
import { Server } from "socket.io";
import { Store } from "./store";
import { ctx } from "./handlers/context";
import { registerStorageHandlers } from "./handlers/storage";

const PORT = Number(process.env.PORT || 3003);
const APP_VERSION = "0.3.0";

const http = createServer();
const io = new Server(http, {
  cors: { origin: [/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/] },
  serveClient: false,
});

const store = new Store();
ctx.init(store, io);

io.on("connection", (socket) => {
  registerStorageHandlers(socket);

  // Conversations (nettoyage final des tests + besoins du front).
  socket.on(
    "conversations:delete",
    (payload: { id?: string }, cb?: (data: unknown) => void) => {
      const id = typeof payload?.id === "string" ? payload.id : "";
      if (id) store.deleteConversation(id);
      if (typeof cb === "function") cb({ ok: true });
      ctx.broadcast("storage:changed");
    }
  );

  // État du service (carte Agent — battements via la connexion même).
  socket.on("system:ping", (cb?: (data: unknown) => void) => {
    if (typeof cb === "function") cb({ ok: true, at: Date.now() });
  });

  // Carte Mise à jour (volet Système) : version installée + disponible.
  // Le lanceur écrit le verdict ; ici on répond honnêtement : à jour
  // (aucun canal de dépôt dans ce service) — jamais de « Vérification… »
  // éternel côté interface.
  socket.on("system:update-check", (cb?: (data: unknown) => void) => {
    if (typeof cb === "function") {
      cb({ installed: APP_VERSION, available: null });
    }
  });
});

http.listen(PORT, () => {
  console.log(`[hermes-chat] service chat+stockage démarré sur le port ${PORT}`);
});
