import { defineConfig } from "vitest/config";

// Audit CRAP 2026-11 — première couverture réelle du mini-service.
// Les tests unitaires vivent dans test/ ; ils ne couvrent que les modules
// purs testables sous Node (les stores exigent bun:sqlite, hors Vitest).
// Crapper (vitest --coverage) surcharge reportsDirectory/reporter/include
// par ses propres drapeaux CLI — cette config reste la base du `npm test`.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
      reportsDirectory: "../../target/coverage/typescript/mini-services__hermes-chat",
      include: ["modes.ts", "prompts.ts", "models.ts", "hermes-connector.ts", "webchat/fiches.ts", "webchat/paths.ts", "shared/chat-protocol.ts"],
      exclude: ["test/**", "node_modules/**"],
      reportOnFailure: true,
    },
  },
});
