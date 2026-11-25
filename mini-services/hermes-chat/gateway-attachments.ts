// C3 (25/11, constat n°3 du plan de correction) — Pièces jointes
// conformes au contrat du moteur : le canonical wire n'accepte en
// prompt.submit que des IMAGES déjà présentes dans le cache de staging
// du profil moteur (session_ingress_media.py : png/jpg/jpeg/gif/webp/
// bmp/tiff, mimes refusés ailleurs). L'ancien code envoyait des chemins
// db/ de l'interface → refus invalid_params systématique.
// Le dépôt passe désormais par le RPC image.attach_bytes (base64 →
// chemin stagé, methods_prompt.py) AVANT la soumission ; une pièce non
// image est refusée AVANT tout envoi, avec un message lisible — le tour
// ne part pas, rien n'atteint le moteur.
import { readFile } from "node:fs/promises";
import { resolve as pathResolve, join } from "node:path";
import type { Attachment } from "./types";

/** Mimes d'images acceptés, mappés vers l'extension hint attendue par
 *  image.attach_bytes. .svg/.ico sont exclus : le pipeline vision de
 *  l'amont ne les envoie pas non plus (browser-uploads.ts amont). */
const IMAGE_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

/** Attachement canonique prêt pour prompt.submit ({path, mime} fermé). */
export interface GatewayWireAttachment {
  path: string;
  mime: string;
}

/** RPC minimal attendu (le framing vit dans le tour, hermes-connector). */
export type AttachRpc = (method: string, params: Record<string, unknown>) => Promise<any>;

/** Dépose UNE image via image.attach_bytes (octets lus depuis db/) et rend
 *  l'attachement canonique {path, mime} — le chemin est celui du cache de
 *  staging DU MOTEUR, pas le nôtre. Appelée APRÈS session.create (le RPC
 *  vit sur la session en main) et AVANT prompt.submit. */
async function stageOneImage(
  rpc: AttachRpc,
  a: Attachment,
  ext: string,
): Promise<GatewayWireAttachment> {
  const localPath = pathResolve(join(import.meta.dir, "..", "..", "db"), a.url.replace(/^\//, ""));
  const bytes = await readFile(localPath);
  const staged = await rpc("image.attach_bytes", {
    content_base64: bytes.toString("base64"),
    filename: a.name || a.url.split("/").pop() || "upload",
    ext,
  });
  const stagedPath = staged?.path;
  if (typeof stagedPath !== "string" || !stagedPath) {
    throw new Error(`image.attach_bytes : aucun chemin retourné pour « ${a.name} »`);
  }
  return { path: stagedPath, mime: a.mime };
}

/** Traduit les pièces persistées du service en attachements canoniques.
 *  Une pièce non image jette une erreur claire AVANT tout envoi : le tour
 *  ne part pas, rien n'atteint le moteur. Budget CRAP du plan : ≤ 8. */
export async function buildGatewayAttachments(
  rpc: AttachRpc,
  uploads: Attachment[] | undefined,
): Promise<GatewayWireAttachment[] | undefined> {
  if (!uploads?.length) return undefined;
  const out: GatewayWireAttachment[] = [];
  for (const a of uploads) {
    const ext = IMAGE_MIME_EXT[(a.mime ?? "").toLowerCase()];
    if (!ext) {
      throw new Error(
        `Pièce « ${a.name} » non envoyée : le moteur Hermes n'accepte que des ` +
          `images (png, jpeg, gif, webp, bmp) en mode agent.`,
      );
    }
    out.push(await stageOneImage(rpc, a, ext));
  }
  return out.length ? out : undefined;
}
