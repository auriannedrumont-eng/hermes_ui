// Sonde branchement auto : envoi d'un tour SANS toucher aux réglages.
// La fausse gateway (fake-gateway.ts) doit être lancée AVANT : le service
// doit basculer en mode gateway à la re-sonde du tour, sans action UI.
import { io } from "socket.io-client";

const socket = io("http://127.0.0.1:3003", { transports: ["websocket"] });
let content = "";
let errored = false;

const fail = (msg: string) => {
  console.log("ECHEC:", msg);
  socket.close();
  process.exit(1);
};

socket.on("connect", () => {
  socket.emit("conversations:create", { title: "sonde-gw" }, (res: any) => {
    const convId = res?.conversation?.id ?? res?.id;
    if (!convId) return fail(`conversation non créée: ${JSON.stringify(res)}`);
    socket.on("hello", (h: any) => {
      if (h?.mode) console.log("hello.mode =", h.mode);
    });
    socket.on("stream:delta", (d: any) => {
      if (typeof d?.delta === "string") content += d.delta;
    });
    socket.on("stream:error", (e: any) => {
      errored = true;
      fail(e?.error ?? JSON.stringify(e));
    });
    socket.on("stream:done", () => {
      console.log("contenu =", JSON.stringify(content));
      console.log(errored ? "ECHEC" : "OK — branchement automatique validé");
      socket.close();
      process.exit(errored ? 1 : 0);
    });
    socket.emit("chat:send", { conversationId: convId, content: "ping" });
    setTimeout(() => fail("timeout tour"), 25000);
  });
});
socket.on("connect_error", (err) => fail(`connexion: ${err.message}`));
