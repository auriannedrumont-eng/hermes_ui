// Verdict du connecteur : connecte le mini-service et lit gateway:get
// (mode gateway = le connecteur a passé la porte ; mode local = refusé).
import { io } from "socket.io-client";

const socket = io("http://localhost:3003", {
  transports: ["polling", "websocket"],
});
const timer = setTimeout(() => {
  console.log("VERDICT: TIMEOUT (service muet)");
  process.exit(1);
}, 10_000);
socket.on("connect", () => {
  socket.emit("gateway:get", (res: any) => {
    clearTimeout(timer);
    const mode = res?.mode ?? res?.gatewayMode ?? JSON.stringify(res);
    console.log(`VERDICT: mode=${mode}  détail=${JSON.stringify(res)}`);
    process.exit(0);
  });
});
socket.on("connect_error", (e: Error) => {
  console.log(`VERDICT: connect_error ${e.message}`);
  process.exit(1);
});
