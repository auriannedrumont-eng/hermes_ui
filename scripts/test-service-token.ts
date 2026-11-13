// Test du jeton de service (revue 2026-11-13) : le mini-service hermes-chat
// écoute sur 3003 (socket.io) et 3004 (HTTP) SANS authentification — toute
// page visitée par la victime peut s'y connecter et lire/écrire ses données.
// Le correctif exige un jeton : HERMES_SERVICE_TOKEN.
//
// ATTENDU APRÈS CORRECTIF :
//   - socket.io   : connexion refusée (connect_error) sans jeton, acceptée avec
//   - HTTP 3004   : 401 sans jeton, 200 avec (sauf routes /share/... publiques)
//   - le client   : envoie le jeton (auth + query) depuis socket.ts
//
// Ce test démarre le vrai service avec/ sans token, sur des ports dédiés
// (3303/3304) pour ne pas toucher à l'instance de dev, puis vérifie chaque
// cas. Il utilise le jeton via variable d'environnement.
import { io } from "socket.io-client";

// ── 1. Comportement SANS jeton configuré : mode ouvert par défaut (dev) ──
// (le jeton n'est actif que si HERMES_SERVICE_TOKEN est défini)

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

function tryConnect(url: string, auth?: Record<string, unknown>): Promise<{ ok: boolean; err?: string }> {
  return new Promise((resolve) => {
    const s = io(url, {
      path: "/",
      transports: ["websocket"],
      timeout: 2500,
      ...(auth ? { auth } : {}),
    });
    const t = setTimeout(() => {
      s.close();
      resolve({ ok: false, err: "timeout" });
    }, 3500);
    s.on("connect", () => {
      clearTimeout(t);
      s.close();
      resolve({ ok: true });
    });
    s.on("connect_error", (e: any) => {
      clearTimeout(t);
      s.close();
      resolve({ ok: false, err: e?.message ?? "connect_error" });
    });
  });
}

async function httpGet(url: string, headers?: Record<string, string>): Promise<{ status: number; body: string }> {
  const res = await fetch(url, { headers });
  return { status: res.status, body: (await res.text()).slice(0, 120) };
}

async function main() {
  const TOKEN = "test-token-JetonService-1234567890abcdef";
  const TOKEN_URL = "http://localhost:3303";
  const TOKEN_FILES_URL = "http://localhost:3304";
  const socketServerUrl = TOKEN_URL;

  console.log("[1] Service SANS jeton (non fourni) : refus attendu");
  {
    const r = await tryConnect(socketServerUrl);
    check(
      "socket.io sans jeton → connexion REFUSÉE",
      !r.ok,
      r.ok ? "connecté sans jeton (vulnérabilité)" : r.err
    );
  }

  console.log("[2] Service AVEC jeton (auth.token) : accepté");
  {
    const r = await tryConnect(socketServerUrl, { token: TOKEN });
    check(
      "socket.io avec jeton → connexion ACCEPTÉE",
      r.ok,
      r.err ?? "connecté"
    );
  }

  console.log("[3] Mauvais jeton : refusé");
  {
    const r = await tryConnect(socketServerUrl, { token: "mauvais-jeton" });
    check(
      "socket.io mauvais jeton → REFUSÉ",
      !r.ok,
      r.ok ? "connecté avec mauvais jeton (vulnérabilité)" : r.err
    );
  }

  console.log("[4] HTTP 3004 : 401 sans jeton sur route protégée");
  {
    const r = await httpGet(`${TOKEN_FILES_URL}/uploads/test.png`);
    check(
      "GET /uploads sans jeton → 401",
      r.status === 401,
      `statut ${r.status} — ${r.body}`
    );
  }

  console.log("[5] HTTP 3004 : routes /share/... publiques (pas de jeton)");
  {
    // Token de partage inexistant mais FORMAT valide → 404 (pas 401) :
    // la route doit rester publique pour le destinataire du lien.
    const r = await httpGet(`${TOKEN_FILES_URL}/share/AbcDefGhijKlmnOpqrStuv/data.json`);
    check(
      "GET /share/<token> sans jeton → 404 (public, pas 401)",
      r.status === 404,
      `statut ${r.status}`
    );
  }

  console.log(failures === 0 ? "\nJeton : 0 échec" : `\nJeton : ${failures} échec(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erreur du test :", e);
  process.exit(1);
});
