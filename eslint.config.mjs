import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "temp/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
  {
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["packages/pwa/**/*.ts", "packages/pwa-react/**/*.{ts,tsx}", "templates/*/src/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    files: [
      "packages/vite/**/*.ts",
      "packages/deploy/**/*.ts",
      "packages/devflow/**/*.ts",
      "scripts/**/*.ts",
      "**/*.{js,mjs,cjs}",
      "**/*.config.ts",
    ],
    languageOptions: { globals: globals.node },
  },
);
