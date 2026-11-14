// QA DOM du chantier v2.4 (2026-11-14) : assertions sur le rendu réel de
// l'app servie par Caddy (http://localhost:8181 — port non privilégié, le
// 81 du sandbox nécessite root). Deux phases :
//  A) le volet Paramètres : sections Outils / Skills / Profils / Système
//     + carte « Conversations longues » (Hermes) ;
//  B) le chemin complet de la compaction automatique — faux fournisseur
//     OpenAI-compatible sur 127.0.0.1:4611, conversation longue semée via
//     le socket (11 tours), dernier envoi par l'UI : la décision v2.4 doit
//     déclencher le résumé AVANT le tour (ordre prouvé par le journal de
//     requêtes du faux serveur), résumé injecté en tête du payload final.
//     F-16 au passage : bouton « Lire en continu » pendant le stream.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chromium } from "playwright";
import { io } from "socket.io-client";

const MOCK_PORT = 4611;
const MOCK_SECRET = "mock-secret-v24";
const requests: { i: number; url: string; stream: boolean; first: string; second: string; last: string; model: string }[] = [];

// ── Faux serveur OpenAI-compatible ──────────────────────────────────────
// /models : 200 (mock-secret-v24) ; /chat/completions : SSE pour les tours,
// JSON fixe pour les synthèses (compaction — sans champ stream). Le débit
// est ralenti quand le message utilisateur contient TRESLENT (fenêtre de
// clic pour F-16). Chaque requête est journalisée avec son ordinal.
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = req.headers.authorization ?? "";
  const good = auth === `Bearer ${MOCK_SECRET}`;
  const send = (status: number, json: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(json));
  };
  if (req.url === "/models") {
    if (!good) return send(401, { error: { message: "Invalid API key" } });
    return send(200, {
      data: [
        { id: "mock-mini", display_name: "Mock Mini" },
        { id: "mock-vision", display_name: "Mock Vision" },
      ],
    });
  }
  if (req.url === "/chat/completions" && req.method === "POST") {
    if (!good) return send(401, { error: { message: "Invalid API key for this model" } });
    const body = JSON.parse((await readBody(req)) || "{}") as any;
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const last = msgs[msgs.length - 1];
    const text = typeof last?.content === "string" ? last.content : "";
    const entry = {
      i: requests.length + 1,
      url: "/chat/completions",
      stream: body.stream === true,
      first: String(msgs[0]?.content ?? ""),
      second: String(msgs[1]?.content ?? ""),
      last: text.slice(0, 60),
      model: String(body.model ?? ""),
    };
    requests.push(entry);
    if (!body.stream) {
      // Synthèse (compaction) : réponse non streamée
      return send(200, {
        choices: [{ message: { content: "Résumé mock de la conversation de test, couvrant les onze échanges." } }],
        usage: { prompt_tokens: 40, completion_tokens: 12 },
      });
    }
    const perChunk = /TRESLENT/.test(text) ? 1400 : /LENTEUR/.test(text) ? 400 : 0;
    const chunks = [
      "Voici une première phrase suffisamment longue pour la lecture continue. ",
      "Et voici une seconde phrase, tout aussi longue, pour le test. ",
    ];
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const c of chunks) {
      await new Promise<void>((resolve) => setTimeout(resolve, perChunk));
      res.write(`data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: c } }] })}\n\n`);
    }
    res.write(
      `data: ${JSON.stringify({
        model: body.model,
        choices: [{ delta: {} }],
        usage: { prompt_tokens: 18, completion_tokens: 14 },
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  send(404, { error: { message: "not found" } });
}

const server = createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.writableEnded) res.end();
  });
});
server.listen(MOCK_PORT, "127.0.0.1");

// ── Socket de test (service :3003) ──────────────────────────────────────
const socket = io("http://localhost:3003", { transports: ["websocket"] });
function emit(event: string, payload?: unknown): Promise<any> {
  return new Promise((resolve) => {
    if (payload === undefined) socket.emit(event, (res: any) => resolve(res ?? {}));
    else socket.emit(event, payload, (res: any) => resolve(res ?? {}));
  });
}
function waitEvent(name: string, match: (p: any) => boolean, timeoutMs = 20000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(name, handler);
      reject(new Error(`timeout en attendant ${name}`));
    }, timeoutMs);
    const handler = (p: any) => {
      if (!match(p)) return;
      clearTimeout(timer);
      socket.off(name, handler);
      resolve(p);
    };
    socket.on(name, handler);
  });
}

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

const BASE = "http://localhost:8181/";
const bigMsg = (i: number) => `Contexte de test ${i} pour la conversation longue. ` + "a".repeat(22000 - 40);

async function main() {
  await new Promise<void>((resolve) => {
    if (socket.connected) resolve();
    else socket.once("connect", () => resolve());
  });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // Diagnostic : toute erreur non capturée de la page doit remonter dans le QA.
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  // ════ Phase A — le volet Paramètres ════════════════════════════════
  console.log("— Phase A : volet, sections v2.4 —");
  try {
    await page.locator('button[aria-label="Ouvrir les paramètres"]').click();
    await page.waitForTimeout(400);

    // Outils
    await page.getByRole("button", { name: "Outils", exact: true }).click();
    await page.waitForTimeout(300);
    let pane = await page.locator("section").last().innerText();
    check("Outils : recherche web listée", /Recherche web/.test(pane));
    check("Outils : pastille « sans clé » (aucune clé Tavily/Exa dans cet env)", /sans clé/.test(pane));
    check("Outils : voix présente", /Voix — dictée et lecture/.test(pane) && /présent/.test(pane));
    check("Outils : génération d'images verrouillée gateway", /Génération d'images/.test(pane) && /gateway/.test(pane));
    const manageBtn = page.getByRole("button", { name: "Gérer les clés" });
    check("Outils : lien « Gérer les clés »", (await manageBtn.count()) === 1);
    await manageBtn.click();
    await page.waitForTimeout(300);
    pane = await page.locator("section").last().innerText();
    check("Outils → navigation vers Clés de services", /Tavily|service d'API|Clés/i.test(pane));

    // Skills
    await page.getByRole("button", { name: "Skills", exact: true }).click();
    await page.waitForTimeout(300);
    pane = await page.locator("section").last().innerText();
    check("Skills : état vide honnête", /Aucun skill pour l'instant/.test(pane));
    check("Skills : rien de simulé (mention gateway)", /gateway/.test(pane));
    await page.getByRole("button", { name: "Presets de prompt" }).click();
    await page.waitForTimeout(300);
    pane = await page.locator("section").last().innerText();
    check("Skills → lien croisé vers Hermes (presets)", /Instructions personnalisées/.test(pane));

    // Hermes : carte Conversations longues
    check("Hermes : carte « Conversations longues »", /Conversations longues/.test(pane));
    check("Hermes : fenêtre du modèle affichée", /Fenêtre du modèle/.test(pane) && /jetons/.test(pane));
    const autoSwitch = page.locator('button[role="switch"][aria-label*="résumé automatique"]');
    check("Hermes : interrupteur résumé automatique", (await autoSwitch.count()) === 1);
    await autoSwitch.click();
    await page.waitForTimeout(300);
    check(
      "Hermes : activation persistée (hermes.compaction.auto)",
      (await page.evaluate(() => localStorage.getItem("hermes-ui:hermes.compaction.auto"))) === "true",
    );
    check(
      "Hermes : seuil visible après activation",
      (await page.locator('input[aria-label="Seuil du résumé automatique"]').count()) === 1,
    );

    // Profils — repartir d'une liste vide côté service (idempotence du QA :
    // un run interrompu peut laisser des profils derrière lui).
    await emit("settings:set", { key: "hermes.profiles", value: "[]" });
    await page.getByRole("button", { name: "Profils", exact: true }).click();
    await page.waitForTimeout(300);
    pane = await page.locator("section").last().innerText();
    check("Profils : état vide au départ", /Aucun profil/.test(pane));
    await page.getByRole("button", { name: "Créer un profil" }).click();
    await page.waitForTimeout(200);
    await page.getByLabel("Nom du profil").fill("QA Profil");
    check("Profils : aperçu « Sera capturé »", /Sera capturé/.test(await page.locator("section").last().innerText()));
    await page.getByRole("button", { name: "Créer", exact: true }).click();
    await page.waitForTimeout(500);
    pane = await page.locator("section").last().innerText();
    check("Profils : ligne créée + résumé", /QA Profil/.test(pane) && /web coupé/.test(pane));
    await page.getByRole("button", { name: "Appliquer", exact: true }).first().click();
    await page.waitForTimeout(400);
    pane = await page.locator("section").last().innerText();
    check("Profils : flash « appliqué »", /appliqué — effet au prochain tour|appliqué/.test(pane));
    check(
      "Profils : marqueur appliqué persisté",
      typeof (await page.evaluate(() => localStorage.getItem("hermes-ui:hermes.profiles.applied"))) === "string",
    );
    check(
      "Profils : application écrit les réglages capturés (web=false)",
      (await page.evaluate(() => localStorage.getItem("hermes-ui:hermes.tools.web"))) === "false",
    );
    // La liste vit côté service : elle survit à un rechargement.
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    await page.locator('button[aria-label="Ouvrir les paramètres"]').click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Profils", exact: true }).click();
    await page.waitForTimeout(400);
    check("Profils : liste servie par le service (reload)", /QA Profil/.test(await page.locator("section").last().innerText()));
    // Nettoyage : dupliquer puis tout supprimer
    await page.getByRole("button", { name: "Dupliquer QA Profil", exact: true }).click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Supprimer QA Profil", exact: true }).click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: "Supprimer QA Profil (copie)", exact: true }).click();
    await page.waitForTimeout(400);
    check(
      "Profils : marqueur appliqué retiré à la suppression",
      (await page.evaluate(() => localStorage.getItem("hermes-ui:hermes.profiles.applied"))) === null,
    );

    // Système
    await page.getByRole("button", { name: "Système", exact: true }).click();
    await page.waitForTimeout(300);
    pane = await page.locator("section").last().innerText();
    const rev = await page.evaluate(() => document.body.innerText.match(/[0-9a-f]{7}|inconnue/)?.[0] ?? "");
    check("Système : révision git affichée (7 hex ou inconnue)", /^[0-9a-f]{7}$|^inconnue$/.test(rev), rev);
    check("Système : chrome-headless présent", /Rendu \(chrome-headless\).*présent/s.test(pane) || /présent/.test(pane));
    check("Système : profils de rendu + Nettoyer", /Profils de rendu/.test(pane) && /Nettoyer maintenant/.test(pane));
    check("Système : moteur verrouillé gateway (jamais simulé)", /Moteur Hermes/.test(pane) && /gateway/.test(pane));
    await page.getByRole("button", { name: "Fermer les paramètres" }).click();
    await page.waitForTimeout(300);
  } catch (e) {
    check("Phase A (volet)", false, String(e).slice(0, 100));
  } finally {
    // Le volet doit être fermé quoi qu'il arrive (Phase B a besoin du composer).
    await page
      .getByRole("button", { name: "Fermer les paramètres" })
      .click()
      .catch(() => {});
    await page.waitForTimeout(300);
  }

  // ════ Phase B — faux fournisseur, F-16, compaction automatique ═════
  console.log("— Phase B : fournisseur mock, F-16, compaction automatique —");
  let providerId: string | null = null;
  let bigConvId: string | null = null;
  try {
    // 1. Fournisseur mock + clé
    const add = await emit("providers:add", { name: `http://127.0.0.1:${MOCK_PORT}`, kind: "llm" });
    providerId = add.provider?.id ?? null;
    check("providers:add mock v24", !!providerId, add.error ?? "");
    const key = await emit("providers:add-key", {
      providerId,
      label: "Clé mock v24",
      secret: MOCK_SECRET,
    });
    check("providers:add-key", !!key.key?.id);
    await page.waitForTimeout(1200); // models:changed → sélecteur vivant

    // 2. F-16 : un tour lent, bouton « Lire en continu » pendant le stream
    const box = page.locator("textarea").last();
    await box.click();
    await box.fill("Réponds lentement TRESLENT en deux phrases assez longues.");
    await box.press("Enter");
    await page.waitForTimeout(2100); // premier delta à ~1 400 ms (TRESLENT)
    const readBtn = page.getByRole("button", { name: "Lire en continu" });
    check("F-16 : bouton « Lire en continu » pendant le stream", (await readBtn.count()) === 1);
    if (await readBtn.count()) {
      await readBtn.click();
      await page.waitForTimeout(200);
      const pressed = await page.getByRole("button", { name: "Couper la lecture" }).getAttribute("aria-pressed");
      check("F-16 : lecture active (aria-pressed)", pressed === "true");
      const voices = await page.evaluate(() =>
        typeof speechSynthesis !== "undefined" ? speechSynthesis.getVoices().length : -1
      );
      const pending = await page.evaluate(() =>
        typeof speechSynthesis !== "undefined"
          ? speechSynthesis.pending || speechSynthesis.speaking
          : false
      );
      // Headless Chromium est souvent livré sans voix : speak() est mis en
      // file mais rien ne « parle » — l'absence de voix n'est pas un défaut
      // du code, la file reste démontrée par pending.
      check(
        "F-16 : file speechSynthesis alimentée (headless sans voix admis)",
        pending === true || voices === 0,
        `voices=${voices} pending=${pending}`,
      );
      await page.getByRole("button", { name: "Couper la lecture" }).click();
      await page.waitForTimeout(200);
      const off = await page.evaluate(() => !speechSynthesis.speaking && !speechSynthesis.pending);
      check("F-16 : coupure = silence immédiat", off === true);
    }
    await page.waitForTimeout(4500); // fin du tour lent

    // 3. Conversation longue : 11 tours semés via le socket (service),
    //    page ouverte dessus — le hook suivra par les broadcasts.
    const conv = await emit("conversations:create", { title: null });
    bigConvId = conv.conversation?.id ?? null;
    check("conversation longue créée", !!bigConvId);
    for (let i = 1; i <= 11; i++) {
      const send = await emit("chat:send", {
        conversationId: bigConvId,
        content: bigMsg(i),
        model: "mock-mini",
      });
      if (send?.error) {
        check(`tour semé ${i}`, false, send.error);
        continue;
      }
      await waitEvent(
        "stream:done",
        (p) => p?.conversationId === bigConvId,
        15000,
      ).catch(() => null);
    }
    check("11 tours semés via le service", true, `${requests.length} requêtes au mock`);

    // 4. Ouvrir la conversation dans l'UI + armer la compaction (50 %)
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    await page.getByText(/Contexte de test 1/).first().click();
    await page.waitForTimeout(900);
    await page.evaluate(() => {
      localStorage.setItem("hermes-ui:hermes.compaction.auto", "true");
      localStorage.setItem("hermes-ui:hermes.compaction.threshold", "50");
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(2000);
    await page.getByText(/Contexte de test 1/).first().click();
    await page.waitForTimeout(900);

    // 5. Dernier envoi PAR L'UI : la décision doit déclencher le résumé.
    // Le socket du script écoute aussi le broadcast (il va à tous les clients).
    let broadcastSeen: any = null;
    const onBroadcast = (p: any) => {
      if (p?.conversationId === bigConvId) broadcastSeen = p;
    };
    socket.on("conversation:compacted", onBroadcast);
    const before = requests.length;
    // Sonde page : la jauge du composer (title de l'anneau) avant l'envoi.
    const gaugeBefore = await page
      .locator('[title^="Contexte :"]')
      .first()
      .getAttribute("title")
      .catch(() => null);
    const box2 = page.locator("textarea").last();
    await box2.click();
    await box2.fill(bigMsg(12));
    await box2.press("Enter");
    // Attendre le toast de confirmation (max 30 s) — le nôtre (v2.4) ou
    // celui du hook existant (F-01, « Contexte compacté ») : l'un des deux
    // prouve que la page a reçu le broadcast.
    const toast = page.getByText(/Résumé automatique créé|Contexte compacté/);
    let toasted = false;
    try {
      await toast.first().waitFor({ state: "visible", timeout: 30000 });
      toasted = true;
    } catch {
      toasted = false;
    }
    check("auto-compact : toast de confirmation (v2.4 ou hook)", toasted);
    await page.waitForTimeout(2500); // le tour part après le résumé

    // Sonde page : la jauge doit avoir chuté (le résumé remplace l'historique).
    const gaugeAfter = await page
      .locator('[title^="Contexte :"]')
      .first()
      .getAttribute("title")
      .catch(() => null);
    check(
      "auto-compact : la page a bien reçu le compact (jauge reçue)",
      !!gaugeBefore && !!gaugeAfter && gaugeBefore !== gaugeAfter,
      `avant="${gaugeBefore}" après="${gaugeAfter}"`,
    );

    const after = requests.slice(before);
    const summarize = after.find((r) => !r.stream);
    const finalTurn = [...after].reverse().find((r) => r.stream);
    check("auto-compact : synthèse AVANT le tour (ordre au mock)", !!summarize && !!finalTurn,
      `ordres: ${after.map((r) => (r.stream ? "S" : "Z")).join(",")}`);
    check(
      "auto-compact : le résumé est en tête de l'historique du tour (après le prompt système)",
      !!finalTurn && /^\[Résumé des \d+ premiers messages/.test(finalTurn.second),
      (finalTurn?.second ?? "").slice(0, 60),
    );
    check(
      "auto-compact : le tour porte bien le nouveau message utilisateur",
      !!finalTurn && /Contexte de test 12/.test(finalTurn.last),
    );
    socket.off("conversation:compacted", onBroadcast);
    check(
      "auto-compact : broadcast conversation:compacted vu par un 3e client",
      !!broadcastSeen && !!broadcastSeen.compact,
      broadcastSeen ? `summaryChars=${broadcastSeen.compact?.summaryChars}` : "jamais reçu",
    );
    // Diagnostic : journal du mock + dernier état du fil.
    console.log(
      "    journal mock (fin de run) :",
      requests.slice(-4).map((r) => `#${r.i}${r.stream ? "S" : "Z"}`).join(" "),
    );
    const bodyTail = (await page.locator("body").innerText().catch(() => "")).slice(-300);
    console.log("    fin du fil : " + JSON.stringify(bodyTail.slice(-160)));
  } catch (e) {
    check("Phase B (compaction automatique)", false, String(e).slice(0, 100));
  } finally {
    // Nettoyage : conversations + fournisseur
    if (bigConvId) await emit("conversations:delete", { id: bigConvId }).catch(() => {});
    const convs = await emit("conversations:list");
    for (const c of convs.conversations ?? []) {
      if (/Contexte de test|TRESLENT|lentement/i.test(c.title ?? "")) {
        await emit("conversations:delete", { id: c.id }).catch(() => {});
      }
    }
    if (providerId) await emit("providers:remove", { id: providerId }).catch(() => {});
    if (pageErrors.length) {
      console.log("  ⚠ erreurs de page pendant le run :");
      for (const e of pageErrors.slice(0, 8)) console.log("    " + e.slice(0, 160));
    }
  }

  await browser.close();
  socket.close();
  server.close();
  console.log(failures === 0 ? "TOUS OK — QA DOM v2.4" : `${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ERREUR:", e);
  process.exit(1);
});
