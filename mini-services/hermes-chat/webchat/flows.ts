// Flux de pilotage par site (spec §5 « L'algorithme, commun aux trois sites »
// et annexes A/B/C). Rappels non négociables :
// - Attendre un ÉTAT, jamais une durée : toutes les attentes sont des boucles
//   d'observation à plafond explicite, dont le dépassement est un échec franc.
// - Insertion par Input.insertText (jamais touche par touche, jamais d'Entrée
//   nue), clic réel sur le bouton d'envoi, vérification que le compositeur
//   s'est vidé.
// - Le signal de fin reste le DOM (un crochet posé par CDP meurt avec la
//   connexion qui l'a posé).
import type { CdpPage } from "./cdp";
import { sleep } from "./cdp";
import type { SiteFiche } from "./fiches";

export interface FlowResult {
  /** URL du chat à l'issue du tour (rapport). */
  url: string;
  /** Texte extrait (le site a répondu sans produire de fichiers). */
  text?: string;
  /** Fichiers produits, en base64 (écrits côté pilote via la garde de chemin). */
  files?: { name: string; base64: string }[];
}

export interface FlowCtx {
  page: CdpPage;
  fiche: SiteFiche;
  prompt: string;
  /** Plafond de génération (ms) — filet, pas méthode de fin. */
  timeoutMs: number;
  onStep: (msg: string) => void;
  onHeartbeat: () => void;
}

/** Attente d'un état (expression JS) sous plafond — échec franc au dépassement. */
async function waitFor(
  ctx: FlowCtx,
  expr: string,
  what: string,
  capMs: number,
  pollMs = 500
): Promise<void> {
  const deadline = Date.now() + capMs;
  while (Date.now() < deadline) {
    ctx.onHeartbeat();
    let ok = false;
    try {
      ok = Boolean(await ctx.page.evaluate(expr));
    } catch {
      ok = false; // page en re-rendu : on ré-observe
    }
    if (ok) return;
    await sleep(pollMs);
  }
  throw new Error(`Plafond dépassé : ${what} (${Math.round(capMs / 1000)} s)`);
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

// ── z.ai — Annexe A (vérifié) ────────────────────────────────────────────

/** État de génération z.ai, lu dans le DOM (une observation, pas une durée). */
const ZAI_STATE_EXPR = `(() => {
  const bodyText = document.body ? document.body.innerText : "";
  const marks = [...document.querySelectorAll('[class*="markdown"]')];
  const last = marks.length ? marks[marks.length - 1] : null;
  return {
    filesCard: bodyText.includes("All files in task"),
    thinking: bodyText.includes("Thinking..."),
    lastLen: last ? (last.innerText || "").length : 0,
  };
})()`;

/** Extraction du texte réponse : conteneur cloné, bruit retiré. */
const ZAI_TEXT_EXPR = `(() => {
  const direct = document.querySelector(".chat-assistant");
  const marks = [...document.querySelectorAll('[class*="markdown"]')];
  const el = direct || (marks.length ? marks[marks.length - 1] : null);
  if (!el) return "";
  const clone = el.cloneNode(true);
  clone.querySelectorAll("iframe, script, style").forEach((n) => n.remove());
  let text = (clone.innerText || "").trim();
  // Bruit connu (fiche) : en-tête « Thought Process » en tête de réponse.
  text = text.replace(/^\\s*Thought Process\\s*\\n?/i, "").trim();
  return text;
})()`;

/** Crochet de récupération de fichiers : mémorise /api/v1/storage/ et
 *  neutralise HTMLAnchorElement.prototype.click (dialogue natif impossible
 *  sur un profil nu). Posé dans la page — meurt avec elle, jamais utilisé
 *  comme signal de fin. */
const ZAI_HOOK_EXPR = `(() => {
  if (window.__hermesPilotHook) return window.__hermesPilotHook.urls.slice();
  const urls = [];
  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      const u = typeof input === "string" ? input : (input && input.url) || "";
      if (u.indexOf("/api/v1/storage/") !== -1) urls.push(u);
    } catch (e) {}
    return origFetch(input, init);
  };
  HTMLAnchorElement.prototype.click = function () {};
  window.__hermesPilotHook = { urls: urls };
  return urls;
})()`;

/** Lecture du crochet + rapatriement des octets DANS la page (base64). */
const ZAI_FETCH_FILES_EXPR = `(async () => {
  const hook = window.__hermesPilotHook;
  if (!hook) return [];
  const out = [];
  const seen = new Set();
  for (const u of hook.urls) {
    if (seen.has(u)) continue;
    seen.add(u);
    const abs = u.indexOf("http") === 0 ? u : location.origin + u;
    const res = await fetch(abs, { credentials: "include" });
    if (!res.ok) continue;
    const buf = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = "";
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    out.push({ url: u, base64: btoa(binary) });
  }
  return out;
})()`;

export async function runZai(ctx: FlowCtx): Promise<FlowResult> {
  const { page, fiche } = ctx;
  ctx.onStep("Attente du compositeur (accueil = nouvelle tâche — jamais « New Chat »)");
  await waitFor(ctx, `!!(${fiche.compositeur_pret})`, "compositeur z.ai prêt", 40_000);

  // B. Taper et envoyer — vérifier le vidage du compositeur (≤ 12 essais).
  ctx.onStep("Insertion de la consigne et envoi");
  let sent = false;
  for (let attempt = 1; attempt <= 12 && !sent; attempt++) {
    await page.evaluate(
      `(() => { const t = document.querySelector('textarea'); if (t) t.focus(); })()`
    );
    await page.insertText(ctx.prompt);
    await page.click(fiche.sel_envoyer);
    // Le textarea doit se vider dans les 6 s (la page re-rend son compositeur
    // juste après le chargement — d'où les réessais).
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      ctx.onHeartbeat();
      const empty = await page.evaluate(
        `(() => {
           const t = document.querySelector('textarea');
           return !!t && (t.value || "").length === 0;
         })()`
      );
      if (empty) { sent = true; break; }
      await sleep(500);
    }
    if (!sent && attempt < 12) await sleep(800);
  }
  if (!sent) {
    throw new Error("envoi refusé : le compositeur z.ai ne se vide pas après 12 essais");
  }

  // C. Savoir où en est la génération — un état, pas une durée. La FORME de
  //  la réponse est OBSERVÉE, jamais décidée à l'avance (fusion : une seule
  //  entrée par site) : le site répond en texte (question) ou pose ses
  //  fichiers (tâche qui en produit) — on attend l'un OU l'autre, le premier
  //  qui survient l'emporte.
  ctx.onStep("Attente de la génération (états du DOM)");
  const deadline = Date.now() + ctx.timeoutMs;
  let stableCount = 0;
  let lastLen = -1;
  let emptyPolls = 0;
  let producedFiles = false;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`plafond de ${Math.round(ctx.timeoutMs / 1000)} s dépassé (z.ai)`);
    }
    ctx.onHeartbeat();
    await sleep(4_000);
    const st = (await page.evaluate(ZAI_STATE_EXPR)) as {
      filesCard: boolean; thinking: boolean; lastLen: number;
    };
    if (st.filesCard && !st.thinking) {
      producedFiles = true;
      break;
    }
    const stable = st.lastLen > 0 && st.lastLen === lastLen;
    // Fin « texte » : réponse stable, génération terminée — MAIS tant que des
    // artefacts sont annoncés (carte présente), on continue d'attendre leur
    // pose : un résumé qui se fige pendant que les fichiers s'écrivent n'est
    // pas une fin.
    if (stable && !st.thinking && !st.filesCard) {
      stableCount++;
      if (stableCount >= 2) break; // 3 relevés consécutifs identiques
    } else {
      stableCount = 0;
    }
    if (!st.thinking && st.lastLen === 0 && !st.filesCard) {
      emptyPolls++;
      if (emptyPolls >= 8) {
        throw new Error("aucun texte produit par z.ai (session expirée ? refus du site ?)");
      }
    } else {
      emptyPolls = 0;
    }
    lastLen = st.lastLen;
  }

  // D/E. Récupérer ce que le site a produit : ses fichiers, sinon son texte.
  if (producedFiles) {
    ctx.onStep("Récupération des fichiers produits (crochet fetch dans la page)");
    await page.evaluate(ZAI_HOOK_EXPR);
    // Cliquer CHAQUE bouton de téléchargement (jusqu'à 3 passes, en
    // s'arrêtant dès qu'une URL non bloquée est apparue) — un artefact par
    // bouton, tous doivent partir.
    const sel = fiche.sel_fichiers!;
    for (let pass = 0; pass < 3; pass++) {
      const before = (await page.evaluate(`window.__hermesPilotHook.urls.slice()`)) as string[];
      const count = Number(
        await page.evaluate(`(() => {
          return [...document.querySelectorAll(${JSON.stringify(sel)})]
            .filter((e) => e.offsetParent && e.getBoundingClientRect().width > 0).length;
        })()`)
      ) || 0;
      for (let i = 0; i < count; i++) {
        ctx.onHeartbeat();
        await page.clickFinder(`(() => {
          const vis = [...document.querySelectorAll(${JSON.stringify(sel)})]
            .filter((e) => e.offsetParent && e.getBoundingClientRect().width > 0);
          const el = vis[${i}];
          if (!el) return null;
          el.scrollIntoView({ block: "center", behavior: "instant" });
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`);
        await sleep(1_200);
      }
      await sleep(2_500);
      const after = (await page.evaluate(`window.__hermesPilotHook.urls.slice()`)) as string[];
      if (after.length > before.length) break; // une URL non bloquée est apparue
    }
    const picked = (await page.evaluate(ZAI_FETCH_FILES_EXPR)) as {
      url: string; base64: string;
    }[];
    const files = picked.map((p) => {
      // Le nom vient du paramètre path= de l'URL : dernier segment seulement,
      // la garde de chemin côté pilote re-vérifie tout (jamais de confiance).
      let name = "fichier";
      try {
        const u = new URL(p.url, "https://x.invalid");
        const p2 = u.searchParams.get("path") ?? u.pathname;
        name = p2.split("/").filter(Boolean).pop() || "fichier";
      } catch {
        name = "fichier";
      }
      return { name, base64: p.base64 };
    });
    if (files.length === 0) {
      throw new Error("aucun fichier récupéré malgré les artefacts annoncés (z.ai)");
    }
    const url = await page.evaluate("location.href");
    return { url: String(url ?? fiche.url_accueil), files };
  }

  ctx.onStep("Lecture du texte de réponse");
  const text = String((await page.evaluate(ZAI_TEXT_EXPR)) ?? "").trim();
  if (!text) {
    throw new Error("réponse vide — échec franc (le DOM n'expose pas de texte)");
  }
  const url = await page.evaluate("location.href");
  return { url: String(url ?? fiche.url_accueil), text };
}

// ── Google AI Studio — Annexe B (vérifié) ───────────────────────────────

const AI_TURNS_EXPR = `document.querySelectorAll(".model-prompt-container").length`;
const AI_USERS_EXPR = `document.querySelectorAll(".user-prompt-container").length`;
const AI_BUSY_EXPR = `(() => {
  const btn = document.querySelector("button.ctrl-enter-submits");
  if (!btn) return false;
  return [...btn.querySelectorAll("*")].some((c) => {
    const t = (c.textContent || "").trim();
    return t === "Stop" || t === "progress_activity";
  });
})()`;
const AI_LAST_LEN_EXPR = `(() => {
  const turns = [...document.querySelectorAll(".model-prompt-container")];
  const last = turns[turns.length - 1];
  return last ? (last.innerText || "").length : 0;
})()`;

/** Extraction AI Studio : clone du dernier tour, bruit retiré, blocs de code
 *  sortis par textContent du <pre> puis réinjectés en triples backticks. */
function aiExtractExpr(noise: string[]): string {
  const noiseJson = JSON.stringify(noise);
  return `(() => {
    const turns = [...document.querySelectorAll(".model-prompt-container")];
    const last = turns[turns.length - 1];
    if (!last) return "";
    const clone = last.cloneNode(true);
    const noise = ${noiseJson};
    noise.forEach((sel) => clone.querySelectorAll(sel).forEach((n) => n.remove()));
    // Blocs de code : innerText écrase leurs en-têtes et peut perdre des
    // sauts de ligne — le textContent du <pre>, lui, est exact.
    const codes = [];
    clone.querySelectorAll("ms-code-block").forEach((cb, i) => {
      const pre = cb.querySelector("pre");
      codes.push(pre ? (pre.textContent || "") : "");
      const token = document.createElement("span");
      token.textContent = "__GEMINI_CODE_" + i + "__";
      cb.replaceWith(token);
    });
    let text = (clone.innerText || "").trim();
    codes.forEach((code, i) => {
      // Replacement par fonction : le code peut contenir $&, $1… qui seraient
      // interprétés par un remplacement littéral.
      text = text.replace(
        "__GEMINI_CODE_" + i + "__",
        () => "\\n\\n\`\`\`\\n" + code + "\\n\`\`\`\\n\\n"
      );
    });
    // Nettoyages connus (fiche) :
    text = text.replace(/^\\s*En train de réfléchir[^\\n]*$/gim, "");
    text = text.replace(/^\\s*Model [^\\n]*$/i, "");
    const paras = text.split("\\n\\n");
    if (paras.length && paras[paras.length - 1].indexOf("thumb_up") !== -1) {
      paras.pop();
    }
    return paras.join("\\n\\n").trim();
  })()`;
}

export async function runAiStudio(ctx: FlowCtx): Promise<FlowResult> {
  const { page, fiche } = ctx;
  ctx.onStep("Discussion neuve : about:blank, puis l'accueil, puis 0 tour");
  await page.navigate("about:blank");
  await sleep(800);
  await page.navigate(fiche.url_accueil);
  await waitFor(ctx, `!!(${fiche.compositeur_pret})`, "compositeur AI Studio prêt", 40_000);

  // Bandeau de consentement éventuel (cliquer puis continuer).
  const consentSrc = (fiche.bandeau_consentement ?? "").replace(/^\/(.*)\/[a-z]*$/i, "$1");
  if (consentSrc) {
    const clicked = await page.clickFinder(`(() => {
      const re = new RegExp(${JSON.stringify(consentSrc)}, "i");
      const btn = [...document.querySelectorAll("button")].find((b) => {
        if (!b.offsetParent) return false;
        return re.test((b.textContent || "").trim());
      });
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (clicked) {
      ctx.onStep("Bandeau de consentement accepté");
      await sleep(1_000);
    }
  }

  // Discussion NEUVE : vérifier 0 tour existant, sinon recharger sans cache.
  let turns = Number(await page.evaluate(AI_TURNS_EXPR)) || 0;
  if (turns > 0) {
    ctx.onStep("Tours résiduels détectés — rechargement sans cache");
    await page.reloadIgnoringCache();
    await waitFor(ctx, `!!(${fiche.compositeur_pret})`, "compositeur AI Studio (rechargé)", 40_000);
    turns = Number(await page.evaluate(AI_TURNS_EXPR)) || 0;
    if (turns > 0) {
      throw new Error(`discussion AI Studio non neuve (${turns} tours) après rechargement`);
    }
  }

  // B. Choisir le modèle demandé — vérifier le sous-titre après le clic.
  const sel = fiche.selecteur_modele!;
  const slug = fiche.modele ?? null;
  if (slug) {
    // La carte se cherche parmi les CANDIDATS de la fiche (le DOM d'AI
    // Studio bouge) — attente d'ÉTAT sous plafond : première charge après
    // connexion, la page met du temps à rendre son en-tête.
    const candidats = [sel.carte, ...(sel.carte_candidates ?? [])].filter(
      (s, i, a) => s && a.indexOf(s) === i
    );
    const probeExpr = `(() => {
      const cands = ${JSON.stringify(candidats)};
      for (const s of cands) {
        const els = [...document.querySelectorAll(s)];
        if (els.some((e) => e.offsetParent && e.getBoundingClientRect().width > 0)) return s;
      }
      return null;
    })()`;
    const carteDeadline = Date.now() + 20_000;
    let carteSel: string | null = null;
    while (Date.now() < carteDeadline) {
      ctx.onHeartbeat();
      carteSel = (await page.evaluate(probeExpr)) as string | null;
      if (carteSel) break;
      await sleep(500);
    }
    if (!carteSel) {
      // Diagnostic : les boutons VISIBLES du DOM réel — la fiche (en
      // données) se corrige à partir de CE rapport, jamais à l'aveugle.
      const boutons = (await page.evaluate(`(() => {
        return [...document.querySelectorAll("button")]
          .filter((b) => b.offsetParent && b.getBoundingClientRect().width > 0)
          .slice(0, 40)
          .map((b) => ({
            cls: String(b.className || "").slice(0, 80),
            label: (b.getAttribute("aria-label") || "").slice(0, 60),
            text: (b.textContent || "").trim().slice(0, 50),
          }));
      })()`)) as { cls: string; label: string; text: string }[];
      throw new Error(
        `carte du sélecteur de modèle AI Studio introuvable (sélecteurs essayés : ` +
          `${candidats.join(", ")}) — boutons visibles : ${JSON.stringify(boutons)}`
      );
    }
    ctx.onStep(`Carte du sélecteur de modèle trouvée (${carteSel})`);
    const subtitleExpr = `(() => {
      const card = document.querySelector(${JSON.stringify(carteSel)});
      if (!card) return "";
      const el = card.querySelector(${JSON.stringify(sel.sous_titre)});
      return el ? (el.textContent || "").trim() : "";
    })()`;
    const current = String((await page.evaluate(subtitleExpr)) ?? "").trim();
    if (current !== slug) {
      ctx.onStep(`Choix du modèle « ${slug} » (courant : « ${current || "?"} »)`);
      if (!(await page.click(carteSel))) {
        throw new Error("carte du sélecteur de modèle AI Studio visible mais non cliquable");
      }
      await waitFor(ctx, `!!document.querySelector(${JSON.stringify(sel.palette)})`, "palette de modèles", 8_000);
      const itemFinder = `(() => {
        const slug = ${JSON.stringify(slug)};
        const items = [...document.querySelectorAll(${JSON.stringify(sel.palette)} + " " + ${JSON.stringify(sel.item)})];
        const hit = items.find((b) => {
          const sub = b.querySelector(${JSON.stringify(sel.item_sous_titre)});
          return sub && (sub.textContent || "").trim() === slug;
        });
        if (!hit || !hit.offsetParent) return null;
        const r = hit.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`;
      if (!(await page.clickFinder(itemFinder))) {
        // Pas dans la liste visible : remplir la recherche PAR LE SETTER
        // NATIF (une affectation .value directe ne réveille pas le framework).
        await page.evaluate(`(() => {
          const input = document.querySelector(${JSON.stringify(sel.palette)} + " " + ${JSON.stringify(sel.recherche)});
          if (!input) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
          setter.call(input, ${JSON.stringify(slug)});
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        })()`);
        await sleep(1_500);
        if (!(await page.clickFinder(itemFinder))) {
          const present = (await page.evaluate(`(() => {
            return [...document.querySelectorAll(${JSON.stringify(sel.palette)} + " " + ${JSON.stringify(sel.item_sous_titre)})]
              .map((e) => (e.textContent || "").trim()).filter(Boolean).slice(0, 30);
          })()`)) as string[];
          throw new Error(
            `modèle « ${slug} » introuvable dans la palette — modèles présents : ${
              present.join(", ") || "aucun"
            }`
          );
        }
      }
      await sleep(1_200);
      const after = String((await page.evaluate(subtitleExpr)) ?? "").trim();
      if (after !== slug) {
        throw new Error(
          `le modèle AI Studio n'a pas changé (attendu « ${slug} », lu « ${after || "?"} »)`
        );
      }
    }
  }

  // C. Taper et envoyer — double vérification (textarea vidé + 30 premiers
  // caractères réapparus dans le dernier tour utilisateur), ≤ 10 essais.
  ctx.onStep("Insertion de la consigne et envoi");
  const first30 = norm(ctx.prompt).slice(0, 30);
  let sent = false;
  for (let attempt = 1; attempt <= 10 && !sent; attempt++) {
    await page.evaluate(
      `(() => { const t = document.querySelector('textarea'); if (t) t.focus(); })()`
    );
    await page.insertText(ctx.prompt);
    await page.click(fiche.sel_envoyer);
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      ctx.onHeartbeat();
      const ok = (await page.evaluate(`(() => {
        const t = document.querySelector('textarea');
        const emptied = !!t && (t.value || "").length === 0;
        const users = [...document.querySelectorAll(".user-prompt-container")];
        const last = users[users.length - 1];
        const echoed = !!last && (last.innerText || "").replace(/\\s+/g, " ").trim()
          .indexOf(${JSON.stringify(first30)}) !== -1;
        return emptied && echoed;
      })()`)) as boolean;
      if (ok) { sent = true; break; }
      await sleep(500);
    }
    if (!sent && attempt < 10) await sleep(800);
  }
  if (!sent) {
    throw new Error("envoi refusé : AI Studio n'a pas pris la consigne après 10 essais");
  }

  // D. Attendre la fin — un état, pas une durée.
  ctx.onStep("Attente de la génération (bouton Stop + texte stable)");
  const deadline = Date.now() + ctx.timeoutMs;
  let stableCount = 0;
  let lastLen = -1;
  let emptyPolls = 0;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`plafond de ${Math.round(ctx.timeoutMs / 1000)} s dépassé (AI Studio)`);
    }
    ctx.onHeartbeat();
    await sleep(4_000);
    const busy = Boolean(await page.evaluate(AI_BUSY_EXPR));
    const len = Number(await page.evaluate(AI_LAST_LEN_EXPR)) || 0;
    if (!busy && len > 0 && len === lastLen) {
      stableCount++;
      if (stableCount >= 2) break; // 3 relevés consécutifs identiques
    } else {
      stableCount = 0;
    }
    const users = Number(await page.evaluate(AI_USERS_EXPR)) || 0;
    if (!busy && users > 0 && len === 0) {
      emptyPolls++;
      if (emptyPolls >= 8) {
        throw new Error("AI Studio a échoué sans rien dire (aucun texte produit)");
      }
    } else {
      emptyPolls = 0;
    }
    lastLen = len;
  }

  // E. Extraire le texte.
  ctx.onStep("Lecture du texte de réponse");
  const text = String(
    (await page.evaluate(aiExtractExpr(fiche.bruit_reponse ?? []))) ?? ""
  ).trim();
  if (!text) {
    throw new Error("réponse vide — échec franc (le DOM n'expose pas de texte)");
  }
  const url = await page.evaluate("location.href");
  return { url: String(url ?? fiche.url_accueil), text };
}

// ── gemini.google.com — Annexe C (à relever) ────────────────────────────

/** Tant que verifie=false : indisponible, explicitement — jamais cassé. */
export async function runGeminiApp(_ctx: FlowCtx): Promise<FlowResult> {
  throw new Error(
    "gemini.google.com est indisponible : les sélecteurs de la page n'ont pas " +
      "encore été relevés (fiche verifie=false). Procédure de relevé dans la " +
      "fiche — Annexe C de la spécification."
  );
}
