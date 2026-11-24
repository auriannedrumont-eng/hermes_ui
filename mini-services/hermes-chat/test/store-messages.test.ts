// Tests du store — vague 4, « Store jetable » (cf. FORK.md §9 du 2026-11-25).
// Les MÊMES builders que le service de production (store-messages.ts, corps
// VERBATIM) tournent sur un MemoryStore : SQLite réel (node:sqlite) en
// mémoire. Couverture visée : machine de versions F-14
// (buildMessageVersionsMethods, CC 73) et CRUD/modes
// (buildConversationMethods, CC 40).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../store-memory";
import type { ChatMessage, ConversationMeta } from "../types";
import type { ConversationMode, ModeConfig } from "../modes";
import type { Attachment } from "../shared/chat-protocol";

let store: MemoryStore;

beforeEach(() => {
  store = new MemoryStore();
});

afterEach(() => {
  store.close();
});

// Horodatages distincts et croissants — l'ordre du fil (created_at ASC)
// et les « dernier message » doivent être déterministes.
let tick = 0;
const iso = () => new Date(Date.UTC(2026, 10, 25, 10, 0, 0, tick++)).toISOString();

function addUser(conv: string, content: string): ChatMessage {
  return store.appendMessage({ conversationId: conv, role: "user", content, createdAt: iso() });
}

function addAssistant(
  conv: string,
  content: string,
  opts: Partial<Pick<ChatMessage, "variant">> & {
    versionGroup?: string;
    versionIndex?: number;
    versionActive?: number;
    attachments?: Attachment[];
  } = {},
): ChatMessage {
  return store.appendMessage({
    conversationId: conv,
    role: "assistant",
    content,
    createdAt: iso(),
    ...opts,
  });
}

function row(sql: string, ...params: (string | number | null)[]): Record<string, unknown> | undefined {
  return store.db.query(sql).get(...params) as Record<string, unknown> | undefined;
}

function scalar(sql: string, ...params: (string | number | null)[]): number {
  const r = store.db.query(sql).get(...params) as { n?: number } | undefined;
  return r?.n ?? 0;
}

const att = (id: string): Attachment => ({
  id,
  name: `${id}.png`,
  mime: "image/png",
  size: 3,
  kind: "image",
  url: `/uploads/${id}.png`,
});

/** Fil de référence : user + une réponse a1 — la base des régénérations. */
function seededTurn(): { conv: ConversationMeta; u1: ChatMessage; a1: ChatMessage } {
  const conv = store.createConversation("Fil de test");
  const u1 = addUser(conv.id, "première question");
  const a1 = addAssistant(conv.id, "première réponse");
  return { conv, u1, a1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildConversationMethods — CRUD, modes (F-30), sessions moteur, épinglage
// ─────────────────────────────────────────────────────────────────────────────
describe("CRUD conversations (buildConversationMethods)", () => {
  it("createConversation pose les valeurs par défaut (mode chat, sans projet)", () => {
    const conv = store.createConversation("Bonjour");
    expect(conv.title).toBe("Bonjour");
    expect(conv.mode).toBe("chat");
    expect(conv.modeRounds).toBeNull();
    expect(conv.modeConfig).toBeNull();
    expect(conv.projectId).toBeNull();
    expect(conv.messageCount).toBe(0);
    expect(conv.preview).toBe("");
    expect(conv.pinned).toBeUndefined(); // non posé à la création — la liste le calcule
    expect(row("SELECT mode, mode_rounds, mode_config FROM conversations WHERE id = ?", conv.id))
      .toMatchObject({ mode: null, mode_rounds: null, mode_config: null });
  });

  it("createConversation rattache le projet S'IL existe réellement", () => {
    const p = store.createProject("Dossier");
    const inside = store.createConversation("dedans", p.id);
    const ghost = store.createConversation("projet fantôme", "id-inconnu");
    expect(inside.projectId).toBe(p.id);
    expect(ghost.projectId).toBeNull();
  });

  it("getConversation compte les versions ACTIVES seulement (F-14)", () => {
    const { conv, a1 } = seededTurn();
    store.supersedeTrailingAssistant(conv.id); // a1 → inactive
    addAssistant(conv.id, "réponse régénérée", { versionGroup: a1.id, versionIndex: 2 });
    const meta = store.getConversation(conv.id)!;
    expect(meta.messageCount).toBe(2); // u1 + v2 (a1 inactive exclue)
    expect(store.countVersions(a1.id)).toBe(2); // le groupe, lui, compte les 2 lignes
  });

  it("getConversation renvoie le VRAI aperçu du dernier message utilisateur, tronqué à 90", () => {
    const conv = store.createConversation("Aperçu");
    addUser(conv.id, "x".repeat(120));
    addUser(conv.id, "dernier " + "y".repeat(120));
    const meta = store.getConversation(conv.id)!;
    expect(meta.preview).toBe("dernier " + "y".repeat(120).slice(0, 90 - "dernier ".length));
    expect(meta.preview.length).toBe(90);
    expect(meta.messageCount).toBe(2);
  });

  it("getConversation sur un id inconnu → null", () => {
    expect(store.getConversation("inconnu")).toBeNull();
  });

  it("renameConversation met à jour titre et updated_at ; inconnu → null", () => {
    const conv = store.createConversation("Avant");
    const renamed = store.renameConversation(conv.id, "Après");
    expect(renamed).not.toBeNull();
    expect(renamed!.title).toBe("Après");
    expect(store.listConversations().find((c) => c.id === conv.id)!.title).toBe("Après");
    expect(store.renameConversation("inconnu", "x")).toBeNull();
  });

  it("setConversationMode + getConversationModeState : aller-retour complet (F-30)", () => {
    const conv = store.createConversation("Modes");
    const config: ModeConfig = { debateParallel: true, rounds: 4 };
    const updated = store.setConversationMode(conv.id, "debate", 4, config);
    expect(updated!.mode).toBe("debate");
    expect(updated!.modeRounds).toBe(4);
    const state = store.getConversationModeState(conv.id);
    expect(state.mode).toBe("debate");
    expect(state.rounds).toBe(4);
    expect(state.config).toEqual(config);
  });

  it("mode inconnu en base → résolu « chat » dans l'état, brut dans la conversation", () => {
    const conv = store.createConversation("Mode corrompu");
    store.setConversationMode(conv.id, "inconnu-x" as ConversationMode, null, null);
    const state = store.getConversationModeState(conv.id);
    expect(state.mode).toBe("chat"); // resolveMode protège l'état consommé
    // getConversation rend la valeur BRUTE stockée (le front résout lui-même) :
    expect(store.getConversation(conv.id)!.mode).toBe("inconnu-x");
  });

  it("modeConfig vide → null en base ; config non vide → objet relu", () => {
    const conv = store.createConversation("Config");
    store.setConversationMode(conv.id, "plan", null, {});
    expect(row("SELECT mode_config FROM conversations WHERE id = ?", conv.id)!.mode_config).toBeNull();
    expect(store.getConversationModeState(conv.id).config).toBeNull();
    const config: ModeConfig = { members: 3 };
    store.setConversationMode(conv.id, "council", null, config);
    expect(store.getConversationModeState(conv.id).config).toEqual(config);
  });

  it("setConversationMode sur une conversation inconnue → null", () => {
    expect(store.setConversationMode("inconnu", "chat", null, null)).toBeNull();
  });

  it("liaison session moteur : null tant que non posée, puis id persisté (75)", () => {
    const conv = store.createConversation("Sessions");
    expect(store.getConversationMotorSession(conv.id)).toBeNull();
    store.setConversationMotorSession(conv.id, "ui-" + conv.id);
    expect(store.getConversationMotorSession(conv.id)).toBe("ui-" + conv.id);
  });

  it("getConversationModeState sur une conversation inconnue → état par défaut", () => {
    const state = store.getConversationModeState("inconnu");
    expect(state.mode).toBe("chat"); // r?.mode ?? "chat"
    expect(state.rounds).toBeNull();
    expect(state.config).toBeNull();
  });

  it("setPinned épingle en tête de liste ; inconnu → null", () => {
    const c1 = store.createConversation("ancienne");
    const c2 = store.createConversation("récente");
    store.db.query("UPDATE conversations SET updated_at = ? WHERE id = ?").run("2026-11-25T10:00:05.000Z", c1.id);
    store.db.query("UPDATE conversations SET updated_at = ? WHERE id = ?").run("2026-11-25T10:00:10.000Z", c2.id);
    expect(store.listConversations().map((c) => c.id)).toEqual([c2.id, c1.id]); // updated_at DESC
    expect(store.setPinned(c1.id, true)!.pinned).toBe(true);
    expect(store.listConversations().map((c) => c.id)).toEqual([c1.id, c2.id]); // pinned DESC
    expect(store.setPinned(c1.id, false)!.pinned).toBe(false);
    expect(store.setPinned("inconnu", true)).toBeNull();
  });

  it("touchConversation sans titre ne touche que updated_at ; avec titre, change le titre", () => {
    const conv = store.createConversation("Titre initial");
    const touched = store.touchConversation(conv.id);
    expect(touched!.title).toBe("Titre initial");
    expect(touched!.updatedAt >= conv.updatedAt).toBe(true);
    const retitled = store.touchConversation(conv.id, "Nouveau titre");
    expect(retitled!.title).toBe("Nouveau titre");
    expect(store.getConversation(conv.id)!.title).toBe("Nouveau titre");
    expect(store.touchConversation("inconnu")).toBeNull();
  });

  it("listConversations : messageCount, preview et modeConfig de chaque ligne", () => {
    const conv = store.createConversation("Liste", null, "plan", 3, { rounds: 3 });
    addUser(conv.id, "question listée");
    addAssistant(conv.id, "réponse listée");
    const entry = store.listConversations().find((c) => c.id === conv.id)!;
    expect(entry.messageCount).toBe(2);
    expect(entry.preview).toBe("question listée");
    expect(entry.mode).toBe("plan");
    expect(entry.modeRounds).toBe(3);
    expect(entry.modeConfig).toEqual({ rounds: 3 });
  });

  it("listConversations : aperçu vide pour une conversation sans message utilisateur", () => {
    const conv = store.createConversation("Sans user");
    addAssistant(conv.id, "réponse seule");
    const entry = store.listConversations().find((c) => c.id === conv.id)!;
    expect(entry.preview).toBe(""); // (r.preview ?? "") — LEFT JOIN sans user
    expect(entry.messageCount).toBe(1);
  });

  it("deleteConversation emporte TOUT ce qui vit pour elle (D-02) en un acte", () => {
    const conv = store.createConversation("À supprimer");
    const u1 = addUser(conv.id, "question");
    const a1 = addAssistant(conv.id, "réponse");
    store.db
      .query(
        "INSERT INTO artifacts (id, conversation_id, message_id, key, version, kind, name, mime, content, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run("art-1", conv.id, a1.id, "cle", 1, "code", "a.py", "text/x-python", "print(1)", 8, iso());
    store.db
      .query(
        "INSERT INTO system_prompts (id, scope, conversation_id, title, content, created_at, updated_at) VALUES (?, 'conversation', ?, ?, ?, ?, ?)",
      )
      .run("sp-1", conv.id, "titre", "prompt dédié", iso(), iso());
    store.db
      .query("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)")
      .run(`compact:${conv.id}`, "résumé de compaction", iso());

    store.deleteConversation(conv.id);

    expect(store.getConversation(conv.id)).toBeNull();
    expect(store.getMessages(conv.id)).toEqual([]);
    expect(scalar("SELECT COUNT(*) AS n FROM artifacts WHERE conversation_id = ?", conv.id)).toBe(0);
    expect(scalar("SELECT COUNT(*) AS n FROM system_prompts WHERE conversation_id = ?", conv.id)).toBe(0);
    expect(scalar("SELECT COUNT(*) AS n FROM settings WHERE key = ?", `compact:${conv.id}`)).toBe(0);
    expect(store.getMessages(conv.id)).toEqual([]); // second appel : rien ne ressuscite
    void u1;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildProjectMethods — rangement des conversations par projets (même store)
// ─────────────────────────────────────────────────────────────────────────────
describe("projets (buildProjectMethods)", () => {
  it("createProject : position incrémentale, garde de parent (fantôme ou non-racine → racine)", () => {
    const p1 = store.createProject("Premier");
    const p2 = store.createProject("Second");
    expect(p1.position).toBe(0);
    expect(p2.position).toBe(1);
    const enfant = store.createProject("Enfant", p1.id);
    expect(enfant.parentId).toBe(p1.id); // parent racine existant → accepté
    const fantôme = store.createProject("Fantôme", "id-inconnu");
    expect(fantôme.parentId).toBeNull(); // parent inconnu → retombe racine
    const petitEnfant = store.createProject("Trop profond", enfant.id);
    expect(petitEnfant.parentId).toBeNull(); // un seul niveau d'imbrication
    expect(store.getProject("id-inconnu")).toBeNull();
  });

  it("listProjects : ordre de position, rename met à jour, inconnu → null", () => {
    const p1 = store.createProject("A");
    const p2 = store.createProject("B");
    store.reorderProjects([p2.id, p1.id]); // positions 0..n-1
    const listed = store.listProjects();
    expect(listed.map((p) => [p.id, p.position])).toEqual([[p2.id, 0], [p1.id, 1]]);
    expect(store.renameProject(p1.id, "A renommé")!.name).toBe("A renommé");
    expect(store.renameProject("inconnu", "x")).toBeNull();
  });

  it("reorderProjects : positions = index fourni, ids inconnus laissent un trou", () => {
    const p1 = store.createProject("A");
    const p2 = store.createProject("B");
    const listed = store.reorderProjects(["inconnu", p2.id, p1.id]);
    // Comportement verbatim : position = index DANS LA LISTE fournie — un id
    // inconnu n'est pas écrit, mais consomme son index (trou 0 ici).
    expect(listed.map((p) => p.position)).toEqual([1, 2]);
  });

  it("setProjectDiskPath : lie puis délie ; inconnu → null", () => {
    const p = store.createProject("Liable");
    expect(store.setProjectDiskPath(p.id, "/home/utilisatrice/notes")!.diskPath).toBe("/home/utilisatrice/notes");
    expect(store.setProjectDiskPath(p.id, null)!.diskPath).toBeNull();
    expect(store.setProjectDiskPath("inconnu", "/x")).toBeNull();
  });

  it("setProjectArchived : archive le sous-arbre ; désarchiver l'enfant réactive le parent (B18)", () => {
    const parent = store.createProject("Parent");
    const enfant = store.createProject("Enfant", parent.id);
    const archivé = store.setProjectArchived(parent.id, true)!;
    expect(archivé.archived).toBe(true);
    expect(store.getProject(enfant.id)!.archived).toBe(true); // propagation au sous-arbre
    const désarchivé = store.setProjectArchived(enfant.id, false)!;
    expect(désarchivé.archived).toBe(false);
    // B18 : sans cette règle, l'enfant réapparaissait invisible (parent archivé) :
    expect(store.getProject(parent.id)!.archived).toBe(false); // le parent SEUL réactivé
    expect(store.setProjectArchived("inconnu", true)).toBeNull();
  });

  it("deleteProject : conversations du sous-arbre retournent « Sans projet », sous-dossiers promus", () => {
    const parent = store.createProject("Parent");
    const enfant = store.createProject("Enfant", parent.id);
    const c1 = store.createConversation("chez parent", parent.id);
    const c2 = store.createConversation("chez enfant", enfant.id);
    store.deleteProject(parent.id);
    expect(store.getProject(parent.id)).toBeNull();
    expect(store.getProject(enfant.id)!.parentId).toBeNull(); // promu racine
    expect(store.getConversation(c1.id)!.projectId).toBeNull();
    expect(store.getConversation(c2.id)!.projectId).toBeNull();
  });

  it("moveConversation : vers un projet, vers « Sans projet », gardes → null", () => {
    const p = store.createProject("Destination");
    const conv = store.createConversation("Mobile");
    expect(store.moveConversation(conv.id, p.id)!.projectId).toBe(p.id);
    expect(store.moveConversation(conv.id, null)!.projectId).toBeNull();
    expect(store.moveConversation(conv.id, "projet-inconnu")).toBeNull();
    expect(store.moveConversation("conv-inconnue", p.id)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildMessageVersionsMethods — machine de versions F-14 (+ Lot audit passe 2)
// ─────────────────────────────────────────────────────────────────────────────
describe("machine de versions F-14 (buildMessageVersionsMethods)", () => {
  it("appendMessage : versionGroup → version_active=1 par défaut ; sans groupe → NULL", () => {
    const conv = store.createConversation("Défauts");
    const a1 = addAssistant(conv.id, "sans groupe");
    const v2 = addAssistant(conv.id, "avec groupe", { versionGroup: "G", versionIndex: 2 });
    expect(row("SELECT version_active FROM messages WHERE id = ?", a1.id)!.version_active).toBeNull();
    expect(row("SELECT version_active FROM messages WHERE id = ?", v2.id)!.version_active).toBe(1);
  });

  it("appendMessage : tous les champs optionnels font l'aller-retour SQL", () => {
    const conv = store.createConversation("Champs");
    const full = store.appendMessage({
      conversationId: conv.id,
      role: "assistant",
      content: "riche",
      createdAt: iso(),
      reasoning: "raisonnement interne",
      toolEvents: [{ name: "outil", state: "done" } as never],
      attachments: [att("att-full")],
      model: "modele-x",
      stopped: true,
      variant: "b",
      versionGroup: "G-rich",
      versionIndex: 1,
      versionActive: 1,
      usage: { input: 10, output: 20, cost: 0.3 },
      sources: [{ url: "https://exemple.test", title: "Source" } as never],
      modeTag: "voix-a",
      modeFlow: [{ label: "étape", content: "détail" } as never],
    } as Parameters<typeof store.appendMessage>[0]);
    const got = store.getMessage(conv.id, full.id)!;
    expect(got.content).toBe("riche");
    expect(got.reasoning).toBe("raisonnement interne");
    expect(got.toolEvents).toEqual([{ name: "outil", state: "done" }]);
    expect(got.attachments).toEqual([att("att-full")]);
    expect(got.model).toBe("modele-x");
    expect(got.stopped).toBe(true);
    expect(got.variant).toBe("b");
    expect(got.usage).toEqual({ input: 10, output: 20, cost: 0.3 });
    expect(got.sources).toEqual([{ url: "https://exemple.test", title: "Source" }]);
    expect(got.modeTag).toBe("voix-a");
    expect(got.modeFlow).toEqual([{ label: "étape", content: "détail" }]);
    // ...et le message SANS aucun champ optionnel : tous les ?? / ternaires côté vide
    const bare = addUser(conv.id, "brut");
    const bareGot = store.getMessage(conv.id, bare.id)!;
    expect(bareGot.reasoning).toBeUndefined();
    expect(bareGot.toolEvents).toBeUndefined();
    expect(bareGot.attachments).toBeUndefined();
    expect(bareGot.model).toBeUndefined();
    expect(bareGot.stopped).toBeUndefined();
    expect(bareGot.variant).toBeUndefined();
    expect(bareGot.usage).toBeUndefined();
    expect(bareGot.sources).toBeUndefined();
    expect(bareGot.modeTag).toBeUndefined();
    expect(bareGot.modeFlow).toBeUndefined();
    const listed = store.getMessages(conv.id);
    expect(listed.find((m) => m.id === full.id)!.stopped).toBe(true);
    expect(listed.find((m) => m.id === bare.id)!.usage).toBeUndefined();
  });

  it("getMessage : version_group présent mais groupe d'une seule ligne → pas de sélecteur", () => {
    const conv = store.createConversation("Solo");
    addUser(conv.id, "q");
    const only = addAssistant(conv.id, "unique", { versionGroup: "G-solo", versionIndex: 1 });
    const got = store.getMessage(conv.id, only.id)!;
    expect(got.versions).toBeUndefined(); // count === 1 → pas de métadonnées
  });

  it("countVersions : 0 si groupe inconnu, sinon le nombre de lignes du groupe", () => {
    const { conv, a1 } = seededTurn();
    store.supersedeTrailingAssistant(conv.id); // a1 rejoint son groupe (rétro-complétion)
    addAssistant(conv.id, "v2", { versionGroup: a1.id, versionIndex: 2 });
    expect(store.countVersions(a1.id)).toBe(2);
    expect(store.countVersions("groupe-inconnu")).toBe(0);
  });

  it("supersedeTrailingAssistant : retire DU FIL, retro-complète le groupe, renvoie le tour", () => {
    const { conv, u1, a1 } = seededTurn();
    const r = store.supersedeTrailingAssistant(conv.id);
    expect(r.lastUser).not.toBeNull();
    expect(r.lastUser!.id).toBe(u1.id);
    expect(r.supersededIds).toEqual([a1.id]);
    expect(r.groups).toEqual({ plain: a1.id });
    expect(r.activeByGroup).toEqual({ [a1.id]: { id: a1.id, index: 1 } });
    expect(row("SELECT version_group, version_index, version_active FROM messages WHERE id = ?", a1.id))
      .toEqual({ version_group: a1.id, version_index: 1, version_active: 0 });
    expect(store.getMessages(conv.id).map((m) => m.id)).toEqual([u1.id]); // retiré du fil, pas supprimé
    expect(store.countVersions(a1.id)).toBe(1);
  });

  it("supersedeTrailingAssistant sans message utilisateur : rien n'est touché", () => {
    const conv = store.createConversation("Sans user");
    const a1 = addAssistant(conv.id, "seule réponse");
    const r = store.supersedeTrailingAssistant(conv.id);
    expect(r.lastUser).toBeNull();
    expect(r.supersededIds).toEqual([]);
    expect(r.groups).toEqual({});
    expect(row("SELECT version_active FROM messages WHERE id = ?", a1.id)!.version_active).toBeNull();
  });

  it("supersede sans variante : traverse les variantes, clé par variante (Lot 3 L3-4)", () => {
    const conv = store.createConversation("Traverse");
    const u1 = addUser(conv.id, "question");
    const a1 = addAssistant(conv.id, "voix plain");
    const b1 = addAssistant(conv.id, "voix b", { variant: "b" });
    const r = store.supersedeTrailingAssistant(conv.id);
    expect(r.supersededIds).toEqual([b1.id, a1.id]); // parcours de la fin
    expect(r.groups).toEqual({ plain: a1.id, b: b1.id });
    expect(r.lastUser!.id).toBe(u1.id);
    expect(scalar("SELECT COUNT(*) AS n FROM messages WHERE version_active = 0")).toBe(2);
  });

  it("supersede variante « a » : cible ce côté, l'autre reste au fil (F-17)", () => {
    const conv = store.createConversation("Côté a");
    const u1 = addUser(conv.id, "question");
    const a1 = addAssistant(conv.id, "a1", { variant: "a" });
    const b1 = addAssistant(conv.id, "b1", { variant: "b" });
    const a2 = addAssistant(conv.id, "a2", { variant: "a" });
    const r = store.supersedeTrailingAssistant(conv.id, "a");
    expect(r.supersededIds).toEqual([a2.id, a1.id]);
    expect(r.groups).toEqual({ a: a2.id }); // la première rencontre fixe la clé
    expect(row("SELECT version_active FROM messages WHERE id = ?", b1.id)!.version_active).toBeNull();
    expect(store.getMessages(conv.id).map((m) => m.id)).toEqual([u1.id, b1.id]);
  });

  it("supersede variante « a » alors que le bloc final est côté « b » : rien", () => {
    const conv = store.createConversation("Côté b");
    const u1 = addUser(conv.id, "question");
    const b1 = addAssistant(conv.id, "b1", { variant: "b" });
    const r = store.supersedeTrailingAssistant(conv.id, "a");
    expect(r.lastUser!.id).toBe(u1.id);
    expect(r.supersededIds).toEqual([]);
    expect(row("SELECT version_active FROM messages WHERE id = ?", b1.id)!.version_active).toBeNull();
  });

  it("activeByGroup capture la version AFFICHÉE avant écriture (Lot audit passe 2)", () => {
    const { conv, a1 } = seededTurn();
    store.supersedeTrailingAssistant(conv.id);
    const v2 = addAssistant(conv.id, "v2 affichée", { versionGroup: a1.id, versionIndex: 2 });
    const r = store.supersedeTrailingAssistant(conv.id);
    expect(r.activeByGroup).toEqual({ [a1.id]: { id: v2.id, index: 2 } });
  });

  it("setMessageVersion affiche la version demandée, les autres passent inactives", () => {
    const { conv, a1 } = seededTurn();
    store.supersedeTrailingAssistant(conv.id); // a1 → v1 inactive du groupe
    addAssistant(conv.id, "v2", { versionGroup: a1.id, versionIndex: 2 });
    const msgs = store.setMessageVersion(conv.id, a1.id, 1)!;
    expect(msgs.map((m) => m.content)).toEqual(["première question", "première réponse"]);
    const shown = msgs.find((m) => m.id === a1.id)!;
    expect(shown.versions).toEqual({ group: a1.id, index: 1, count: 2 });
    expect(row("SELECT version_active FROM messages WHERE id = ?", a1.id)!.version_active).toBe(1);
    expect(scalar("SELECT COUNT(*) AS n FROM messages WHERE version_group = ? AND version_active = 0", a1.id)).toBe(1);
  });

  it("setMessageVersion : bornes et groupe inconnu → null", () => {
    const { conv, a1 } = seededTurn();
    addAssistant(conv.id, "v2", { versionGroup: a1.id, versionIndex: 2 });
    expect(store.setMessageVersion(conv.id, a1.id, 0)).toBeNull();
    expect(store.setMessageVersion(conv.id, a1.id, 3)).toBeNull();
    expect(store.setMessageVersion(conv.id, "groupe-inconnu", 1)).toBeNull();
  });

  it("setMessageVersion : la ligne cible doit exister DANS la conversation (garde F-14)", () => {
    const conv = store.createConversation("Source");
    addUser(conv.id, "q");
    addAssistant(conv.id, "r", { versionGroup: "G-partagé", versionIndex: 1 });
    const other = store.createConversation("Ailleurs");
    expect(store.countVersions("G-partagé")).toBe(1); // compte GLOBAL
    expect(store.setMessageVersion(other.id, "G-partagé", 1)).toBeNull(); // mais rien ici
  });

  it("restoreLatestVersion : réactive l'index MAX quand aucune n'est active", () => {
    const { conv, a1 } = seededTurn();
    store.supersedeTrailingAssistant(conv.id);
    addAssistant(conv.id, "v2", { versionGroup: a1.id, versionIndex: 2 });
    store.supersedeTrailingAssistant(conv.id); // v2 inactive aussi — fil sans réponse
    expect(store.getMessages(conv.id).map((m) => m.role)).toEqual(["user"]);
    store.restoreLatestVersion(conv.id, a1.id);
    const msgs = store.getMessages(conv.id);
    expect(msgs.map((m) => m.id)).toEqual([msgs.find((m) => m.role === "user")!.id, msgs.find((m) => m.role === "assistant")!.id]);
    expect(msgs.find((m) => m.role === "assistant")!.content).toBe("v2"); // index MAX
  });

  it("restoreLatestVersion : groupe inconnu → no-op silencieux", () => {
    const { conv, u1, a1 } = seededTurn();
    store.restoreLatestVersion(conv.id, "groupe-inconnu"); // active null, latest null
    expect(store.getMessages(conv.id).map((m) => m.id)).toEqual([u1.id, a1.id]);
  });

  it("restoreLatestVersion : no-op quand une version est déjà active", () => {
    const { conv, a1 } = seededTurn();
    store.supersedeTrailingAssistant(conv.id); // a1 inactive, plus aucune active
    addAssistant(conv.id, "v2", { versionGroup: a1.id, versionIndex: 2 }); // v2 active
    store.restoreLatestVersion(conv.id, a1.id); // garde : une active existe → retour immédiat
    const active = store.getMessages(conv.id).filter((m) => m.role === "assistant");
    expect(active).toHaveLength(1);
    expect(active[0].content).toBe("v2");
    expect(row("SELECT version_active FROM messages WHERE id = ?", a1.id)!.version_active).toBe(0); // intouchée
  });

  it("restoreVersionById réactive LA version précise affichée avant régénération", () => {
    const { conv, a1 } = seededTurn();
    store.supersedeTrailingAssistant(conv.id);
    addAssistant(conv.id, "v2", { versionGroup: a1.id, versionIndex: 2 });
    store.supersedeTrailingAssistant(conv.id); // aucune active — tour régénéré stoppé à vide
    store.restoreVersionById(conv.id, a1.id); // celle qui était affichée (activeByGroup)
    const active = store.getMessages(conv.id).filter((m) => m.role === "assistant");
    expect(active.map((m) => m.content)).toEqual(["première réponse"]);
    expect(row("SELECT version_active FROM messages WHERE content = ?", "v2")!.version_active).toBe(0);
  });

  it("getMessage : métadonnées de versions, JSON relu, null si inconnu", () => {
    const { conv, a1 } = seededTurn();
    store.supersedeTrailingAssistant(conv.id); // a1 → v1 du groupe
    addAssistant(conv.id, "v2", { versionGroup: a1.id, versionIndex: 2 });
    const withVersions = store.getMessage(conv.id, a1.id)!;
    expect(withVersions.versions).toEqual({ group: a1.id, index: 1, count: 2 });
    expect(withVersions.content).toBe("première réponse");
    expect(store.getMessage(conv.id, "inconnu")).toBeNull();
    expect(store.getMessage("conv-inconnue", a1.id)).toBeNull();
  });

  it("deleteMessage : suppression simple d'une réponse non versionnée", () => {
    const { conv, u1, a1 } = seededTurn();
    const a2 = addAssistant(conv.id, "deuxième réponse");
    const removed = store.deleteMessage(conv.id, a2.id)!;
    expect(removed.id).toBe(a2.id);
    expect(removed.content).toBe("deuxième réponse");
    expect(store.getMessages(conv.id).map((m) => m.id)).toEqual([u1.id, a1.id]);
    expect(row("SELECT id FROM messages WHERE id = ?", a2.id)).toBeUndefined();
  });

  it("deleteMessage version active : promotion de la plus récente + renumérotation 1..k", () => {
    const { conv, a1 } = seededTurn();
    store.supersedeTrailingAssistant(conv.id);
    addAssistant(conv.id, "v2", { versionGroup: a1.id, versionIndex: 2 });
    store.supersedeTrailingAssistant(conv.id);
    addAssistant(conv.id, "v3", { versionGroup: a1.id, versionIndex: 3 });
    expect(store.countVersions(a1.id)).toBe(3);
    const removed = store.deleteMessage(conv.id, store.getMessages(conv.id).find((m) => m.content === "v3")!.id)!;
    expect(removed.versions).toEqual({ group: a1.id, index: 3, count: 3 });
    // v2 promue active, renumérotation 1..2
    const v1Row = row("SELECT version_index, version_active FROM messages WHERE content = ?", "première réponse");
    const v2Row = row("SELECT version_index, version_active FROM messages WHERE content = ?", "v2");
    expect(v1Row).toEqual({ version_index: 1, version_active: 0 });
    expect(v2Row).toEqual({ version_index: 2, version_active: 1 });
    const msgs = store.getMessages(conv.id);
    expect(msgs.find((m) => m.content === "v2")!.versions).toEqual({ group: a1.id, index: 2, count: 2 });
  });

  it("deleteMessage dernière version restante : le groupe se dissout (plus de sélecteur fantôme)", () => {
    const { conv, a1 } = seededTurn();
    store.supersedeTrailingAssistant(conv.id); // a1 → v1 inactive du groupe a1.id
    addAssistant(conv.id, "v2", { versionGroup: a1.id, versionIndex: 2 }); // v2 active
    store.deleteMessage(conv.id, store.getMessages(conv.id).find((m) => m.content === "v2")!.id);
    const r = row("SELECT version_group, version_index, version_active FROM messages WHERE id = ?", a1.id)!;
    expect(r).toEqual({ version_group: null, version_index: null, version_active: null }); // dissolution réelle
    const shown = store.getMessage(conv.id, a1.id)!;
    expect(shown.versions).toBeUndefined();
    expect(store.getMessages(conv.id).find((m) => m.id === a1.id)!.versions).toBeUndefined();
  });

  it("deleteMessage sur un id inconnu → null", () => {
    const { conv } = seededTurn();
    expect(store.deleteMessage(conv.id, "inconnu")).toBeNull();
  });

  it("deleteMessage du membre unique d'un groupe : ni promotion ni renumérotation", () => {
    const conv = store.createConversation("Solo");
    const u1 = addUser(conv.id, "q");
    const only = addAssistant(conv.id, "unique", { versionGroup: "G-solo", versionIndex: 1 });
    const removed = store.deleteMessage(conv.id, only.id)!;
    expect(removed.id).toBe(only.id);
    expect(store.getMessages(conv.id).map((m) => m.id)).toEqual([u1.id]);
    expect(scalar("SELECT COUNT(*) AS n FROM messages WHERE version_group = ?", "G-solo")).toBe(0);
  });

  it("purgeInactiveVersionsOf : purge les versions inactives des groupes touchés, pièces jointes rendues", () => {
    const { conv, a1 } = seededTurn();
    const v1att = addAssistant(conv.id, "v1 att", {
      versionGroup: a1.id,
      versionIndex: 1,
      versionActive: 0,
      attachments: [att("att-v1")],
    });
    const v2 = addAssistant(conv.id, "v2", { versionGroup: a1.id, versionIndex: 2 });
    const r = store.purgeInactiveVersionsOf(conv.id, [v2.id]);
    expect(r.purgedIds).toEqual([v1att.id]); // la ligne INACTIVE du groupe (a1, active NULL, reste)
    expect(r.purgedAttachments).toEqual([att("att-v1")]);
    expect(row("SELECT id FROM messages WHERE id = ?", v1att.id)).toBeUndefined();
    expect(row("SELECT id FROM messages WHERE id = ?", a1.id)).toBeDefined();
    expect(scalar("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?", conv.id)).toBe(3); // u1 + a1 + v2
  });

  it("purgeInactiveVersionsOf : rien à purger → réponse vide", () => {
    expect(store.purgeInactiveVersionsOf("conv-x", [])).toEqual({ purgedIds: [], purgedAttachments: [] });
    const { conv } = seededTurn();
    expect(store.purgeInactiveVersionsOf(conv.id, [])).toEqual({ purgedIds: [], purgedAttachments: [] });
  });

  it("deleteTrailingAssistant : retire les réponses actives ET les versions inactives des groupes touchés (D-02 corrigé)", () => {
    // ANOMALIE D-02 CORRIGÉE (constatée sous vague 4, vérifiée sous bun:sqlite
    // natif ET node:sqlite) : la purge des versions inactives des groupes
    // touchés est désormais passée AVANT les DELETE — les version_group des
    // lignes tronquées sont relevés tant qu'ils existent encore. Les lignes
    // version_active = 0 et leurs pièces jointes partent avec le fil.
    const { conv, u1, a1 } = seededTurn();
    const v1att = addAssistant(conv.id, "v1 att", {
      versionGroup: a1.id,
      versionIndex: 1,
      versionActive: 0,
      attachments: [att("att-v1")],
    });
    const v2 = addAssistant(conv.id, "v2", { versionGroup: a1.id, versionIndex: 2 });
    const r = store.deleteTrailingAssistant(conv.id);
    expect(r.lastUser!.id).toBe(u1.id);
    // Les deux réponses ACTIVES du fil (fin → début), puis la version inactive
    // du groupe touché (purge D-02, ids annexés en fin — convention F-14).
    expect(r.removedIds).toEqual([v2.id, a1.id, v1att.id]);
    expect(r.removedAttachments).toEqual([att("att-v1")]);
    expect(scalar("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?", conv.id)).toBe(1); // u1 seul
    expect(store.getMessages(conv.id).map((m) => m.id)).toEqual([u1.id]); // le fil est propre
    expect(row("SELECT id FROM messages WHERE id = ?", v1att.id)).toBeUndefined(); // inactive purgée
  });

  it("deleteTrailingAssistant : conversation sans réponse finale → rien n'est retiré", () => {
    const conv = store.createConversation("Sans réponse");
    const u1 = addUser(conv.id, "question seule");
    const r = store.deleteTrailingAssistant(conv.id);
    expect(r.lastUser!.id).toBe(u1.id);
    expect(r.removedIds).toEqual([]);
    expect(r.removedAttachments).toEqual([]);
    expect(store.getMessages(conv.id).map((m) => m.id)).toEqual([u1.id]);
  });

  it("deleteTrailingAssistant variante « a » : ne retire que ce côté, l'autre reste au fil", () => {
    const conv = store.createConversation("Côtés");
    const u1 = addUser(conv.id, "q");
    const b1 = addAssistant(conv.id, "b1", { variant: "b" });
    const a1 = addAssistant(conv.id, "a1", { variant: "a" });
    const r = store.deleteTrailingAssistant(conv.id, "a");
    expect(r.removedIds).toEqual([a1.id]);
    expect(store.getMessages(conv.id).map((m) => m.id)).toEqual([u1.id, b1.id]);
  });

  it("editUserMessageAndTruncate : réécrit le contenu et supprime tout ce qui suit", () => {
    const { conv, u1, a1 } = seededTurn();
    const a2 = addAssistant(conv.id, "réponse 2");
    const r = store.editUserMessageAndTruncate(conv.id, u1.id, "question corrigée")!;
    expect(r.message.id).toBe(u1.id);
    expect(r.message.content).toBe("question corrigée");
    expect(r.removedIds).toEqual([a1.id, a2.id]);
    expect(row("SELECT content FROM messages WHERE id = ?", u1.id)!.content).toBe("question corrigée");
    expect(store.getMessages(conv.id).map((m) => m.id)).toEqual([u1.id]);
  });

  it("editUserMessageAndTruncate : réécrit et tronque, les versions inactives partent avec (D-02 corrigé)", () => {
    // Même correctif que deleteTrailingAssistant (cf. supra) : la purge des
    // versions inactives du groupe tronqué est passée AVANT les DELETE —
    // l'inactive du groupe part avec le fil au lieu de survivre pour toujours.
    const { conv, u1, a1 } = seededTurn();
    store.supersedeTrailingAssistant(conv.id); // a1 → v1 inactive du groupe
    const v2 = addAssistant(conv.id, "v2", { versionGroup: a1.id, versionIndex: 2 });
    const a2 = addAssistant(conv.id, "réponse 2");
    const r = store.editUserMessageAndTruncate(conv.id, u1.id, "relance")!;
    expect(r.removedIds).toEqual([v2.id, a2.id, a1.id]); // visibles tronqués + inactive purgée (purge en fin)
    expect(r.removedAttachments).toEqual([]);
    expect(scalar("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?", conv.id)).toBe(1); // u1 seul
    expect(row("SELECT id FROM messages WHERE id = ?", a1.id)).toBeUndefined(); // inactive purgée
  });

  it("editUserMessageAndTruncate : refuse un message non-utilisateur ou inconnu", () => {
    const { conv, a1 } = seededTurn();
    expect(store.editUserMessageAndTruncate(conv.id, a1.id, "x")).toBeNull();
    expect(store.editUserMessageAndTruncate(conv.id, "inconnu", "x")).toBeNull();
  });

  it("editUserMessageAndTruncate : message utilisateur présent mais invisible du fil → null", () => {
    // Le garde idx < 0 : getMessage trouve la ligne, mais getMessages (fil
    // actif) ne la montre pas — jamais de troncature sur une ligne fantôme.
    const conv = store.createConversation("Fantôme");
    const ghost = store.appendMessage({
      conversationId: conv.id,
      role: "user",
      content: "question inactive",
      createdAt: iso(),
      versionGroup: "G-fantôme",
      versionIndex: 1,
      versionActive: 0,
    });
    expect(store.editUserMessageAndTruncate(conv.id, ghost.id, "x")).toBeNull();
  });
});
