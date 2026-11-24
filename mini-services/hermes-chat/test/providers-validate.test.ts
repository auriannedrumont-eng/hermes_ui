// Tests des validations pures fournisseurs & clés (vague 4, cible C — cf.
// FORK.md §9 du 2026-11-25). Les helpers de providers-validate.ts portent
// la règle « https requis, http strictement local » (une seule vérité pour
// resolveKnownProvider / providers:add / providers:set-base /
// testProviderKey) et les bornes verbatim des handlers ; parseRepoInput
// (providers.ts, export préexistant façon parseModelOptions) est verrouillé
// au même endroit.
import { describe, expect, it } from "vitest";
import {
  checkKeySecret,
  checkProviderBaseUrl,
  isAllowedProviderUrl,
  isLocalHostname,
  isMcpLaunchSource,
  isProviderStrategy,
  resolveExplicitBaseUrl,
  sameAsCanonicalBaseUrl,
} from "../providers-validate";
import { parseRepoInput } from "../providers";

describe("règle https / http-local (isAllowedProviderUrl)", () => {
  it("https passe toujours", () => {
    expect(isAllowedProviderUrl(new URL("https://api.z.ai/api/paas/v4"))).toBe(true);
  });
  it("http passe sur localhost, 127.0.0.1 et [::1] uniquement", () => {
    expect(isAllowedProviderUrl(new URL("http://localhost:11434"))).toBe(true);
    expect(isAllowedProviderUrl(new URL("http://127.0.0.1:8080/v1"))).toBe(true);
    expect(isAllowedProviderUrl(new URL("http://[::1]:3000"))).toBe(true);
    expect(isAllowedProviderUrl(new URL("http://exemple.test"))).toBe(false);
    expect(isAllowedProviderUrl(new URL("http://192.168.1.10:11434"))).toBe(false);
    expect(isLocalHostname("localhost")).toBe(true);
    expect(isLocalHostname("exemple.test")).toBe(false);
  });
});

describe("checkProviderBaseUrl (providers:set-base, refus verbatim)", () => {
  it("accepte https et strippe les slashes finaux", () => {
    expect(checkProviderBaseUrl("https://api.z.ai/api/paas/v4///")).toEqual({
      ok: true,
      url: "https://api.z.ai/api/paas/v4",
    });
  });
  it("accepte http strictement local", () => {
    expect(checkProviderBaseUrl("http://localhost:11434/")).toEqual({
      ok: true,
      url: "http://localhost:11434",
    });
  });
  it("refuse le schéma manquant (message verbatim du handler)", () => {
    expect(checkProviderBaseUrl("api.z.ai")).toEqual({
      ok: false,
      error: "Adresse invalide — elle commence par https://",
    });
  });
  it("refuse http vers le réseau (le test ne sert pas de sonde)", () => {
    expect(checkProviderBaseUrl("http://exemple.test")).toEqual({
      ok: false,
      error: "https requis (http admis sur localhost uniquement)",
    });
  });
  it("refuse une adresse imparsable (message verbatim)", () => {
    expect(checkProviderBaseUrl("https://ex essaie")).toEqual({
      ok: false,
      error: "Adresse invalide",
    });
  });
});

describe("resolveExplicitBaseUrl (providers:add, override silencieux)", () => {
  it("une adresse explicite VALIDE gagne sur la canonique", () => {
    expect(
      resolveExplicitBaseUrl("https://passerelle.entreprise.test/v1", "https://canon.test"),
    ).toBe("https://passerelle.entreprise.test/v1");
  });
  it("une adresse invalide ou hors schéma garde la canonique, sans erreur", () => {
    expect(resolveExplicitBaseUrl("", "https://canon.test")).toBe("https://canon.test");
    expect(resolveExplicitBaseUrl("n'importe quoi", "https://canon.test")).toBe("https://canon.test");
    expect(resolveExplicitBaseUrl("http://exemple.test", "https://canon.test")).toBe("https://canon.test");
  });
  it("sans canonique, la garde s'applique quand même", () => {
    expect(resolveExplicitBaseUrl("https://ok.test", null)).toBe("https://ok.test");
    expect(resolveExplicitBaseUrl("https://impar valable", null)).toBeNull();
  });
});

describe("sameAsCanonicalBaseUrl (providers:add, nullification)", () => {
  it("identique au canon (slashes normés) → null en base", () => {
    expect(sameAsCanonicalBaseUrl("https://api.z.ai/api/paas/v4/", "https://api.z.ai/api/paas/v4")).toBe(true);
  });
  it("différente, ou canon absente → conservée", () => {
    expect(sameAsCanonicalBaseUrl("https://autre.test", "https://api.z.ai/api/paas/v4")).toBe(false);
    expect(sameAsCanonicalBaseUrl("https://autre.test", null)).toBe(false);
    expect(sameAsCanonicalBaseUrl(null, "https://api.z.ai/api/paas/v4")).toBe(false);
  });
});

describe("checkKeySecret (providers:add-key, borne verbatim 8)", () => {
  it("refuse en dessous de 8 caractères (7 → erreur verbatim)", () => {
    expect(checkKeySecret("1234567")).toBe("Clé trop courte");
  });
  it("accepte 8 caractères et plus", () => {
    expect(checkKeySecret("12345678")).toBeNull();
    expect(checkKeySecret("sk-une-cle-complete")).toBeNull();
  });
});

describe("isProviderStrategy (providers:set-strategy, liste verbatim)", () => {
  it("les trois stratégies du pool passent", () => {
    expect(isProviderStrategy("fill_first")).toBe(true);
    expect(isProviderStrategy("round_robin")).toBe(true);
    expect(isProviderStrategy("least_used")).toBe(true);
  });
  it("tout le reste est refusé", () => {
    expect(isProviderStrategy("fill-first")).toBe(false); // tirets, pas underscores
    expect(isProviderStrategy("random")).toBe(false);
    expect(isProviderStrategy("")).toBe(false);
  });
});

describe("isMcpLaunchSource (registry:install, regex verbatim)", () => {
  it("adresse https et commandes de lancement → serveur MCP", () => {
    expect(isMcpLaunchSource("https://mcp.exemple.test/sse")).toBe(true);
    expect(isMcpLaunchSource("npx -y @modelcontextprotocol/server-memory")).toBe(true);
    expect(isMcpLaunchSource("uvx mcp-server-fetch")).toBe(true);
    expect(isMcpLaunchSource("bunx serve")).toBe(true);
    expect(isMcpLaunchSource("node server.js")).toBe(true);
    expect(isMcpLaunchSource("python3 -m serve")).toBe(true);
    expect(isMcpLaunchSource("python -m serve")).toBe(true);
    expect(isMcpLaunchSource("docker run -i mcp/image")).toBe(true);
  });
  it("nom connu ou texte libre → pas MCP", () => {
    expect(isMcpLaunchSource("tavily")).toBe(false);
    expect(isMcpLaunchSource("npm install chose")).toBe(false); // npm hors liste
    expect(isMcpLaunchSource("npxx")).toBe(false); // \b après la liste
  });
});

describe("parseRepoInput (providers.ts, export préexistant)", () => {
  it("https github.com (www, .git, slash final tolérés)", () => {
    expect(parseRepoInput("https://github.com/owner/repo")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseRepoInput("https://www.github.com/owner/repo.git/")).toEqual({ owner: "owner", repo: "repo" });
  });
  it("ssh et forme owner/repo", () => {
    expect(parseRepoInput("git@github.com:owner/repo.git")).toEqual({ owner: "owner", repo: "repo" });
    expect(parseRepoInput("owner/repo")).toEqual({ owner: "owner", repo: "repo" });
  });
  it("hors dépôt GitHub → null", () => {
    expect(parseRepoInput("https://gitlab.com/owner/repo")).toBeNull();
    expect(parseRepoInput("")).toBeNull();
    expect(parseRepoInput("tavily")).toBeNull();
  });
});
