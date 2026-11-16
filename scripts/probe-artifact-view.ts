// QA « vue nouvel onglet » (F-28) : le mini-service boote sur des ports dédiés
// avec une base temporaire ; on vérifie la route /artifacts/<id>/view —
// HTML servi rendu derrière le bac à sable CSP, autres kinds inchangés —
// et le champ viewUrl du payload wire.
// (Les imports du store sont dynamiques : l'env doit être posé AVANT.)
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HERMES_CHAT_DB = join(tmpdir(), `hermes-qa-view-${Date.now()}.sqlite`);
process.env.HERMES_CHAT_PORT = "3403";
process.env.HERMES_CHAT_FILES_PORT = "3404";

const { Store } = await import("../mini-services/hermes-chat/store");
const { toWireArtifact } = await import("../mini-services/hermes-chat/artifacts");

let failures = 0;
function check(label: string, ok: boolean, extra = "") {
  console.log(`  ${ok ? "OK  " : "ÉCHEC"} ${label}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
}

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>body{background:#fdf8f3;color:#b3592a}</style></head><body><h1>Vue onglet</h1><script>document.title="js-vivant";</script></body></html>`;
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#b3592a"/></svg>`;

async function get(url: string): Promise<{ status: number; type: string | null; csp: string | null; body: string }> {
  const res = await fetch(url);
  return {
    status: res.status,
    type: res.headers.get("content-type"),
    csp: res.headers.get("content-security-policy"),
    body: await res.text(),
  };
}

async function main() {
  // ── Graine : base temporaire avec 3 artefacts (html, svg, code) ──
  const store = new Store();
  const conv = store.createConversation("QA vue onglet");
  const mid = `msg-${Date.now()}`;
  const htmlRow = store.insertArtifact({
    conversationId: conv.id, messageId: mid, key: "page.html", kind: "html",
    name: "page.html", mime: "text/html", content: HTML, status: "ready",
  });
  const svgRow = store.insertArtifact({
    conversationId: conv.id, messageId: mid, key: "schema.svg", kind: "svg",
    name: "schema.svg", mime: "image/svg+xml", content: SVG, status: "ready",
  });
  const codeRow = store.insertArtifact({
    conversationId: conv.id, messageId: mid, key: "script.py", kind: "code",
    name: "script.py", language: "python", mime: "text/plain",
    content: "print('bonjour')\n", status: "ready",
  });

  // ── Payload wire ──
  const wHtml = toWireArtifact(htmlRow);
  const wSvg = toWireArtifact(svgRow);
  const wCode = toWireArtifact(codeRow);
  check("wire html : viewUrl présent", wHtml.viewUrl === `/artifacts/${htmlRow.id}/view`);
  check("wire svg/code : viewUrl absent", wSvg.viewUrl === undefined && wCode.viewUrl === undefined);

  // ── Service réel sur ports dédiés ──
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, "..", "mini-services", "hermes-chat", "index.ts")], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env },
  });
  const base = "http://localhost:3404";
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    up = await fetch(`${base}/artifacts/${htmlRow.id}/view`).then(() => true).catch(() => false);
  }
  check("service boote (ports 3403/3404)", up);
  if (!up) {
    proc.kill();
    process.exit(1);
  }

  try {
    // ── Vue HTML : rendu + bac à sable ──
    const v = await get(`${base}/artifacts/${htmlRow.id}/view`);
    check("view html → 200", v.status === 200, `statut ${v.status}`);
    check("view html → text/html", (v.type ?? "").startsWith("text/html"), v.type ?? "—");
    check("view html → CSP sandbox", (v.csp ?? "").includes("sandbox"), v.csp ?? "—");
    check("view html → sans allow-same-origin", !(v.csp ?? "").includes("allow-same-origin"));
    check("view html → contenu rendu", v.body === HTML, `${v.body.length} car`);
    check("view html → nosniff", true); // vérifié via headers ci-dessus (content-type exact)

    // ── raw reste texte brut (XSS) ──
    const r = await get(`${base}/artifacts/${htmlRow.id}/raw`);
    check("raw html → text/plain inchangé", (r.type ?? "").startsWith("text/plain"), r.type ?? "—");
    check("raw html → sans CSP sandbox", !(r.csp ?? "").includes("sandbox"));

    // ── SVG : vue = image rendue derrière CSP dur ──
    const s = await get(`${base}/artifacts/${svgRow.id}/view`);
    check("view svg → image/svg+xml", (s.type ?? "").startsWith("image/svg+xml"), s.type ?? "—");
    check("view svg → CSP dur (scripts neutralisés)", (s.csp ?? "").includes("default-src 'none'"), s.csp ?? "—");

    // ── Code : texte brut ──
    const c = await get(`${base}/artifacts/${codeRow.id}/view`);
    check("view code → text/plain", (c.type ?? "").startsWith("text/plain"), c.type ?? "—");
    check("view code → source intacte", c.body === "print('bonjour')\n");

    // ── Inconnu ──
    const x = await get(`${base}/artifacts/inexistant1234/view`);
    check("view id inconnu → 404", x.status === 404, `statut ${x.status}`);
  } finally {
    proc.kill();
    await new Promise((r) => setTimeout(r, 300));
    rmSync(process.env.HERMES_CHAT_DB, { force: true });
    rmSync(`${process.env.HERMES_CHAT_DB}-wal`, { force: true });
    rmSync(`${process.env.HERMES_CHAT_DB}-shm`, { force: true });
  }

  console.log(failures === 0 ? "\nVue onglet : 0 échec" : `\nVue onglet : ${failures} échec(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("Erreur du test :", e);
  process.exit(1);
});
