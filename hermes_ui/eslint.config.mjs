// Config ESLint v9 (flat) minimale — le projet est petit ; les règles
// qui comptent : hooks React (dépendances d'effets) et TypeScript strict.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [".next/**", "node_modules/**", "next-env.d.ts", "download/**"],
  },
  ...tseslint.configs.recommended.map((c) => ({
    ...c,
    files: ["src/**/*.{ts,tsx}", "mini-services/**/*.ts", "scripts/**/*.ts"],
  })),
  {
    files: ["src/**/*.{ts,tsx}", "mini-services/**/*.ts", "scripts/**/*.ts"],
    rules: {
      // Les acks socket.io arrivent en callback : des « any » bornés au
      // périmètre d'un ack restent lisibles ; tsc garde la strictité.
      "@typescript-eslint/no-explicit-any": "off",
      // Les types remontent du protocole partagé ; les imports de type
      // « inutilisés » selon eslint sont parfois des ré-exports voulus.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  }
);
