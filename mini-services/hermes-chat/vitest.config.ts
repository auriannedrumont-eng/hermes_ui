import { defineConfig } from "vitest/config";

// Audit CRAP 2026-11 — première couverture réelle du mini-service.
// Les tests unitaires vivent dans test/ ; ils ne couvrent que les modules
// purs testables sous Node — depuis la vague 4 (« Store jetable »), les
// builders du store y tournent aussi (node:sqlite :memory:, via db-driver).
// Crapper (vitest --coverage) surcharge reportsDirectory/reporter/include
// par ses propres drapeaux CLI — cette config reste la base du `npm test`.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text"],
      reportsDirectory: "../../target/coverage/typescript/mini-services__hermes-chat",
      include: ["modes.ts", "prompts.ts", "models.ts", "hermes-connector.ts", "webchat/fiches.ts", "webchat/paths.ts", "shared/chat-protocol.ts", "store-messages.ts", "providers-validate.ts", "providers.ts"],
      exclude: ["test/**", "node_modules/**"],
      reportOnFailure: true,
    },
  },
});
