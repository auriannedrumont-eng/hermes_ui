// Test rapide du pipeline chrome-headless-shell : PNG plein page + PDF
import { chromeRenderer } from "../mini-services/hermes-chat/render";
import { writeFileSync } from "node:fs";

const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Test artefact</title>
<style>
  body { font-family: 'Noto Sans', sans-serif; background: #faf7f2; color: #1a1a1a; padding: 48px; }
  h1 { color: #b3592a; border-bottom: 3px solid #b3592a; padding-bottom: 12px; }
  .cards { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; margin-top: 32px; }
  .card { background: white; border-radius: 14px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,.08); }
  .card h3 { margin: 0 0 8px; font-size: 15px; }
  .card .val { font-size: 30px; font-weight: 700; color: #b3592a; }
  .tall { margin-top: 40px; height: 2200px; background: linear-gradient(#f3e9dd, #e7d9c9); border-radius: 12px; display:flex; align-items:center; justify-content:center; font-size: 22px; color:#8a5a33;}
</style></head>
<body>
<h1>Rapport de ventes — T4 2026</h1>
<p>Document de test du pipeline d'artefacts, page volontairement haute (plein page).</p>
<div class="cards">
  <div class="card"><h3>Chiffre d'affaires</h3><div class="val">1,24 M€</div></div>
  <div class="card"><h3>Nouveaux clients</h3><div class="val">348</div></div>
  <div class="card"><h3>Marge brute</h3><div class="val">42,6 %</div></div>
</div>
<div class="tall">Section longue — doit apparaître en entier dans le PNG plein page</div>
</body></html>`;

const t0 = Date.now();
try {
  const { png, pdf, renderMs } = await chromeRenderer.renderHtml(html);
  writeFileSync("/tmp/test-artifact.png", png);
  writeFileSync("/tmp/test-artifact.pdf", pdf);
  console.log(
    `OK rendu en ${renderMs} ms (total ${Date.now() - t0} ms) — PNG ${png.length} octets, PDF ${pdf.length} octets`
  );
  chromeRenderer.shutdown();
  process.exit(0);
} catch (err) {
  console.error("ÉCHEC :", err instanceof Error ? err.message : err);
  process.exit(1);
}
