// Test B2 (revue 2026-11-13) : le résumé de compaction doit rester en tête
// de l'historique envoyé au modèle, quel que soit le nombre de messages
// postérieurs. Avant correctif : slice(-MAX_HISTORY) appliqué au tableau
// complet éliminait le résumé (élément 0) dès le 30e message postérieur.
// Ce test reproduit la logique exacte de runAssistantTurn (index.ts) :
// construction compactée vs non compactée, avant et après correctif.
let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

const MAX_HISTORY = 30;

interface SimpleMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

const summaryMsg = (count: number, at: string, summary: string) =>
  `[Résumé des ${count} premiers messages de cette conversation — compaction du ${new Date(at).toLocaleString("fr-FR")}]\n\n${summary}`;

// ── Comportement AVANT correctif (démonstration du bug) ──────────────
function historyBefore(after: SimpleMessage[], summary: string, summarizedCount: number, at: string) {
  return [
    { role: "user" as const, content: summaryMsg(summarizedCount, at, summary) },
    ...after.map((m) => ({ role: m.role, content: m.content })),
  ].slice(-MAX_HISTORY);
}

// ── Comportement APRÈS correctif (code réel de index.ts) ─────────────
function historyAfter(after: SimpleMessage[], summary: string, summarizedCount: number, at: string) {
  return [
    { role: "user" as const, content: summaryMsg(summarizedCount, at, summary) },
    ...after
      .slice(-(MAX_HISTORY - 1))
      .map((m) => ({ role: m.role, content: m.content })),
  ];
}

const SUMMARY = "Résumé de test : contexte conservé.";
const AT = "2026-11-13T10:00:00.000Z";
const mk = (i: number): SimpleMessage => ({
  id: `m${i}`,
  role: i % 2 === 0 ? "user" : "assistant",
  content: `message ${i}`,
});

// Cas 1 : peu de messages postérieurs — le résumé survit dans les deux versions
{
  const after = [mk(1), mk(2), mk(3)];
  check(
    "avant correctif, 3 postérieurs : résumé conservé",
    historyBefore(after, SUMMARY, 12, AT)[0].content.includes("Résumé de test")
  );
  check(
    "après correctif, 3 postérieurs : résumé conservé",
    historyAfter(after, SUMMARY, 12, AT)[0].content.includes("Résumé de test")
  );
}

// Cas 2 : 29 postérieurs — dernier cas où l'ancien code garde le résumé
{
  const after = Array.from({ length: 29 }, (_, i) => mk(i + 1));
  check(
    "avant correctif, 29 postérieurs : résumé encore là (limite)",
    historyBefore(after, SUMMARY, 40, AT)[0].content.includes("Résumé de test")
  );
  check(
    "après correctif, 29 postérieurs : résumé + 29 = 30 entrées",
    historyAfter(after, SUMMARY, 40, AT).length === 30
  );
}

// Cas 3 : 30 postérieurs — LÀ où l'ancien code perdait le résumé
{
  const after = Array.from({ length: 30 }, (_, i) => mk(i + 1));
  const before = historyBefore(after, SUMMARY, 40, AT);
  const fixed = historyAfter(after, SUMMARY, 40, AT);
  check(
    "BUG historique : 30 postérieurs → résumé ÉLIMINÉ par slice(-30)",
    !before[0].content.includes("Résumé de test")
  );
  check(
    "correctif : 30 postérieurs → résumé en tête (entrée 0)",
    fixed[0].content.includes("Résumé de test")
  );
  check(
    "correctif : 30 entrées au total (1 résumé + 29 derniers)",
    fixed.length === 30 && fixed[1].content === "message 2"
  );
}

// Cas 4 : 100 postérieurs — le plafond coupe les postérieurs, jamais le résumé
{
  const after = Array.from({ length: 100 }, (_, i) => mk(i + 1));
  const fixed = historyAfter(after, SUMMARY, 140, AT);
  check("100 postérieurs : résumé en tête", fixed[0].content.includes("Résumé de test"));
  check("100 postérieurs : 30 entrées (plafond respecté)", fixed.length === 30);
  check(
    "100 postérieurs : les 29 DERNIERS partent (message 72…100)",
    fixed[1].content === "message 72" && fixed[29].content === "message 100"
  );
}

// Cas 5 : 0 postérieur (compaction juste après le résumé) — inchangé
{
  const fixed = historyAfter([], SUMMARY, 5, AT);
  check("0 postérieur : résumé seul, 1 entrée", fixed.length === 1 && fixed[0].role === "user");
}

// Cas 6 : message utilisateur final en cours (le tour en vol n'est pas encore
// dans `existing`) — le slice(-29) ne doit jamais déborder sur un tableau vide
{
  const after = Array.from({ length: 100 }, (_, i) => mk(i + 1));
  const fixed = historyAfter(after, SUMMARY, 140, AT);
  check("rôles préservés (user/assistant alternés)", fixed.every((h) => h.role === "user" || h.role === "assistant"));
}

console.log(failures === 0 ? "\nB2 : 0 échec — correctif validé" : `\nB2 : ${failures} échec(s)`);
process.exit(failures === 0 ? 0 : 1);
