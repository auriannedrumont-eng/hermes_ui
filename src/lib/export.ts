// Export d'une conversation : Markdown, JSON et PDF (impression navigateur).
import { serviceUrl } from "@/lib/service";
import type { ChatMessage, ConversationMeta } from "@/lib/chat-types";

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "conversation"
  );
}

/** Construit le Markdown complet d'une conversation. */
export function conversationToMarkdown(
  conversation: ConversationMeta,
  messages: ChatMessage[]
): string {
  const lines: string[] = [
    `# ${conversation.title}`,
    "",
    `> Exporté de Hermes Web le ${new Date().toLocaleString("fr-FR")} · ${messages.length} message(s)`,
    "",
    "---",
    "",
  ];
  for (const m of messages) {
    if (m.role === "user") {
      lines.push(`## Vous`, "", m.content || "*(message vide)*", "");
      if (m.attachments?.length) {
        for (const a of m.attachments) {
          lines.push(`- [${a.name}](${serviceUrl(a.url)}) (${a.kind}, ${a.size} o)`);
        }
        lines.push("");
      }
    } else {
      lines.push(
        `## Hermes${m.model ? ` — ${m.model}` : ""}`,
        "",
        m.content || "*(réponse vide)*",
        ""
      );
      if (m.toolEvents?.length) {
        lines.push(
          `Outils utilisés : ${m.toolEvents.map((t) => `\`${t.name}\``).join(", ")}`,
          ""
        );
      }
    }
    lines.push("---", "");
  }
  return lines.join("\n");
}

/** Télécharge un contenu textuel en fichier. */
export function downloadTextFile(content: string, filename: string, mime: string): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/** Exporte la conversation en fichier Markdown. */
export function exportMarkdown(conversation: ConversationMeta, messages: ChatMessage[]): void {
  downloadTextFile(
    conversationToMarkdown(conversation, messages),
    `hermes-${slugify(conversation.title)}.md`,
    "text/markdown"
  );
}

/** Exporte la conversation en fichier JSON (structure complète). */
export function exportJson(conversation: ConversationMeta, messages: ChatMessage[]): void {
  downloadTextFile(
    JSON.stringify({ conversation, messages }, null, 2),
    `hermes-${slugify(conversation.title)}.json`,
    "application/json"
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Exporte la conversation en PDF via la boîte d'impression du navigateur. */
export function exportPdf(conversation: ConversationMeta, messages: ChatMessage[]): void {
  const parts: string[] = [];
  for (const m of messages) {
    const who = m.role === "user" ? "Vous" : `Hermes${m.model ? ` — ${m.model}` : ""}`;
    const cls = m.role === "user" ? "user" : "bot";
    let body = `<pre>${escapeHtml(m.content)}</pre>`;
    if (m.attachments?.length) {
      body += `<ul class="atts">${m.attachments
        .map((a) => `<li>${escapeHtml(a.name)} (${a.kind})</li>`)
        .join("")}</ul>`;
    }
    parts.push(`<div class="msg ${cls}"><div class="who">${escapeHtml(who)}</div>${body}</div>`);
  }
  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>${escapeHtml(conversation.title)}</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; margin: 40px auto; max-width: 720px; color: #1a1a1a; line-height: 1.55; }
  h1 { font-size: 22px; border-bottom: 2px solid #b3592a; padding-bottom: 8px; }
  .meta { color: #666; font-size: 12px; margin-bottom: 24px; }
  .msg { margin: 18px 0; page-break-inside: avoid; }
  .who { font-weight: bold; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
  .msg.user .who { color: #b3592a; }
  .msg.bot .who { color: #555; }
  pre { font-family: inherit; white-space: pre-wrap; margin: 0; font-size: 14px; }
  .atts { font-size: 12px; color: #666; margin: 6px 0 0; padding-left: 18px; }
  @media print { body { margin: 12mm; } }
</style></head><body>
<h1>${escapeHtml(conversation.title)}</h1>
<p class="meta">Hermes Web · ${messages.length} message(s) · exporté le ${new Date().toLocaleString("fr-FR")}</p>
${parts.join("\n")}
</body></html>`;
  const win = window.open("", "_blank", "width=800,height=900");
  if (!win) return;
  win.document.write(html);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 350);
}
