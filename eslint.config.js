// @ts-check
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

/**
 * Flat config covering every workspace.
 *
 * Deliberately pragmatic rather than maximal: this repository ran with a CI
 * "Lint" step and no linter installed for its whole life, so a strict type-aware
 * ruleset would report several hundred pre-existing findings and simply be
 * disabled again. Rules that catch real defects are errors; stylistic and
 * migration-shaped rules are warnings, so the baseline is visible and can be
 * ratcheted down over time without blocking CI today.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "packages/shared/dist/**",
      "**/*.d.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      // Real-defect rules — these stay errors.
      "no-fallthrough": "error",
      "no-unsafe-finally": "error",
      "no-unreachable": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "@typescript-eslint/no-misused-new": "error",
      "@typescript-eslint/no-namespace": "off",

      // Known baseline debt: 116 `any` annotations and a spread of unused
      // symbols. Surfaced, not enforced, until they are paid down.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      "@typescript-eslint/ban-ts-comment": [
        "warn",
        { "ts-ignore": "allow-with-description", "ts-expect-error": "allow-with-description" },
      ],
      "no-empty": ["warn", { allowEmptyCatch: true }],
    },
  },

  {
    files: ["apps/backend/**/*.ts", "packages/shared/**/*.ts", "scripts/**/*.{ts,mjs}"],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  {
    files: ["apps/frontend/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: { ...globals.browser },
    },
    rules: {
      // Hook ordering is a correctness rule — never a warning.
      "react-hooks/rules-of-hooks": "error",
      // Two existing call sites suppress this inline; surfacing the rest is the
      // point, but it is not yet clean enough to block CI.
      "react-hooks/exhaustive-deps": "warn",
    },
  },

  {
    files: ["**/*.test.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
