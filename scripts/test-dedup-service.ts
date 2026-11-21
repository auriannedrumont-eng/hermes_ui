// Test ciblé : déduplication service (lot audit 2026-11-21).
// 1. providers:add-key avec le MÊME secret deux fois → le 2e doit refuser.
// 2. registry:install avec la même adresse https deux fois → le 2e doit refuser.
// Lance : bun scripts/test-dedup-service.ts  (service hermes-chat :3003 requis)
import { io } from "socket.io-client";

const socket = io("http://localhost:3003", { transports: ["websocket"] });
const failures: string[] = [];
const ok = (cond: boolean, label: string) => {
  console.log((cond ? "  OK  " : "  ✗   ") + label);
  if (!cond) failures.push(label);
};
// Chien de garde global : ne jamais rester suspendu.
const globalTimer = setTimeout(() => {
  console.error("TIMEOUT global 15 s — test interrompu");
  process.exit(2);
}, 15_000);

function emit<T>(event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => socket.emit(event, payload, (res: T) => resolve(res)));
}

socket.on("connect", async () => {
  try {
    // ── Clés : même secret refusé ──
    const add1 = await emit<{ provider?: { id?: string }; error?: string }>(
      "providers:add",
      { name: "https://dedup-test.example.com/v1", kind: "llm" }
    );
    ok(!add1.error && !!add1.provider, "fournisseur de test créé");
    const pid = add1.provider?.id ?? "";
    const k1 = await emit<{ key?: { id?: string }; error?: string }>(
      "providers:add-key",
      { providerId: pid, label: "Test 1", secret: "sk-dedup-secret-0123456789" }
    );
    ok(!k1.error && !!k1.key, "première clé acceptée");
    const k2 = await emit<{ key?: unknown; error?: string }>(
      "providers:add-key",
      { providerId: pid, label: "Test 2 (doublon)", secret: "sk-dedup-secret-0123456789" }
    );
    ok(!!k2.error && /existe déjà/i.test(k2.error ?? ""), `clé en doublon refusée : « ${k2.error ?? "?"} »`);
    const k3 = await emit<{ key?: { id?: string }; error?: string }>(
      "providers:add-key",
      { providerId: pid, label: "Test 3 (autre)", secret: "sk-autre-secret-9876543210" }
    );
    ok(!k3.error && !!k3.key, "clé distincte toujours acceptée");

    // ── Extensions : même source refusée ──
    const m1 = await emit<{ what?: string; extension?: { id?: string }; error?: string }>(
      "registry:install",
      { source: "https://dedup-mcp.example.com/endpoint" }
    );
    ok(m1.what === "mcp" && !!m1.extension?.id, "serveur MCP créé");
    const m2 = await emit<{ what?: string; error?: string }>("registry:install", {
      source: "https://dedup-mcp.example.com/endpoint",
    });
    ok(!!m2.error && /déjà ajouté/i.test(m2.error ?? ""), `MCP en doublon refusé : « ${m2.error ?? "?"} »`);

    // ── Nettoyage (ids connus depuis les acks — pas de providers:list) ──
    for (const kid of [k1.key?.id, k3.key?.id]) {
      if (kid) await emit("providers:remove-key", { keyId: kid });
    }
    if (pid) await emit("providers:remove", { id: pid });
    const mid = m1.extension?.id;
    if (mid) await emit("extensions:remove", { id: mid });
    console.log("  … nettoyage fait");

    clearTimeout(globalTimer);
    socket.close();
    console.log(failures.length === 0 ? "\nTOUS OK" : `\n${failures.length} ÉCHEC(S)`);
    process.exit(failures.length === 0 ? 0 : 1);
  } catch (err) {
    console.error("erreur test:", err);
    process.exit(1);
  }
});
socket.on("connect_error", (e: Error) => {
  clearTimeout(globalTimer);
  console.error("service injoignable:", e.message);
  process.exit(1);
});
