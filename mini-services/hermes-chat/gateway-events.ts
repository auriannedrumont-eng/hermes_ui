// C5 (25/11) — Réduction des événements de tour : la chaîne if/else du
// onEvent d'origine (delta, raisonnement, outils, statut, complétion,
// erreur) vit ici, séparée du framing et du canal. Le sink ACCUMULE le
// contenu et le raisonnement, tient les outils ouverts (loi du fil
// propre 24/11 : seul le couple tool.start → tool.complete crée/ferme
// une carte) et rend un verdict par trame — le tour (gateway-turn.ts)
// n'a plus qu'à régler sa promesse sur le verdict.
import type { TurnCallbacks } from "./local-engine";

export type EventVerdict = "live" | "complete" | "error";

/** Callbacks strictement nécessaires au sink (le tour garde l'abort). */
export type SinkCallbacks = Pick<
  TurnCallbacks,
  "onDelta" | "onReasoning" | "onStatus" | "onToolEvent"
>;

export class TurnEventSink {
  content = "";
  reasoning = "";
  private endedProperly = false;
  private finalError: Error | null = null;
  private readonly openTools = new Set<string>();

  constructor(private readonly cb: SinkCallbacks) {}

  get ended(): boolean {
    return this.endedProperly;
  }

  get error(): Error | null {
    return this.finalError;
  }

  /** Traite UNE trame d'événement (params de la notification `event`).
   *  Le signal d'abort est déjà filtré en amont : le sink ne voit que
   *  des trames d'un tour vivant. Budget CRAP du plan : ≤ 20. */
  handle(params: unknown): EventVerdict {
    const p = (params ?? {}) as any;
    const evt = String(p?.type ?? "");
    const payload = p?.payload ?? {};
    if (evt === "message.delta" || evt === "reasoning.delta" || evt === "thinking.delta") {
      this.onTextFrame(evt, payload);
      return "live";
    }
    if (evt.startsWith("tool.")) {
      this.onToolFrame(evt, payload);
      return "live";
    }
    if (evt === "status.update") {
      this.onStatusFrame(payload);
      return "live";
    }
    if (evt === "message.complete") {
      this.onCompleteFrame(payload);
      return "complete";
    }
    if (evt === "error") {
      this.finalError = new Error(String(payload?.error ?? payload?.message ?? "Erreur gateway"));
      return "error";
    }
    return "live";
  }

  /** Statut textuel du moteur (libellé amont, repli générique). */
  private onStatusFrame(payload: any): void {
    this.cb.onStatus(String(payload?.text ?? payload?.status ?? "Hermes travaille…"));
  }

  /** message.delta (contenu) et reasoning/thinking.delta (raisonnement) :
   *  accumulation + callback, uniquement si le texte est non vide. */
  private onTextFrame(evt: string, payload: any): void {
    const text = payload?.text;
    if (typeof text !== "string" || !text) return;
    if (evt === "message.delta") {
      this.content += text;
      this.cb.onDelta(text);
    } else {
      this.reasoning += text;
      this.cb.onReasoning(text);
    }
  }

  /** Texte final autoritaire + filet outils : tout outil resté
   *  « running » (complete perdu) est clos — le fil ne garde AUCUN
   *  spinner après la réponse livrée. */
  private onCompleteFrame(payload: any): void {
    this.closeOpenTools();
    const finalText = payload?.text ?? payload?.content;
    if (typeof finalText === "string" && finalText) this.content = finalText;
    this.endedProperly = true;
  }

  private onToolFrame(evt: string, payload: any): void {
    // Loi du fil propre (24/11) : SEUL le couple tool.start →
    // tool.complete crée/ferme une carte. Les autres variantes
    // (tool.generating, tool.progress, tool.output_risk) sont des
    // signaux intermédiaires : les transformer en cartes créait des
    // spinners JAMAIS fermés après la réponse livrée.
    if (evt !== "tool.start" && evt !== "tool.complete") return;
    const toolName = String(payload?.name ?? payload?.tool ?? "outil");
    if (evt === "tool.complete") this.openTools.delete(toolName);
    else this.openTools.add(toolName);
    this.cb.onToolEvent({
      name: toolName,
      status: evt === "tool.complete" ? "done" : "running",
      detail: payload?.summary ?? payload?.preview,
    });
  }

  closeOpenTools(): void {
    for (const name of this.openTools) this.cb.onToolEvent({ name, status: "done" });
    this.openTools.clear();
  }
}
