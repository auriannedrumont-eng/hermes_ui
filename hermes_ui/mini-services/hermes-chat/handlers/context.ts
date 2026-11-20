// Contexte du service — store partagé + broadcast (v0.3.0).
import type { Server } from "socket.io";
import { Store } from "../store";

export const ctx = {
  store: null as unknown as Store,
  io: null as unknown as Server,

  init(store: Store, io: Server): void {
    this.store = store;
    this.io = io;
  },

  /** Diffusion à tous les clients connectés (mutations stockage, etc.). */
  broadcast(event: string, payload?: unknown): void {
    this.io?.emit(event, payload);
  },
};
