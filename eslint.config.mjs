import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  rules: {
    // TypeScript rules
    "@typescript-eslint/no-explicit-any": "off",
    // Revue P1-P7 : les règles qui attrapent les VRAIS bugs (variables non
    // déclarées, code mort, redéclarations, cas de switch non rompus,
    // closures obsolètes, imports morts) sont réactivées — elles étaient
    // toutes sur "off" et les bugs de closure passaient la CI sans alerte.
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/ban-ts-comment": "off",
    "@typescript-eslint/prefer-as-const": "off",
    "@typescript-eslint/no-unused-disable-directive": "off",

    // React rules
    "react-hooks/exhaustive-deps": "warn",
    "react-hooks/purity": "off",
    "react/no-unescaped-entities": "off",
    "react/display-name": "off",
    "react/prop-types": "off",
    "react-compiler/react-compiler": "off",

    // Next.js rules
    "@next/next/no-img-element": "off",
    "@next/next/no-html-link-for-pages": "off",

    // General JavaScript rules
    "prefer-const": "off",
    "no-unused-vars": "off", // doublon de la règle TS ci-dessus
    "no-console": "off",
    "no-debugger": "off",
    "no-empty": "off",
    "no-irregular-whitespace": "off",
    "no-case-declarations": "off",
    "no-fallthrough": "error",
    "no-mixed-spaces-and-tabs": "off",
    // no-undef / no-redeclare : INCOMPATIBLES TypeScript — les globals
    // ambiantes (NodeJS, Bun, React, RequestInit) et le fusion
    // interface+classe du même nom (store.ts) sont des FAUX POSITIFS ; les
    // vrais conflits et variables non déclarées sont déjà des erreurs du
    // compilateur TS (tsc --noEmit en CI).
    "no-redeclare": "off",
    "no-undef": "off",
    "no-unreachable": "error",
    "no-useless-escape": "off",
  },
}, {
  // tools/ : cache du bun portable du lanceur (types « ts7.1 » non
  // parsables par le TypeScript du projet — cf. tsconfig.json exclude) ;
  // hermes-agent/ : la copie fraîche de l'agent clonée DANS le dossier de
  // l'interface (§9 (63)/(66)) — dépôt séparé, jamais linté ni compilé
  // avec nos réglages ; desktop/runtime, db, upload/download : données
  // locales hors dépôt.
  ignores: ["node_modules/**", ".next/**", "out/**", "build/**", "next-env.d.ts", "examples/**", "skills", "tools/**", "desktop/runtime/**", "db/**", "hermes-agent/**"]
}];

export default eslintConfig;
