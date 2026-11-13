// Preload de test (bun --preload) : remplace le moteur z-ai par un faux qui
// streame deux deltas puis échoue — simule une erreur LLM en plein tour pour
// valider la branche stream:error (partiel persisté + « Réessayer », F-04).
//
//   bun --preload scripts/fake-zai-error.preload.ts mini-services/hermes-chat/index.ts
//
// N'est JAMAIS chargé en production : usage test uniquement.
// NB : importe la copie du SDK installée DANS le mini-service (node_modules
// dédié) — la copie de la racine est une instance de module distincte.
import ZAI from "../mini-services/hermes-chat/node_modules/z-ai-web-dev-sdk/dist/index.js";

const CHUNKS = [
  'data: {"model":"fake-error-model","choices":[{"delta":{"content":"Début de réponse qui va être interrompue par une erreur simulée "}}]}\n\n',
  'data: {"model":"fake-error-model","choices":[{"delta":{"content":"avec un partiel déjà reçu — le fil doit le conserver."}}]}\n\n',
];

async function* failingStream(): AsyncGenerator<string> {
  for (const c of CHUNKS) {
    yield c;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Erreur simulée du fournisseur LLM (test F-04)");
}

const originalCreate = ZAI.create.bind(ZAI);
ZAI.create = async () => {
  const real = await originalCreate().catch(() => null);
  return {
    ...(real ?? {}),
    chat: {
      ...(real?.chat ?? {}),
      completions: {
        ...(real?.chat?.completions ?? {}),
        create: async () => failingStream(),
      },
    },
  } as any;
};

console.log("[fake-zai-error] preload actif — tout tour LLM échouera après 2 deltas");
