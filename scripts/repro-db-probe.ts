// Sonde DB du repro live (25/11) : statut des artefacts après stop en
// pleine génération — la carte doit être ready/rendering (partiel), JAMAIS
// error « Génération interrompue ». (bun:sqlite, même driver que le service.)
import { Database } from "bun:sqlite";
const db = new Database("/tmp/repro-db/hermes.sqlite");
const rows = db
  .prepare(
    "SELECT version, status, status_label, error, length(content) AS len FROM artifacts ORDER BY id DESC LIMIT 5"
  )
  .all();
console.log(JSON.stringify(rows, null, 1));
