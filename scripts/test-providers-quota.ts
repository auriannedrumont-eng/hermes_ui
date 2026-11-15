// QA « test de clé honnête jusqu'au solde » (v2.4) — aucun réseau : fetch
// global remplacé par un faux qui rejoue les comportements RÉELS observés
// le 2026-11-15 avec les deux clés en échec d'Aurianne :
//   • z.ai clé API valide + compte SANS crédit : /models répond 200 (12
//     modèles) mais /chat/completions répond 429 code 1113 « Insufficient
//     balance or no resource package » ;
//   • opencode clé valide + quota gratuit épuisé : /models répond 200 mais
//     /chat/completions répond 429 « FreeUsageLimitError » (les modèles
//     gratuits ne tournent que dans l'application opencode).
// Avant le correctif, le bouton « Tester » affichait « 12 modèles » (ou
// « limite atteinte ») — trompeur. Après : la mini-génération (1 jeton,
// modèle flash/gratuit) révèle la vérité dès le test.
// Vérifie aussi les non-régressions : autres fournisseurs non sondés
// (aucun risque de dépense), 401, piège du 200-porteur-d'erreur, repli
// réseau.
import { testProviderKey, explainQuotaError } from "../mini-services/hermes-chat/providers";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

// ── Faux fetch : routes par (méthode, suffixe d'URL) ───────────────────
type Route = { method: string; suffix: string; status: number; body: unknown };
const calls: { method: string; url: string; auth: string; body: any }[] = [];

function fakeFetch(routes: Route[]) {
  return (async (input: any, init?: any) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const auth = String(init?.headers?.Authorization ?? "");
    let body: any = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      /* pas de corps */
    }
    calls.push({ method, url, auth, body });
    const r = routes.find((x) => method === x.method && url.endsWith(x.suffix));
    if (!r) return new Response("not found", { status: 404 });
    if (r.status === 0) throw new Error("network down (simulé)");
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

const ZAI_MODELS = {
  object: "list",
  data: ["glm-4.6", "glm-5.3", "glm-5.3-flash"].map((id) => ({ id, object: "model" })),
};
const OC_MODELS = {
  object: "list",
  data: ["big-pickle", "mimo-v2.6-flash-free"].map((id) => ({ id, type: "chat" })),
};
const CHAT_OK = { choices: [{ message: { role: "assistant", content: "" } }] };
const ZAI_1113 = {
  error: { code: "1113", message: "Insufficient balance or no resource package. Please recharge." },
};
const OC_FREE = {
  type: "error",
  error: {
    type: "FreeUsageLimitError",
    message:
      "Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go",
  },
};

const realFetch = globalThis.fetch;
async function withRoutes<T>(routes: Route[], fn: () => Promise<T>): Promise<T> {
  calls.length = 0;
  globalThis.fetch = fakeFetch(routes) as any;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
}

console.log("QA test de clé honnête — solde & quota révélés au test\n");

// [1] z.ai : clé valide, compte sans crédit → verdict « solde insuffisant »
{
  const r = await withRoutes(
    [
      { method: "GET", suffix: "/api/paas/v4/models", status: 200, body: ZAI_MODELS },
      { method: "POST", suffix: "/api/paas/v4/chat/completions", status: 429, body: ZAI_1113 },
    ],
    () => testProviderKey("z.ai", null, "clevalide.sanscredit"),
  );
  check("[1] z.ai sans crédit : statut exhausted", r.status === "exhausted", JSON.stringify(r));
  check(
    "[1] z.ai sans crédit : libellé explicite",
    r.statusLabel === "clé valide — solde insuffisant, rechargez le compte",
    r.statusLabel,
  );
  const probe = calls.find((c) => c.method === "POST");
  check("[1] sonde sur la surface standard", Boolean(probe?.url.endsWith("/api/paas/v4/chat/completions")));
  check("[1] modèle flash choisi (coût dérisoire)", probe?.body?.model === "glm-5.3-flash");
  check("[1] la clé voyage dans la sonde", probe?.auth === "Bearer clevalide.sanscredit");
}

// [2] z.ai : compte actif → « N modèles — compte actif »
{
  const r = await withRoutes(
    [
      { method: "GET", suffix: "/api/paas/v4/models", status: 200, body: ZAI_MODELS },
      { method: "POST", suffix: "/api/paas/v4/chat/completions", status: 200, body: CHAT_OK },
    ],
    () => testProviderKey("z.ai", null, "clevalide.aveccredit"),
  );
  check("[2] z.ai compte actif : statut ok", r.status === "ok", JSON.stringify(r));
  check("[2] z.ai compte actif : libellé", r.statusLabel === "3 modèles — compte actif", r.statusLabel);
}

// [3] z.ai Coding Plan (JWT) : sonde sur la SURFACE CODING
{
  const r = await withRoutes(
    [
      { method: "GET", suffix: "/api/coding/paas/v4/models", status: 200, body: ZAI_MODELS },
      { method: "POST", suffix: "/api/coding/paas/v4/chat/completions", status: 200, body: CHAT_OK },
    ],
    () =>
      testProviderKey(
        "z.ai",
        null,
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhdXJpYW5uZSJ9.c2lnbmF0dXJlLWZhdXNzZQ",
      ),
  );
  check("[3] Coding Plan : statut ok", r.status === "ok", JSON.stringify(r));
  check("[3] Coding Plan : libellé avec mention", r.statusLabel === "3 modèles (Coding Plan) — compte actif", r.statusLabel);
  const probe = calls.find((c) => c.method === "POST");
  check(
    "[3] sonde sur la surface coding",
    Boolean(probe?.url.endsWith("/api/coding/paas/v4/chat/completions")),
  );
}

// [4] opencode : quota gratuit épuisé → verdict « abonnement requis »
{
  const r = await withRoutes(
    [
      { method: "GET", suffix: "/inference/v1/models", status: 200, body: OC_MODELS },
      { method: "POST", suffix: "/inference/openai/v1/chat/completions", status: 429, body: OC_FREE },
    ],
    () => testProviderKey("opencode", null, "oc_sk_quotaeepuise"),
  );
  check("[4] opencode quota épuisé : statut exhausted", r.status === "exhausted", JSON.stringify(r));
  check(
    "[4] opencode quota épuisé : libellé explicite",
    r.statusLabel === "clé valide — quota gratuit épuisé (abonnement requis)",
    r.statusLabel,
  );
  const probe = calls.find((c) => c.method === "POST");
  check("[4] sonde sur la surface chat réelle", Boolean(probe?.url.includes("/inference/openai/v1/chat/completions")));
  check("[4] modèle gratuit choisi", probe?.body?.model === "big-pickle");
}

// [5] opencode : compte actif
{
  const r = await withRoutes(
    [
      { method: "GET", suffix: "/inference/v1/models", status: 200, body: OC_MODELS },
      { method: "POST", suffix: "/inference/openai/v1/chat/completions", status: 200, body: CHAT_OK },
    ],
    () => testProviderKey("opencode", null, "oc_sk_compteactif"),
  );
  check("[5] opencode compte actif : statut ok", r.status === "ok", JSON.stringify(r));
  check("[5] opencode compte actif : libellé", r.statusLabel === "2 modèles — compte actif", r.statusLabel);
}

// [6] 429 dès la liste des modèles : la raison du corps est traduite.
//     v2.5 : après le 429 de la surface standard, le test essaie l'AUTRE
//     portefeuille z.ai (surface coding) — deux appels, et le verdict
//     reste celui de la première surface quand les deux sont à sec.
{
  const r = await withRoutes(
    [{ method: "GET", suffix: "/models", status: 429, body: ZAI_1113 }],
    () => testProviderKey("z.ai", null, "clevalide.toutrouge"),
  );
  check("[6] 429 sur /models : statut exhausted", r.status === "exhausted", JSON.stringify(r));
  check("[6] 429 sur /models : raison traduite", r.statusLabel === "solde insuffisant (recharge requise)", r.statusLabel);
  check(
    "[6] les DEUX portefeuilles essayés (standard puis coding)",
    calls.length === 2 &&
      calls[0].url.endsWith("/api/paas/v4/models") &&
      calls[1].url.endsWith("/api/coding/paas/v4/models"),
    calls.map((c) => c.url.replace("https://api.z.ai", "")).join(" → "),
  );
}

// [7] Autre fournisseur (OpenRouter) : AUCUNE sonde — zéro risque de dépense
//     (son test connu interroge /api/v1/key, pas /models — public chez eux)
{
  const r = await withRoutes(
    [
      {
        method: "GET",
        suffix: "/api/v1/key",
        status: 200,
        body: { data: { label: "clé perso", usage: 0, limit: null } },
      },
    ],
    () => testProviderKey("OpenRouter", null, "sk-or-123"),
  );
  check("[7] OpenRouter : statut ok", r.status === "ok", JSON.stringify(r));
  check("[7] OpenRouter : libellé simple", r.statusLabel === "connecté", r.statusLabel);
  check("[7] OpenRouter : liste seule, pas de génération", calls.length === 1, `${calls.length} appel(s)`);
}

// [8] Piège z.ai : la sonde répond 200 avec une erreur dans le corps
{
  const r = await withRoutes(
    [
      { method: "GET", suffix: "/api/paas/v4/models", status: 200, body: ZAI_MODELS },
      { method: "POST", suffix: "/api/paas/v4/chat/completions", status: 200, body: ZAI_1113 },
    ],
    () => testProviderKey("z.ai", null, "clevalide.piege200"),
  );
  check("[8] 200-porteur-d'erreur : statut exhausted", r.status === "exhausted", JSON.stringify(r));
  check(
    "[8] 200-porteur-d'erreur : raison traduite",
    r.statusLabel === "clé valide — solde insuffisant (recharge requise)",
    r.statusLabel,
  );
}

// [9] Sonde injoignable → repli honnête sur le verdict de la liste
{
  const r = await withRoutes(
    [
      { method: "GET", suffix: "/api/paas/v4/models", status: 200, body: ZAI_MODELS },
      { method: "POST", suffix: "/api/paas/v4/chat/completions", status: 0, body: null },
    ],
    () => testProviderKey("z.ai", null, "clevalide.sonderombue"),
  );
  check("[9] sonde tombée : repli sur « ok »", r.status === "ok", JSON.stringify(r));
  check("[9] sonde tombée : libellé de repli", r.statusLabel === "3 modèles", r.statusLabel);
}

// [10] Non-régression : 401 sur la liste → « clé refusée »
{
  const r = await withRoutes(
    [{ method: "GET", suffix: "/api/paas/v4/models", status: 401, body: { error: { code: "1001" } } }],
    () => testProviderKey("z.ai", null, "mauvaise.cle"),
  );
  check("[10] 401 : statut error", r.status === "error", JSON.stringify(r));
  check("[10] 401 : libellé", r.statusLabel === "clé refusée", r.statusLabel);
}

// [11] Non-régression : surface Anthropic de z.ai, 200 porteur d'erreur d'auth
{
  const r = await withRoutes(
    [
      {
        method: "GET",
        suffix: "/api/paas/v4/models",
        status: 200,
        body: { code: 401, success: false, msg: "token expired or incorrect" },
      },
    ],
    () => testProviderKey("z.ai", null, "clepiegee.tokengate"),
  );
  check("[11] 200-porteur-401 : statut error", r.status === "error", JSON.stringify(r));
  check("[11] 200-porteur-401 : libellé", r.statusLabel === "clé refusée", r.statusLabel);
}

// [12] explainQuotaError : les trois familles + inconnue + vide
{
  const a = explainQuotaError(JSON.stringify(ZAI_1113));
  check("[12] 1113 → balance", a.kind === "balance" && a.short === "solde insuffisant (recharge requise)");
  const b = explainQuotaError("Free usage limit reached. Free models work in OpenCode");
  check("[12] FreeUsageLimit → free_limit", b.kind === "free_limit");
  const c = explainQuotaError("Too many requests, rate limit exceeded");
  check("[12] débit → rate", c.kind === "rate");
  const d = explainQuotaError("quelque chose d'inattendu");
  check("[12] inconnu → long du fournisseur", d.kind === null && d.long === "quelque chose d'inattendu");
  const e = explainQuotaError("(corps vide)");
  check("[12] vide → limite atteinte", e.kind === null && e.short === "limite atteinte");
}

console.log(
  failures === 0 ? "\nQA 12/12 : le bouton « Tester » dit désormais la vérité." : `\n${failures} échec(s).`,
);
process.exit(failures === 0 ? 0 : 1);
