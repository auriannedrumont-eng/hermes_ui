// Sonde : un tour sans agent ni clé doit échouer avec l'erreur claire
// (plus aucun LLM simulé). Vérifie aussi le hello (mode honnête).
import { io } from "socket.io-client";

const socket = io("http://127.0.0.1:3003", { transports: ["websocket"] });

const fail = (msg: string) => {
  console.log("ECHEC:", msg);
  socket.close();
  process.exit(1);
};

socket.on("connect", () => {
  socket.emit("hello", (hello: any) => {
    console.log("hello.mode =", hello?.mode);
    console.log("hello.model =", hello?.model);
    console.log("hello.gatewayUrl =", hello?.gatewayUrl);
    socket.emit("conversations:create", { title: "sonde" }, (res: any) => {
      const convId = res?.conversation?.id ?? res?.id;
      if (!convId) return fail(`conversation non créée: ${JSON.stringify(res)}`);
      socket.on("stream:error", (e: any) => {
        console.log("stream.error =", e?.error ?? JSON.stringify(e));
        socket.close();
        process.exit(0);
      });
      socket.emit("chat:send", { conversationId: convId, content: "ping" }, (ack: any) => {
        if ((ack as any)?.error) {
          console.log("ack.error =", (ack as any).error);
          socket.close();
          process.exit(0);
        }
      });
      setTimeout(() => fail("timeout — aucun stream:error reçu"), 20000);
    });
  });
});
socket.on("connect_error", (err) => fail(`connexion: ${err.message}`));
