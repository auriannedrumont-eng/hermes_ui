// Debug arrêt SIGTERM (F-09) : capture TOUTE la sortie du service.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, rmSync, existsSync, statSync } from "node:fs";

const DB_DIR = new URL("../db-debug-local", import.meta.url).pathname;;
rmSync(DB_DIR, { recursive: true, force: true });
mkdirSync(DB_DIR, { recursive: true });

const proc = spawn("bun", ["mini-services/hermes-chat/index.ts"], {
  cwd: new URL("..", import.meta.url).pathname,
  env: {
    ...process.env,
    HERMES_SERVICE_TOKEN: "tok-debug",
    HERMES_CHAT_PORT: "3313",
    HERMES_CHAT_FILES_PORT: "3314",
    HERMES_GATEWAY_URL: "",
    HERMES_CHAT_DB: `${DB_DIR}/hermes-chat.sqlite`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
proc.stdout.on("data", (d: Buffer) => process.stdout.write(`[out] ${d}`));
proc.stderr.on("data", (d: Buffer) => process.stdout.write(`[err] ${d}`));

// attend le boot
await new Promise<void>((resolve) => {
  const t = setTimeout(resolve, 15000);
  const onData = (d: Buffer) => {
    if (d.toString().includes("pièces jointes démarré")) {
      clearTimeout(t);
      proc.stdout.off("data", onData);
      resolve();
    }
  };
  proc.stdout.on("data", onData);
});
console.log("--- boot OK, envoi SIGTERM ---");
proc.kill("SIGTERM");
const [code, signal] = await once(proc, "exit");
console.log(`--- exit: code=${code} signal=${signal} ---`);
const wal = `${DB_DIR}/hermes-chat.sqlite-wal`;
console.log(
  `WAL: ${existsSync(wal) ? statSync(wal).size + " o" : "absent (fermeture propre)"}`
);
rmSync(DB_DIR, { recursive: true, force: true });
