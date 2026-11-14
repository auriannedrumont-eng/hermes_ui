// Test unitaire de la décision de compaction automatique (v2.4) —
// src/lib/compaction.ts est une lib pure : testable sans navigateur ni
// service. Couvre bornes du seuil, refus des fils trop courts, frontière
// exacte du pourcentage et garde-fous (fenêtre nulle, valeurs absurdes).
import {
  shouldAutoCompact,
  clampCompactThreshold,
  MIN_MESSAGES_FOR_AUTO_COMPACT,
  COMPACT_THRESHOLD_DEFAULT,
  COMPACT_THRESHOLD_MIN,
  COMPACT_THRESHOLD_MAX,
} from "../src/lib/compaction";

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK" : "ÉCHEC"}  ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

function main() {
  console.log("— clampCompactThreshold —");
  check("null → défaut 80", clampCompactThreshold(null) === 80);
  check("undefined → défaut 80", clampCompactThreshold(undefined) === 80);
  check("NaN → défaut 80", clampCompactThreshold(NaN) === 80);
  check("sous la borne → 50", clampCompactThreshold(10) === COMPACT_THRESHOLD_MIN);
  check("au-dessus de la borne → 95", clampCompactThreshold(120) === COMPACT_THRESHOLD_MAX);
  check("dans les bornes → intact", clampCompactThreshold(75) === 75);
  check("arrondi", clampCompactThreshold(82.4) === 82);
  check("constantes cohérentes",
    COMPACT_THRESHOLD_MIN === 50 && COMPACT_THRESHOLD_MAX === 95 && COMPACT_THRESHOLD_DEFAULT === 80);

  console.log("— shouldAutoCompact : refus —");
  const base = {
    enabled: true,
    thresholdPct: 80,
    windowTokens: 1000,
    usedTokens: 850,
    messageCount: 10,
  };
  check("désactivé → jamais", shouldAutoCompact({ ...base, enabled: false }) === false);
  check(
    `fil trop court (< ${MIN_MESSAGES_FOR_AUTO_COMPACT}) → non`,
    shouldAutoCompact({ ...base, messageCount: 3, usedTokens: 999 }) === false
  );
  check("fil à la limite court inclus → oui",
    shouldAutoCompact({ ...base, messageCount: MIN_MESSAGES_FOR_AUTO_COMPACT }) === true);
  check("sous le seuil → non", shouldAutoCompact({ ...base, usedTokens: 799 }) === false);
  check("fenêtre nulle → non", shouldAutoCompact({ ...base, windowTokens: 0 }) === false);
  check("fenêtre négative → non", shouldAutoCompact({ ...base, windowTokens: -5 }) === false);
  check("usage nul → non", shouldAutoCompact({ ...base, usedTokens: 0 }) === false);

  console.log("— shouldAutoCompact : frontières —");
  check("exactement 80 % → oui (≥, pas >)", shouldAutoCompact({ ...base, usedTokens: 800 }) === true);
  check("79,9 % → non", shouldAutoCompact({ ...base, usedTokens: 799.4 }) === false);
  check("seuil 50 appliqué", shouldAutoCompact({ ...base, thresholdPct: 50, usedTokens: 501 }) === true);
  check("seuil absurde (30) borné à 50 : 40 % → non",
    shouldAutoCompact({ ...base, thresholdPct: 30, usedTokens: 400 }) === false);
  check("seuil absurde (30) borné à 50 : 60 % → oui",
    shouldAutoCompact({ ...base, thresholdPct: 30, usedTokens: 600 }) === true);

  console.log(failures === 0 ? "TOUS OK — compaction (unitaire)" : `${failures} ÉCHEC(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
