// Validations pures des fournisseurs & clés (vague 4, audit CRAP 2026-11 —
// cible C, cf. FORK.md §9) : la règle « https requis, http strictement local »
// vivait en QUATRE copies (resolveKnownProvider, providers:add,
// providers:set-base, testProviderKey) — une seule vérité ici, testée par
// Vitest (façon parseModelOptions : des exports suffisent). Les messages
// d'erreur sont identiques octet par octet aux messages d'origine des
// handlers ; aucun changement du protocole socket.

/** Boucle locale : la seule exception au https obligatoire (Ollama & co). */
export function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** La garde commune aux quatre anciennes copies : https, ou http sur la
 *  boucle locale uniquement. Le test de clé ne doit pas servir de sonde. */
export function isAllowedProviderUrl(u: URL): boolean {
  return u.protocol === "https:" || (u.protocol === "http:" && isLocalHostname(u.hostname));
}

/** Résultat de validation d'une adresse de fournisseur. */
export type BaseUrlCheck = { ok: true; url: string } | { ok: false; error: string };

/** providers:set-base — adresse explicite OBLIGATOIRE : trois refus verbatim
 *  (schéma manquant, protocole interdit, parse impossible) ; au succès,
 *  slashes finaux supprimés — la valeur stockée d'origine. */
export function checkProviderBaseUrl(raw: string): BaseUrlCheck {
  if (!/^https?:\/\//i.test(raw)) {
    return { ok: false, error: "Adresse invalide — elle commence par https://" };
  }
  try {
    const u = new URL(raw);
    if (!isAllowedProviderUrl(u)) {
      return { ok: false, error: "https requis (http admis sur localhost uniquement)" };
    }
  } catch {
    return { ok: false, error: "Adresse invalide" };
  }
  return { ok: true, url: raw.replace(/\/+$/, "") };
}

/** providers:add — adresse explicite OPTIONNELLE : si elle passe la même
 *  garde, elle gagne sur l'adresse canonique (passerelle d'entreprise,
 *  bascule z.ai vers la surface coding) ; sinon — vide, hors schéma,
 *  invalide — la canonique est conservée SANS erreur (comportement d'origine,
 *  silencieux). v2.5 : une adresse avec chemin est la base COMPLÈTE. */
export function resolveExplicitBaseUrl(explicit: string, fallback: string | null): string | null {
  if (explicit && /^https?:\/\//i.test(explicit)) {
    try {
      if (isAllowedProviderUrl(new URL(explicit))) {
        return explicit.replace(/\/+$/, "");
      }
    } catch {
      /* adresse invalide : adresse canonique conservée */
    }
  }
  return fallback;
}

/** providers:add — une adresse identique au canon (slashes normés) se stocke
 *  null : l'adresse canonique reste la référence et les surfaces de TEST
 *  propres à certains fournisseurs (opencode) sont préservées. */
export function sameAsCanonicalBaseUrl(
  baseUrl: string | null,
  canonicalDefault: string | null,
): boolean {
  return Boolean(
    canonicalDefault &&
      baseUrl &&
      baseUrl.replace(/\/+$/, "") === canonicalDefault.replace(/\/+$/, ""),
  );
}

/** providers:add-key — longueur minimale du secret (verbatim : 8). */
export function checkKeySecret(secret: string): string | null {
  return secret.length < 8 ? "Clé trop courte" : null;
}

/** providers:set-strategy — stratégie bornée (verbatim : la liste `ok`). */
export function isProviderStrategy(strategy: string): boolean {
  return ["fill_first", "round_robin", "least_used"].includes(strategy);
}

/** registry:install — l'entrée collée devient un serveur MCP quand c'est une
 *  adresse https OU une commande de lancement (verbatim : les deux regex). */
export function isMcpLaunchSource(raw: string): boolean {
  return /^https?:\/\//i.test(raw) || /^(npx|uvx|bunx|node|python3?|docker)\b/i.test(raw);
}
